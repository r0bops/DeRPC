// Must stay first: evaluated before any Lodestar module (see the file for why).
import "./runtime/node-globals.ts";

export {
  TOR_JS_PIN,
  NYM_PIN,
  TOR_JS_DEMO_GATEWAY,
  MAINNET_CHECKPOINT,
  withGateways,
  MAINNET_EXECUTION_ENDPOINTS,
  MAINNET_BEACON_ENDPOINTS,
  MAINNET_TOKENS,
  MAINNET_OPERATORS,
  ENS_NAMES_ARE_MOCK,
  type WorkerPin,
} from "./config/mainnet.ts";
export { createJsonRpcSend } from "./transport/json-rpc.ts";
export {
  createVerifiedReader,
  mappingSlot,
  type JsonRpcSend,
  type TokenConfig,
  type VerifiedReader,
  type VerifiedValue,
} from "./verify/reader.ts";
export {
  checkWorkerPin,
  gateReader,
  WORKER_HASH_SLOT,
  WorkerPinChainError,
  WorkerPinMismatchError,
} from "./verify/worker-pin.ts";
export {
  verifyAccountProof,
  verifyStorageProof,
  verifyCode,
  ProofVerificationError,
  EMPTY_CODE_HASH,
  type AccountProof,
  type StorageProofEntry,
  type VerifiedAccount,
} from "./verify/index.ts";
export { createPinnedBootstrapProvider, type Eip1193Like } from "./transport/pinned-bootstrap.ts";
export {
  startAnonTransport,
  TransportUnavailableError,
  type AnonTransport,
  type AnonFetchOptions,
  type TransportState,
  type WorkerLogLine,
} from "./transport/anon-transport.ts";
export { asFetch, type FetchAdapterOptions } from "./transport/fetch-adapter.ts";
export {
  startVerifiedHeaderSource,
  StaleCheckpointError,
  StaleHeaderError,
  HeaderSourceNotReadyError,
  GENESIS,
  type HeaderNetwork,
  type HeaderSourceOptions,
  type VerifiedHeader,
  type VerifiedHeaderSource,
} from "./light-client/header-source.ts";
export { PollingLightClientTransport } from "./light-client/polling-transport.ts";
export {
  createPool,
  PoolExhaustedError,
  NoOperatorsChosenError,
  type Pool,
  type PoolEndpoint,
  type PoolEvent,
  type PoolAttempt,
  type EndpointState,
} from "./pool/pool.ts";
export { createPooledReader } from "./pool/pooled-reader.ts";
