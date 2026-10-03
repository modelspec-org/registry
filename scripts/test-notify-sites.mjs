// Tests for the site notification (CC0-1.0): scripts/notify-sites.mjs, its list of sites and
// .github/workflows/notify-sites.yml. Offline: a fake `gh` on PATH records its arguments, nothing is sent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { INDEX_NAMES, ghArguments, indexChecksum, notifyAll, reasonText, redact, summary, validateIndexName, validateSites } from './notify-sites.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = 'modelspec-org/registry';
const SITES = ['specscore/modelspec', 'sneat-co/meaninggraph', 'openvaultdb/ovdb-directory'];
const INDEX = 'modelspec-registry';
const SUM = `sha256:${'a'.repeat(64)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'ghp_TESTTOKEN0123456789abcdef';

const scratch = mkdtempSync(join(tmpdir(), 'notify-sites-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- the list of sites ----

test('the list of sites is the one file, valid, and does not contain this repository', () => {
  const data = JSON.parse(readFileSync(join(root, 'scripts/notify-sites.json'), 'utf8'));
  assert.deepEqual(Object.keys(data), ['index', 'sites']);
  assert.deepEqual(validateSites(data, REPOSITORY), SITES);
  assert.equal(validateIndexName(data), INDEX);
});

test('validateSites refuses an empty list, a malformed name, a duplicate and the repository itself', () => {
  for (const bad of [undefined, {}, { sites: [] }, { sites: 'a/b' }, { sites: ['nobody'] }, { sites: ['a/b/c'] }, { sites: ['a b/c'] }, { sites: [7] }, { sites: ['https://github.com/a/b'] }]) {
    assert.throws(() => validateSites(bad, REPOSITORY), /sites must be|is not an owner\/name/, JSON.stringify(bad));
  }
  assert.throws(() => validateSites({ sites: ['a/b', 'A/B'] }), /listed twice/);
  assert.throws(() => validateSites({ sites: ['a/b', REPOSITORY.toUpperCase()] }, REPOSITORY), /cannot notify itself/);
});

test('the index name is one the sites know, and the checksum is read from index.json and must have the right shape', () => {
  assert.deepEqual(INDEX_NAMES, ['ovdb-directory', 'modelspec-registry', 'meaninggraph-registry']);
  for (const bad of [undefined, {}, { index: 'directory' }, { index: 'OVDB-DIRECTORY' }, { index: '__proto__' }]) assert.throws(() => validateIndexName(bad), /index must be one of/);
  assert.equal(indexChecksum(JSON.stringify({ format: 'x', checksum: SUM, databases: [] })), SUM);
  for (const bad of ['{}', JSON.stringify({ checksum: 'sha256:abc' }), JSON.stringify({ checksum: SUM.toUpperCase() }), JSON.stringify({ checksum: `${SUM}\n` }), JSON.stringify({ checksum: 7 }), 'null']) {
    assert.throws(() => indexChecksum(bad), /carries no checksum of the form sha256/, bad);
  }
  assert.throws(() => indexChecksum('{broken'), /index\.json is not valid JSON/);
  // the checksum of the real index.json of this repository is well formed
  assert.match(indexChecksum(readFileSync(join(root, 'index.json'), 'utf8')), /^sha256:[0-9a-f]{64}$/);
});

// ---- the pure parts ----

test('the reason names this repository and the commit, as plain one-line text', () => {
  assert.equal(reasonText({ repository: REPOSITORY, sha: SHA }), `index.json changed in ${REPOSITORY} at 0123456789ab`);
  assert.equal(reasonText({ repository: REPOSITORY, sha: SHA, event: 'workflow_dispatch' }), `re-sent by hand for ${REPOSITORY} at 0123456789ab`);
  assert.ok(!/[\n`$"'\;|&<>(){}]/.test(reasonText({ repository: 'a/b`$(x);\n::error::', sha: '"; rm' })));
});

test('the arguments start deploy.yml on main of the site, with the reason, the index and its checksum as inputs', () => {
  assert.deepEqual(ghArguments('sneat-co/meaninggraph', 'why', INDEX, SUM), ['workflow', 'run', 'deploy.yml', '--repo', 'sneat-co/meaninggraph', '--ref', 'main', '-f', 'reason=why', '-f', `index=${INDEX}`, '-f', `checksum=${SUM}`]);
});

test('redact removes the token and anything shaped like one', () => {
  assert.equal(redact(`bad credentials ${TOKEN} for x`, TOKEN), 'bad credentials *** for x');
  assert.equal(redact('github_pat_11ABCDEFG0123456789_abc and gho_abcdefgh1234', ''), '*** and ***');
  assert.equal(redact(undefined), '');
});

test('every site is attempted when one fails, one throws, and the failures are counted and redacted', () => {
  const three = ['first/site', 'second/site', 'third/site'];
  const seen = [];
  const start = (site, args) => {
    seen.push([site, args]);
    if (site === three[0]) return { status: 1, stderr: `\nHTTP 403: Resource not accessible (${TOKEN})\nmore`, stdout: '' };
    if (site === three[1]) throw new Error(`spawn failed ${TOKEN}`);
    return { status: 0, stdout: '', stderr: '' };
  };
  const outcome = notifyAll({ sites: three, index: INDEX, checksum: SUM, repository: REPOSITORY, sha: SHA, event: 'push', token: TOKEN, start });
  assert.deepEqual(seen.map(([site]) => site), three, 'all were attempted, in order');
  assert.equal(outcome.failed, 2);
  assert.deepEqual(outcome.results.map(result => result.ok), [false, false, true]);
  assert.equal(outcome.results[0].detail, 'HTTP 403: Resource not accessible (***)');
  assert.equal(outcome.results[1].detail, 'spawn failed ***');
  const text = summary(outcome);
  assert.ok(!text.includes(TOKEN));
  assert.match(text, /- first\/site: FAILED \(HTTP 403/);
  assert.match(text, /- third\/site: started/);
  assert.match(text, /2 of 3 could not be started\./);
  assert.ok(text.includes(`${INDEX} ${SUM}`), 'the summary names the index and the checksum');
  assert.ok(seen.every(([, args]) => args.includes(`index=${INDEX}`) && args.includes(`checksum=${SUM}`)));
  assert.match(summary(notifyAll({ sites: three, index: INDEX, checksum: SUM, repository: REPOSITORY, sha: SHA, start: () => ({ status: 0 }) })), /All 3 started\./);
});

// ---- the program, with a fake gh ----

function fakeGh(failFor = '') {
  const bin = join(scratch, `bin-${Math.random().toString(36).slice(2)}`);
  const log = join(bin, 'calls.txt');
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf 'token=%s\\n' "$GH_TOKEN" >> '${log}'\ncase "$*" in *"${failFor}"*) [ -n "${failFor}" ] && { echo "HTTP 404: Not Found (${TOKEN})" >&2; exit 1; };; esac\nexit 0\n`;
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, log };
}
// stderr is only seen when the program fails (execFileSync drops it otherwise); the program writes nothing to it on success.
function run(env, bin) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/notify-sites.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch, ...env } });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('the program starts every site and exits 0 when all start', () => {
  const { bin, log } = fakeGh();
  const result = run({ GH_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA, GITHUB_EVENT_NAME: 'push' }, bin);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('workflow run'));
  const realChecksum = indexChecksum(readFileSync(join(root, 'index.json'), 'utf8'));
  assert.deepEqual(calls, SITES.map(site => `workflow run deploy.yml --repo ${site} --ref main -f reason=index.json changed in ${REPOSITORY} at 0123456789ab -f index=${INDEX} -f checksum=${realChecksum}`));
  assert.match(result.stdout, new RegExp(`All ${SITES.length} started\\.`));
  assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
});

test('the program attempts all sites, reports each, and exits 1 when one cannot be started', () => {
  const { bin, log } = fakeGh(SITES[0]);
  const summaryFile = join(scratch, 'summary.md');
  const result = run({ GH_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA, GITHUB_STEP_SUMMARY: summaryFile }, bin);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('workflow run')).length, SITES.length, 'every site was attempted');
  assert.ok(result.stdout.includes(`- ${SITES[0]}: FAILED (HTTP 404: Not Found (***))`));
  assert.ok(result.stdout.includes(`::error::${SITES[0]}: HTTP 404`));
  assert.match(readFileSync(summaryFile, 'utf8'), new RegExp(`1 of ${SITES.length} could not be started\\.`));
  assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN) && !readFileSync(summaryFile, 'utf8').includes(TOKEN));
});

test('the program refuses to run without a token', () => {
  const { bin } = fakeGh();
  const result = run({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA }, bin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GH_TOKEN is not set/);
});

// ---- the workflow ----

const workflow = readFileSync(join(root, '.github/workflows/notify-sites.yml'), 'utf8');
const code = workflow.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '').replace(/\n{2,}/g, '\n');

test('the workflow runs on a push of index.json to main and by hand, never for a pull request, only in this repository on main', () => {
  assert.match(code, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths: \[index\.json\]\n {2}workflow_dispatch:\npermissions:/m);
  assert.ok(!/pull_request|schedule/.test(code));
  assert.ok(code.includes(`if: github.repository == '${REPOSITORY}' && github.ref == 'refs/heads/main'`));
  assert.match(code, /^permissions:\n {2}contents: read$/m);
  assert.equal([...code.matchAll(/^\s*permissions:/gm)].length, 1);
});

test('the token is compared once, handed to one step and never echoed; without it the job says so and succeeds', () => {
  assert.equal([...code.matchAll(/secrets\./g)].length, 2);
  assert.ok(code.includes("HAS_TOKEN: ${{ secrets.SITES_DEPLOY_TRIGGER_TOKEN != '' }}"));
  const steps = code.split('\n      - ');
  const holders = steps.filter(text => text.includes('GH_TOKEN: ${{ secrets.SITES_DEPLOY_TRIGGER_TOKEN }}'));
  assert.equal(holders.length, 1);
  assert.match(holders[0], /run: node scripts\/notify-sites\.mjs$/m);
  assert.match(holders[0], /if: env\.HAS_TOKEN == 'true'/);
  const skipped = steps.find(text => text.startsWith('name: Skipped, no token'));
  assert.match(skipped, /if: env\.HAS_TOKEN != 'true'/);
  assert.match(skipped, /::notice::/);
  assert.match(skipped, /GITHUB_STEP_SUMMARY/);
  assert.ok(!/exit 1/.test(skipped), 'a missing secret never fails the job');
  assert.ok(!/echo[^\n]*\$\{?(GH_TOKEN|SITES_DEPLOY_TRIGGER_TOKEN)/.test(code));
  for (const text of steps) {
    const at = text.indexOf('run:');
    if (at !== -1) assert.ok(!text.slice(at).includes('${{'), 'no expression inside a run:');
  }
});

test('every action is pinned by full commit SHA', () => {
  const uses = [...code.matchAll(/^\s*(?:- )?uses: (\S+)$/gm)].map(match => match[1]);
  assert.ok(uses.length >= 2);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use);
  assert.match(code, /persist-credentials: false/);
});

test('the job checks out the whole repository, so index.json is there to be read', () => {
  assert.ok(!/sparse-checkout/.test(code));
  assert.match(code, /- uses: actions\/checkout@[0-9a-f]{40}\n {8}if: env\.HAS_TOKEN == 'true'\n {8}with:\n {10}persist-credentials: false/);
});
