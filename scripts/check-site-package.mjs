// Bind a downloaded Actions artifact to the exact commit and root that passed the build job.
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contenthashFromCid } from './package-ipfs.mjs';
import { WEBSITE_NAME } from './verify-site-release.mjs';

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

// This acknowledges only the VPS's durable acceptance. Independent public verification
// remains mandatory even if the publish CLI returned success, and especially after a timeout.
export function checkPublicationState({ response, cid, carSha256, sourceSha, runNumber, runId }) {
  const publication = response?.publication;
  const accepted = publication?.accepted;
  if (response?.ok !== true || response.keyIdentityMatches !== true || response.ipnsName !== WEBSITE_NAME ||
      publication?.ipnsName !== WEBSITE_NAME || !['pending', 'publish-uncertain', 'published'].includes(publication.status)) {
    throw new Error('VPS did not acknowledge the fixed website publishing identity');
  }
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || !Number.isSafeInteger(runId) || runId < 1 ||
      accepted?.runNumber !== runNumber || accepted.runId !== runId || accepted.cid !== cid ||
      accepted.carSha256 !== carSha256 || accepted.sourceSha !== sourceSha) {
    throw new Error('VPS accepted a different release; do not treat this publication as successful');
  }
  return { accepted: true, status: publication.status, publicVerificationStillRequired: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === '--publication') {
      if (process.argv.length !== 9) throw new Error('Usage: --publication STATE_JSON CID CAR_SHA256 SOURCE_SHA RUN_NUMBER RUN_ID');
      const [path, cid, carSha256, sourceSha, number, id] = process.argv.slice(3);
      if (lstatSync(path).size > 65536) throw new Error('Publication response is oversized');
      console.log(JSON.stringify(checkPublicationState({ response: JSON.parse(readFileSync(path, 'utf8')), cid, carSha256, sourceSha, runNumber: Number(number), runId: Number(id) })));
    } else {
      if (process.argv.length !== 5) throw new Error('Usage: check-site-package.mjs DIRECTORY CID SOURCE_SHA');
      const [directory, cid, sourceSha] = process.argv.slice(2);
      const result = checkSitePackage({ directory, cid, sourceSha });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `car_sha256=${result.carSha256}\n`);
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(`Package refused: ${error.message}`);
    process.exitCode = 1;
  }
}
