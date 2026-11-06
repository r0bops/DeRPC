// Optional Docker packaging check using a fresh local chain and throwaway keys only.
// First run live-browser.mjs to obtain a browser-authenticated header, then build:
// docker build -f wrapper/Dockerfile -t derpc-wrapper-paid-check .
// DERPC_TEST_HEADER_REPORT=/tmp/derpc-wrapper-live.json node wrapper/test/paid-container.mjs
// Loopback ports 18545 and 18787 must be free. All temporary containers, volumes and keys are removed.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(`${root}/contracts/package.json`);
const ganache = require('ganache');
const { createPublicClient, createWalletClient, http, parseEventLogs } = await import('viem');
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
const { compile } = await import(`${root}/contracts/scripts/compile.mjs`);
const { PaymentClient } = await import(`${root}/payments/src/client.ts`);
const { verifyAccountProof } = await import(`${root}/provider/src/verify/index.ts`);
const headerReport = process.env.DERPC_TEST_HEADER_REPORT ?? '/tmp/derpc-wrapper-live.json';
const image = process.env.DERPC_TEST_IMAGE ?? 'derpc-wrapper-paid-check';
const output = process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-paid-docker-report.json';
const dir = mkdtempSync(`${tmpdir()}/derpc-paid-docker-`);
const suffix = Date.now().toString();
const container = `derpc-paid-smoke-${suffix}`;
const volume = `${container}-state`;
const report = { started: new Date().toISOString(), localOnly: true, testChain:31337, stages: [] };
const docker = args => {
  const result = spawnSync('docker', args, { encoding:'utf8', timeout:60000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const server = ganache.server({ chain:{chainId:31337,hardfork:'shanghai'}, logging:{quiet:true}, wallet:{totalAccounts:3} });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = 'http://127.0.0.1:18787';
const json = value => JSON.stringify(value, (_k,v) => typeof v==='bigint'?v.toString():v);
const assert = (condition,message) => { if (!condition) throw new Error(message); };
async function ready() {
  for (let n=0;n<30;n++) {
    try { const r = await fetch(`${base}/.well-known/derpc.json`); if(r.ok) return; } catch {}
    await delay(300);
  }
  throw new Error(`container did not start: ${docker(['logs',container])}`);
}
async function post(path,body,headers={}) {
  const response = await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:json(body)});
  const result = await response.json();
  return {status:response.status,body:result};
}
try {
  await server.listen(18545,'127.0.0.1');
  const accounts = Object.values(server.provider.getInitialAccounts()).map(a=>({key:a.secretKey,account:privateKeyToAccount(a.secretKey)}));
  const payer=accounts[0].account, operator=accounts[1].account, signer=privateKeyToAccount(generatePrivateKey());
  const transport=http('http://127.0.0.1:18545',{retryCount:0});
  const client=createPublicClient({transport,pollingInterval:50});
  const wallet=createWalletClient({account:payer,transport});
  const artifact=compile()['QueryEscrow.sol'].QueryEscrow;
  const deploy=await wallet.deployContract({abi:artifact.abi,bytecode:`0x${artifact.evm.bytecode.object}`,chain:null});
  const escrow=(await client.waitForTransactionReceipt({hash:deploy})).contractAddress;
  const open=await wallet.writeContract({address:escrow,abi:artifact.abi,functionName:'open',args:[operator.address,signer.address],value:10000n,chain:null});
  await client.waitForTransactionReceipt({hash:open});
  const session=await client.readContract({address:escrow,abi:artifact.abi,functionName:'sessions',args:[1n]});
  writeFileSync(`${dir}/settlement-key`,accounts[1].key,{mode:0o600});
  docker(['volume','create',volume]);
  const env={DERPC_PORT:'18787',DERPC_ENS_NAME:'paid-check.derpc.eth',DERPC_SIGNER:operator.address,DERPC_DEMO_PROXY:'true',DERPC_EXECUTION_URL:'https://rpc.mevblocker.io',DERPC_BEACON_URL:'https://ethereum-beacon-api.publicnode.com',DERPC_PAYMENT_RPC_URL:'http://127.0.0.1:18545',DERPC_PAYMENT_CHAIN_ID:'31337',DERPC_PAYMENT_ESCROW:escrow,DERPC_PAYMENT_CONFIRMATIONS:'1',DERPC_PRICE_WEI:'10',DERPC_SETTLEMENT_KEY_FILE:'/run/settlement-key',DERPC_PAYMENT_STATE_DIR:'/var/lib/derpc/payments'};
  docker(['run','-d','--name',container,'--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',`type=bind,source=${dir}/settlement-key,target=/run/settlement-key,readonly`,'--mount',`type=volume,source=${volume},target=/var/lib/derpc/payments`,...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),image]);
  await ready(); report.stages.push('paid image started as unprivileged node with read-only root and mounted durable state');
  const header=JSON.parse(readFileSync(headerReport,'utf8')).result.block;
  const address='0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const request={jsonrpc:'2.0',id:1,method:'eth_getProof',params:[address,[],`0x${header.blockNumber.toString(16)}`]};
  const unauth=await post('/rpc',request); assert([400,401,402].includes(unauth.status) && !unauth.body.result,`unauthenticated paid proof was not refused: ${json(unauth)}`);
  const payments=new PaymentClient();
  payments.addSession({operatorId:'paid-check',chainId:31337,escrow,sessionId:1n,payer:payer.address,payee:operator.address,signer,deposit:10000n,price:10n,refundAfter:Number(session[4])});
  const attempt=await payments.begin('paid-check','proof');
  const proof=await post('/rpc',request,attempt.headers()); assert(proof.status===200 && proof.body.result,'authorized proof failed');
  const verified=verifyAccountProof({stateRoot:header.stateRoot,address,proof:proof.body.result});
  const voucher=await attempt.verified();
  const accepted=await post('/payments/voucher',voucher); assert(accepted.status===200 && accepted.body.highestAmount==='10','voucher was not persisted');
  report.stages.push('real mainnet account proof checked against the earlier browser-authenticated state root before voucher10');
  docker(['restart',container]); await ready();
  const recovered=await post('/payments/voucher',voucher); assert(recovered.status===200 && recovered.body.highestAmount==='10','voucher lost across restart');
  report.stages.push('container restart preserved accepted voucher and recovered single-writer state lock');
  const close=await payments.prepareClose('paid-check');
  let settlement=await post('/payments/voucher',{...close.voucher,close:true,closeAuthorization:close.closeAuthorization,closeDeadline:close.closeDeadline});
  assert(settlement.status===200,'explicit settlement rejected');
  for(let n=0;n<10 && settlement.body.settlement.state!=='confirmed';n++) {await delay(300); settlement=await post('/payments/voucher',voucher);}
  assert(settlement.body.settlement.state==='confirmed',`settlement not confirmed: ${json(settlement)}`);
  const receipt=await client.getTransactionReceipt({hash:settlement.body.settlement.transactionHash});
  const closed=parseEventLogs({abi:artifact.abi,eventName:'Closed',logs:receipt.logs})[0];
  assert(closed?.args.paid===10n && closed.args.refunded===9990n,'incorrect contract paid/refunded event');
  const final=await client.readContract({address:escrow,abi:artifact.abi,functionName:'sessions',args:[1n]}); assert(final[5]===true,'session not closed');
  report.stages.push('one local-chain closing transaction paid10wei and refunded9990wei');
  Object.assign(report,{ok:true,escrow,sessionId:'1',unauthenticatedStatus:unauth.status,mainnetProofBlock:header.blockNumber,provenBalance:verified.balance.toString(),settlement:settlement.body,closedEvent:{paid:closed.args.paid.toString(),refunded:closed.args.refunded.toString()}});
} catch(error) { report.error=String(error); process.exitCode=1; }
finally {
  spawnSync('docker',['rm','-f',container],{stdio:'ignore',timeout:30000});
  spawnSync('docker',['volume','rm',volume],{stdio:'ignore',timeout:30000});
  await server.close(); rmSync(dir,{recursive:true,force:true});
  writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
