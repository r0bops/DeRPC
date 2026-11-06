// Bind a downloaded Actions artifact to the exact commit and root that passed the build job.
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contenthashFromCid } from './package-ipfs.mjs';

export function checkSitePackage({ directory, cid, sourceSha }) {
  if (cid?.length !== 59 || sourceSha?.length !== 40 || !/^bafybei[a-z2-7]{52}$/.test(cid) || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('Invalid expected release CID or source commit');
  }
  const manifestPath = join(directory, 'manifest.json');
  const carPath = join(directory, 'site.car');
  const manifestStat = lstatSync(manifestPath);
  const carStat = lstatSync(carPath);
  if (!manifestStat.isFile() || manifestStat.size > 1024 * 1024 || !carStat.isFile() || carStat.size < 1 || carStat.size > 64 * 1024 * 1024) {
    throw new Error('Package must contain bounded regular manifest and CAR files');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'derpc-ipfs-package' ||
      manifest.cid !== cid || manifest.contentUri !== `ipfs://${cid}` || manifest.contenthash !== contenthashFromCid(cid)) {
    throw new Error('Package identity differs from the tested build');
  }
  if (manifest.source?.gitHead !== sourceSha || manifest.source?.uncommittedChanges !== false) {
    throw new Error('Package source is not this exact clean commit');
  }
  if (manifest.car?.file !== 'site.car' || manifest.car?.bytes !== carStat.size || !/^[0-9a-f]{64}$/.test(manifest.car?.sha256 ?? '')) {
    throw new Error('Invalid CAR filename, size or hash');
  }
  const carSha256 = createHash('sha256').update(readFileSync(carPath)).digest('hex');
  if (carSha256 !== manifest.car.sha256) throw new Error('CAR checksum differs from the manifest');
  return { cid, sourceSha, carSha256, bytes: carStat.size };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: check-site-package.mjs DIRECTORY CID SOURCE_SHA');
    const [directory, cid, sourceSha] = process.argv.slice(2);
    const result = checkSitePackage({ directory, cid, sourceSha });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `car_sha256=${result.carSha256}\n`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Package refused: ${error.message}`);
    process.exitCode = 1;
  }
}
