import solc from 'solc';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
export function compile(extra = {}) {
  const sources = Object.fromEntries(readdirSync(join(root, 'src')).filter(f => f.endsWith('.sol')).map(f => [f, { content: readFileSync(join(root, 'src', f), 'utf8') }]));
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { ...sources, ...extra }, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'storageLayout'] } },
  } })));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return output.contracts;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const contracts = compile();
  mkdirSync(join(root, 'out'), { recursive: true });
  for (const file of Object.values(contracts)) for (const [name, artifact] of Object.entries(file)) {
    writeFileSync(join(root, 'out', `${name}.json`), JSON.stringify({ compiler: solc.version(), ...artifact }, null, 2));
    console.log(`${name}: ${artifact.evm.bytecode.object.length / 2} deployment bytes`);
  }
}
