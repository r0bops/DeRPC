// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSitePackage } from '../../scripts/check-site-package.mjs';
import { contenthashFromCid } from '../../scripts/package-ipfs.mjs';

const cid = 'bafybeidksnvtvc7n4ciiflw7o2gc563lqaxtulmqix2cxvddvhc4sv24me';
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const roots: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'derpc-release-package-test-'));
  roots.push(directory);
  const car = Buffer.from('CAR bytes; full DAG validation runs on the VPS');
  const manifest = {
    schemaVersion: 1, kind: 'derpc-ipfs-package', cid, contentUri: `ipfs://${cid}`,
    contenthash: contenthashFromCid(cid), source: { gitHead: sourceSha, uncommittedChanges: false },
    car: { file: 'site.car', bytes: car.length, sha256: createHash('sha256').update(car).digest('hex') },
  };
  writeFileSync(join(directory, 'site.car'), car);
  const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { directory, manifest, save, check: () => checkSitePackage({ directory, cid, sourceSha }) };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Actions artifact binding', () => {
  it('accepts bytes bound to the expected root and clean source commit', () => {
    const f = fixture();
    expect(f.check()).toEqual({ cid, sourceSha, carSha256: f.manifest.car.sha256, bytes: f.manifest.car.bytes });
  });
  it('refuses a different commit or a dirty source tree', () => {
    const f = fixture();
    f.manifest.source.gitHead = 'f'.repeat(40); f.save();
    expect(f.check).toThrow(/source/);
    f.manifest.source.gitHead = sourceSha; f.manifest.source.uncommittedChanges = true; f.save();
    expect(f.check).toThrow(/source/);
  });
  it('refuses a changed CID, namespace or encoded contenthash', () => {
    const f = fixture();
    f.manifest.contentUri = `ipns://${cid}`; f.save();
    expect(f.check).toThrow(/identity/);
    f.manifest.contentUri = `ipfs://${cid}`; f.manifest.contenthash = '0x'; f.save();
    expect(f.check).toThrow(/identity/);
  });
  it('refuses mutated CAR bytes and size', () => {
    const f = fixture();
    writeFileSync(join(f.directory, 'site.car'), Buffer.alloc(f.manifest.car.bytes, 1));
    expect(f.check).toThrow(/checksum/);
    writeFileSync(join(f.directory, 'site.car'), 'short');
    expect(f.check).toThrow(/size/);
  });
  it('refuses filenames outside the fixed artifact and symlinks', () => {
    const f = fixture();
    f.manifest.car.file = '../site.car'; f.save();
    expect(f.check).toThrow(/filename/);
    rmSync(join(f.directory, 'site.car'));
    symlinkSync(join(f.directory, 'manifest.json'), join(f.directory, 'site.car'));
    expect(f.check).toThrow(/regular/);
  });
  it('rejects missing, empty and oversized packages before reading their contents', () => {
    const f = fixture();
    writeFileSync(join(f.directory, 'site.car'), '');
    expect(f.check).toThrow(/bounded/);
    writeFileSync(join(f.directory, 'manifest.json'), ' '.repeat(1024 * 1024 + 1));
    expect(f.check).toThrow(/bounded/);
  });
  it('refuses noncanonical command inputs', () => {
    const f = fixture();
    for (const invalid of [cid + '\n', '--help', cid + ';true']) {
      expect(() => checkSitePackage({ directory: f.directory, cid: invalid, sourceSha })).toThrow(/Invalid/);
    }
    expect(() => checkSitePackage({ directory: f.directory, cid, sourceSha: sourceSha + '\n' })).toThrow(/Invalid/);
  });
});
