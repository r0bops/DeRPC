import { serve } from '../src/server.ts';
import { createStateReader } from './control.mjs';
import { assertDemoUpstream, createDemoHandler } from './proxy.mjs';

if (process.env.DERPC_DEMO_FAULTS !== 'true') throw new Error('Explicit DERPC_DEMO_FAULTS=true is required');
const ens = process.env.DERPC_ENS_NAME;
const upstream = 'http://127.0.0.1:8787';
const identity = await assertDemoUpstream(upstream, ens);
const server = serve(createDemoHandler({ upstream, state: createStateReader('/control/scenario.json') }), 8790);
console.log(JSON.stringify({ service: 'derpc-demo-fault-overlay', ens: identity.ens, listen: '127.0.0.1:8790', default: 'off', maxSeconds: 300, control: 'operator SSH only' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
