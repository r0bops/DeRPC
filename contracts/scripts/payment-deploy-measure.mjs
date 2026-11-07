import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { administrativeClient, escrowBuild } from './payment-deploy.mjs';
import { compile } from './compile.mjs';

// An intentionally simple local fixture, not a production smart wallet.
const recipientSource = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract MeasurementRecipient {
  function invoke(address to, bytes calldata data) external payable {
    (bool ok,) = to.call{value: msg.value}(data);
    require(ok, "local fixture call failed");
  }
  receive() external payable { revert("local recipient rejects payment"); }
}`;
const LOCAL_TIME = '2026-11-07T00:00:00.000Z';

/** Actual gas receipts on an ephemeral local EVM, never a claim about a public network's fee market. */
export async function measureEscrowGas() {
  const build = escrowBuild();
  const chainId = 31337;
  const rpc = ganache.provider({ chain: { chainId, hardfork: 'shanghai', time: new Date(LOCAL_TIME) },
    miner: { timestampIncrement: 0 }, logging: { quiet: true }, wallet: { totalAccounts: 3, deterministic: true } });
  const transport = custom(rpc, { retryCount: 0 });
  const client = createPublicClient({ transport, pollingInterval: 10, cacheTime: 0 });
  const [payerAccount, operatorAccount, sessionAccount] = Object.values(rpc.getInitialAccounts()).map(account => privateKeyToAccount(account.secretKey));
  const payer = createWalletClient({ account: payerAccount, transport });
  const operator = createWalletClient({ account: operatorAccount, transport });
  const results = {};
  const record = async (operation, hash, expectedStatus = 'success') => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== expectedStatus) throw new Error(`${operation}: unexpected receipt status`);
    results[operation] = {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
      transactionFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(),
    };
    return receipt;
  };
  try {
    const deployment = await record('deploy', await payer.deployContract({ abi: build.artifact.abi, bytecode: build.creationBytecode, chain: null }));
    const address = deployment.contractAddress;
    if (!address) throw new Error('local deployment has no contract address');
    // Explicit gas allows intentionally reverted LOCAL transactions to produce measurable receipts.
    const write = (wallet, functionName, args, value) => wallet.writeContract({ address, abi: build.artifact.abi, functionName, args, value, chain: null, gas: 1_000_000n });
    const deposit = 1000000000000000n;
    await record('open', await write(payer, 'open', [operatorAccount.address, sessionAccount.address], deposit));
    await record('topUp', await write(payer, 'topUp', [1n], deposit));
    const amount = 12345n;
    const sign = id => sessionAccount.signTypedData({
      domain: { name: 'DeRPC Query Escrow', version: '1', chainId, verifyingContract: address },
      types: { Voucher: [{ name: 'sessionId', type: 'uint256' }, { name: 'amount', type: 'uint256' }] },
      primaryType: 'Voucher', message: { sessionId: id, amount },
    });
    const signature = await sign(1n);
    const payerBeforeClose = await client.getBalance({ address: payerAccount.address });
    const operatorBeforeClose = await client.getBalance({ address: operatorAccount.address });
    const closing = await record('close', await write(operator, 'close', [1n, amount, signature]));
    const paid = await client.getBalance({ address: operatorAccount.address }) - operatorBeforeClose + closing.gasUsed * closing.effectiveGasPrice;
    const returned = await client.getBalance({ address: payerAccount.address }) - payerBeforeClose;
    if (paid !== amount || returned !== deposit * 2n - amount) throw new Error('EOA settlement amounts differ');
    await record('duplicateCloseRetry', await write(operator, 'close', [1n, amount, signature]), 'reverted');
    await record('openRefundSession', await write(payer, 'open', [operatorAccount.address, sessionAccount.address], deposit));
    await record('earlyRefund', await write(payer, 'refund', [2n]), 'reverted');
    const duration = await client.readContract({ address, abi: build.artifact.abi, functionName: 'SESSION_DURATION' });
    await rpc.request({ method: 'evm_increaseTime', params: [Number(duration) + 1] });
    await rpc.request({ method: 'evm_mine', params: [] });
    await record('expiredClose', await write(operator, 'close', [2n, amount, await sign(2n)]), 'reverted');
    const beforeRefund = await client.getBalance({ address: payerAccount.address });
    const refunded = await record('refund', await write(payer, 'refund', [2n]));
    if (await client.getBalance({ address: payerAccount.address }) - beforeRefund + refunded.gasUsed * refunded.effectiveGasPrice !== deposit) throw new Error('timeout refund amount differs');

    const fixture = compile({ 'MeasurementRecipient.sol': { content: recipientSource } })['MeasurementRecipient.sol'].MeasurementRecipient;
    const deployFixture = async name => (await record(name, await payer.deployContract({ abi: fixture.abi,
      bytecode: `0x${fixture.evm.bytecode.object}`, chain: null }))).contractAddress;
    const rejectingPayer = await deployFixture('deployRejectingPayerFixture');
    const rejectingOperator = await deployFixture('deployRejectingOperatorFixture');
    const invoke = (recipient, functionName, args, value) => payer.writeContract({ address: recipient,
      abi: fixture.abi, functionName: 'invoke', args: [address, encodeFunctionData({ abi: build.artifact.abi, functionName, args })],
      value, chain: null, gas: 1_000_000n });
    await record('openRejectingRecipients', await invoke(rejectingPayer, 'open', [rejectingOperator, sessionAccount.address], deposit));
    await record('closeDeferredRecipients', await invoke(rejectingOperator, 'close', [3n, amount, await sign(3n)]));
    const credit = recipient => client.readContract({ address, abi: build.artifact.abi, functionName: 'pendingWithdrawals', args: [recipient] });
    if (await credit(rejectingPayer) !== deposit - amount || await credit(rejectingOperator) !== amount) throw new Error('deferred credits differ');
    await record('withdrawRejectedDestination', await invoke(rejectingPayer, 'withdraw', [rejectingPayer]), 'reverted');
    if (await credit(rejectingPayer) !== deposit - amount) throw new Error('failed withdrawal consumed credit');
    const beforeWithdraw = await client.getBalance({ address: sessionAccount.address });
    await record('withdrawPayerCredit', await invoke(rejectingPayer, 'withdraw', [sessionAccount.address]));
    await record('withdrawOperatorCredit', await invoke(rejectingOperator, 'withdraw', [sessionAccount.address]));
    if (await credit(rejectingPayer) !== 0n || await credit(rejectingOperator) !== 0n ||
      await client.getBalance({ address: sessionAccount.address }) - beforeWithdraw !== deposit) throw new Error('deferred recovery differs');
    const balance = await client.getBalance({ address });
    if (balance !== 0n) throw new Error('local flow left funds in escrow');
    return {
      schemaVersion: 2, kind: 'derpc-query-escrow-local-gas', measuredAt: new Date().toISOString(),
      method: {
        reproduction: 'node contracts/scripts/payment-deploy-measure.mjs --out <new-report.json> [--sample-fees]',
        cycleTotals: 'Named sums of recorded transaction gas. eoaOpenAndClose excludes the recorded top-up; its close was measured after that top-up. Fixture deployments are reported separately and excluded from session cycles.',
        publicSamples: '--sample-fees adds only administrative chain/block/gas-price reads after the disposable chain is disconnected; it never submits transactions.',
      },
      environment: { kind: 'ephemeral-in-memory-ganache', version: '7.9.2', chainId, hardfork: 'shanghai', publicDeployment: false,
        deterministicDisposableAccounts: true, initialBlockTime: LOCAL_TIME, timestampIncrementSeconds: 0 },
      compiler: build.compiler, sourceHash: build.sourceHash, creationCodeHash: build.creationCodeHash, codeHash: build.codeHash,
      conditions: {
        nativeAsset: 'local test ETH', depositWei: deposit.toString(), settledAmountWei: amount.toString(),
        recipients: 'EOA baseline; separate local contract fixtures that reject payment and forward withdrawals to an EOA', sessionLifetimeSeconds: duration.toString(),
        gasPrices: 'Per-receipt prices generated by this local EVM; not a public testnet or mainnet quote.',
        limitations: 'Gas depends on state and calldata. Rollup data fees and public congestion are not measured. This does not select a real-funds settlement chain.',
      },
      operations: results,
      accounting: { eoaClose: { depositAndTopUpWei: (deposit * 2n).toString(), operatorPaidWei: paid.toString(), payerRefundedWei: returned.toString() },
        timeoutRefundWei: deposit.toString(), deferred: { depositWei: deposit.toString(), operatorCreditWei: amount.toString(), payerCreditWei: (deposit - amount).toString(),
          failedWithdrawalPreservedCredit: true, bothCreditsRecovered: true } },
      recipientFixture: { sourceHash: keccak256(stringToHex(recipientSource)), runtimeCodeHash: keccak256(`0x${fixture.evm.deployedBytecode.object}`),
        scope: 'Minimal rejecting contracts; forwarded call gas includes fixture overhead. Fixture deployment is excluded from session totals; real wallet costs may differ.' },
      cycles: Object.fromEntries(Object.entries({
        eoaOpenAndClose: ['open', 'close'], eoaWithTopUp: ['open', 'topUp', 'close'],
        eoaWithMinedDuplicateClose: ['open', 'topUp', 'close', 'duplicateCloseRetry'],
        timeoutRefund: ['openRefundSession', 'refund'],
        timeoutWithFailedAttempts: ['openRefundSession', 'earlyRefund', 'expiredClose', 'refund'],
        deferredRecipients: ['openRejectingRecipients', 'closeDeferredRecipients', 'withdrawPayerCredit', 'withdrawOperatorCredit'],
        deferredWithFailedWithdrawal: ['openRejectingRecipients', 'closeDeferredRecipients', 'withdrawRejectedDestination', 'withdrawPayerCredit', 'withdrawOperatorCredit'],
      }).map(([name, operations]) => [name, { operations, gasUsed: operations.reduce((total, operation) => total + BigInt(results[operation].gasUsed), 0n).toString() }])),
      successfulCloseCycleGas: (BigInt(results.open.gasUsed) + BigInt(results.close.gasUsed)).toString(),
      timeoutCycleGas: (BigInt(results.openRefundSession.gasUsed) + BigInt(results.refund.gasUsed)).toString(),
      escrowBalanceAfterWei: balance.toString(),
      limitations: [
        'Only disposable local Ganache accounts sign transactions; no user key or public-chain signer is loaded.',
        'Reverted retry costs describe mined failures. Dropped or replaced transactions and network recovery are not measured.',
        'No accepted RPC reads occur in this contract measurement. Any per-read division is a volume sensitivity calculation, not observed demand.',
        'Shanghai execution gas does not establish current public-chain gas rules, rollup data fees, congestion, finality or availability.',
        'Principal and operator payout are transfers, not transaction fees. No minimum useful deposit, gas reserve, chain, asset or legal decision is selected.',
      ],
    };
  } finally { await rpc.disconnect(); }
}

/** Read-only administrative fee observations; wallets above never receive these transports. */
export async function samplePublicFees(report) {
  const sources = [
    { chainId: 560048, name: 'Hoodi', asset: 'test ETH', url: 'https://ethereum-hoodi-rpc.publicnode.com' },
    { chainId: 1, name: 'Ethereum mainnet', asset: 'ETH', url: 'https://ethereum-rpc.publicnode.com' },
    { chainId: 1, name: 'Ethereum mainnet', asset: 'ETH', url: 'https://rpc.mevblocker.io' },
  ];
  return Promise.all(sources.map(async source => {
    const startedAt = new Date().toISOString();
    try {
      const client = administrativeClient(source.url);
      const [chainId, gasPrice, block] = await Promise.all([client.getChainId(), client.getGasPrice(), client.getBlock()]);
      if (chainId !== source.chainId) throw new Error('wrong chain');
      return { ...source, startedAt, checkedAt: new Date().toISOString(), ok: true,
        methods: ['eth_chainId', 'eth_gasPrice', 'eth_getBlockByNumber'],
        block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString(), baseFeePerGasWei: block.baseFeePerGas?.toString() },
        sampledGasPriceWei: gasPrice.toString(),
        operationFeeProjectionWei: Object.fromEntries(Object.entries(report.operations).map(([name, value]) => [name, (BigInt(value.gasUsed) * gasPrice).toString()])),
        cycleProjections: Object.fromEntries(Object.entries(report.cycles).map(([name, cycle]) => {
          const fee = BigInt(cycle.gasUsed) * gasPrice;
          return [name, { transactionFeeWei: fee.toString(), assumedAcceptedReads: Object.fromEntries([1n, 10n, 100n, 1000n, 10000n].map(count =>
            [count.toString(), { transactionFeePerReadWeiRoundedUp: ((fee + count - 1n) / count).toString() }])) }];
        })),
        limits: 'Administrative RPC observations, not light-client verified. Gas price and latest block are sampled concurrently, not atomically. Projections multiply local Shanghai gas by this fee quote; they are not public receipts, deployment approval, final fee estimates or profitability claims.',
      };
    } catch (error) {
      return { ...source, startedAt, checkedAt: new Date().toISOString(), ok: false, error: { name: error.name, message: 'Read-only fee observation failed; no transaction attempted.' } };
    }
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (![2, 3].includes(args.length) || args[0] !== '--out' || !args[1] || args.length === 3 && args[2] !== '--sample-fees') throw new Error('usage: node contracts/scripts/payment-deploy-measure.mjs --out <new-file.json> [--sample-fees]');
  const report = await measureEscrowGas();
  if (args.includes('--sample-fees')) report.publicFeeSamples = await samplePublicFees(report);
  writeFileSync(args[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Local receipt measurements written to ${args[1]}; no public transaction was sent.`);
}
