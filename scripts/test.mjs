// Tests for the registry checks (CC0-1.0), offline. Each test builds a registry
// in a temporary directory, with local git repositories that stand in for
// https URLs (https://example.test/fixtures/<name>), breaks one thing, and
// expects the check to name it. The real Chinook record is checked against
// GitHub by `npm run check`, not here; its files are copied into
// scripts/fixtures/chinookdb so that the checks run on the real model offline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { addressOf, defaultBranch, entryFor, gitEnv, git, isRepositoryPath, maxFileBytes, onBranch, openCommit, repositoryHosts, repositoryKey, setGitProtocols } from './lib/git.mjs';
import { astDifferences, describeEntities, parseHcl, serializeModel, toModelspecJson, validateModel } from './lib/modelspec.mjs';
import { buildIndex, checkRegistry, declaredLicence, loadModels, readRegistry, recordProblems, registryFormat, wellFormed } from './lib/registry.mjs';

// The local repositories that stand in for https URLs are file:// URLs, at
// https://example.test/fixtures/<name>; the tests allow that host and protocol.
setGitProtocols('https:file');
repositoryHosts.set('example.test', 2);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'scripts', 'fixtures', 'chinookdb');
const scratch = mkdtempSync(join(tmpdir(), 'registry-test-'));
const cacheDir = join(scratch, 'cache');
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
const origins = new Map();
const noNetwork = () => { throw new Error('git was asked to fetch a URL it should never have been handed'); };
const urlFor = (url) => origins.get(url) ?? noNetwork();

// A local git repository with `files` on main, standing in for
// https://example.test/fixtures/<name>. With `side`, those files are committed
// on a branch that main does not contain: the stand-in for a commit that only a
// fork has, which GitHub still serves through the parent's URL. `symlinks` are
// { path: target }; `gitlinks` are paths committed as submodule entries.
function origin(name, files, { side, symlinks = {}, gitlinks = [] } = {}) {
  const dir = join(scratch, `origin-${count++}`);
  mkdirSync(dir);
  const put = (entries) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  const commit = (message, links = []) => {
    gitIn(dir, 'add', '-A');
    // After `add -A`, which would drop an entry that has no file in the work tree.
    for (const path of links) gitIn(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},${path}`);
    gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
    return gitIn(dir, 'rev-parse', 'HEAD');
  };
  gitIn(dir, 'init', '-q', '-b', 'main');
  put(files);
  for (const [path, target] of Object.entries(symlinks)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); symlinkSync(target, join(dir, path)); }
  const head = commit('files', gitlinks);
  let sideCommit;
  if (side) {
    gitIn(dir, 'checkout', '-q', '-b', 'side');
    put(side);
    sideCommit = commit('side');
    gitIn(dir, 'checkout', '-q', 'main');
  }
  const repository = `https://example.test/fixtures/${name}`;
  origins.set(repository, `file://${dir}`);
  return { name, dir, repository, commit: head, sideCommit };
}

const mit = 'MIT License\n\nCopyright (c) 2026 Test\n';
const cc0 = 'Creative Commons Legal Code\n\nCC0 1.0 Universal\n';
const fixtureHcl = `# Licence: MIT
entity "Artist" {
  key = ["ArtistId"]

  property "ArtistId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type    = "string"
    max_len = 120
  }
}

entity "Album" {
  key = ["AlbumId"]

  property "AlbumId" {
    type     = "int"
    required = true
  }

  property "ArtistId" {
    entity   = "Artist"
    required = true
  }
}
`;
const moduleFor = (name) => ({ id: `example.test/fixtures/${name}/model/fixture`, name: 'fixture', version: '0.1.0' });
const jsonFor = (name, hcl = fixtureHcl, module = moduleFor(name)) => toModelspecJson(parseHcl(hcl), module);

// A model repository: HCL source, JSON AST generated from it, a LICENSE. `hcl`
// and `json` replace the contents; `json` may be an object or raw text;
// `files` are added or replace any of them (a null removes one).
function modelOrigin(name, { hcl = fixtureHcl, json, licence = mit, files = {}, ...options } = {}) {
  const ast = json ?? jsonFor(name, hcl);
  const base = {
    'model/fixture.modelspec.hcl': hcl,
    'model/fixture.modelspec.json': typeof ast === 'string' ? ast : serializeModel(ast),
    ...(licence === null ? {} : { LICENSE: licence }),
  };
  const merged = { ...base, ...files };
  for (const path of Object.keys(merged)) if (merged[path] === null) delete merged[path];
  return origin(name, merged, options);
}

const fixtureRecord = (source, extra = {}) => ({
  format: registryFormat,
  title: 'Fixture',
  description: 'A model for the tests.',
  status: 'draft',
  address: `modelspec://example.test/fixtures/${source.name}/fixture`,
  repository: source.repository,
  commit: source.commit,
  module: 'fixture',
  source_file: 'model/fixture.modelspec.hcl',
  json_file: 'model/fixture.modelspec.json',
  licence: 'MIT',
  maintainers: ['trakhimenok'],
  ...extra,
});

// An empty registry (no models) with the real maintainers; `records` maps an id
// to a record (or to a function of the directory).
function registry(records = {}, { index = true } = {}) {
  const dir = join(scratch, `registry-${count++}`);
  mkdirSync(join(dir, 'models', '$records'), { recursive: true });
  for (const name of ['.ingitdb', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  for (const [id, record] of Object.entries(records)) writeFileSync(join(dir, 'models', '$records', `${id}.yaml`), stringifyYaml(record));
  if (index) writeFileSync(join(dir, 'index.json'), buildIndex(loadModels(options(dir)).entries));
  return dir;
}
// Branch histories are fetched once per registry directory, not once per test.
const options = (dir) => ({ root: dir, urlFor, cacheDir, fetched: new Set(), branches: new Map() });
const check = (dir) => checkRegistry(options(dir));
const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`);
const checkRecords = (records) => check(registry(records, { index: false })).problems.filter((problem) => !/index\.json/.test(problem));
// The problems of one fixture model repository.
const problemsOf = (source, extra) => checkRecords({ fixture: fixtureRecord(source, extra) });

// ---- the registry as committed --------------------------------------------

test('the committed records are well formed and the committed index.json is consistent', () => {
  const committed = readRegistry(root);
  assert.deepEqual(committed.problems, []);
  assert.deepEqual(recordProblems(committed), []);
  assert.deepEqual(committed.models.map((model) => model.key), ['chinook']);
  const { data } = committed.models[0];
  assert.equal(data.address, 'modelspec://github.com/datatug/chinookdb/chinook');
  assert.equal(data.repository, 'https://github.com/datatug/chinookdb');
  assert.equal(data.commit, 'be96bf45fdfa13559b6627d281c1e30ce92ad38f');
  assert.equal(data.module, 'chinook');
  assert.equal(data.status, 'draft');
  assert.deepEqual([data.source_file, data.json_file], ['model/chinook.modelspec.hcl', 'model/chinook.modelspec.json']);
  assert.ok(wellFormed(committed.models[0]));
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  assert.equal(index.format, 'modelspec-registry/draft-1');
  assert.equal(index.checksum, `sha256:${createHash('sha256').update(JSON.stringify(index.models)).digest('hex')}`);
  const [chinook] = index.models;
  assert.deepEqual([chinook.id, chinook.address, chinook.repository, chinook.commit, chinook.licence], ['chinook', data.address, data.repository, data.commit, 'MIT']);
  assert.deepEqual(chinook.files, { source: data.source_file, json: data.json_file });
  assert.equal(chinook.entities.length, 11);
  assert.equal(readFileSync(join(root, 'index.json'), 'utf8'), `${JSON.stringify(index, null, 2)}\n`, 'index.json is written the way buildIndex writes it');
});

test('the real Chinook model files pass every model check', () => {
  const source = origin('chinook-real', { 'model/chinook.modelspec.hcl': readFileSync(join(fixtures, 'model', 'chinook.modelspec.hcl')), 'model/chinook.modelspec.json': readFileSync(join(fixtures, 'model', 'chinook.modelspec.json')), LICENSE: readFileSync(join(fixtures, 'LICENSE')) });
  const json = JSON.parse(readFileSync(join(fixtures, 'model', 'chinook.modelspec.json'), 'utf8'));
  const record = fixtureRecord(source, { address: `modelspec://example.test/fixtures/chinook-real/chinook`, module: 'chinook', source_file: 'model/chinook.modelspec.hcl', json_file: 'model/chinook.modelspec.json' });
  // The fixture's module.id names the real repository, so the real files are
  // checked as that repository: a record for it, served from the local copy.
  origins.set('https://github.com/datatug/chinookdb', origins.get(source.repository));
  const real = { ...record, address: 'modelspec://github.com/datatug/chinookdb/chinook', repository: 'https://github.com/datatug/chinookdb' };
  const dir = registry({ chinook: real });
  const { problems, entries } = loadModels(options(dir));
  assert.deepEqual(problems, []);
  assert.equal(json.module.id, 'github.com/datatug/chinookdb/model/chinook');
  assert.deepEqual(entries[0].entities.map((entity) => entity.name), ['Artist', 'Album', 'Track', 'Genre', 'MediaType', 'Playlist', 'PlaylistTrack', 'Customer', 'Employee', 'Invoice', 'InvoiceLine']);
  assert.deepEqual(check(dir).problems, []);
});

test('a well-formed fixture model passes, so the failures below are about what each test broke', () => {
  const source = modelOrigin('fine');
  const dir = registry({ fine: fixtureRecord(source) });
  assert.deepEqual(check(dir).problems, []);
  const { entries } = loadModels(options(dir));
  assert.deepEqual(entries[0].entities, [
    { name: 'Artist', key: ['ArtistId'], properties: [{ name: 'ArtistId', type: 'int', required: true, key: true }, { name: 'Name', type: 'string', required: false, key: false }] },
    { name: 'Album', key: ['AlbumId'], properties: [{ name: 'AlbumId', type: 'int', required: true, key: true }, { name: 'ArtistId', type: 'reference', references: 'Artist', required: true, key: false }] },
  ]);
  assert.deepEqual([entries[0].module, entries[0].module_id, entries[0].module_version, entries[0].modelspec], ['fixture', moduleFor('fine').id, '0.1.0', '1.0-draft']);
});

// ---- the records alone: nothing here reaches git -------------------------

test('a repository that is not a canonical https URL on an allowed host is refused before git', () => {
  const bad = {
    'http': 'http://github.com/datatug/chinookdb',
    'ssh': 'git@github.com:datatug/chinookdb',
    'git protocol': 'git://github.com/datatug/chinookdb',
    'file': 'file:///etc',
    'an option': '--upload-pack=touch /tmp/x',
    'another option': '-oProxyCommand=touch /tmp/x',
    'another host': 'https://gitlab.com/datatug/chinookdb',
    'www host': 'https://www.github.com/datatug/chinookdb',
    'an IP literal': 'https://140.82.112.3/datatug/chinookdb',
    'a port': 'https://github.com:443/datatug/chinookdb',
    'a user': 'https://user@github.com/datatug/chinookdb',
    'one segment': 'https://github.com/datatug',
    'three segments': 'https://github.com/datatug/chinookdb/tree',
    '.git suffix': 'https://github.com/datatug/chinookdb.git',
    'upper-case .GIT suffix': 'https://github.com/datatug/chinookdb.GIT',
    'trailing slash': 'https://github.com/datatug/chinookdb/',
    'a dot segment': 'https://github.com/./chinookdb',
    'a dot-dot segment': 'https://github.com/datatug/..',
    'a query': 'https://github.com/datatug/chinookdb?x=1',
    'a fragment': 'https://github.com/datatug/chinookdb#x',
    'a space': 'https://github.com/datatug/chinook db',
    'a shell substitution': 'https://github.com/datatug/$(touch x)',
    'a semicolon': 'https://github.com/datatug/a;touch x',
    'a backtick': 'https://github.com/datatug/`touch x`',
    'a missing value': undefined,
  };
  for (const [what, repository] of Object.entries(bad)) {
    assert.equal(repositoryKey(repository), null, what);
    assert.equal(addressOf(repository, 'chinook'), null, what);
    const record = { key: 'x', file: 'models/$records/x.yaml', data: { ...fixtureRecord({ name: 'x', repository: 'https://github.com/datatug/chinookdb', commit: 'a'.repeat(40) }), repository } };
    expectProblem(recordProblems({ models: [record], maintainers: [{ key: 'trakhimenok' }] }), /repository must be an https URL of a repository on/);
    assert.equal(wellFormed(record), false, what);
  }
  assert.equal(repositoryKey('https://github.com/datatug/chinookdb'), 'github.com/datatug/chinookdb');
  assert.equal(addressOf('https://github.com/datatug/chinookdb', 'chinook'), 'modelspec://github.com/datatug/chinookdb/chinook');
});

test('a malformed record never reaches git: the check passes urlFor nothing', () => {
  const marker = join(scratch, 'marker-shell');
  const source = { name: 'x', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const broken = {
    option: fixtureRecord(source, { repository: '--upload-pack=touch ' + marker }),
    shell: fixtureRecord(source, { repository: `https://github.com/datatug/$(touch ${marker})` }),
    host: fixtureRecord(source, { repository: 'https://gitlab.com/datatug/chinookdb' }),
    commit: fixtureRecord(source, { commit: '--help' }),
    paths: fixtureRecord(source, { source_file: `model/$(touch ${marker}).modelspec.hcl` }),
  };
  const { problems } = check(registry(broken, { index: false })); // urlFor throws if git is reached
  assert.ok(problems.length >= 5);
  assert.equal(existsSync(marker), false);
});

test('an address that is not the repository plus the module fails', () => {
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const records = (extra) => recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data: fixtureRecord(source, extra) }], maintainers: [{ key: 'trakhimenok' }] });
  expectProblem(records({}), /address must be modelspec:\/\/github\.com\/datatug\/chinookdb\/fixture/);
  expectProblem(records({ address: 'meaning://github.com/datatug/chinookdb' }), /address must be modelspec:\/\/github\.com\/datatug\/chinookdb\/fixture/);
  expectProblem(records({ address: 'modelspec://github.com/datatug/chinookdb' }), /address must be/);
  expectProblem(records({ address: 'modelspec://github.com/datatug/chinookdb/fixture/' }), /address must be/);
  expectProblem(records({ address: 'modelspec://github.com/datatug/other/fixture' }), /address must be/);
  expectProblem(records({ address: 'modelspec://github.com/datatug/chinookdb/Fixture' }), /address must be/);
  assert.deepEqual(records({ address: 'modelspec://github.com/datatug/chinookdb/fixture' }), []);
  for (const module of ['1chinook', 'a.b', 'a-b', 'a/b', '', 'a b']) {
    expectProblem(records({ module, address: `modelspec://github.com/datatug/chinookdb/${module}` }), /module must be a ModelSpec module name/);
  }
});

test('a model registered under a second id, or by the same address in another case, fails', () => {
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const data = fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture' });
  const model = (key, extra = {}) => ({ key, file: `models/$records/${key}.yaml`, data: { ...data, ...extra } });
  const maintainers = [{ key: 'trakhimenok' }];
  expectProblem(recordProblems({ models: [model('one'), model('two')], maintainers }), /address modelspec:\/\/github\.com\/datatug\/chinookdb\/fixture is registered under 2 ids \(one: .*, two: .*, compared ignoring case\)/);
  expectProblem(recordProblems({ models: [model('one'), model('two', { repository: 'https://github.com/Datatug/ChinookDB', address: 'modelspec://github.com/Datatug/ChinookDB/fixture' })], maintainers }), /is registered under 2 ids/);
  assert.deepEqual(recordProblems({ models: [model('one'), model('two', { module: 'other', address: 'modelspec://github.com/datatug/chinookdb/other' })], maintainers }), [], 'two modules of one repository are two models');
});

test('ids, formats, statuses, commit ids, licences and maintainers are checked', () => {
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const problems = (key, extra) => recordProblems({ models: [{ key, file: `models/$records/${key}.yaml`, data: fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', ...extra }) }], maintainers: [{ key: 'trakhimenok' }] });
  for (const id of ['Chinook', 'a_b', 'a--b', '-a', 'a-', 'a'.repeat(81), 'a.b']) expectProblem(problems(id, {}), /id ".*" must be lower-case letters, digits and single hyphens, at most 80 characters/);
  assert.deepEqual(problems('a'.repeat(80), {}), []);
  expectProblem(problems('x', { format: 'modelspec-registry/draft-2' }), /format must be modelspec-registry\/draft-1/);
  expectProblem(problems('x', { status: 'live' }), /status must be one of draft, published, deprecated/);
  for (const commit of ['abc', 'A'.repeat(40), 'a'.repeat(41), 'main', '--end-of-options', undefined]) expectProblem(problems('x', { commit }), /commit must be a full 40-character lower-case commit id/);
  for (const licence of ['', 'MIT License', '-MIT', undefined, 5]) expectProblem(problems('x', { licence }), /licence must be an SPDX licence identifier/);
  expectProblem(problems('x', { maintainers: ['nobody'] }), /maintainer nobody has no record in maintainers\/\$records\/nobody\.yaml/);
  expectProblem(problems('x', { maintainers: [] }), /maintainers must name at least one maintainer/);
  expectProblem(problems('x', { maintainers: undefined }), /maintainers must name at least one maintainer/);
  const stray = registry({}, { index: false });
  writeFileSync(join(stray, 'models', '$records', 'README.md'), 'x');
  writeFileSync(join(stray, 'models', '$records', 'bad.yaml'), 'a: [');
  expectProblem(check(stray).problems, /^models\/\$records\/README\.md: a record is a <key>\.yaml file/);
  expectProblem(check(stray).problems, /^models\/\$records\/bad\.yaml: not YAML/);
});

test('a model file path that is not a plain path inside the repository fails and never reaches git', () => {
  const marker = join(scratch, 'marker-path');
  const bad = ['../x.modelspec.hcl', 'model/../../x.modelspec.hcl', '/etc/x.modelspec.hcl', 'model/*.modelspec.hcl', 'model/?.modelspec.hcl', 'model/[a].modelspec.hcl', ':(top)x.modelspec.hcl', ':(glob)**/x.modelspec.hcl', './x.modelspec.hcl', 'model//x.modelspec.hcl', 'model/', 'x\\y.modelspec.hcl', 'x y.modelspec.hcl', `$(touch ${marker}).modelspec.hcl`, `x;touch ${marker}.modelspec.hcl`, '`touch x`.modelspec.hcl', '-x.modelspec.hcl/', '', undefined, 3];
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  for (const path of bad) {
    assert.equal(isRepositoryPath(path), false, String(path));
    const data = fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', source_file: path });
    expectProblem(recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data }], maintainers: [{ key: 'trakhimenok' }] }), /source_file: .* must be a relative path inside the repository/);
    assert.equal(wellFormed({ data }), false);
  }
  for (const path of ['model/fixture.modelspec.hcl', 'a.modelspec.hcl', 'a-b/c_d/e.f.modelspec.hcl']) assert.equal(isRepositoryPath(path), true, path);
  assert.equal(existsSync(marker), false);
  const records = (extra) => recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data: fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', ...extra }) }], maintainers: [{ key: 'trakhimenok' }] });
  expectProblem(records({ source_file: 'model/fixture.modelspec.json' }), /source_file: model\/fixture\.modelspec\.json must be a \*\.modelspec\.hcl file/);
  expectProblem(records({ json_file: 'model/fixture.modelspec.hcl' }), /json_file: model\/fixture\.modelspec\.hcl must be a \*\.modelspec\.json file/);
  expectProblem(records({ json_file: 'model/fixture.modelspec.hcl', source_file: 'model/fixture.modelspec.hcl' }), /source_file and json_file must be two different files/);
});

// ---- git: every refusal the hardening promises ---------------------------

test('a URL or revision shaped like a git option is never read as one', () => {
  const marker = join(scratch, 'marker-option');
  const attacks = [`--upload-pack=touch ${marker}`, `-oProxyCommand=touch ${marker}`, `--exec=touch ${marker}`, `-c core.sshCommand=touch ${marker}`];
  const source = modelOrigin('options');
  for (const attack of attacks) {
    assert.throws(() => defaultBranch(attack));
    assert.throws(() => openCommit(attack, source.commit, join(scratch, 'cache-option')), /cannot fetch/);
    assert.throws(() => onBranch(attack, 'main', source.commit, join(scratch, 'cache-option-history')), /cannot read the history/);
  }
  assert.equal(existsSync(marker), false);
  // A revision from a record cannot be an option either: only a full commit id is accepted.
  assert.throws(() => openCommit(origins.get(source.repository), '--upload-pack=x', join(scratch, 'cache-option')), /is not a full commit id/);
  assert.equal(onBranch(origins.get(source.repository), '--help', source.commit, join(scratch, 'cache-option-history')), false);
  assert.equal(onBranch(origins.get(source.repository), 'main', '--help', join(scratch, 'cache-option-history')), false);
});

test('git talks only the protocols it is allowed: a file URL is refused unless the tests allow it', () => {
  const source = modelOrigin('protocol');
  const url = origins.get(source.repository);
  assert.equal(gitEnv().GIT_ALLOW_PROTOCOL, 'https:file');
  setGitProtocols('https');
  try {
    assert.equal(gitEnv().GIT_ALLOW_PROTOCOL, 'https');
    assert.throws(() => openCommit(url, source.commit, join(scratch, 'cache-protocol')), /cannot fetch .*(not allowed|transport)/i);
    assert.throws(() => defaultBranch(url));
  } finally { setGitProtocols('https:file'); }
  assert.ok(openCommit(url, source.commit, join(scratch, 'cache-protocol')));
  setGitProtocols('https');
  try { assert.equal(gitEnv().GIT_ALLOW_PROTOCOL, 'https', 'the default is https only'); } finally { setGitProtocols('https:file'); }
});

test('the registry never reads global or system git configuration, nor inherited GIT_ variables', () => {
  // A global config that rewrites one https URL to a local repository. As a
  // positive control, plain git follows it; the registry's git does not.
  const source = modelOrigin('redirected');
  const cfg = join(scratch, `gitconfig-${count++}`);
  writeFileSync(cfg, `[url "${origins.get(source.repository)}"]\n\tinsteadOf = https://example.test/fixtures/not-there\n`);
  const plain = execFileSync('git', ['ls-remote', 'https://example.test/fixtures/not-there', 'HEAD'], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_ALLOW_PROTOCOL: 'https:file' } }).toString();
  assert.match(plain, /HEAD/, 'positive control: the rewrite works for a git that reads the config');
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_DIR: join(scratch, 'no-such-git-dir'), GIT_WORK_TREE: scratch, GIT_INDEX_FILE: join(scratch, 'no-index'), GIT_SSL_CAINFO: '/ca.pem', GIT_CONFIG_COUNT: '1' });
  try {
    const env = gitEnv();
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT']) assert.equal(name in env, false, `${name} is dropped`);
    assert.equal(env.GIT_SSL_CAINFO, '/ca.pem', 'TLS trust settings pass through');
    assert.throws(() => defaultBranch('https://example.test/fixtures/not-there'), 'the insteadOf rewrite is not applied');
    // An inherited GIT_DIR does not redirect the commands either.
    assert.ok(openCommit(origins.get(source.repository), source.commit, join(scratch, 'cache-env')));
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('pathspecs are literal, and a returned path must be the path asked for', () => {
  const source = origin('literal', { 'model/a.hcl': 'a', 'model/b.hcl': 'b' });
  // Positive control: git's default pathspecs expand a glob; the registry's git does not.
  assert.deepEqual(execFileSync('git', ['-C', source.dir, 'ls-files', '--', 'model/*.hcl']).toString().trim().split('\n'), ['model/a.hcl', 'model/b.hcl']);
  assert.equal(git(['-C', source.dir, 'ls-files', '--', 'model/*.hcl']), '');
  assert.equal(git(['-C', source.dir, 'ls-files', '--', ':(glob)model/**']), '');
  // lookup() refuses a glob or magic pathspec before it reaches git ...
  const view = openCommit(origins.get(source.repository), source.commit, join(scratch, 'cache-literal'));
  assert.equal(view.lookup('model/a.hcl'), 'file');
  for (const path of ['model/*.hcl', 'model/?.hcl', ':(glob)model/**', 'model']) {
    if (path === 'model') assert.equal(view.lookup(path), 'directory');
    else assert.throws(() => view.lookup(path), /is not a plain path inside the repository/);
  }
  assert.throws(() => view.read('model/*.hcl'), /is not a plain path/);
  assert.equal(view.lookup('model/missing.hcl'), 'missing');
  // ... and entryFor refuses anything but the one entry for exactly that path.
  const line = (path, mode = '100644', type = 'blob', id = 'a'.repeat(40)) => `${mode} ${type} ${id}\t${path}\0`;
  assert.equal(entryFor('model/a.hcl', ''), null);
  assert.deepEqual(entryFor('model/a.hcl', line('model/a.hcl')), { path: 'model/a.hcl', mode: '100644', type: 'blob', id: 'a'.repeat(40) });
  assert.throws(() => entryFor('model/a.hcl', line('model/b.hcl')), /git returned "model\/b\.hcl" for "model\/a\.hcl"; refusing/);
  assert.throws(() => entryFor('model/*.hcl', line('model/a.hcl') + line('model/b.hcl')), /refusing to use it/);
  assert.throws(() => entryFor('model/a.hcl', line('model/a.hcl') + line('model/a.hcl')), /refusing to use it/);
  assert.throws(() => entryFor('model/a.hcl', line('model/a.hcl', '100644', 'blob', 'not-an-object-id')), /refusing to use it/);
  assert.throws(() => entryFor('model/a.hcl', line('model/a.hcl', '100644', 'blob', '--help')), /refusing to use it/);
});

test('no registry script runs a shell or builds a command line from a string', () => {
  const files = [join(root, 'scripts'), join(root, 'scripts', 'lib')].flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'test.mjs' && name !== 'test-ingitdb.mjs').map((name) => join(dir, name)));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\bexecSync\b|\bspawnSync\b|\bspawn\(|(?<![.\w])exec\(|shell:\s*true|\bfork\(/, `${file} must only use execFileSync with an argument list`);
    for (const call of text.matchAll(/execFileSync\(([^,]+),/g)) assert.doesNotMatch(call[1], /`|\+|\$\{/, `${file}: execFileSync must be given a fixed command, not a built string`);
  }
});

// ---- the commit -----------------------------------------------------------

test('an unknown commit fails', () => {
  const source = modelOrigin('unknown-commit');
  expectProblem(problemsOf(source, { commit: '0c34c1a3e0616fa53810916503b3bf3c8a925800' }), /^models\/\$records\/fixture\.yaml: cannot fetch 0c34c1a3e0616fa53810916503b3bf3c8a925800 from file:/);
});

test('a commit that only a side branch has (a fork) fails, one on the default branch passes', () => {
  const source = modelOrigin('fork', { side: { 'model/other.txt': 'only on the side branch' } });
  assert.deepEqual(problemsOf(source), []);
  expectProblem(problemsOf(source, { commit: source.sideCommit }), /commit .* is not in the history of main, the default branch of https:\/\/example\.test\/fixtures\/fork \(a commit only a fork or another branch has\)/);
});

test('a record whose commit is on the default branch but not its tip still passes', () => {
  const source = modelOrigin('older');
  writeFileSync(join(source.dir, 'later.txt'), 'later');
  gitIn(source.dir, 'add', '-A');
  gitIn(source.dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'later');
  assert.notEqual(gitIn(source.dir, 'rev-parse', 'HEAD'), source.commit);
  assert.deepEqual(problemsOf(source), []);
});

// ---- the files ------------------------------------------------------------

test('a file that does not exist at the commit fails', () => {
  const source = modelOrigin('missing-files', { files: { 'model/fixture.modelspec.json': null } });
  expectProblem(problemsOf(source), /^models\/\$records\/fixture\.yaml: json_file: model\/fixture\.modelspec\.json does not exist at commit /);
  const noHcl = modelOrigin('missing-hcl', { files: { 'model/fixture.modelspec.hcl': null } });
  expectProblem(problemsOf(noHcl), /source_file: model\/fixture\.modelspec\.hcl does not exist at commit /);
  const none = modelOrigin('missing-both', { files: { 'model/fixture.modelspec.hcl': null, 'model/fixture.modelspec.json': null } });
  assert.equal(problemsOf(none).length, 2, 'both are reported');
});

test('a symbolic link, a submodule or a directory where a model file is expected fails', () => {
  const link = modelOrigin('link-json', { files: { 'model/fixture.modelspec.json': null, 'model/real.json': serializeModel(jsonFor('link-json')) }, symlinks: { 'model/fixture.modelspec.json': 'real.json' } });
  expectProblem(problemsOf(link), /json_file: model\/fixture\.modelspec\.json is not a regular file at commit .* \(a symbolic link or submodule\)/);
  const linkOut = modelOrigin('link-out', { files: { 'model/fixture.modelspec.hcl': null }, symlinks: { 'model/fixture.modelspec.hcl': '/etc/passwd' } });
  expectProblem(problemsOf(linkOut), /source_file: model\/fixture\.modelspec\.hcl is not a regular file at commit .* \(a symbolic link or submodule\)/);
  const submodule = modelOrigin('submodule', { files: { 'model/fixture.modelspec.json': null }, gitlinks: ['model/fixture.modelspec.json'] });
  expectProblem(problemsOf(submodule), /json_file: model\/fixture\.modelspec\.json is not a regular file at commit .* \(a symbolic link or submodule\)/);
  const directory = modelOrigin('directory', { files: { 'model/fixture.modelspec.hcl': null, 'model/fixture.modelspec.hcl/inner.txt': 'x' } });
  expectProblem(problemsOf(directory), /source_file: model\/fixture\.modelspec\.hcl is not a regular file at commit .* \(a directory\)/);
});

test('a file larger than the registry reads fails', () => {
  const source = modelOrigin('huge', { json: `${' '.repeat(maxFileBytes + 1)}{}` });
  expectProblem(problemsOf(source), /json_file: model\/fixture\.modelspec\.json is \d+ bytes, more than the 5242880 the registry reads/);
});

test('a file is read from the object store, so a tracked file is never checked out', () => {
  const source = modelOrigin('no-checkout');
  const view = openCommit(origins.get(source.repository), source.commit, join(scratch, 'cache-no-checkout'));
  const cached = readdirSync(join(scratch, 'cache-no-checkout')).filter((name) => !name.startsWith('.'));
  assert.equal(cached.length, 1);
  assert.equal(existsSync(join(scratch, 'cache-no-checkout', cached[0], 'model')), false, 'the cache is a bare repository');
  assert.match(view.read('model/fixture.modelspec.json'), /"modelspec": "1.0-draft"/);
  assert.deepEqual(view.rootNames().map((entry) => entry.name).sort(), ['LICENSE', 'model']);
});

// ---- the JSON AST ---------------------------------------------------------

const withJson = (name, change, options = {}) => {
  const json = jsonFor(name);
  change(json);
  return modelOrigin(name, { json, ...options });
};

test('a JSON file that is not JSON, or not an object, fails', () => {
  expectProblem(problemsOf(modelOrigin('not-json', { json: '{ nope' })), /fixture\.modelspec\.json is not JSON: /);
  expectProblem(problemsOf(modelOrigin('json-array', { json: '[]' })), /model\/fixture\.modelspec\.json: the JSON AST must be an object/);
  expectProblem(problemsOf(modelOrigin('json-null', { json: 'null' })), /the JSON AST must be an object/);
  expectProblem(problemsOf(modelOrigin('json-string', { json: '"x"' })), /the JSON AST must be an object/);
});

test('a JSON AST that breaks the structural checks of the ModelSpec specification fails', () => {
  const cases = [
    ['wrong-version', (json) => { json.modelspec = '2.0'; }, /modelspec must be "1.0-draft"/],
    ['no-module-id', (json) => { delete json.module.id; }, /module\.id and module\.version are required/],
    ['no-module-version', (json) => { delete json.module.version; }, /module\.id and module\.version are required/],
    ['module-not-object', (json) => { json.module = 'x'; }, /module must be an object/],
    ['entities-array', (json) => { json.entities = []; }, /entities must be an object keyed by name/],
    ['entity-no-properties', (json) => { delete json.entities.Artist.properties; }, /entities Artist must be an object with properties/],
    ['property-not-object', (json) => { json.entities.Artist.properties.Name = 'string'; }, /Artist\.Name must be an object/],
    ['key-not-list', (json) => { json.entities.Artist.key = 'ArtistId'; }, /entity Artist key must be a list of property names/],
    ['no-key', (json) => { delete json.entities.Artist.key; }, /entity Artist needs a key/],
    ['key-not-property', (json) => { json.entities.Artist.key = ['Nope']; }, /entity Artist key Nope is not a property/],
    ['unknown-entity', (json) => { json.entities.Album.properties.ArtistId.entity = 'Nope'; }, /Album\.ArtistId references unknown entity Nope/],
    ['unknown-type', (json) => { json.entities.Artist.properties.Name.type = 'varchar'; }, /Artist\.Name has unsupported type "varchar"/],
    ['two-kinds', (json) => { json.entities.Artist.properties.Name.entity = 'Album'; }, /Artist\.Name must have exactly one of type, entity, component/],
    ['unknown-attribute', (json) => { json.entities.Artist.properties.Name.colour = 'blue'; }, /Artist\.Name has unsupported attribute colour/],
    ['bad-constraint', (json) => { json.entities.Artist.properties.Name.max_len = -1; }, /Artist\.Name\.max_len must be a non-negative integer/],
    ['unknown-component', (json) => { json.entities.Artist.use = ['Nope']; }, /entity Artist references unknown component Nope/],
    ['reserved-name', (json) => { json.entities.entities = json.entities.Artist; }, /entities is a reserved name/],
    ['dotted-name', (json) => { json.entities['a.b'] = json.entities.Artist; }, /a\.b: concept names cannot contain dots/],
    ['empty-enum', (json) => { json.enums = { Colour: { values: [] } }; }, /enum Colour needs a non-empty values list/],
    ['duplicate-enum-value', (json) => { json.enums = { Colour: { values: ['red', 'red'] } }; }, /enum Colour has duplicate values/],
    ['entity-and-enum', (json) => { json.enums = { Artist: { values: ['a'] } }; }, /Artist is declared as both entities and enums/],
    ['qualified-reference', (json) => { json.entities.Album.properties.ArtistId.entity = 'core.Artist'; }, /Album\.ArtistId names entity core\.Artist of another module; the registry cannot resolve module-qualified references yet/],
    ['no-entities', (json) => { json.entities = {}; }, /a registered model has at least one entity/],
  ];
  for (const [name, change, pattern] of cases) {
    const problems = problemsOf(withJson(`ast-${name}`, change));
    expectProblem(problems, pattern);
    assert.match(problems[0], /^models\/\$records\/fixture\.yaml: /);
  }
});

test('the module the files declare must be the module in the record and the address', () => {
  expectProblem(problemsOf(withJson('module-name', (json) => { json.module.name = 'other'; })), /module is fixture, but model\/fixture\.modelspec\.json declares module\.name "other"/);
  expectProblem(problemsOf(withJson('module-id-host', (json) => { json.module.id = 'github.com/other/repo/model/fixture'; })), /declares module\.id "github\.com\/other\/repo\/model\/fixture", which must start with example\.test\/fixtures\/module-id-host\/ and end with \/fixture/);
  expectProblem(problemsOf(withJson('module-id-last', (json) => { json.module.id = 'example.test/fixtures/module-id-last/model/other'; })), /module\.id .* must start with example\.test\/fixtures\/module-id-last\/ and end with \/fixture/);
  expectProblem(problemsOf(withJson('module-id-type', (json) => { json.module.id = 7; })), /module\.id 7/);
  expectProblem(problemsOf(withJson('module-id-bare', (json) => { json.module.id = 'fixture'; })), /module\.id "fixture"/);
  // The record says another module than the files declare.
  const source = modelOrigin('record-module');
  expectProblem(problemsOf(source, { module: 'other', address: 'modelspec://example.test/fixtures/record-module/other' }), /module is other, but model\/fixture\.modelspec\.json declares module\.name "fixture"/);
  // Case in the repository part of module.id does not matter; the module name's case does.
  assert.deepEqual(problemsOf(withJson('Module-Id-Case', (json) => { json.module.id = 'EXAMPLE.test/fixtures/Module-Id-Case/model/fixture'; }), {}), []);
});

// ---- the HCL source -------------------------------------------------------

test('a JSON AST that is not what the HCL source says fails', () => {
  const cases = [
    ['type', (json) => { json.entities.Artist.properties.Name.type = 'int'; }, /entities\.Artist\.properties\.Name\.type is "string" in the HCL source but "int" in the JSON AST/],
    ['max-len', (json) => { json.entities.Artist.properties.Name.max_len = 99; }, /Name\.max_len is 120 in the HCL source but 99 in the JSON AST/],
    ['required', (json) => { json.entities.Artist.properties.Name.required = true; }, /Name\.required is in the JSON AST but not in the HCL source/],
    ['required-dropped', (json) => { delete json.entities.Artist.properties.ArtistId.required; }, /ArtistId\.required is in the HCL source but not in the JSON AST/],
    ['entity-removed', (json) => { delete json.entities.Album; }, /entities\.Album is in the HCL source but not in the JSON AST/],
    ['entity-added', (json) => { json.entities.Extra = { key: ['id'], properties: { id: { type: 'int' } } }; }, /entities\.Extra is in the JSON AST but not in the HCL source/],
    ['property-added', (json) => { json.entities.Artist.properties.Extra = { type: 'string' }; }, /entities\.Artist\.properties\.Extra is in the JSON AST but not in the HCL source/],
    ['property-removed', (json) => { delete json.entities.Artist.properties.Name; }, /entities\.Artist\.properties\.Name is in the HCL source but not in the JSON AST/],
    ['reference', (json) => { json.entities.Album.properties.ArtistId = { type: 'int', required: true }; }, /entities\.Album\.properties\.ArtistId\.entity is in the HCL source but not in the JSON AST/],
    ['key', (json) => { json.entities.Album.key = ['AlbumId', 'ArtistId']; }, /entities\.Album\.key is \["AlbumId"\] in the HCL source but \["AlbumId","ArtistId"\] in the JSON AST/],
    ['enums', (json) => { json.enums = { Colour: { values: ['red'] } }; }, /enums is in the JSON AST but not in the HCL source/],
  ];
  for (const [name, change, pattern] of cases) {
    expectProblem(problemsOf(withJson(`hcl-${name}`, change)), new RegExp(`model/fixture\\.modelspec\\.json does not match model/fixture\\.modelspec\\.hcl: .*${pattern.source}`));
  }
  // The order of names, the module and the layout of the JSON do not matter.
  const json = jsonFor('hcl-reordered');
  const reordered = { entities: Object.fromEntries(Object.entries(json.entities).reverse().map(([name, entity]) => [name, { properties: Object.fromEntries(Object.entries(entity.properties).reverse()), key: entity.key }])), module: { ...json.module, version: '9.9.9' }, modelspec: json.modelspec };
  assert.deepEqual(problemsOf(modelOrigin('hcl-reordered', { json: JSON.stringify(reordered) })), []);
});

test('only the first differences are listed, with a count of the rest', () => {
  const problems = problemsOf(withJson('hcl-many', (json) => { for (let i = 0; i < 15; i++) json.entities.Artist.properties[`P${i}`] = { type: 'string' }; }));
  assert.equal(problems.filter((problem) => /does not match/.test(problem)).length, 11);
  expectProblem(problems, /does not match model\/fixture\.modelspec\.hcl: 5 more differences$/);
});

test('an HCL source the registry cannot read fails, never guessed at', () => {
  const unreadable = [
    ['syntax', fixtureHcl.replace('type     = "int"', 'type     = '), /line \d+: /],
    ['unterminated', 'entity "A" {', /line EOF: expected/],
    ['expression', fixtureHcl.replace('entity   = "Artist"', 'entity   = var.x'), /line \d+: unexpected character "\."/],
    ['interpolation', fixtureHcl.replace('max_len = 120', 'pattern = "${var.x}"'), /string interpolation is not ModelSpec v0/],
    ['map-style', 'entity "A" {\n  key = ["id"]\n  properties = { id = { type = "int" } }\n}\n', /map-style values are not ModelSpec v0 syntax/],
    ['collection', `${fixtureHcl}\ncollection "artists" {\n  kind = "editable"\n  source = "Artist"\n}\n`, /top-level collection blocks are not supported by this converter/],
    ['recordset', `${fixtureHcl}\nrecordset "r" {\n  key = ["id"]\n}\n`, /top-level recordset blocks are not supported/],
    ['bare-identifier', fixtureHcl.replace('entity   = "Artist"', 'entity   = Artist'), /line \d+: Artist is not a literal \(expressions are not ModelSpec v0\)/],
    ['top-level-attribute', `x = 1\n${fixtureHcl}`, /top-level attributes are not ModelSpec v0/],
    ['duplicate-entity', `${fixtureHcl}\nentity "Artist" {\n  key = ["ArtistId"]\n  property "ArtistId" {\n    type = "int"\n  }\n}\n`, /duplicate entity "Artist"/],
    ['duplicate-property', fixtureHcl.replace('property "Name" {', 'property "ArtistId" {'), /duplicate property "ArtistId" in entity "Artist"/],
  ];
  for (const [name, hcl, pattern] of unreadable) {
    // The JSON is generated from the good source, so only the HCL is wrong.
    const source = modelOrigin(`unreadable-${name}`, { hcl, json: jsonFor(`unreadable-${name}`) });
    expectProblem(problemsOf(source), new RegExp(`^models/\\$records/fixture\\.yaml: model/fixture\\.modelspec\\.hcl: .*(?:${pattern.source})`));
  }
});

test('the ModelSpec converter and checks do what the specification says', () => {
  const json = jsonFor('spec');
  assert.deepEqual(validateModel(json), []);
  assert.deepEqual(astDifferences(json, json), []);
  assert.deepEqual(astDifferences({ ...json, module: { id: 'a', name: 'a', version: '1' } }, json), [], 'module is ignored');
  assert.deepEqual(describeEntities({ entities: { A: { key: ['x', 'y'], use: ['C'], properties: { x: { type: 'int', required: true }, y: { entity: 'B' }, z: { component: 'C' } } } } }), [
    { name: 'A', key: ['x', 'y'], properties: [{ name: 'x', type: 'int', required: true, key: true }, { name: 'y', type: 'reference', references: 'B', required: false, key: true }, { name: 'z', type: 'component', component: 'C', required: false, key: false }] },
  ]);
  // Components and named enums round-trip through the converter and validate.
  const rich = toModelspecJson(parseHcl('component "Audit" {\n  field "at" {\n    type = "datetime"\n  }\n}\nenum "Colour" {\n  values = ["red", "green"]\n}\nentity "Thing" {\n  key = ["id"]\n  use = ["Audit"]\n  property "id" {\n    type = "uuid"\n  }\n  property "colour" {\n    type = "string"\n    enum = "Colour"\n  }\n}\n'), moduleFor('spec'));
  assert.deepEqual(validateModel(rich), []);
});

// ---- licences -------------------------------------------------------------

test('licences: the record must state the licence the files carry', () => {
  assert.equal(declaredLicence('# Licence: MIT (https://x)\nentity'), 'MIT');
  assert.equal(declaredLicence('// SPDX-License-Identifier: Apache-2.0\n'), 'Apache-2.0');
  assert.equal(declaredLicence('# License: CC0-1.0\n'), 'CC0-1.0');
  assert.equal(declaredLicence('entity "A" {\n}\n'), null);
  assert.equal(declaredLicence(`${'\n'.repeat(10)}# Licence: MIT`), null, 'only the first lines count');

  // The record says Apache-2.0, the HCL says MIT, the repository's LICENSE says MIT.
  const source = modelOrigin('licence-differs');
  const problems = problemsOf(source, { licence: 'Apache-2.0' });
  expectProblem(problems, /licence is Apache-2\.0, but model\/fixture\.modelspec\.hcl declares MIT/);
  expectProblem(problems, /licence is Apache-2\.0, but model\/fixture\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);

  // The HCL declares nothing: it takes the repository's default, like the JSON.
  const undeclared = fixtureHcl.replace('# Licence: MIT\n', '');
  assert.deepEqual(problemsOf(modelOrigin('licence-default', { hcl: undeclared })), []);
  expectProblem(problemsOf(modelOrigin('licence-default-differs', { hcl: undeclared }), { licence: 'CC0-1.0' }), /licence is CC0-1\.0, but model\/fixture\.modelspec\.hcl declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);

  // The HCL declares MIT, but the repository (and so the JSON) is Apache-2.0.
  const apache = 'Apache License\n Version 2.0, January 2004\n';
  expectProblem(problemsOf(modelOrigin('licence-json-differs', { licence: apache })), /licence is MIT, but model\/fixture\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is Apache-2\.0/);

  // No LICENSE file, or one the check does not recognise: the JSON cannot declare one.
  expectProblem(problemsOf(modelOrigin('licence-none', { licence: null })), /model\/fixture\.modelspec\.json declares no licence, and the repository's LICENSE files name no licence the check recognises; a JSON file cannot declare one/);
  expectProblem(problemsOf(modelOrigin('licence-unknown', { licence: 'Some custom terms\n' })), /LICENSE file names no licence the check recognises/);
  expectProblem(problemsOf(modelOrigin('licence-hcl-none', { hcl: undeclared, licence: null })), /model\/fixture\.modelspec\.hcl declares no licence, and the repository's LICENSE files name no licence the check recognises; the file must declare its licence/);

  // Several licence files and no unsuffixed one are ambiguous; an unsuffixed LICENSE wins over suffixed ones.
  expectProblem(problemsOf(modelOrigin('licence-ambiguous', { licence: null, files: { 'LICENSE-MIT': mit, 'LICENSE-CC0': cc0 } })), /LICENSE files name several \((MIT, CC0-1\.0|CC0-1\.0, MIT)\)/);
  assert.deepEqual(problemsOf(modelOrigin('licence-suffixed', { files: { 'LICENSE-CC0': cc0 } })), [], 'the unsuffixed LICENSE is the default, as in datatug/chinookdb');
  // A LICENSE that is a symbolic link is the default but is not read.
  expectProblem(problemsOf(modelOrigin('licence-link', { licence: null, files: { 'real-license': mit }, symlinks: { LICENSE: 'real-license' } })), /LICENSE file names no licence the check recognises/);
});

// ---- index.json -----------------------------------------------------------

test('index.json is missing, stale, or edited: the check fails', () => {
  const source = modelOrigin('indexed');
  const record = fixtureRecord(source);
  const dir = registry({ fixture: record });
  assert.deepEqual(check(dir).problems, []);
  const indexPath = join(dir, 'index.json');
  const index = readFileSync(indexPath, 'utf8');

  rmSync(indexPath);
  expectProblem(check(dir).problems, /^index\.json is missing; run npm run index and commit it/);
  writeFileSync(indexPath, index.replace('"draft"', '"published"'));
  expectProblem(check(dir).problems, /^index\.json differs from the records and the models they pin; run npm run index and commit it/);
  writeFileSync(indexPath, index.replace('"Artist"', '"Artists"'));
  expectProblem(check(dir).problems, /^index\.json differs/);
  writeFileSync(indexPath, index.trimEnd());
  expectProblem(check(dir).problems, /^index\.json differs/);
  writeFileSync(indexPath, index);
  assert.deepEqual(check(dir).problems, []);
  // A change to the record, with no new index, is stale too.
  writeFileSync(join(dir, 'models', '$records', 'fixture.yaml'), stringifyYaml({ ...record, title: 'Renamed' }));
  expectProblem(check(dir).problems, /^index\.json differs/);
});

test('index.json is not compared while a model has problems, and a broken model is never indexed', () => {
  const source = modelOrigin('index-broken', { files: { 'model/fixture.modelspec.json': null } });
  const dir = registry({ fixture: fixtureRecord(source) }, { index: false });
  writeFileSync(join(dir, 'index.json'), buildIndex([]));
  const { problems } = check(dir);
  assert.equal(problems.length, 1);
  expectProblem(problems, /does not exist at commit/);
  assert.deepEqual(loadModels(options(dir)).entries, []);
});

test('buildIndex is deterministic: sorted by id, the checksum is the sha256 of the compact models', () => {
  const a = modelOrigin('index-a');
  const b = modelOrigin('index-b');
  const dir = registry({ zeta: fixtureRecord(a), alpha: fixtureRecord(b) });
  const { entries } = loadModels(options(dir));
  const written = buildIndex(entries);
  assert.equal(buildIndex([...entries].reverse()), written, 'record order does not matter');
  assert.equal(buildIndex(loadModels(options(dir)).entries), written, 'a second run is byte-identical');
  assert.equal(written, readFileSync(join(dir, 'index.json'), 'utf8'));
  const index = JSON.parse(written);
  assert.deepEqual(index.models.map((model) => model.id), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(index), ['format', 'checksum', 'models']);
  assert.equal(index.format, 'modelspec-registry/draft-1');
  assert.equal(index.checksum, `sha256:${createHash('sha256').update(JSON.stringify(index.models)).digest('hex')}`);
  assert.match(index.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.ok(written.endsWith('}\n'));
  assert.deepEqual(Object.keys(index.models[0]), ['id', 'title', 'description', 'status', 'address', 'repository', 'commit', 'module', 'module_id', 'module_version', 'modelspec', 'licence', 'files', 'maintainers', 'entities']);
  // The checksum covers the models: change one and it changes.
  const changed = JSON.parse(written);
  changed.models[0].commit = 'f'.repeat(40);
  assert.notEqual(`sha256:${createHash('sha256').update(JSON.stringify(changed.models)).digest('hex')}`, index.checksum);
  assert.equal(buildIndex([]).includes('"models": []'), true);
});

test('a second model of the same repository is a second entry', () => {
  const source = modelOrigin('two-modules', { files: { 'model/other.modelspec.hcl': fixtureHcl, 'model/other.modelspec.json': serializeModel(toModelspecJson(parseHcl(fixtureHcl), { id: 'example.test/fixtures/two-modules/model/other', name: 'other', version: '0.1.0' })) } });
  const dir = registry({
    fixture: fixtureRecord(source),
    other: fixtureRecord(source, { module: 'other', address: 'modelspec://example.test/fixtures/two-modules/other', source_file: 'model/other.modelspec.hcl', json_file: 'model/other.modelspec.json' }),
  });
  assert.deepEqual(check(dir).problems, []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).models.map((model) => model.address), ['modelspec://example.test/fixtures/two-modules/fixture', 'modelspec://example.test/fixtures/two-modules/other']);
});
