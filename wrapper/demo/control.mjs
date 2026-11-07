// Root/SSH-controlled demonstration state. No HTTP control endpoint exists.
import { constants, openSync, readSync, closeSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MAX_SECONDS = 300;
const modes = ['off', 'corrupt-proof', 'unavailable'];
const off = reason => ({ mode: 'off', ...(reason ? { reason } : {}) });

export function validateState(value, now = Date.now()) {
  if (!value || value.schemaVersion !== 1 || !modes.includes(value.mode)) throw new Error('Invalid demo control state');
  const expected = value.mode === 'off' ? ['schemaVersion', 'mode'] : ['schemaVersion', 'mode', 'id', 'issuedAt', 'expiresAt'];
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid demo control fields');
  if (value.mode === 'off') return off();
  if (!/^[a-f0-9]{32}$/.test(value.id) || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.issuedAt < 0 || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_SECONDS * 1000) throw new Error('Invalid demo control lifetime');
  if (now < value.issuedAt || now >= value.expiresAt) return off('expired or clock changed');
  return { mode: value.mode, id: value.id, issuedAt: value.issuedAt, expiresAt: value.expiresAt };
}

export function readControl(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(1025);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > 1024) throw new Error('Demo control file is too large');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(descriptor); }
}

export function createStateReader(path, { now = Date.now, monotonic = () => performance.now() } = {}) {
  let seen, deadline = 0;
  return () => {
    let state;
    try { state = validateState(readControl(path), now()); }
    catch { return off('missing or invalid control file'); }
    if (state.mode === 'off') return state;
    // A wall-clock rollback cannot prolong a previously observed activation.
    const key = `${state.id}:${state.mode}:${state.issuedAt}:${state.expiresAt}`;
    if (seen !== key) { seen = key; deadline = monotonic() + Math.min(MAX_SECONDS * 1000, state.expiresAt - now()); }
    return monotonic() >= deadline ? off('expired') : state;
  };
}

export function writeControl(path, mode, seconds = 60, now = Date.now()) {
  if (!isAbsolute(path) || !modes.includes(mode)) throw new Error('Use an absolute control path and off, corrupt-proof or unavailable');
  if (mode !== 'off' && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS)) throw new Error('Duration must be 1–300 seconds');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022) throw new Error('Control directory must not be writable by other users');
  try { if (!lstatSync(path).isFile()) throw new Error('Control path must be a regular file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = mode === 'off' ? { schemaVersion: 1, mode } : {
    schemaVersion: 1, mode, id: randomBytes(16).toString('hex'), issuedAt: now, expiresAt: now + seconds * 1000,
  };
  validateState(state, now);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o644 });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return validateState(state, now);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [mode, duration, ...extra] = process.argv.slice(2);
    if (extra.length || !mode || mode === 'status' && duration !== undefined || mode === 'off' && duration !== undefined) throw new Error('Usage: control.mjs status | off | corrupt-proof|unavailable [seconds]');
    const path = process.env.DERPC_DEMO_CONTROL_FILE;
    if (!path || !isAbsolute(path)) throw new Error('Set DERPC_DEMO_CONTROL_FILE to an absolute path');
    const state = mode === 'status' ? createStateReader(path)() : writeControl(path, mode, duration === undefined ? 60 : Number(duration));
    console.log(JSON.stringify({ demoOnly: true, ...state }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
