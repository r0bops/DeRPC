import { Common, Mainnet } from "@ethereumjs/common";
import { createEVM, getOpcodesForHF, paramsEVM, type EVMOpts, type EVMRunCallOpts } from "@ethereumjs/evm";
import { SimpleStateManager } from "@ethereumjs/statemanager";
import { Account, createAddressFromString, createZeroAddress, type Address } from "@ethereumjs/util";
import { assertAddress, InputError, type HeaderView, type JsonRpcSend, type VerifiedValue } from "../verify/reader.ts";
import { bytesToHex, hexToBytes, type Hex } from "../verify/hex.ts";
import { EMPTY_CODE_HASH, ProofVerificationError, verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof, type VerifiedAccount } from "../verify/index.ts";

export interface ExecutionLimits {
  gas: bigint;
  steps: number;
  accounts: number;
  slots: number;
  roundTrips: number;
  codeBytes: number;
  memoryBytes: number;
  inputBytes: number;
  outputBytes: number;
  depth: number;
  timeoutMs: number;
}

export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  gas: 1_000_000n, steps: 100_000, accounts: 24, slots: 64, roundTrips: 128,
  codeBytes: 256 * 1024, memoryBytes: 4 * 1024 * 1024,
  inputBytes: 64 * 1024, outputBytes: 128 * 1024, depth: 32, timeoutMs: 60_000,
});

/** Limits and unavailable execution context are local refusals, not proof failures. */
export class ExecutionLimitError extends Error { override name = "ExecutionLimitError"; }
export class UnsupportedExecutionError extends Error { override name = "UnsupportedExecutionError"; }
export class CallRevertedError extends Error {
  override name = "CallRevertedError";
  readonly data: Hex;
  constructor(data: Hex, reason: string) { super(reason); this.data = data; }
}

export interface VerifiedCallInput {
  to: Hex;
  data?: Hex;
  from?: Hex;
  /** Total transaction gas including intrinsic calldata cost; bounded by configured gas and block gas. */
  gas?: bigint;
  signal?: AbortSignal;
}

export interface VerifiedExecutor {
  call(input: VerifiedCallInput): Promise<VerifiedValue<Hex>>;
}

const CALL_FIELDS = new Set(["to", "data", "from", "gas", "signal"]);

/** Runtime boundary for JavaScript callers; unsupported transaction semantics must never be ignored. */
export function assertVerifiedCallInput(input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new InputError("verified call input must be an object");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !CALL_FIELDS.has(key)) throw new InputError(`unsupported verified call field: ${String(key)}`);
  }
  const call = input as Record<string, unknown>;
  if (typeof call.to !== "string") throw new InputError("call target must be a 20-byte hex address");
  assertAddress(call.to as Hex);
  if (call.from !== undefined) {
    if (typeof call.from !== "string") throw new InputError("call sender must be a 20-byte hex address");
    assertAddress(call.from as Hex, "caller");
  }
  if (call.data !== undefined && (typeof call.data !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(call.data))) throw new InputError("call data must be whole hex bytes");
  if (call.gas !== undefined && typeof call.gas !== "bigint") throw new InputError("call gas must be a bigint");
  if (call.signal !== undefined) {
    // Native brand checking also accepts signals from another browser realm.
    try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(call.signal); }
    catch { throw new InputError("call signal must be an AbortSignal"); }
  }
}

/**
 * Host-side mainnet execution. The only remote methods are eth_getProof and eth_getCode at one authenticated
 * finalized block. Each call has a fresh ephemeral EVM, so simulated writes cannot affect another read.
 */
export function createVerifiedExecutor(options: { headers: HeaderView; send: JsonRpcSend; limits?: Partial<ExecutionLimits> }): VerifiedExecutor {
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...options.limits };
  if (typeof limits.gas !== "bigint" || limits.gas < 21_000n || limits.gas > 30_000_000n) throw new InputError("execution gas cap must be between 21000 and 30000000");
  for (const [key, value] of Object.entries(limits)) {
    if (key !== "gas" && (!Number.isSafeInteger(value) || value <= 0)) throw new InputError(`invalid execution limit: ${key}`);
  }

  return { async call(input) {
    assertVerifiedCallInput(input);
    const data = input.data ?? "0x";
    if ((data.length - 2) / 2 > limits.inputBytes) throw new ExecutionLimitError("call data exceeds execution limit");
    const block = options.headers.finalized();
    if (block.network !== "mainnet") throw new UnsupportedExecutionError("verified execution requires a mainnet header source");
    const context = block.execution;
    if (!context) throw new UnsupportedExecutionError("verified execution requires the authenticated execution payload context");
    const gas = input.gas ?? limits.gas;
    if (typeof gas !== "bigint" || gas < 21_000n || gas > limits.gas || gas > context.gasLimit) throw new ExecutionLimitError("call gas exceeds the configured or authenticated block limit");

    const began = performance.now();
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(limits.timeoutMs)]);
    let fatal: unknown;
    const fail = (error: unknown): never => { fatal ??= error; throw error; };
    const check = () => {
      if (fatal !== undefined) throw fatal;
      if (signal.aborted) fail(signal.reason);
      if (performance.now() - began >= limits.timeoutMs) fail(new ExecutionLimitError("execution deadline exceeded"));
    };
    const common = new Common({ chain: Mainnet });
    common.setHardforkBy({ blockNumber: BigInt(block.blockNumber), timestamp: BigInt(block.timestamp) });
    // The current authenticated chain supports post-merge state. Future experimental forks require a
    // separate validation round; never execute them with a convenient older rule set.
    if (!["merge", "shanghai", "cancun", "prague", "osaka", "bpo1", "bpo2"].includes(common.hardfork())) {
      throw new UnsupportedExecutionError(`execution fork ${common.hardfork()} has not been validated`);
    }
    const calldata = hexToBytes(data);
    let tokens = 0n;
    for (const byte of calldata) tokens += byte === 0 ? 1n : 4n;
    const intrinsic = 21_000n + 4n * tokens;
    const minimum = common.isActivatedEIP(7623) ? 21_000n + 10n * tokens : intrinsic;
    if (gas < minimum) throw new ExecutionLimitError("gas is below intrinsic calldata requirements");

    let roundTrips = 0;
    let totalCodeBytes = 0;
    const accounts = new Map<string, VerifiedAccount>();
    const codes = new Map<string, Uint8Array>();
    const storage = new Map<string, Uint8Array>();
    const tag = `0x${block.blockNumber.toString(16)}`;
    const isolationKey = `derpc:call:${input.from?.toLowerCase() ?? input.to.toLowerCase()}`;

    async function remote(method: string, params: unknown[]): Promise<unknown> {
      check();
      if (++roundTrips > limits.roundTrips) fail(new ExecutionLimitError("execution round-trip limit"));
      let onAbort: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const result = await Promise.race([options.send(method, params, { isolationKey, signal }), aborted]);
        check();
        return result;
      } catch (error) { return fail(error); }
      finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
    }

    async function proofFor(address: Address, key?: Uint8Array): Promise<{ account: VerifiedAccount; value?: bigint }> {
      const hex = address.toString();
      if (!accounts.has(hex) && accounts.size >= limits.accounts) fail(new ExecutionLimitError("execution account limit"));
      const slot = key ? bytesToHex(key) : undefined;
      const result = await remote("eth_getProof", [hex, slot ? [slot] : [], tag]);
      try {
        if (!result || typeof result !== "object") throw new ProofVerificationError("missing execution proof");
        const proof = result as AccountProof;
        // Bound verifier input before recursive RLP decoding. Transport body limits are additional.
        if (!Array.isArray(proof.accountProof) || proof.accountProof.length > 64 || !Array.isArray(proof.storageProof) || proof.storageProof.length !== (slot ? 1 : 0) || proof.storageProof.some(p => !p || !Array.isArray(p.proof) || p.proof.length > 64)) throw new ProofVerificationError("oversized or malformed execution proof");
        const nodes = [...(proof.accountProof ?? []), ...(proof.storageProof ?? []).flatMap(p => p.proof ?? [])];
        if (nodes.length > 128 || nodes.some(n => typeof n !== "string" || n.length > 32768) || nodes.reduce((n, p) => n + p.length, 0) > 1024 * 1024) throw new ProofVerificationError("oversized or malformed execution proof");
        const account = verifyAccountProof({ stateRoot: block.stateRoot, address: hex, proof });
        const value = slot ? verifyStorageProof({ storageRoot: account.storageRoot, slot, proof: proof.storageProof[0]! }) : undefined;
        accounts.set(hex, account);
        return { account, value };
      } catch (error) {
        return fail(error instanceof ProofVerificationError ? error : new ProofVerificationError(error instanceof Error ? error.message : "invalid execution proof"));
      }
    }
    const originalAccount = async (address: Address) => accounts.get(address.toString()) ?? (await proofFor(address)).account;
    const storageKey = (address: Address, key: Uint8Array) => `${address.toString()}_${bytesToHex(key)}`;

    // The proven backend survives nested reverts; its immutable values are rematerialized into the
    // CURRENT checkpoint only. Testing just cache misses is unsafe: a reverted child can discard a
    // materialized slot while the proof cache still says it has been read.
    class ProvenState extends SimpleStateManager {
      private cleared = [new Set<string>()];
      private currentCleared() { return this.cleared[this.cleared.length - 1]!; }
      override async getAccount(address: Address): Promise<Account | undefined> {
        check();
        if (this.topAccountStack().has(address.toString())) return super.getAccount(address);
        const a = await originalAccount(address);
        const account = a.exists ? new Account(a.nonce, a.balance, hexToBytes(a.storageRoot), hexToBytes(a.codeHash)) : undefined;
        await super.putAccount(address, account);
        return account;
      }
      override async getCode(address: Address): Promise<Uint8Array> {
        check();
        if (this.topCodeStack().has(address.toString())) return super.getCode(address);
        const account = await originalAccount(address);
        let code = codes.get(address.toString());
        if (!code) {
          if (account.codeHash === EMPTY_CODE_HASH) code = new Uint8Array();
          else {
            const raw = await remote("eth_getCode", [address.toString(), tag]);
            if (typeof raw !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(raw)) fail(new ProofVerificationError("invalid execution code"));
            if ((raw as string).length / 2 - 1 + totalCodeBytes > limits.codeBytes) fail(new ExecutionLimitError("execution code size limit"));
            try { verifyCode({ codeHash: account.codeHash, code: raw as Hex }); } catch (error) { fail(error); }
            code = hexToBytes(raw as Hex);
          }
          totalCodeBytes += code.length;
          codes.set(address.toString(), code);
        }
        // Do not call putCode: materializing proven code must not mutate account fields.
        this.topCodeStack().set(address.toString(), code);
        return code;
      }
      override async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
        check();
        if (key.length !== 32) fail(new UnsupportedExecutionError("execution requested a non-word storage key"));
        const id = storageKey(address, key);
        if (this.topStorageStack().has(id)) return super.getStorage(address, key);
        if (this.currentCleared().has(address.toString())) return new Uint8Array();
        let value = storage.get(id);
        if (!value) {
          if (storage.size >= limits.slots) fail(new ExecutionLimitError("execution storage-slot limit"));
          const proven = (await proofFor(address, key)).value!;
          let digits = proven.toString(16);
          if (digits.length % 2) digits = `0${digits}`;
          value = proven === 0n ? new Uint8Array() : hexToBytes(`0x${digits}`);
          storage.set(id, value);
        }
        await super.putStorage(address, key, value);
        return value;
      }
      override async clearStorage(address: Address) {
        await super.clearStorage(address);
        this.currentCleared().add(address.toString());
      }
      override async deleteAccount(address: Address) {
        await super.deleteAccount(address);
        this.topCodeStack().set(address.toString(), new Uint8Array());
        await this.clearStorage(address);
      }
      override async checkpoint() { await super.checkpoint(); this.cleared.push(new Set(this.currentCleared())); }
      override async commit() { await super.commit(); this.cleared.splice(-2, 1); }
      override async revert() { await super.revert(); this.cleared.pop(); }
    }

    const stateManager = new ProvenState({ common });
    const forbidden = (name: string): never => fail(new UnsupportedExecutionError(`${name} needs unavailable authenticated block context`));
    common.updateParams(paramsEVM);
    const original = getOpcodesForHF(common);
    let steps = 0;
    // Budget checks surround the library's actual fork-specific gas handlers. A step-event hook is
    // unsafe here: trace generation copies memory and reads REVERT data before notifying listeners.
    // None of the supported forks allocate EVM memory inside dynamic gas handlers (future fork
    // CREATE2 rules do), so checking expanded words before the logic handler bounds allocations.
    const customOpcodes: NonNullable<EVMOpts["customOpcodes"]> = [];
    for (const [opcode, info] of original.opcodes) {
      if (info.isInvalid) continue;
      const handler = original.handlers.get(opcode)!;
      const gasHandler = info.dynamicGas ? original.dynamicGasHandlers.get(opcode) : undefined;
      customOpcodes.push({
        opcode, opcodeName: info.name, baseFee: info.fee,
        async gasFunction(state, cost, chain) {
          check();
          if (++steps > limits.steps) fail(new ExecutionLimitError("execution step limit"));
          if (state.env.depth >= limits.depth) fail(new ExecutionLimitError("execution call-depth limit"));
          const gasCost = gasHandler ? await gasHandler(state, cost, chain) : cost;
          if (state.memoryWordCount * 32n > BigInt(limits.memoryBytes)) fail(new ExecutionLimitError("execution memory limit"));
          check();
          return gasCost;
        },
        logicFunction: opcode === 0x40 ? () => forbidden("BLOCKHASH") : handler,
      });
    }
    const evm = await createEVM({
      common, stateManager,
      blockchain: {
        getBlock: async () => forbidden("BLOCKHASH"),
        putBlock: async () => forbidden("block writes"),
        shallowCopy() { return this; },
      },
      customOpcodes,
    });
    // Even a host DEBUG environment setting must not enable unbounded trace snapshots.
    Object.defineProperty(evm, "DEBUG", { value: false, writable: false });
    evm.events.on("beforeMessage", message => {
      check();
      if (message.depth >= limits.depth) fail(new ExecutionLimitError("execution call-depth limit"));
      if (message.data.length > limits.memoryBytes) fail(new ExecutionLimitError("execution message size limit"));
    });
    evm.events.on("afterMessage", result => {
      check();
      if (result.execResult.returnValue.length > limits.outputBytes) fail(new ExecutionLimitError("execution return data limit"));
    });
    const from = input.from ? createAddressFromString(input.from) : createZeroAddress();
    const to = createAddressFromString(input.to);
    // Standalone runCall does not apply transaction warming itself.
    for (const address of [from.toString(), to.toString(), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(address.replace(/^0x/, ""));
    if (common.isActivatedEIP(3651)) evm.journal.addAlwaysWarmAddress(context.feeRecipient.slice(2).toLowerCase());
    const evmBlock: NonNullable<EVMRunCallOpts["block"]> = { header: {
      number: BigInt(block.blockNumber), timestamp: BigInt(block.timestamp),
      coinbase: createAddressFromString(context.feeRecipient), prevRandao: hexToBytes(context.prevRandao),
      gasLimit: context.gasLimit, baseFeePerGas: context.baseFeePerGas,
      difficulty: 0n, // post-merge; opcode 0x44 uses authenticated prevRandao
      getBlobGasPrice: () => forbidden("BLOBBASEFEE"),
    } };
    // No blobs are supplied, so BLOBHASH returns zero as for an ordinary call. Blob base fee is
    // refused until its fork-specific excessBlobGas formula is included and tested.
    const result = await evm.runCall({
      block: evmBlock, caller: from, origin: from, to, data: calldata, gasLimit: gas - intrinsic,
      gasPrice: 0n, value: 0n, blobVersionedHashes: [],
    });
    check();
    if (result.execResult.returnValue.length > limits.outputBytes) throw new ExecutionLimitError("execution return data limit");
    const value = bytesToHex(result.execResult.returnValue);
    if (result.execResult.exceptionError) {
      if (value.startsWith("0x556f1830")) throw new UnsupportedExecutionError("CCIP-Read OffchainLookup is refused");
      throw new CallRevertedError(value, `verified execution reverted: ${result.execResult.exceptionError.error}`);
    }
    options.headers.assertFresh?.(block);
    return { value, block };
  } };
}
