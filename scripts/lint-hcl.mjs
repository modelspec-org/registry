// Runs SpecScore's HCL parser and ModelSpec linter over every registered model
// source (CC0-1.0).
//
//   node scripts/lint-hcl.mjs [registry directory]   (default: this repository; needs
//   network; SPECSCORE=<binary> skips the download)
//
// `specscore graph lint` (https://github.com/specscore/specscore-cli) is one HCL
// parser for ModelSpec; the reference CLI (`modelspec`) is another. SpecScore reads
// ModelSpec sources from a graph module's models/ directory, so each source is
// copied into a throwaway tree with a module named like the record's `module`. It
// reads both spellings of ModelSpec, as the specification asks of every reader,
// and checks HCL syntax with its parser, that the name in a record, component, use
// or enum reference resolves to a concept of the module (of any kind: `record =
// "Money"` passes when Money is a component), reserved names, duplicate record
// types and enum values, and refuses removed and reserved constructs. The pinned
// release also passes what scripts/check.mjs refuses: a duplicate field name, a key
// that names no field, an unsupported field type, a setting it does not know on a
// record type or a field, a member with both a type and a reference or with
// neither, an empty key, an unknown block, a top-level setting, a dot in a concept
// name and a negative max_len. This script needs SpecScore 0.55.0 or later because of the
// --ignore in lintArguments: SPECSCORE=<an older binary> fails every model with
// `Unknown graph rule "graph-model-deprecated-spelling"`.
// The release is pinned by version and SHA-256; its archive is verified against
// the pin before every run and the binary is unpacked fresh from it
// (scripts/lib/specscore.mjs). Caches live in the per-user cache directory, never
// in the checkout. A source in the earlier
// spelling (entity, property; ModelSpec decision 0018) is valid and is linted as
// it is; the script reports it as a notice, which does not change the exit status.
// SpecScore's own advisory finding for it is ignored (lintArguments), so a source
// gets the registry's notice once.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { defaultCacheDir } from './lib/git.mjs';
import { lintRegistry } from './lib/lint.mjs';
import { specscoreBinary } from './lib/specscore.mjs';

const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = defaultCacheDir();
process.exitCode = await lintRegistry({ root, cacheDir, binary: () => specscoreBinary({ cacheDir }), log: console.log, error: console.error });
