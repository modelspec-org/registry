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
// - Hooks, file-system monitors and replace refs never act (-c core.hooksPath,
//   core.fsmonitor, core.useReplaceRefs, GIT_NO_REPLACE_OBJECTS), so a
//   repository in the cache cannot run code of its own or swap one object for
//   another however it got there.
// - The cache lives outside the checkout, in a per-user directory
//   (defaultCacheDir) that must be private to the current user, and nothing in
//   it is trusted: a cached repository is used only when its configuration is
//   one this module writes, it has no alternates, hooks or replace refs, and
//   git fsck passes; anything else is deleted and fetched again. A checkout
//   that tracks a `.cache` is refused (trackedCacheProblems).
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { devNull, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowedProtocols, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
});
// Hooks are pointed at a path with no hooks in it, fsmonitor is off and replace
// refs are ignored, so a repository in the cache cannot run code of its own or
// change what an object id reads as.
export const safeGitConfig = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false'];
export const git = (args, options = {}) => execFileSync('git', [...safeGitConfig, '--literal-pathspecs', ...args], { stdio: 'pipe', env: gitEnv(), maxBuffer: 256 * 1024 * 1024, ...options }).toString();
export const lastLine = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'failed';

// The per-user directory the caches live in: $XDG_CACHE_HOME (when absolute) or
// ~/.cache, then modelspec-registry. Never inside a checkout. Created 0700;
// refused unless it is a real directory (not a symbolic link) owned by the
// current user and not writable by anyone else. `env`, `home` and `uid` are for
// the tests.
export function defaultCacheDir({ env = process.env, home = homedir(), uid = process.getuid?.() } = {}) {
  const base = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache');
  const dir = join(base, 'modelspec-registry');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory; the cache must be a real per-user directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is owned by another user; the cache must be yours`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${dir} is writable by others; the cache must be private (chmod 700)`);
  return dir;
}

// Problems when the checkout tracks anything under `.cache`: the cache is never
// read from the checkout, and a pull request that adds one is refused. A
// directory that is not a git checkout has nothing tracked.
export function trackedCacheProblems(root) {
  let tracked;
  try { tracked = git(['-C', root, 'ls-files', '-z', '--', '.cache']).split('\0').filter(Boolean); } catch { return []; }
  return tracked.length === 0 ? [] : [`.cache is tracked in this checkout (${tracked.slice(0, 3).join(', ')}${tracked.length > 3 ? ', …' : ''}); the registry keeps its caches outside the checkout and never reads one from it. Remove it with git rm -r --cached .cache`];
}

// The configuration a repository this module made can have. Anything else in a
// cached repository's config (hooksPath, fsmonitor, insteadOf, an include, an
// alias, a credential or protocol setting) means it was not made here.
const coreKeys = /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/;
const historyKeys = [coreKeys, /^remote\.origin\.(url|fetch|promisor|partialclonefilter)$/, /^extensions\.(partialclone|objectformat)$/, /^branch\..+\.(remote|merge)$/];
const commitKeys = [coreKeys, /^extensions\.objectformat$/];

// Whether a cached bare repository is what this module made: only safe
// configuration (for a history clone, with its remote being `url`), no
// alternates, no hooks, no replace refs, and every object it holds hashes to its
// name (git fsck). A repository that fails is thrown away and fetched again.
export function cacheRepoSound(dir, { url } = {}) {
  try {
    if (!existsSync(join(dir, 'HEAD'))) return false;
    if (existsSync(join(dir, 'objects', 'info', 'alternates')) || existsSync(join(dir, 'commondir'))) return false;
    if (existsSync(join(dir, 'hooks')) && readdirSync(join(dir, 'hooks')).length > 0) return false;
    const keys = git(['config', '--file', join(dir, 'config'), '--list', '--name-only']).split('\n').filter(Boolean);
    if (!keys.every((key) => (url === undefined ? commitKeys : historyKeys).some((pattern) => pattern.test(key)))) return false;
    if (url !== undefined && git(['config', '--file', join(dir, 'config'), '--get', 'remote.origin.url']).trim() !== url) return false;
    if (git(['--git-dir', dir, 'for-each-ref', '--format=%(refname)', 'refs/replace']).trim() !== '') return false;
    git(['--git-dir', dir, 'fsck', '--no-dangling', '--no-progress']);
    return true;
  } catch {
    return false;
  }
}

export const historyPath = (cacheDir, url, branch) => join(cacheDir, createHash('sha256').update(`${url}#${branch}`).digest('hex').slice(0, 32));

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
  const dir = historyPath(cacheDir, url, branch);
  const ref = `refs/heads/${branch}`;
  if (!fetched.has(dir)) {
    const clone = () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      git(['clone', '-q', '--bare', '--template=', '--filter=tree:0', '--single-branch', '--branch', branch, '--end-of-options', url, dir]);
    };
    try {
      let refreshed = false;
      if (cacheRepoSound(dir, { url })) {
        // Through the clone's own remote, which knows it is a partial clone: a
        // fetch by URL asks for objects the clone never had once the branch has
        // moved. If it fails anyway, the clone is thrown away and made again.
        try { git(['--git-dir', dir, 'fetch', '-q', '--force', 'origin', `+${ref}:${ref}`]); refreshed = true; } catch { /* clone again */ }
      }
      if (!refreshed) clone();
    } catch (error) {
      throw new Error(`cannot read the history of ${branch} in ${url}: ${lastLine(error)}`);
    }
    fetched.add(dir);
  }
  try {
    git(['--git-dir', dir, 'merge-base', '--is-ancestor', '--end-of-options', commit, ref]);
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
    try { git(['--git-dir', dir, 'cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
  };
  if (!(cacheRepoSound(dir) && ready())) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    const work = mkdtempSync(join(cacheDir, '.fetch-'));
    try {
      git(['init', '-q', '--bare', '--template=', work]);
      git(['--git-dir', work, 'fetch', '-q', '--depth', '1', '--end-of-options', url, commit]);
      if (git(['--git-dir', work, 'rev-parse', 'FETCH_HEAD']).trim() !== commit) throw new Error('did not fetch that commit');
      renameSync(work, dir);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`cannot fetch ${commit} from ${url}: ${lastLine(error)}`);
    }
  }
  const find = (path) => {
    if (!isRepositoryPath(path)) throw new Error(`${JSON.stringify(path)} is not a plain path inside the repository`);
    return entryFor(path, git(['--git-dir', dir, 'ls-tree', '-z', '--end-of-options', commit, '--', path]));
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
    const size = Number(git(['--git-dir', dir, 'cat-file', '-s', id]).trim());
    if (!(size <= maxFileBytes)) throw new Error(`${path} is ${size} bytes, more than the ${maxFileBytes} the registry reads`);
    return git(['--git-dir', dir, 'cat-file', 'blob', id]);
  };
  // The names (and modes) of the files in the repository root, for LICENSE files.
  const rootNames = () => git(['--git-dir', dir, 'ls-tree', '-z', '--end-of-options', commit]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { name: line.slice(tab + 1), mode: line.slice(0, tab).split(' ')[0] };
  });
  return { commit, lookup, read, rootNames };
}
