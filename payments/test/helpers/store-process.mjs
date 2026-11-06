import { FileDelegationStore } from '../../src/node-store.ts';

const directory = process.argv[2];
let store;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await store?.close(); } finally { process.exit(0); }
}
try {
  store = await FileDelegationStore.open(directory);
  process.send?.({ type: 'opened', workerPid: store.workerPid });
  process.on('message', message => {
    if (message?.type === 'close') void close();
  });
  process.on('disconnect', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
} catch (error) {
  process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
