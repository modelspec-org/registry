// Checks the registry, CC0-1.0 like everything else here.
//
//   node scripts/check.mjs [registry directory]   (default: this repository)
//
// Run after `ingitdb validate` (structure, types, required columns, enums,
// foreign keys). This adds what needs the model's repository: each model is
// fetched at its commit (which must be in the history of the repository's
// default branch, not a commit only a fork has); its two files are tracked
// regular files at that commit; the JSON AST passes the structural checks of
// the ModelSpec specification and is what the HCL source says; the module the
// files declare is the record's, and the address is the repository plus the
// module; the licence is the one the record states. Finally index.json must be
// what `npm run index` writes. A model file in the earlier spelling (entity,
// property; 1.0-draft) is valid and still read: it is reported as a notice, one
// per registry record, that does not change the exit status.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './lib/registry.mjs';

const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
process.exitCode = runCheck({ root, log: console.log, error: console.error });
