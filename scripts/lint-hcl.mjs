// Runs SpecScore's HCL parser and ModelSpec linter over every registered model
// source (CC0-1.0).
//
//   node scripts/lint-hcl.mjs        (needs network; SPECSCORE=<binary> skips the download)
//
// `specscore graph lint` is the only real ModelSpec HCL parser there is today
// (https://github.com/specscore/specscore-cli). It reads ModelSpec sources from
// a graph module's models/ directory, so each source is copied into a throwaway
// tree with a module named like the record's `module`. It checks HCL syntax with
// the real parser, reference resolution, reserved names, duplicate concepts and
// enum values: what scripts/check.mjs cannot check with its own subset parser.
// The release is pinned by version and SHA-256, the same one datatug/chinookdb
// lints with; its archive is verified against the pin before every run and the
// binary is unpacked fresh from it (scripts/lib/specscore.mjs). Caches live in
// the per-user cache directory, never in the checkout.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCacheDir, git, openCommit, trackedCacheProblems } from './lib/git.mjs';
import { readRegistry, recordProblems, wellFormed } from './lib/registry.mjs';
import { specscoreBinary } from './lib/specscore.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const registry = readRegistry(root);
const problems = [...trackedCacheProblems(root), ...registry.problems, ...recordProblems(registry)];
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}
const cacheDir = defaultCacheDir();
const { path: specscore, dispose } = await specscoreBinary({ cacheDir });
process.on('exit', dispose);
const run = (cwd, ...args) => execFileSync(specscore, [...args, '--no-telemetry'], { cwd, stdio: 'pipe' }).toString();
let failed = 0;
for (const record of registry.models.filter(wellFormed)) {
  const { file, data } = record;
  const work = mkdtempSync(join(tmpdir(), 'modelspec-lint-'));
  try {
    const view = openCommit(data.repository, data.commit, join(cacheDir, 'models'));
    const source = join(work, 'source.hcl');
    writeFileSync(source, view.read(data.source_file));
    const tree = join(work, 'tree');
    mkdirSync(tree);
    git(['-C', tree, 'init', '-q', '--template=']);
    run(tree, 'init', '--host', 'github.com', '--org', 'example', '--repo', 'example', '--title', 'example');
    run(tree, 'graph', 'new', 'module', '--id', data.module, '--name', record.key, '--summary', 'ModelSpec registry check', '--bare');
    const models = join(tree, 'spec', 'graph', 'modules', data.module, 'models');
    mkdirSync(models, { recursive: true });
    copyFileSync(source, join(models, 'model.hcl'));
    run(tree, 'graph', 'lint', '--severity', 'info');
    console.log(`ok: ${file}: ${data.source_file} passes specscore graph lint (specscore ${run(tree, '--version').trim()})`);
  } catch (error) {
    failed++;
    console.error(`error: ${file}: ${data.source_file}: ${String(error.stdout ?? '').trim() || String(error.stderr ?? error.message).trim()}`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
if (failed > 0) process.exit(1);
