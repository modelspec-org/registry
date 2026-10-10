// What scripts/lint-hcl.mjs does, as a function whose binary, output and
// repository URLs are arguments, so scripts/test.mjs runs it offline against a
// stand-in for specscore. CC0-1.0 like everything else here.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, openCommit, trackedCacheProblems } from './git.mjs';
import { readRegistry, recordProblems, sourceNotices, wellFormed } from './registry.mjs';
import { lintArguments } from './specscore.mjs';

// Lints the source of every well-formed record with `specscore graph lint`. `binary()`
// resolves to { path, dispose } and is called only when the registry's own records are
// sound. Notices and errors go to `error` (standard error), the `ok:` line of each source
// to `log` (standard output). Returns the exit status: 1 when a record is not sound or a
// source fails the lint, never because of a notice.
export async function lintRegistry({ root, cacheDir, binary, urlFor = (url) => url, log, error }) {
  const registry = readRegistry(root);
  const problems = [...trackedCacheProblems(root), ...registry.problems, ...recordProblems(registry)];
  if (problems.length > 0) {
    for (const problem of problems) error(`error: ${problem}`);
    return 1;
  }
  const { path: specscore, dispose } = await binary();
  const run = (cwd, ...args) => execFileSync(specscore, [...args, '--no-telemetry'], { cwd, stdio: 'pipe' }).toString();
  let failed = 0;
  try {
    for (const record of registry.models.filter(wellFormed)) {
      const { file, data } = record;
      const work = mkdtempSync(join(tmpdir(), 'modelspec-lint-'));
      try {
        const view = openCommit(urlFor(data.repository), data.commit, join(cacheDir, 'models'));
        const source = join(work, 'source.hcl');
        const text = view.read(data.source_file);
        writeFileSync(source, text);
        for (const notice of sourceNotices(file, data.source_file, text)) error(`notice: ${notice}`);
        const tree = join(work, 'tree');
        mkdirSync(tree);
        git(['-C', tree, 'init', '-q', '--template=']);
        run(tree, 'init', '--host', 'github.com', '--org', 'example', '--repo', 'example', '--title', 'example');
        run(tree, 'graph', 'new', 'module', '--id', data.module, '--name', record.key, '--summary', 'ModelSpec registry check', '--bare');
        const models = join(tree, 'spec', 'graph', 'modules', data.module, 'models');
        mkdirSync(models, { recursive: true });
        copyFileSync(source, join(models, 'model.hcl'));
        run(tree, ...lintArguments);
        log(`ok: ${file}: ${data.source_file} passes specscore graph lint (specscore ${run(tree, '--version').trim()})`);
      } catch (cause) {
        failed++;
        error(`error: ${file}: ${data.source_file}: ${String(cause.stdout ?? '').trim() || String(cause.stderr ?? cause.message).trim()}`);
      } finally { rmSync(work, { recursive: true, force: true }); }
    }
  } finally { dispose(); }
  return failed > 0 ? 1 : 0;
}
