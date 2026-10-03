// Starts the `deploy.yml` workflow, on `main`, of every site built from this repository's index.json
// (the list, and the name this index goes by, are in scripts/notify-sites.json). Each site is told which index
// changed and the `checksum` that index.json now carries: a site reads the index through a cache that can be five
// minutes old, so it waits until it sees that checksum before it builds. Run by .github/workflows/notify-sites.yml:
//
//   GH_TOKEN=<token with Actions write access on the sites> GITHUB_REPOSITORY=<owner/name> GITHUB_SHA=<commit> \
//     node scripts/notify-sites.mjs
//
// Every site is attempted, whatever happens to the others; each result goes to the log and to the job
// summary, and the exit status is 1 when any site could not be started (so a broken token is visible).
// The token is only read from the environment, only handed to `gh`, and removed from anything printed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW = 'deploy.yml';
export const REF = 'main';
/** The names an index may go by in a notification; the sites know the same names. */
export const INDEX_NAMES = ['ovdb-directory', 'modelspec-registry', 'meaninggraph-registry'];
export const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** The list of sites, or an error naming what is wrong with it. `self` (this repository) may not be in it. */
export function validateSites(data, self = '') {
  const sites = data?.sites;
  if (!Array.isArray(sites) || sites.length === 0) throw new Error('sites must be a non-empty list of owner/name');
  const seen = new Set();
  for (const site of sites) {
    if (typeof site !== 'string' || !REPOSITORY.test(site)) throw new Error(`${JSON.stringify(site)} is not an owner/name repository`);
    if (seen.has(site.toLowerCase())) throw new Error(`${site} is listed twice`);
    seen.add(site.toLowerCase());
    if (self && site.toLowerCase() === self.toLowerCase()) throw new Error(`${site} is this repository: a site cannot notify itself`);
  }
  return [...sites];
}

/** The name this index goes by, or an error. */
export function validateIndexName(data) {
  if (!INDEX_NAMES.includes(data?.index)) throw new Error(`index must be one of ${INDEX_NAMES.join(', ')}`);
  return data.index;
}

/** The `checksum` field of the index.json text, or an error: it must be sha256: and 64 lower-case hex digits. */
export function indexChecksum(text) {
  let checksum;
  try {
    checksum = JSON.parse(text)?.checksum;
  } catch (error) {
    throw new Error(`index.json is not valid JSON: ${redact(error.message)}`);
  }
  if (typeof checksum !== 'string' || !CHECKSUM.test(checksum)) throw new Error('index.json carries no checksum of the form sha256:<64 hex digits>');
  return checksum;
}

/** The text a started run shows as its `reason`: what changed, where, at which commit. One line, plain characters. */
export function reasonText({ repository, sha, event = 'push' }) {
  const commit = String(sha ?? '').slice(0, 12);
  const what = event === 'workflow_dispatch' ? 're-sent by hand for' : 'index.json changed in';
  return `${what} ${repository} at ${commit}`.replace(/[^\w ./@-]/g, '');
}

/** The `gh` arguments that start the site's deploy workflow on main. */
export function ghArguments(site, reason, index, checksum) {
  return ['workflow', 'run', WORKFLOW, '--repo', site, '--ref', REF, '-f', `reason=${reason}`, '-f', `index=${index}`, '-f', `checksum=${checksum}`];
}

/** Removes the token (and anything shaped like a GitHub token) from text that is about to be printed. */
export function redact(text, token = '') {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '***');
}

/**
 * Attempts every site. `start(site, args)` returns {status, stdout, stderr} (injected; the default runs `gh`).
 * Returns {results: [{site, ok, detail}], failed}. A site that fails, or whose start throws, never stops the others.
 */
export function notifyAll({ sites, index, checksum, repository, sha, event, token = '', start }) {
  const reason = reasonText({ repository, sha, event });
  const results = [];
  for (const site of sites) {
    try {
      const run = start(site, ghArguments(site, reason, index, checksum));
      if (run.status === 0) results.push({ site, ok: true, detail: 'deploy workflow started' });
      else results.push({ site, ok: false, detail: redact(firstLine(run.stderr) || firstLine(run.stdout) || `gh exited with status ${run.status}`, token) });
    } catch (error) {
      results.push({ site, ok: false, detail: redact(error.message, token) });
    }
  }
  return { reason, index, checksum, results, failed: results.filter(result => !result.ok).length };
}

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';

/** The job summary: one line per site. */
export function summary({ reason, index, checksum, results, failed }) {
  const lines = [`Notified the sites built from index.json (${reason}; ${index} ${checksum}):`, ''];
  for (const { site, ok, detail } of results) lines.push(`- ${site}: ${ok ? 'started' : 'FAILED'} (${detail})`);
  lines.push('', failed ? `${failed} of ${results.length} could not be started.` : `All ${results.length} started.`);
  return lines.join('\n');
}

// `gh` is run with a fixed command and an argument list, never through a shell. The token is its only secret.
function runGh(token) {
  return (site, args) => {
    try {
      const stdout = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', GH_TOKEN: token } });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      return { status: typeof error.status === 'number' ? error.status : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') || error.message };
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.GH_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!token) {
    console.error('::error::GH_TOKEN is not set');
    process.exit(1);
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const data = JSON.parse(readFileSync(join(here, 'notify-sites.json'), 'utf8'));
    const sites = validateSites(data, repository);
    const index = validateIndexName(data);
    const checksum = indexChecksum(readFileSync(join(here, '..', 'index.json'), 'utf8'));
    const outcome = notifyAll({ sites, index, checksum, repository, sha: process.env.GITHUB_SHA, event: process.env.GITHUB_EVENT_NAME, token, start: runGh(token) });
    const text = summary(outcome);
    console.log(text);
    for (const { site, ok, detail } of outcome.results) if (!ok) console.log(`::error::${site}: ${detail}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    process.exit(outcome.failed ? 1 : 0);
  } catch (error) {
    console.error(`::error::${redact(error.message, token)}`);
    process.exit(1);
  }
}
