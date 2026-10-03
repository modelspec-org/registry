// Starts the `deploy.yml` workflow, on `main`, of every site built from this repository's index.json. The sites,
// and the name of the secret that holds the token for each, are in scripts/notify-sites.json. A notification
// carries only a `reason`: each site finds out for itself what changed (it reads every index at the commit that
// is current when it runs). Run by .github/workflows/notify-sites.yml:
//
//   SITES_TRIGGER_TOKEN_<OWNER>=<token> ... GITHUB_REPOSITORY=<owner/name> GITHUB_SHA=<commit> \
//     node scripts/notify-sites.mjs
//
// One token per site owner (a fine-grained token belongs to one owner): the one named for a site is handed to
// `gh` for that site's call and to nothing else; a `gh` call's environment holds that token and no other, and
// each call has a time limit. A site whose token is absent is skipped with a notice (and a line in the job
// summary), not failed. A site whose token is present but whose call fails is a failure: every site is
// attempted, and the exit status is 1 at the end when any failed, so a broken token is visible. With no token
// at all the program says so and exits 0. Tokens are only read from the environment and removed from
// anything printed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW = 'deploy.yml';
export const REF = 'main';
export const GH_TIMEOUT_MS = 60_000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
/** The names a site's secret may have: one per site owner. */
export const SECRET_NAME = /^SITES_TRIGGER_TOKEN_[A-Z0-9_]+$/;

/** The list of sites ({repo, secret}), or an error naming what is wrong with it. `self` (this repository) may not be in it. */
export function validateSites(data, self = '') {
  const sites = data?.sites;
  if (!Array.isArray(sites) || sites.length === 0) throw new Error('sites must be a non-empty list of {repo, secret}');
  const seen = new Set();
  for (const site of sites) {
    if (!site || typeof site !== 'object' || Array.isArray(site) || Object.keys(site).sort().join() !== 'repo,secret') throw new Error(`${JSON.stringify(site)} is not {repo, secret}`);
    if (typeof site.repo !== 'string' || !REPOSITORY.test(site.repo)) throw new Error(`${JSON.stringify(site.repo)} is not an owner/name repository`);
    if (typeof site.secret !== 'string' || !SECRET_NAME.test(site.secret)) throw new Error(`${JSON.stringify(site.secret)} is not a secret name of the form SITES_TRIGGER_TOKEN_<OWNER>`);
    if (seen.has(site.repo.toLowerCase())) throw new Error(`${site.repo} is listed twice`);
    seen.add(site.repo.toLowerCase());
    if (self && site.repo.toLowerCase() === self.toLowerCase()) throw new Error(`${site.repo} is this repository: a site cannot notify itself`);
  }
  return sites.map(({ repo, secret }) => ({ repo, secret }));
}

/** The distinct secret names of the list, in order of first use. */
export const secretsOf = sites => [...new Set(sites.map(site => site.secret))];

/** The text a started run shows as its `reason`: what changed, where, at which commit. One line, plain characters. */
export function reasonText({ repository, sha, event = 'push' }) {
  const commit = String(sha ?? '').slice(0, 12);
  const what = event === 'workflow_dispatch' ? 're-sent by hand for' : 'index.json changed in';
  return `${what} ${repository} at ${commit}`.replace(/[^\w ./@-]/g, '');
}

/** The `gh` arguments that start the site's deploy workflow on main: the reason is the only input. */
export function ghArguments(site, reason) {
  return ['workflow', 'run', WORKFLOW, '--repo', site, '--ref', REF, '-f', `reason=${reason}`];
}

/** Removes the tokens (and anything shaped like a GitHub token) from text that is about to be printed. */
export function redact(text, tokens = []) {
  let out = String(text ?? '');
  for (const token of [tokens].flat()) if (token) out = out.split(token).join('***');
  return out.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '***');
}

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';

/**
 * Attempts every site. `tokens` maps secret names to token values (absent or empty: no token). `start(site, args, token)`
 * returns {status, stdout, stderr} (injected; the default runs `gh`). Returns {reason, results: [{site, secret, state,
 * detail}], started, skipped, failed}, state being started, skipped (no token) or failed. A failure, or a start that
 * throws, never stops the others.
 */
export function notifyAll({ sites, repository, sha, event, tokens = {}, start }) {
  const reason = reasonText({ repository, sha, event });
  const all = Object.values(tokens);
  const results = [];
  for (const { repo, secret } of sites) {
    const token = tokens[secret] ?? '';
    if (!token) {
      results.push({ site: repo, secret, state: 'skipped', detail: `no ${secret} secret` });
      continue;
    }
    try {
      const run = start(repo, ghArguments(repo, reason), token);
      if (run.status === 0) results.push({ site: repo, secret, state: 'started', detail: 'deploy workflow started' });
      else results.push({ site: repo, secret, state: 'failed', detail: redact(firstLine(run.stderr) || firstLine(run.stdout) || `gh exited with status ${run.status}`, all) });
    } catch (error) {
      results.push({ site: repo, secret, state: 'failed', detail: redact(error.message, all) });
    }
  }
  const count = state => results.filter(result => result.state === state).length;
  return { reason, results, started: count('started'), skipped: count('skipped'), failed: count('failed') };
}

/** The job summary: one line per site. */
export function summary({ reason, results, started, skipped, failed }) {
  const lines = [`Notified the sites built from index.json (${reason}):`, ''];
  for (const { site, state, detail } of results) lines.push(`- ${site}: ${state === 'failed' ? 'FAILED' : state} (${detail})`);
  const parts = [`${started} of ${results.length} started`];
  if (skipped) parts.push(`${skipped} skipped for want of a token`);
  if (failed) parts.push(`${failed} FAILED`);
  lines.push('', `${parts.join(', ')}.`);
  return lines.join('\n');
}

/**
 * The default `start`: runs `gh` with a fixed command and an argument list, never through a shell, with a time limit.
 * Its environment is the path, a home directory and the one token it was given: no other secret reaches it.
 */
export function runGh({ timeoutMs = GH_TIMEOUT_MS } = {}) {
  return (site, args, token) => {
    try {
      const stdout = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', GH_TOKEN: token } });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      if (error.code === 'ETIMEDOUT') return { status: 1, stdout: '', stderr: `gh did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
      return { status: typeof error.status === 'number' ? error.status : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') || error.message };
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  let tokens = {};
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sites = validateSites(JSON.parse(readFileSync(join(here, 'notify-sites.json'), 'utf8')), repository);
    tokens = Object.fromEntries(secretsOf(sites).map(name => [name, process.env[name] ?? '']));
    const note = text => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (!Object.values(tokens).some(Boolean)) {
      const text = `No ${Object.keys(tokens).join(', ')} secret: the sites were not notified.`;
      console.log(`::notice::${text}`);
      note(`Sites not notified: ${text}`);
      process.exit(0);
    }
    const outcome = notifyAll({ sites, repository, sha: process.env.GITHUB_SHA, event: process.env.GITHUB_EVENT_NAME, tokens, start: runGh() });
    const text = summary(outcome);
    console.log(text);
    for (const { site, state, detail } of outcome.results) {
      if (state === 'failed') console.log(`::error::${site}: ${detail}`);
      if (state === 'skipped') console.log(`::notice::${site} was not notified: ${detail}`);
    }
    note(text);
    process.exit(outcome.failed ? 1 : 0);
  } catch (error) {
    console.error(`::error::${redact(error.message, Object.values(tokens))}`);
    process.exit(1);
  }
}
