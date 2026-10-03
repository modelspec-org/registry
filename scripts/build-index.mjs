// Writes index.json from the records and the model files they pin (CC0-1.0).
// CI fails when the committed index.json differs from what this writes. A
// model that fails its checks is never written to the index: the problems are
// printed and nothing is written.
//
//   node scripts/build-index.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadModels } from './lib/registry.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { problems, entries } = loadModels({ root });
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error('index.json not written: fix the problems above (npm run check lists them)');
  process.exit(1);
}
writeFileSync(join(root, 'index.json'), buildIndex(entries));
console.log(`wrote index.json (${entries.length} model${entries.length === 1 ? '' : 's'})`);
