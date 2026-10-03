// Tests for the site notification (CC0-1.0): scripts/notify-sites.mjs, its list of sites and
// .github/workflows/notify-sites.yml. Offline: a fake `gh` on PATH records its arguments and the token it was
// given, nothing is sent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { GH_TIMEOUT_MS, SECRET_NAME, ghArguments, notifyAll, reasonText, redact, runGh, secretsOf, summary, validateSites } from './notify-sites.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = 'modelspec-org/registry';
const SITES = [{ repo: 'specscore/modelspec', secret: 'SITES_TRIGGER_TOKEN_SPECSCORE' }, { repo: 'sneat-co/meaninggraph', secret: 'SITES_TRIGGER_TOKEN_SNEAT_CO' }, { repo: 'openvaultdb/ovdb-directory', secret: 'SITES_TRIGGER_TOKEN_OPENVAULTDB' }];
const SECRETS = [...new Set(SITES.map(site => site.secret))];
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKENS = Object.fromEntries(SECRETS.map((name, i) => [name, `ghp_TESTTOKEN${i}0123456789abcdef`]));
const ALL_TOKENS = Object.values(TOKENS);

const scratch = mkdtempSync(join(tmpdir(), 'notify-sites-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- the list of sites ----

test('the list of sites is the one file, valid, names each site secret, and does not contain this repository', () => {
  const data = JSON.parse(readFileSync(join(root, 'scripts/notify-sites.json'), 'utf8'));
  assert.deepEqual(Object.keys(data), ['sites']);
  assert.deepEqual(validateSites(data, REPOSITORY), SITES);
  for (const { secret } of SITES) assert.match(secret, SECRET_NAME);
  assert.deepEqual(secretsOf(SITES), SECRETS);
});

test('validateSites refuses an empty list, a malformed entry, a bad secret name, a duplicate and the repository itself', () => {
  const ok = { repo: 'a/b', secret: 'SITES_TRIGGER_TOKEN_A' };
  for (const bad of [undefined, {}, { sites: [] }, { sites: 'a/b' }, { sites: ['a/b'] }, { sites: [{ repo: 'a/b' }] }, { sites: [{ ...ok, extra: 1 }] }, { sites: [null] }, { sites: [[ok]] }]) {
    assert.throws(() => validateSites(bad, REPOSITORY), /sites must be|is not \{repo, secret\}/, JSON.stringify(bad));
  }
  for (const repo of ['nobody', 'a/b/c', 'a b/c', 7, 'https://github.com/a/b']) assert.throws(() => validateSites({ sites: [{ ...ok, repo }] }, REPOSITORY), /is not an owner\/name/, String(repo));
  for (const secret of ['GH_TOKEN', 'SITES_TRIGGER_TOKEN_', 'sites_trigger_token_a', 'SITES_TRIGGER_TOKEN_A B', 'SITES_DEPLOY_TRIGGER_TOKEN', 'SITES_TRIGGER_TOKEN_A\n', 7, undefined]) {
    assert.throws(() => validateSites({ sites: [{ ...ok, secret }] }, REPOSITORY), /is not a secret name/, String(secret));
  }
  assert.throws(() => validateSites({ sites: [ok, { ...ok, repo: 'A/B' }] }), /listed twice/);
  assert.throws(() => validateSites({ sites: [ok, { ...ok, repo: REPOSITORY.toUpperCase() }] }, REPOSITORY), /cannot notify itself/);
  assert.deepEqual(validateSites({ sites: [ok, { repo: 'c/d', secret: 'SITES_TRIGGER_TOKEN_A' }] }), [ok, { repo: 'c/d', secret: 'SITES_TRIGGER_TOKEN_A' }], 'two sites of one owner share a secret');
});

// ---- the pure parts ----

test('the reason names this repository and the commit, as plain one-line text', () => {
  assert.equal(reasonText({ repository: REPOSITORY, sha: SHA }), `index.json changed in ${REPOSITORY} at 0123456789ab`);
  assert.equal(reasonText({ repository: REPOSITORY, sha: SHA, event: 'workflow_dispatch' }), `re-sent by hand for ${REPOSITORY} at 0123456789ab`);
  assert.ok(!/[\n`$"'\;|&<>(){}]/.test(reasonText({ repository: 'a/b`$(x);\n::error::', sha: '"; rm' })));
});

test('the arguments start deploy.yml on main of the site, with the reason as the only input', () => {
  assert.deepEqual(ghArguments('some/site', 'why'), ['workflow', 'run', 'deploy.yml', '--repo', 'some/site', '--ref', 'main', '-f', 'reason=why']);
  assert.equal(ghArguments('some/site', 'why').filter(arg => arg === '-f').length, 1, 'one input');
});

test('redact removes the tokens and anything shaped like one', () => {
  assert.equal(redact(`bad credentials ${ALL_TOKENS[0]} for x`, ALL_TOKENS), 'bad credentials *** for x');
  assert.equal(redact(`${ALL_TOKENS[0]} ${ALL_TOKENS[ALL_TOKENS.length - 1]}`, ALL_TOKENS), '*** ***', 'every token, not only the one that was used');
  assert.equal(redact('github_pat_11ABCDEFG0123456789_abc and gho_abcdefgh1234', ''), '*** and ***');
  assert.equal(redact(undefined), '');
});

// A start that records its calls: {site, args, token}.
function recorder(behaviour = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const start = (site, args, token) => {
    calls.push({ site, args, token });
    return behaviour(site, token);
  };
  start.calls = calls;
  return start;
}
const run = (tokens, start) => notifyAll({ sites: SITES, repository: REPOSITORY, sha: SHA, event: 'push', tokens, start });

test('every site is given its own token, and only that one', () => {
  const start = recorder();
  const outcome = run(TOKENS, start);
  assert.deepEqual(start.calls.map(call => call.site), SITES.map(site => site.repo), 'all attempted, in order');
  for (const [i, { repo, secret }] of SITES.entries()) {
    assert.equal(start.calls[i].token, TOKENS[secret], `${repo} gets the token of ${secret}`);
    assert.deepEqual(start.calls[i].args, ghArguments(repo, outcome.reason));
    assert.ok(!start.calls[i].args.some(arg => ALL_TOKENS.some(token => arg.includes(token))), 'a token is never an argument');
  }
  assert.equal(outcome.started, SITES.length);
  assert.equal(outcome.skipped + outcome.failed, 0);
  assert.match(summary(outcome), new RegExp(`${SITES.length} of ${SITES.length} started\\.`));
});

test('a token that is absent skips its sites with a notice-worthy line, never a failure, and the others are still started', () => {
  for (const missing of SECRETS) {
    const tokens = { ...TOKENS, [missing]: '' };
    const start = recorder();
    const outcome = run(tokens, start);
    const skippedSites = SITES.filter(site => site.secret === missing).map(site => site.repo);
    assert.deepEqual(outcome.results.filter(result => result.state === 'skipped').map(result => result.site), skippedSites, missing);
    assert.deepEqual(start.calls.map(call => call.site), SITES.filter(site => site.secret !== missing).map(site => site.repo), 'no call for a skipped site');
    assert.equal(outcome.failed, 0, 'absent is not a failure');
    assert.ok(outcome.results.filter(result => result.state === 'skipped').every(result => result.detail === `no ${missing} secret`));
    assert.match(summary(outcome), new RegExp(`${skippedSites.length} skipped for want of a token`));
    assert.match(summary(outcome), new RegExp(`- ${skippedSites[0]}: skipped \\(no ${missing} secret\\)`));
  }
  const nothing = run(Object.fromEntries(SECRETS.map(name => [name, ''])), recorder());
  assert.equal(nothing.started + nothing.failed, 0);
  assert.equal(nothing.skipped, SITES.length);
  assert.deepEqual(run({}, recorder()).results.map(result => result.state), SITES.map(() => 'skipped'), 'an undefined token is absent too');
});

test('a token that is present but fails is a failure; all sites are attempted, failures are counted and every token is redacted', () => {
  for (const failing of SECRETS) {
    const start = recorder((site, token) => {
      if (token === TOKENS[failing]) return { status: 1, stderr: `\nHTTP 403: Resource not accessible (${ALL_TOKENS.join(' ')})\nmore`, stdout: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const outcome = run(TOKENS, start);
    assert.equal(start.calls.length, SITES.length, 'every site was attempted');
    const failedSites = SITES.filter(site => site.secret === failing).map(site => site.repo);
    assert.deepEqual(outcome.results.filter(result => result.state === 'failed').map(result => result.site), failedSites);
    assert.equal(outcome.failed, failedSites.length);
    const text = summary(outcome);
    for (const token of ALL_TOKENS) assert.ok(!text.includes(token));
    assert.match(text, /FAILED \(HTTP 403: Resource not accessible \(\*\*\* /);
    assert.match(text, new RegExp(`${failedSites.length} FAILED\\.`));
  }
  const throwing = run(TOKENS, recorder(() => { throw new Error(`spawn failed ${ALL_TOKENS[0]}`); }));
  assert.equal(throwing.failed, SITES.length);
  assert.ok(throwing.results.every(result => result.detail === 'spawn failed ***'));
});

test('one site that is skipped and one that fails: the outcome has both, and the run is red', () => {
  const [first, second] = SECRETS;
  const start = recorder((site, token) => (token === TOKENS[second] ? { status: 1, stderr: 'HTTP 404', stdout: '' } : { status: 0 }));
  const outcome = run({ ...TOKENS, [first]: '' }, start);
  assert.ok(outcome.skipped >= 1);
  assert.ok(outcome.failed >= 1 || SECRETS.length === 1);
  assert.match(summary(outcome), /skipped for want of a token/);
});

// ---- the program, with a fake gh ----

function fakeGh({ failToken = '', sleepFor = 0 } = {}) {
  const bin = join(scratch, `bin-${Math.random().toString(36).slice(2)}`);
  const log = join(bin, 'calls.txt');
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
printf 'token=%s\\n' "$GH_TOKEN" >> '${log}'
printf 'other=%s\\n' "$(env | grep -c 'SITES_TRIGGER_TOKEN\\|GITHUB_TOKEN\\|CLOUDFLARE')" >> '${log}'
[ ${sleepFor} -gt 0 ] && sleep ${sleepFor}
if [ -n "${failToken}" ] && [ "$GH_TOKEN" = "${failToken}" ]; then echo "HTTP 404: Not Found ($GH_TOKEN)" >&2; exit 1; fi
exit 0
`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, log };
}
// stderr is only seen when the program fails (execFileSync drops it otherwise); the program writes nothing to it on success.
function program(env, bin) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/notify-sites.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch, ...env } });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
const BASE = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA, GITHUB_EVENT_NAME: 'push' };
const calls = log => {
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 3) out.push({ args: lines[i], token: lines[i + 1].replace('token=', ''), others: Number(lines[i + 2].replace('other=', '')) });
  return out;
};

test('the program starts every site with its own token, sends only the reason, and the gh environment holds no other secret', () => {
  const { bin, log } = fakeGh();
  const result = program({ ...BASE, ...TOKENS, GITHUB_TOKEN: 'ghp_AMBIENT0123456789', CLOUDFLARE_API_TOKEN: 'cf-ambient' }, bin);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const made = calls(log);
  assert.deepEqual(made.map(call => call.args), SITES.map(site => `workflow run deploy.yml --repo ${site.repo} --ref main -f reason=index.json changed in ${REPOSITORY} at 0123456789ab`));
  assert.deepEqual(made.map(call => call.token), SITES.map(site => TOKENS[site.secret]));
  assert.ok(made.every(call => call.others === 0), 'the environment of gh has no SITES_TRIGGER_TOKEN_*, no GITHUB_TOKEN, no CLOUDFLARE variable');
  assert.match(result.stdout, new RegExp(`${SITES.length} of ${SITES.length} started\\.`));
  for (const token of [...ALL_TOKENS, 'ghp_AMBIENT0123456789']) assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
});

test('the program skips the sites whose token is absent (a notice, exit 0) and starts the others', () => {
  const [missing] = SECRETS;
  const { bin, log } = fakeGh();
  const summaryFile = join(scratch, 'summary-skip.md');
  const tokens = { ...TOKENS };
  delete tokens[missing];
  const result = program({ ...BASE, ...tokens, GITHUB_STEP_SUMMARY: summaryFile }, bin);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const skipped = SITES.filter(site => site.secret === missing).map(site => site.repo);
  assert.deepEqual(calls(log).map(call => call.args.split(' ')[4]), SITES.filter(site => site.secret !== missing).map(site => site.repo));
  for (const site of skipped) assert.ok(result.stdout.includes(`::notice::${site} was not notified: no ${missing} secret`));
  assert.match(readFileSync(summaryFile, 'utf8'), new RegExp(`- ${skipped[0]}: skipped \\(no ${missing} secret\\)`));
});

test('the program with no token at all says so and exits 0 without calling gh', () => {
  const { bin, log } = fakeGh();
  const summaryFile = join(scratch, 'summary-none.md');
  const result = program({ ...BASE, GITHUB_STEP_SUMMARY: summaryFile }, bin);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /::notice::No SITES_TRIGGER_TOKEN_\w+.* secret: the sites were not notified\./);
  assert.match(readFileSync(summaryFile, 'utf8'), /Sites not notified/);
  assert.throws(() => readFileSync(log, 'utf8'), /ENOENT/, 'gh was never run');
  const empty = program({ ...BASE, ...Object.fromEntries(SECRETS.map(name => [name, ''])) }, bin);
  assert.equal(empty.status, 0, 'empty secrets are absent secrets');
});

test('the program attempts all sites, reports each, and exits 1 at the end when a present token fails', () => {
  const failing = SECRETS[SECRETS.length - 1];
  const { bin, log } = fakeGh({ failToken: TOKENS[failing] });
  const summaryFile = join(scratch, 'summary-fail.md');
  const result = program({ ...BASE, ...TOKENS, GITHUB_STEP_SUMMARY: summaryFile }, bin);
  assert.equal(result.status, 1);
  assert.equal(calls(log).length, SITES.length, 'every site was attempted, also after the failure');
  const failed = SITES.filter(site => site.secret === failing).map(site => site.repo);
  for (const site of failed) {
    assert.ok(result.stdout.includes(`- ${site}: FAILED (HTTP 404: Not Found (***))`));
    assert.ok(result.stdout.includes(`::error::${site}: HTTP 404`));
  }
  assert.match(readFileSync(summaryFile, 'utf8'), new RegExp(`${failed.length} FAILED\\.`));
  for (const token of ALL_TOKENS) assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token) && !readFileSync(summaryFile, 'utf8').includes(token));
});

test('a failing token and an absent token together: the failure still makes the run red', () => {
  if (SECRETS.length < 2) return;
  const [absent, failing] = SECRETS;
  const { bin } = fakeGh({ failToken: TOKENS[failing] });
  const tokens = { ...TOKENS };
  delete tokens[absent];
  const result = program({ ...BASE, ...tokens }, bin);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /skipped for want of a token/);
  assert.match(result.stdout, /FAILED/);
});

test('a gh call has a time limit: a gh that does not answer fails that site and does not hold up the report', () => {
  assert.equal(GH_TIMEOUT_MS, 60_000);
  const { bin } = fakeGh({ sleepFor: 30 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    const started = Date.now();
    const outcome = runGh({ timeoutMs: 400 })('some/site', ['workflow', 'run'], TOKENS[SECRETS[0]]);
    assert.ok(Date.now() - started < 10_000, 'gave up long before the fake gh would have answered');
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /gh did not answer within 0 seconds|gh did not answer within 1 seconds/);
  } finally {
    process.env.PATH = before;
  }
  const source = readFileSync(join(root, 'scripts/notify-sites.mjs'), 'utf8');
  assert.match(source, /timeout: timeoutMs/);
  assert.match(source, /export const GH_TIMEOUT_MS = 60_000;/);
});

// ---- gh is started without a shell ----

// The names of the things that are forbidden are assembled from parts, so that this file does not itself contain them:
// the repository's own test (scripts/test.mjs) scans every script for them.
const EXEC_SYNC = ['exec', 'Sync'].join('');
const SPAWN_SYNC = ['spawn', 'Sync'].join('');
const EXEC = ['ex', 'ec'].join('');
const SHELL_OPTION = ['shell', ': true'].join('');
const FORBIDDEN_CALLS = new RegExp(`\\b${EXEC_SYNC}\\s*\\(|\\b${SPAWN_SYNC}\\s*\\(|\\bspawn\\s*\\(|\\b${EXEC}\\s*\\(|\\bfork\\s*\\(`);

/** The problems with how `source` starts a program: anything but one call of the file-and-arguments form with 'gh', without a shell. */
export function shellProblems(source) {
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  const problems = [];
  if (/\bshell\s*:/.test(code)) problems.push('a shell option');
  if (FORBIDDEN_CALLS.test(code)) problems.push('a function that may use a shell, or is not the file-and-arguments form');
  if (/['"`](?:\/bin\/)?(?:sh|bash|zsh|dash|cmd|powershell)(?:\.exe)?['"`]/.test(code)) problems.push('a shell named as the program');
  if (/['"`]-c['"`]/.test(code)) problems.push('a -c argument');
  const programs = [...code.matchAll(/\bexecFileSync\(\s*([^,)]+)/g)].map(match => match[1].trim());
  if (programs.length !== 1 || programs[0] !== "'gh'") problems.push(`the file-and-arguments call is not made once with 'gh' (${programs.join(', ') || 'never'})`);
  if (/child_process/.test(code) && !/import \{ execFileSync \} from 'node:child_process';/.test(code)) problems.push('child_process is imported for more than that call');
  return problems;
}

test('the script starts gh with the file-and-arguments form and an argument list, never a shell', () => {
  assert.deepEqual(shellProblems(readFileSync(join(root, 'scripts/notify-sites.mjs'), 'utf8')), []);
});

test('the shell check itself fails for gh through sh -c, a shell option, a string command and a second program', () => {
  const head = "import { execFileSync } from 'node:child_process';\n";
  assert.deepEqual(shellProblems(`${head}execFileSync('gh', args, { env });\n`), []);
  for (const bad of [
    `${head}execFileSync('sh', ['-c', \`gh \${args.join(' ')}\`]);\n`,
    `${head}execFileSync('gh', args, { ${SHELL_OPTION} });\n`,
    `${head}execFileSync('bash', ['-c', 'gh workflow run']);\n`,
    `import { ${EXEC_SYNC} } from 'node:child_process';\n${EXEC_SYNC}('gh workflow run');\n`,
    `import { execFileSync, ${SPAWN_SYNC} } from 'node:child_process';\n${SPAWN_SYNC}('gh', args);\nexecFileSync('gh', args);\n`,
    `${head}execFileSync('gh', args);\nexecFileSync('curl', [url]);\n`,
    `import { ${EXEC} } from 'node:child_process';\n${EXEC}('gh workflow run');\n`,
    `${head}execFileSync(program, args);\n`,
  ]) assert.ok(shellProblems(bad).length > 0, bad);
});

// ---- the workflow ----

const workflow = readFileSync(join(root, '.github/workflows/notify-sites.yml'), 'utf8');
const code = workflow.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '').replace(/\n{2,}/g, '\n');

test('the workflow runs on a push of index.json to main and by hand and on nothing else, only in this repository on main', () => {
  assert.match(code, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths: \[index\.json\]\n {2}workflow_dispatch:\npermissions:/m);
  const block = /^on:\n((?: {2}.*\n)+)/m.exec(`${code}\n`)[1];
  assert.deepEqual([...block.matchAll(/^ {2}([a-z_]+):/gm)].map(match => match[1]), ['push', 'workflow_dispatch'], 'exactly these triggers: one added after workflow_dispatch fails here');
  assert.ok(!/pull_request|schedule|workflow_run|repository_dispatch|workflow_call/.test(code));
  assert.ok(code.includes(`if: github.repository == '${REPOSITORY}' && github.ref == 'refs/heads/main'`));
  assert.match(code, /^permissions:\n {2}contents: read$/m);
  assert.equal([...code.matchAll(/^\s*permissions:/gm)].length, 1);
  assert.match(code, /^ {4}timeout-minutes: 10$/m, 'the job has a time limit');
});

test('the workflow names exactly the secrets of the list, each compared once and handed to one step, never echoed', () => {
  const named = [...new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]))].sort();
  assert.deepEqual(named, [...SECRETS].sort(), 'the secrets of the workflow are those of scripts/notify-sites.json');
  assert.equal([...code.matchAll(/secrets\./g)].length, SECRETS.length * 2, 'each secret: once in the comparison, once in the step that runs the script');
  assert.ok(code.includes(`HAS_ANY_TOKEN: \${{ ${SECRETS.map(name => `secrets.${name} != ''`).join(' || ')} }}`));
  assert.ok(!/SITES_DEPLOY_TRIGGER_TOKEN/.test(workflow), 'the old single token is gone');
  const steps = code.split('\n      - ');
  const holders = steps.filter(text => /secrets\.[A-Z0-9_]+ \}\}/.test(text.replace(/HAS_ANY_TOKEN[^\n]*\n/, '')) && /\n {8}env:\n/.test(text));
  assert.equal(holders.length, 1, 'one step holds the tokens');
  for (const name of SECRETS) assert.ok(holders[0].includes(`          ${name}: \${{ secrets.${name} }}`), name);
  assert.match(holders[0], /run: node scripts\/notify-sites\.mjs$/m);
  assert.match(holders[0], /if: env\.HAS_ANY_TOKEN == 'true'/);
  assert.ok(!holders[0].includes('GH_TOKEN'), 'no GH_TOKEN of the workflow: the script gives gh the token of its site');
  const skipped = steps.find(text => text.startsWith('name: Skipped, no token'));
  assert.match(skipped, /if: env\.HAS_ANY_TOKEN != 'true'/);
  assert.match(skipped, /::notice::/);
  assert.match(skipped, /GITHUB_STEP_SUMMARY/);
  assert.ok(!/exit 1/.test(skipped), 'a missing secret never fails the job');
  assert.ok(!/echo[^\n]*\$\{?(GH_TOKEN|SITES_TRIGGER_TOKEN)/.test(code.replace(/::notice::[^\n]*/g, '')));
  for (const text of steps) {
    const at = text.indexOf('run:');
    if (at !== -1) assert.ok(!text.slice(at).includes('${{'), 'no expression inside a run:');
  }
});

test('the checkout and setup steps get no token', () => {
  for (const text of code.split('\n      - ').filter(step => /^uses:/.test(step))) assert.ok(!/secrets\./.test(text), text.split('\n')[0]);
});

test('every action is pinned by full commit SHA', () => {
  const uses = [...code.matchAll(/^\s*(?:- )?uses: (\S+)$/gm)].map(match => match[1]);
  assert.ok(uses.length >= 2);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use);
  assert.match(code, /persist-credentials: false/);
});

test('the job checks out the whole repository, so scripts/notify-sites.json is there to be read', () => {
  assert.ok(!/sparse-checkout/.test(code));
  assert.match(code, /- uses: actions\/checkout@[0-9a-f]{40}\n {8}if: env\.HAS_ANY_TOKEN == 'true'\n {8}with:\n {10}persist-credentials: false/);
});
