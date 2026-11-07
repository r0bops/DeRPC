import { describe, expect, it } from 'vitest';
import { isLocalAdministrativeClient } from '../lib/ens-common.mjs';

describe('administrative evidence environment', () => {
  it('keeps injected clients with no known URL local-only', () => {
    expect(isLocalAdministrativeClient({})).toBe(true);
    expect(isLocalAdministrativeClient({ transport: {} })).toBe(true);
  });

  it.each([
    'http://localhost:8855', 'http://127.0.0.1:8855', 'http://127.42.8.9',
    'http://127.255.255.255', 'http://127.1', 'http://2130706433',
    'http://0x7f000001', 'http://[::1]:8855', 'http://[0:0:0:0:0:0:0:1]',
  ])('marks a normalized loopback endpoint local-only: %s', url => {
    expect(isLocalAdministrativeClient({ transport: { url } })).toBe(true);
  });

  it.each([
    'https://rpc.example', 'https://127.42.8.9.example', 'https://localhost.example',
    'https://127.42.8.9@rpc.example', 'https://126.255.255.255',
    'https://128.0.0.1', 'https://[2001:4860:4860::8888]',
  ])('does not treat a remote endpoint or lookalike as loopback: %s', url => {
    expect(isLocalAdministrativeClient({ transport: { url } })).toBe(false);
  });

  it('refuses malformed URLs rather than classifying them as public evidence', () => {
    expect(() => isLocalAdministrativeClient({ transport: { url: 'not a URL' } })).toThrow();
  });
});
