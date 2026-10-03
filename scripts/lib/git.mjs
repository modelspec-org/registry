// Hardened git access for the registry checks, CC0-1.0 like everything else here.
//
// Everything the registry reads from a model's publisher comes through this
// module. It is the same hardening as meaninggraph/registry and the OVDB
// Directory, in the order the rules bite:
//
// - A repository is only ever an https URL on an allow-listed host with exactly
//   the host's number of path segments (repositoryKey); records that do not fit
//   are refused before they reach git.
// - git runs through execFileSync with an argument list, never a shell, so no
//   value from a record is ever interpolated into a command line.
// - Every URL or revision from a record is passed after --end-of-options, so a
//   value that starts with "-" can never be read as an option.
// - git only talks https to a remote (GIT_ALLOW_PROTOCOL); tests add file for
//   local repositories that stand in for https URLs.
// - The user's and the system's git configuration are not read, and every
//   inherited GIT_* variable is dropped, so a local insteadOf rewrite, hook
//   setting or GIT_DIR cannot change what is fetched or run. Repositories are
//   initialised without templates, so no hook is ever copied in.
// - Pathspecs are literal (--literal-pathspecs): a path from a record is a
//   path, never a glob or a `:(magic)` pathspec. The entry git returns is then
//   compared with the path that was asked for, and anything else is refused.
// - A commit only counts when it is in the history of the repository's default
//   branch: GitHub serves a fork's commits through the parent's URL, so "can be
//   fetched" alone would let a fork's commit be registered under the parent.
// - Files are read from the object store by object id (`git cat-file blob
//   <id>`), never checked out, so a symbolic link in the repository is only a
//   tree entry that lookup() reports as a link and read() refuses.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

export const commitPattern = /^[0-9a-f]{40}$/;
const objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// The hosts a repository may live on, each with the number of path segments
// that name a repository there. Adding a host is a reviewed change to this list.
export const repositoryHosts = new Map([['github.com', 2]]);
const segmentPattern = /^[A-Za-z0-9_.-]+$/;
// A branch name: no leading "-", ".", "/", no "..".
export const refNamePattern = /^(?![-.\/])(?!.*\.\.)[A-Za-z0-9._\/-]+$/;
// A path inside a repository: relative, no "..", no ".", no glob or pathspec
// characters (no `*?[:`), no shell characters, no trailing slash.
const filePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
export const isRepositoryPath = (path) => typeof path === 'string' && filePathPattern.test(path) && !path.endsWith('/') && !path.includes('//');
// The largest model file the registry reads, in bytes.
export const maxFileBytes = 5 * 1024 * 1024;

let allowedProtocols = 'https';
export const setGitProtocols = (protocols) => { allowedProtocols = protocols; };
const keptGitVariables = new Set(['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_CURL_VERBOSE']);
export const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || keptGitVariables.has(name))),
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowedProtocols, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
});
export const git = (args, options = {}) => execFileSync('git', ['--literal-pathspecs', ...args], { stdio: 'pipe', env: gitEnv(), maxBuffer: 256 * 1024 * 1024, ...options }).toString();
export const lastLine = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'failed';

// `{host}/{org}/{repo}` of a repository's canonical https form, or null. One
// spelling per repository: an allow-listed host (no www., no IP literal, no
// port, no user), exactly the host's number of path segments, none of them "."
// or "..", no `.git` suffix in any case, no trailing slash, query or fragment.
export function repositoryKey(repository) {
  if (typeof repository !== 'string' || !repository.startsWith('https://')) return null;
  const [host, ...segments] = repository.slice('https://'.length).split('/');
  if (!repositoryHosts.has(host) || segments.length !== repositoryHosts.get(host)) return null;
  if (!segments.every((segment) => segmentPattern.test(segment) && segment !== '.' && segment !== '..')) return null;
  if (/\.git$/i.test(segments.at(-1))) return null;
  return `${host}/${segments.join('/')}`;
}

// A ModelSpec module's short name, as meaning/draft-1 writes it in
// modelspec://{host}/{org}/{repo}/{module}.{Entity}.
export const modulePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

// modelspec://{host}/{org}/{repo}/{module} for a repository and a module, or null.
export function addressOf(repository, module) {
  const key = repositoryKey(repository);
  return key && typeof module === 'string' && modulePattern.test(module) ? `modelspec://${key}/${module}` : null;
}

// The branch a repository's HEAD names (its default branch), from ls-remote.
export function defaultBranch(url) {
  const head = git(['ls-remote', '--symref', '--end-of-options', url, 'HEAD']);
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head);
  if (!match) throw new Error(`${url} does not name a default branch`);
  return match[1];
}

// Only a commit in the history of the branch counts: this keeps a bare,
// commits-only (tree:0) clone of the branch per URL in cacheDir, fetches it
// again once per run (`fetched` remembers), and asks git whether the commit is
// an ancestor of the branch (or the branch itself). A commit the clone does
// not have is not in that history either.
export function onBranch(url, branch, commit, cacheDir, fetched = new Set()) {
  if (!commitPattern.test(commit) || !refNamePattern.test(branch)) return false;
  const dir = join(cacheDir, createHash('sha256').update(`${url}#${branch}`).digest('hex').slice(0, 32));
  const ref = `refs/heads/${branch}`;
  if (!fetched.has(dir)) {
    try {
      if (existsSync(join(dir, 'HEAD'))) git(['-C', dir, 'fetch', '-q', '--force', '--end-of-options', url, `+${ref}:${ref}`]);
      else {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(cacheDir, { recursive: true });
        git(['clone', '-q', '--bare', '--template=', '--filter=tree:0', '--single-branch', '--branch', branch, '--end-of-options', url, dir]);
      }
    } catch (error) {
      throw new Error(`cannot read the history of ${branch} in ${url}: ${lastLine(error)}`);
    }
    fetched.add(dir);
  }
  try {
    git(['-C', dir, 'merge-base', '--is-ancestor', '--end-of-options', commit, ref]);
    return true;
  } catch {
    return false;
  }
}

const regularModes = new Set(['100644', '100755']);

// Reads `git ls-tree -z` output and returns the entry for exactly `path`:
// { path, mode, type, id }, or null when there is none. An entry for any other
// path is refused: lookups use literal pathspecs, so one should never come
// back, and if one does the answer is not about the file that was asked for.
export function entryFor(path, output) {
  const entries = output.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, id] = line.slice(0, tab).split(' ');
    return { path: line.slice(tab + 1), mode, type, id };
  });
  if (entries.length === 0) return null;
  if (entries.length !== 1 || entries[0].path !== path || !objectIdPattern.test(entries[0].id)) {
    throw new Error(`git returned ${entries.map((entry) => JSON.stringify(entry.path)).join(', ')} for ${JSON.stringify(path)}; refusing to use it`);
  }
  return entries[0];
}

// One commit of a repository as a read-only file tree: a bare repository in
// cacheDir that holds only that commit (shallow fetch). Returns
//   { commit, lookup(path), read(path), rootNames() }
// lookup(path) is 'file' (a tracked regular file), 'link' (a symbolic link or
// submodule), 'directory' or 'missing'; read(path) returns a regular file's
// text and refuses anything else, and a file larger than maxFileBytes.
export function openCommit(url, commit, cacheDir) {
  if (!commitPattern.test(commit)) throw new Error(`${commit} is not a full commit id`);
  const dir = join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}-${commit}`);
  const ready = () => {
    try { git(['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
  };
  if (!(existsSync(join(dir, 'HEAD')) && ready())) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    const work = mkdtempSync(join(cacheDir, '.fetch-'));
    try {
      git(['init', '-q', '--bare', '--template=', work]);
      git(['-C', work, 'fetch', '-q', '--depth', '1', '--end-of-options', url, commit]);
      if (git(['-C', work, 'rev-parse', 'FETCH_HEAD']).trim() !== commit) throw new Error('did not fetch that commit');
      renameSync(work, dir);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`cannot fetch ${commit} from ${url}: ${lastLine(error)}`);
    }
  }
  const find = (path) => {
    if (!isRepositoryPath(path)) throw new Error(`${JSON.stringify(path)} is not a plain path inside the repository`);
    return entryFor(path, git(['-C', dir, 'ls-tree', '-z', '--end-of-options', commit, '--', path]));
  };
  const lookup = (path) => {
    const entry = find(path);
    if (!entry) return 'missing';
    if (entry.type === 'tree') return 'directory';
    return regularModes.has(entry.mode) && entry.type === 'blob' ? 'file' : 'link';
  };
  const read = (path) => {
    const status = lookup(path);
    if (status !== 'file') throw new Error(`${path} is ${status === 'missing' ? 'not in' : 'not a regular file of'} the repository at ${commit}`);
    const { id } = find(path);
    const size = Number(git(['-C', dir, 'cat-file', '-s', id]).trim());
    if (!(size <= maxFileBytes)) throw new Error(`${path} is ${size} bytes, more than the ${maxFileBytes} the registry reads`);
    return git(['-C', dir, 'cat-file', 'blob', id]);
  };
  // The names (and modes) of the files in the repository root, for LICENSE files.
  const rootNames = () => git(['-C', dir, 'ls-tree', '-z', '--end-of-options', commit]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { name: line.slice(tab + 1), mode: line.slice(0, tab).split(' ')[0] };
  });
  return { commit, lookup, read, rootNames };
}
