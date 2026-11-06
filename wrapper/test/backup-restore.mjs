// Optional recovery drill on containers the operator owns. The source Tor container
// is stopped only for its encrypted snapshot, then restarted. Original keys stay intact.
// Requires Docker, network access for the disposable age utility, and free loopback
// ports 18887/18888. The restored Tor has no network and never publishes descriptors.
// Required: DERPC_BACKUP_TOR_CONTAINER and DERPC_BACKUP_PROXY_CONTAINER.
// Optional retained backup: DERPC_RETAIN_RECIPIENT_FILE (SSH-ed25519 PUBLIC key only)
// and DERPC_RETAIN_BACKUP_DIR (owner-only directory outside this repository).
// Retention never reads a corresponding private key or claims to test its decryption.
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
const sourceTor = required('DERPC_BACKUP_TOR_CONTAINER');
const sourceProxy = required('DERPC_BACKUP_PROXY_CONTAINER');
const output = process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-backup-restore-report.json';
const temporary = mkdtempSync(join(tmpdir(), 'derpc-recovery-'));
const suffix = `${process.pid}-${Date.now()}`;
const helper = `derpc-recovery-age-${suffix}`;
const restoredTor = `derpc-recovery-tor-${suffix}`;
const restoredProxy = `derpc-recovery-proxy-${suffix}`;
const restoredVolume = `derpc-recovery-keys-${suffix}`;
const report = { started: new Date().toISOString(), kind: 'encrypted-backup-restore-drill', stages: [] };
let originalStopped = false;
const containers = [];
let volumeCreated = false;
let privateHostname;
let token;
let retainedComplete = false;
const retainedFiles = [];
function sanitize(value) {
  let result = String(value);
  for (const secret of [privateHostname, token]) if (secret) result = result.replaceAll(secret, '[redacted]');
  return result;
}
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${sanitize(result.stderr || result.error || 'no diagnostic')}`);
  return result.stdout.trim();
}
function child(args) {
  const process = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '';
  process.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-8192); });
  const done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}: ${sanitize(error)}`)));
  });
  return { process, done };
}
async function encryptTar(args, path, recipient) {
  const tar = child(args);
  const age = child(['exec', '-i', helper, 'age', '-r', recipient]);
  tar.process.stdin.end();
  await Promise.all([
    pipeline(tar.process.stdout, age.process.stdin),
    pipeline(age.process.stdout, createWriteStream(path, { flags: 'wx', mode: 0o600 })),
    tar.done, age.done,
  ]);
}
async function decryptTar(path, args) {
  const age = child(['exec', '-i', helper, 'age', '-d', '-i', '/tmp/recovery-key']);
  const tar = child(args);
  tar.process.stdout.resume();
  await Promise.all([
    pipeline(createReadStream(path), age.process.stdin),
    pipeline(age.process.stdout, tar.process.stdin),
    age.done, tar.done,
  ]);
}
async function reencrypt(path, destination, recipient) {
  const decrypt = child(['exec', '-i', helper, 'age', '-d', '-i', '/tmp/recovery-key']);
  const encrypt = child(['exec', '-i', helper, 'age', '-r', recipient]);
  await Promise.all([
    pipeline(createReadStream(path), decrypt.process.stdin),
    pipeline(decrypt.process.stdout, encrypt.process.stdin),
    pipeline(encrypt.process.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 })),
    decrypt.done, encrypt.done,
  ]);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
async function request(port, authentication) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authentication ? { authorization: `Bearer ${authentication}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
}

try {
  let retained;
  if (process.env.DERPC_RETAIN_RECIPIENT_FILE || process.env.DERPC_RETAIN_BACKUP_DIR) {
    const publicKey = readFileSync(required('DERPC_RETAIN_RECIPIENT_FILE'), 'utf8').trim();
    const parts = publicKey.split(/\s+/);
    assert(!publicKey.includes('\n') && parts[0] === 'ssh-ed25519' && /^[A-Za-z0-9+/]+={0,2}$/.test(parts[1] ?? ''), 'retain recipient must be one SSH-ed25519 public key');
    const key = Buffer.from(parts[1], 'base64');
    assert(key.length === 51 && key.readUInt32BE(0) === 11 && key.subarray(4, 15).toString() === 'ssh-ed25519' && key.readUInt32BE(15) === 32, 'invalid SSH-ed25519 public key encoding');
    const destination = resolve(required('DERPC_RETAIN_BACKUP_DIR'));
    const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    assert(destination !== repository && !destination.startsWith(`${repository}/`), 'retained secret backups must stay outside the repository');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    assert((statSync(destination).mode & 0o777) === 0o700 && statSync(destination).uid === process.getuid(), 'retained backup directory must be owner-only and owned by this user');
    retained = { recipient: `${parts[0]} ${parts[1]}`, destination, fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` };
  }
  const tor = JSON.parse(docker(['inspect', sourceTor]))[0];
  const proxy = JSON.parse(docker(['inspect', sourceProxy]))[0];
  const originalVolume = tor.Mounts.find(m => m.Type === 'volume' && m.Destination === '/var/lib/tor')?.Name;
  assert(originalVolume && tor.State.Running && proxy.State.Running, 'running source containers and their named onion volume are required');
  const sourceEnv = Object.fromEntries(proxy.Config.Env.map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
  assert(proxy.HostConfig.NetworkMode === 'host', 'source proxy must use the documented host-network compose configuration');
  assert(!sourceEnv.DERPC_PAYMENT_ESCROW, 'this drill does not restore payment keys or funded-session journals');
  const tokenMount = proxy.Mounts.find(m => m.Destination === sourceEnv.DERPC_PERSONAL_TOKEN_FILE);
  assert(tokenMount?.Type === 'bind', 'the personal token must be a separately mounted source file');
  const tokenStat = statSync(tokenMount.Source);
  assert((tokenStat.mode & 0o077) === 0 && tokenStat.uid === 1000, 'source token must be owner-only and readable by container UID 1000');
  token = readFileSync(tokenMount.Source, 'utf8').trim();
  assert(/^[a-f0-9]{64}$/.test(token), 'source token format is invalid');
  const publicHostname = docker(['exec', sourceTor, 'cat', '/var/lib/tor/pool/hostname']);
  privateHostname = docker(['exec', sourceTor, 'cat', '/var/lib/tor/personal/hostname']);
  const permissionPaths = ['/var/lib/tor/pool', '/var/lib/tor/personal', '/var/lib/tor/pool/hs_ed25519_secret_key', '/var/lib/tor/personal/hs_ed25519_secret_key'];
  const originalPermissions = docker(['exec', sourceTor, 'stat', '-c', '%a:%u:%g', ...permissionPaths]);
  const originalIdentity = await (await fetch(`http://127.0.0.1:${sourceEnv.DERPC_PORT ?? '8787'}/.well-known/derpc.json`)).json();

  // Install the packaged utility before giving the helper any secrets; disconnect it afterward.
  docker(['run', '-d', '--name', helper, '--user', '0', '--entrypoint', 'sleep', tor.Image, 'infinity']);
  containers.push(helper);
  docker(['exec', helper, 'sh', '-c', 'apt-get update >/dev/null && apt-get install -y --no-install-recommends age >/dev/null']);
  docker(['network', 'disconnect', 'bridge', helper]);
  assert(Object.keys(JSON.parse(docker(['inspect', helper]))[0].NetworkSettings.Networks).length === 0, 'age helper must be disconnected before key generation');
  docker(['exec', helper, 'sh', '-c', 'umask 077; age-keygen -o /tmp/recovery-key; age-keygen -o /tmp/wrong-key']);
  const recipient = docker(['exec', helper, 'age-keygen', '-y', '/tmp/recovery-key']);
  report.ageVersion = docker(['exec', helper, 'age', '--version']);
  if (retained) docker(['exec', '-i', helper, 'age', '-r', retained.recipient, '-o', '/tmp/owner-recipient-probe.age'], { input: '' });

  const onionArchive = join(temporary, 'onion-keys.tar.age');
  const configArchive = join(temporary, 'personal-config.tar.age');
  const stoppedAt = Date.now();
  docker(['stop', '--time', '10', sourceTor]); originalStopped = true;
  try {
    await encryptTar(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${originalVolume},target=/var/lib/tor,readonly`, '--entrypoint', 'tar', tor.Image, '-C', '/var/lib/tor', '-cpf', '-', '.'], onionArchive, recipient);
  } finally {
    docker(['start', sourceTor]); originalStopped = false;
  }
  report.sourceSnapshotStopMs = Date.now() - stoppedAt;
  report.stages.push('original Tor volume snapshotted read-only through an age encryption pipe; original Tor restarted');

  const stage = join(temporary, 'config-source'); mkdirSync(stage, { mode: 0o700 });
  const config = Object.fromEntries(['DERPC_ENS_NAME', 'DERPC_SIGNER', 'DERPC_EXECUTION_URL', 'DERPC_BEACON_URL', 'DERPC_DEMO_PROXY'].map(key => [key, sourceEnv[key]]));
  writeFileSync(join(stage, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  copyFileSync(tokenMount.Source, join(stage, 'personal-token')); chmodSync(join(stage, 'personal-token'), 0o600);
  await encryptTar(['run', '--rm', '--network', 'none', '--user', '0', '--mount', `type=bind,source=${stage},target=/backup,readonly`, '--entrypoint', 'tar', tor.Image, '-C', '/backup', '-cpf', '-', '.'], configArchive, recipient);
  rmSync(stage, { recursive: true, force: true });
  report.encryptedBytes = { onion: statSync(onionArchive).size, personalConfiguration: statSync(configArchive).size };
  const wrongKey = spawnSync('docker', ['exec', '-i', helper, 'age', '-d', '-i', '/tmp/wrong-key'], { input: readFileSync(configArchive), encoding: 'utf8', timeout: 10_000 });
  assert(wrongKey.status !== 0 && !wrongKey.stdout, 'wrong recovery identity unexpectedly decrypted the archive');
  report.wrongRecoveryIdentityRejected = true;

  docker(['volume', 'create', restoredVolume]); volumeCreated = true;
  await decryptTar(onionArchive, ['run', '--rm', '-i', '--network', 'none', '--user', '0', '--mount', `type=volume,source=${restoredVolume},target=/var/lib/tor`, '--entrypoint', 'tar', tor.Image, '-C', '/var/lib/tor', '-xpf', '-']);
  // Regenerate names from the restored keys: copied hostname files alone are not proof of recovery.
  docker(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${restoredVolume},target=/var/lib/tor`, '--entrypoint', 'rm', tor.Image, '/var/lib/tor/pool/hostname', '/var/lib/tor/personal/hostname']);
  docker(['run', '-d', '--name', restoredTor, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,source=${restoredVolume},target=/var/lib/tor`, tor.Image, 'tor', '-f', '/etc/tor/torrc', '--DisableNetwork', '1']);
  containers.push(restoredTor);
  let regenerated = false;
  for (let n = 0; n < 50; n++) {
    const probe = spawnSync('docker', ['exec', restoredTor, 'test', '-f', '/var/lib/tor/personal/hostname'], { stdio: 'ignore' });
    if (probe.status === 0) { regenerated = true; break; }
    await delay(100);
  }
  assert(regenerated, 'restored Tor did not regenerate its hostnames');
  assert(docker(['exec', restoredTor, 'cat', '/var/lib/tor/pool/hostname']) === publicHostname, 'restored pool key derives another hostname');
  assert(docker(['exec', restoredTor, 'cat', '/var/lib/tor/personal/hostname']) === privateHostname, 'restored personal key derives another hostname');
  assert(docker(['exec', restoredTor, 'stat', '-c', '%a:%u:%g', ...permissionPaths]) === originalPermissions, 'restored key ownership or permissions changed');
  assert(JSON.parse(docker(['inspect', restoredTor]))[0].HostConfig.NetworkMode === 'none', 'restored Tor unexpectedly has networking');
  report.onionRecovery = { publicHostnameSha256: hash(publicHostname), publicNameRegenerated: true, personalNameRegenerated: true, permissionsPreserved: true, disableNetwork: true, dockerNetwork: 'none' };
  report.stages.push('both onion names regenerated from restored keys with Tor networking disabled; ownership and permissions match');

  const restored = join(temporary, 'config-restored'); mkdirSync(restored, { mode: 0o700 });
  await decryptTar(configArchive, ['run', '--rm', '-i', '--network', 'none', '--user', '0', '--mount', `type=bind,source=${restored},target=/restore`, '--entrypoint', 'tar', tor.Image, '-C', '/restore', '-xpf', '-']);
  const restoredConfig = JSON.parse(readFileSync(join(restored, 'config.json'), 'utf8'));
  assert(JSON.stringify(restoredConfig) === JSON.stringify(config), 'restored configuration differs');
  assert(readFileSync(join(restored, 'personal-token'), 'utf8').trim() === token, 'restored token differs');
  assert((statSync(join(restored, 'personal-token')).mode & 0o777) === 0o600, 'restored token permissions differ');
  const env = { ...restoredConfig, DERPC_PORT: '18887', DERPC_PERSONAL_PORT: '18888', DERPC_PERSONAL_TOKEN_FILE: '/run/secrets/personal_token' };
  docker(['run', '-d', '--name', restoredProxy, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,source=${join(restored, 'personal-token')},target=/run/secrets/personal_token,readonly`, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), proxy.Image]);
  containers.push(restoredProxy);
  let identity;
  for (let n = 0; n < 40; n++) {
    try { const response = await fetch('http://127.0.0.1:18887/.well-known/derpc.json'); if (response.ok) { identity = await response.json(); break; } } catch {}
    await delay(200);
  }
  assert(JSON.stringify(identity) === JSON.stringify(originalIdentity), 'restored proxy identity differs');
  const missing = await request(18888), wrong = await request(18888, '0'.repeat(64)), authenticated = await request(18888, token);
  assert(missing.status === 401 && wrong.status === 401, 'restored personal listener accepted a missing or incorrect token');
  assert(authenticated.status === 200 && authenticated.body.result === '0x1', 'restored personal token did not authorize mainnet chain identification');
  assert(docker(['exec', sourceTor, 'cat', '/var/lib/tor/pool/hostname']) === publicHostname, 'original source identity changed');
  report.proxyRecovery = { publicIdentitySha256: hash(JSON.stringify(identity)), identityMatches: true, configurationMatches: true, tokenMatches: true, tokenMode: '0600', missingTokenStatus: missing.status, wrongTokenStatus: wrong.status, authenticatedChain: authenticated.body.result };
  report.stages.push('restored proxy started with recovered configuration; missing/wrong token refused and recovered token accepted');
  if (retained) {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    for (const [kind, source] of [['onion-keys', onionArchive], ['personal-config', configArchive]]) {
      const destination = join(retained.destination, `${kind}-${stamp}-${process.pid}.tar.age`);
      retainedFiles.push(destination);
      await reencrypt(source, destination, retained.recipient);
    }
    report.retainedBackup = {
      recipientType: 'ssh-ed25519', recipientFingerprint: retained.fingerprint,
      artifacts: retainedFiles.map(path => ({ path, bytes: statSync(path).size, sha256: hash(readFileSync(path)), mode: '0600' })),
      directoryMode: '0700', ownerPrivateKeyRead: false, ownerRecipientDecryptionTested: false,
    };
    retainedComplete = true;
    report.stages.push('separate archives retained outside the repository under the owner SSH public recipient; no owner private key was accessed');
  }
  report.ok = true;
} catch (error) {
  report.error = sanitize(error instanceof Error ? error.message : error); process.exitCode = 1;
} finally {
  if (originalStopped) {
    try { docker(['start', sourceTor]); originalStopped = false; } catch (error) { report.restartError = sanitize(error); process.exitCode = 1; }
  }
  const cleanupErrors = [];
  for (const name of containers.reverse()) {
    const result = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) cleanupErrors.push(`container ${name}`);
  }
  if (volumeCreated && spawnSync('docker', ['volume', 'rm', restoredVolume], { encoding: 'utf8', timeout: 30_000 }).status !== 0) cleanupErrors.push('restored onion volume');
  try { rmSync(temporary, { recursive: true, force: true }); } catch { cleanupErrors.push('temporary archive/configuration directory'); }
  if (!retainedComplete) for (const path of retainedFiles) {
    try { rmSync(path, { force: true }); } catch { cleanupErrors.push('incomplete retained archive'); }
  }
  report.cleanup = { completed: cleanupErrors.length === 0, ...(cleanupErrors.length ? { errors: cleanupErrors } : {}) };
  if (cleanupErrors.length) process.exitCode = 1;
  report.limits = [
    retainedComplete ? 'The owner-recipient archives are retained locally, not off-device. Decryption with the owner SSH private key was not attempted; the agent never accessed that key.' : 'The recovery recipient and encrypted archives were temporary test resources, deleted after this drill; this is not a retained operational backup.',
    'The isolated restore used a disposable age recipient. Its temporary private identity, ciphertext archives and restored plaintext files were deleted afterward.',
    'Restored Tor ran with DisableNetwork=1 and Docker network none; no descriptor publication or remote onion reachability was tested.',
    'The recovered proxy used loopback for identity/token checks and its configured public execution upstream for eth_chainId; no new anonymous browser proof was established.',
    'Payment settlement keys, payment journals and funded delegation ledgers are outside this backup/restore drill.',
  ];
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
