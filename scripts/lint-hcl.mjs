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
// lints with.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, openCommit } from './lib/git.mjs';
import { readRegistry, recordProblems, wellFormed } from './lib/registry.mjs';

const version = '0.54.2';
const builds = {
  'linux/x64': { asset: 'linux_amd64', sha: 'e13ddf1543768bbe1f4573bc99202f6e5729b3d2b140c37bad972bdfdf8af12a' },
  'darwin/arm64': { asset: 'darwin_arm64', sha: 'ddc0861c589961b8392607473cd767f07746dad733bdd0af713aa13c69f133f8' },
};
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, '.cache');

async function specscoreBinary() {
  if (process.env.SPECSCORE) return process.env.SPECSCORE;
  const build = builds[`${process.platform}/${process.arch}`];
  if (!build) throw new Error(`no pinned specscore build for ${process.platform}/${process.arch}; set SPECSCORE to an installed binary`);
  const dir = join(cacheDir, `specscore-${version}-${build.asset}`);
  const binary = join(dir, 'specscore');
  if (existsSync(binary)) return binary;
  const archive = `specscore_${version}_${build.asset}.tar.gz`;
  const response = await fetch(`https://github.com/specscore/specscore-cli/releases/download/v${version}/${archive}`);
  if (!response.ok) throw new Error(`cannot download ${archive}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== build.sha) throw new Error(`${archive} SHA-256 is ${actual}, expected ${build.sha}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, archive), bytes);
  execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir, 'specscore']);
  return binary;
}

const registry = readRegistry(root);
const problems = [...registry.problems, ...recordProblems(registry)];
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}
const specscore = await specscoreBinary();
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
