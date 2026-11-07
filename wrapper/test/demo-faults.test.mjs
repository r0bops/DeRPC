import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, chmodSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateReader, validateState, writeControl } from '../demo/control.mjs';
import { assertDemoUpstream, createDemoHandler, DEMO_ACCOUNT } from '../demo/proxy.mjs';
import { createProxy } from '../src/proxy.ts';
import { verifyAccountProof, ProofVerificationError } from '../../provider/src/verify/index.ts';
import { createPool } from '../../provider/src/pool/pool.ts';
import fixture from '../../provider/test/fixtures/mainnet-proofs.json' with { type: 'json' };

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'derpc-demo-faults-')); directories.push(directory); return join(directory, 'state.json'); };
const block = `0x${fixture.block.number.toString(16)}`;
const proof = () => ({ ...structuredClone(fixture.responses.wethWithSlots), storageProof: [] });
const call = (address = fixture.inputs.WETH, id = 1) => ({ jsonrpc: '2.0', id, method: 'eth_getProof', params: [address, [], block] });
const request = body => new Request('http://demo/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const check = proof => verifyAccountProof({ stateRoot: fixture.block.stateRoot, address: fixture.inputs.WETH, proof });

function setup() {
  const control = temp(); writeControl(control, 'off');
  const upstream = vi.fn(async (_url, init) => {
    if (!init?.body) return Response.json({ data: {} });
    const query = JSON.parse(init.body);
    const result = query.method === 'eth_getBlockByNumber' ? { number: block } : query.method === 'eth_chainId' ? '0x1' : proof();
    return Response.json({ jsonrpc: '2.0', id: query.id, result });
  });
  const wrapper = createProxy({ executionUrl: 'http://127.0.0.1:8545', beaconUrl: 'http://127.0.0.1:5052',
    identity: { ens: 'demo-2.derpc.eth', signer: `0x${'11'.repeat(20)}`, chains: [1], version: '1', service: 'demo-proxy' }, fetch: upstream });
  const local = vi.fn(async (url, init) => wrapper(new Request(url, init)));
  const handler = createDemoHandler({ state: createStateReader(control), fetcher: local });
  return { control, handler, local, upstream };
}

describe('server-side demo fault controls', () => {
  it('defaults off and rejects excessive durations, malformed records, symlinks and oversized files', () => {
    const path = temp(), state = createStateReader(path);
    expect(state().mode).toBe('off');
    expect(() => writeControl(path, 'unavailable', 301)).toThrow('1–300');
    writeFileSync(path, 'x'.repeat(1025)); expect(state().mode).toBe('off');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, mode: 'off', unexpected: true })); expect(state().mode).toBe('off');
    const other = temp(); writeControl(other, 'unavailable'); rmSync(path); symlinkSync(other, path);
    expect(state().mode).toBe('off'); expect(() => writeControl(path, 'off')).toThrow('regular file');
  });

  it('expires after the fixed lifetime even if the wall clock moves backward', () => {
    const path = temp(); let wall = 100_000, mono = 0;
    const original = writeControl(path, 'unavailable', 2, wall);
    const state = createStateReader(path, { now: () => wall, monotonic: () => mono });
    expect(state().mode).toBe('unavailable');
    wall = 100_500; mono = 2001;
    expect(state().mode).toBe('off');
    expect(validateState({ schemaVersion: 1, ...original }, 99_999).mode).toBe('off');
    expect(validateState({ schemaVersion: 1, ...original }, 102_000).mode).toBe('off');
    chmodSync(join(path, '..'), 0o777);
    expect(() => writeControl(path, 'off')).toThrow('writable');
  });

  it('serves valid proofs normally, corrupts only the public WETH proof and never contaminates the wrapper cache', async () => {
    const { control, handler, upstream } = setup();
    const normal = await (await handler(request(call()))).json();
    const expected = check(normal.result).balance;
    const proofFetches = () => upstream.mock.calls.filter(([, init]) => init?.body && JSON.parse(init.body).method === 'eth_getProof').length;
    expect(proofFetches()).toBe(1);
    writeControl(control, 'corrupt-proof');
    const response = await handler(request(call())); const altered = await response.json();
    expect(response.headers.get('x-derpc-demo-scenario')).toBe('corrupt-proof');
    expect(() => check(altered.result)).toThrow(ProofVerificationError);
    expect(altered.result.accountProof).toEqual(normal.result.accountProof);
    expect(proofFetches()).toBe(1);
    const other = await handler(request(call(`0x${'22'.repeat(20)}`)));
    expect(other.headers.get('x-derpc-demo-scenario')).toBeNull();
    writeControl(control, 'off');
    expect(check((await (await handler(request(call()))).json()).result).balance).toBe(expected);
    expect((await (await handler(new Request('http://demo/.well-known/derpc-demo.json'))).json()).mode).toBe('off');
  });

  it('returns deliberate 503 without upstream RPC while identity/beacon checks still work and HTTP cannot trigger faults', async () => {
    const { control, handler, local } = setup(); writeControl(control, 'unavailable');
    const response = await handler(request(call()));
    expect(response.status).toBe(503); expect(local).not.toHaveBeenCalled();
    expect((await handler(new Request('http://demo/.well-known/derpc.json'))).status).toBe(200);
    expect((await handler(new Request('http://demo/eth/v1/beacon/light_client/finality_update'))).status).toBe(200);
    for (const path of ['/control', '/admin', '/.well-known/derpc-demo.json']) {
      expect((await handler(new Request(`http://demo${path}`, { method: 'POST', body: '{"mode":"off"}' }))).status).toBe(404);
    }
    expect(createStateReader(control)().mode).toBe('unavailable');
  });

  it.each(['corrupt-proof', 'unavailable'])('the real pool rejects %s and verifies the healthy selected endpoint', async mode => {
    const { control, handler } = setup(); writeControl(control, mode);
    const events = [];
    const pool = createPool({ endpoints: [{ id: 'demo-fault', url: 'https://fault.example', priority: -1 }, { id: 'healthy', url: 'https://healthy.example', priority: 0 }],
      sendFor: endpoint => async () => {
        if (endpoint.id === 'healthy') return proof();
        const response = await handler(request(call()));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).result;
      }, onEvent: event => events.push(event),
    });
    const value = await pool.run(async send => check(await send('eth_getProof', [DEMO_ACCOUNT, [], block], { isolationKey: 'demo-public-account' })).balance);
    expect(value).toBe(check(proof()).balance);
    expect(events.some(event => event.endpoint === 'demo-fault' && event.type === (mode === 'corrupt-proof' ? 'invalid-proof' : 'transient-failure'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'success', endpoint: 'healthy' });
    expect(pool.status().find(endpoint => endpoint.id === 'demo-fault').state).toBe(mode === 'corrupt-proof' ? 'excluded' : 'cooldown');
  });

  it('refuses an ordinary node, demo-1 or a non-loopback upstream before opening the overlay', async () => {
    const { handler } = setup();
    const local = async (url, init) => handler(new Request(url, init));
    await expect(assertDemoUpstream('http://127.0.0.1:8787', 'demo-2.derpc.eth', local)).resolves.toMatchObject({ service: 'demo-proxy' });
    await expect(assertDemoUpstream('http://127.0.0.1:8787', 'demo-1.derpc.eth', local)).rejects.toThrow('designated');
    await expect(assertDemoUpstream('https://public.example', 'demo-2.derpc.eth', local)).rejects.toThrow('loopback');
    await expect(assertDemoUpstream('http://127.0.0.1:8787', 'demo-2.derpc.eth', async () => Response.json({ ens: 'demo-2.derpc.eth', service: 'node', version: '1', chains: [1] }))).rejects.toThrow('expected');
  });
});
