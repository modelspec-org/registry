// Tests for the registry checks (CC0-1.0), offline. Each test builds a registry
// in a temporary directory, with local git repositories that stand in for
// https URLs (https://example.test/fixtures/<name>), breaks one thing, and
// expects the check to name it. The real Chinook record is checked against
// GitHub by `npm run check`, not here; its files are copied into
// scripts/fixtures/chinookdb so that the checks run on the real model offline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { addressOf, cacheRepoSound, defaultBranch, defaultCacheDir, entryFor, gitEnv, git, historyPath, isRepositoryPath, maxFileBytes, onBranch, openCommit, repositoryHosts, repositoryKey, setGitProtocols, trackedCacheProblems } from './lib/git.mjs';
import { astDifferences, describeModel, hclUsesEarlier, parseHcl, parseJson, serializeModel, toModelspecJson, validateModel, vocabularies, vocabularyOf } from './lib/modelspec.mjs';
import { homepageProblem, maxHomepageLength, publicHttpsProblem } from './lib/urls.mjs';
import { lintArguments, specscoreBinary, verifiedArchive } from './lib/specscore.mjs';
import { buildIndex, checkRegistry, checkReport, declaredLicence, earlierSpellingNotice, loadModels, readRegistry, recordProblems, registryFormat, sourceNotices, wellFormed } from './lib/registry.mjs';

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

// Every git call of this suite runs in gitEnv(): no GIT_ variable, and neither the user's nor the
// system's git configuration (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1), so a fixture
// commit never meets commit.gpgsign, a hook or an alias of whoever runs the tests.
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: gitEnv() }).toString().trim();
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
  // So that a --filter=tree:0 clone of it really is a partial clone, as one of GitHub's is.
  gitIn(dir, 'config', 'uploadpack.allowFilter', 'true');
  gitIn(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
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
// The same model in the current spelling, as `modelspec rewrite` writes it.
const currentHcl = fixtureHcl.replaceAll('entity "', 'record "').replaceAll('property "', 'field "').replace('entity   =', 'record   =');
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
  cpSync(join(root, 'models', '.collection'), join(dir, 'models', '.collection'), { recursive: true });
  for (const name of ['.ingitdb', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  for (const [id, record] of Object.entries(records)) writeFileSync(join(dir, 'models', '$records', `${id}.yaml`), stringifyYaml(record));
  if (index) writeFileSync(join(dir, 'index.json'), buildIndex(loadModels(options(dir)).entries));
  return dir;
}
// Branch histories are fetched once per registry directory, not once per test.
const options = (dir) => ({ root: dir, urlFor, cacheDir, fetched: new Set(), branches: new Map() });
const check = (dir) => checkRegistry(options(dir));
const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`);
// What recordProblems needs besides the models: the maintainers and the columns the committed
// collection definitions declare.
const context = { maintainers: [{ key: 'trakhimenok', file: 'maintainers/$records/trakhimenok.yaml', data: { name: 'A' } }], columns: readRegistry(root).columns };
const checkRecords = (records) => check(registry(records, { index: false })).problems.filter((problem) => !/index\.json/.test(problem));
// The problems of one fixture model repository.
const problemsOf = (source, extra) => checkRecords({ fixture: fixtureRecord(source, extra) });

// ---- the registry as committed --------------------------------------------

test('the committed records are well formed and the committed index.json is consistent', () => {
  const committed = readRegistry(root);
  assert.deepEqual(committed.problems, []);
  assert.deepEqual(recordProblems(committed), []);
  const recordKeys = readdirSync(join(root, 'models', '$records'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();
  assert.deepEqual(committed.models.map((model) => model.key), recordKeys);
  const { data } = committed.models.find((model) => model.key === 'chinook');
  assert.equal(data.address, 'modelspec://github.com/demo-db/chinook/chinook');
  assert.equal(data.repository, 'https://github.com/demo-db/chinook');
  assert.equal(data.commit, '3e7bb316d8a438eb7e5930067997a4e4543a275c');
  assert.equal(data.module, 'chinook');
  assert.equal(data.status, 'draft');
  assert.equal(data.homepage, 'https://chinook.demodb.dev/model/');
  assert.deepEqual([data.source_file, data.json_file], ['model/chinook.modelspec.hcl', 'model/chinook.modelspec.json']);
  assert.ok(wellFormed(committed.models[0]));
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  assert.equal(index.format, 'modelspec-registry/draft-1');
  assert.equal(index.checksum, `sha256:${createHash('sha256').update(JSON.stringify(index.models)).digest('hex')}`);
  const chinook = index.models.find((model) => model.id === 'chinook');
  assert.ok(chinook, 'the Chinook provider appears in the generated index');
  assert.deepEqual([chinook.id, chinook.address, chinook.repository, chinook.commit, chinook.licence], ['chinook', data.address, data.repository, data.commit, 'MIT']);
  assert.deepEqual(chinook.files, { source: data.source_file, json: data.json_file });
  assert.equal(chinook.homepage, data.homepage);
  assert.equal(chinook.records.length, 11);
  const pubs = committed.models.find((model) => model.key === 'pubs');
  assert.ok(pubs, 'the Pubs provider has a committed model record');
  assert.equal(pubs.data.commit, 'e99ca33330a043e23b2c5a665356fb8ad8d0b508');
  assert.equal(pubs.data.module, 'pubs');
  assert.deepEqual([pubs.data.source_file, pubs.data.json_file], ['model/pubs.modelspec.hcl', 'model/pubs.modelspec.json']);
  const pubsIndex = index.models.find((model) => model.id === 'pubs');
  assert.ok(pubsIndex, 'the Pubs provider appears in the generated index');
  assert.equal(pubsIndex.records.length, 11, 'every native Pubs table is represented');
  for (const name of ['discounts', 'roysched']) {
    const record = pubsIndex.records.find((candidate) => candidate.name === name);
    assert.ok(record, `${name} remains a record type in the index`);
    assert.deepEqual(record.key, [], `${name} has no fabricated ModelSpec key`);
  }
  const sakila = committed.models.find((model) => model.key === 'sakila');
  assert.ok(sakila, 'the Sakila provider has a committed model record');
  assert.deepEqual(
    [sakila.data.address, sakila.data.repository, sakila.data.commit, sakila.data.module, sakila.data.licence],
    ['modelspec://github.com/demo-db/sakila/sakila', 'https://github.com/demo-db/sakila', '113e54ad83c3e003a4fd195c893f2b19a921435c', 'sakila', 'BSD-3-Clause'],
  );
  const sakilaIndex = index.models.find((model) => model.id === 'sakila');
  assert.ok(sakilaIndex, 'the Sakila provider appears in the generated index');
  assert.equal(sakilaIndex.records.length, 16, 'every physical Sakila table has a record type');
  assert.deepEqual(sakilaIndex.files, { source: sakila.data.source_file, json: sakila.data.json_file });
  assert.equal(readFileSync(join(root, 'index.json'), 'utf8'), `${JSON.stringify(index, null, 2)}\n`, 'index.json is written the way buildIndex writes it');
});

// The shape the index promises, whatever the writer: every model lists `records` and
// `components` as arrays, every record type and every component lists `fields` as an
// array (an empty one when it has no member), and no key of the earlier spelling
// (`entities`, `properties`, `entity`) appears anywhere, in the parsed index or in its text.
function indexShapeProblems(index, text = JSON.stringify(index)) {
  const problems = [];
  for (const word of ['entities', 'properties', 'entity']) {
    if (text.includes(`"${word}":`)) problems.push(`the key "${word}" of the earlier spelling appears in the index`);
  }
  index.models.forEach((model, m) => {
    const where = `models[${m}] (${model.id})`;
    for (const list of ['records', 'components']) {
      if (!Array.isArray(model[list])) problems.push(`${where}: "${list}" is not an array`);
    }
    for (const list of ['records', 'components']) {
      (model[list] ?? []).forEach((member, i) => {
        if (!Array.isArray(member.fields)) problems.push(`${where}.${list}[${i}] (${member.name}): "fields" is not an array`);
      });
    }
  });
  return problems;
}

test('the whole committed index.json holds only the current keys: records and fields, on every model, record type and component', () => {
  const text = readFileSync(join(root, 'index.json'), 'utf8');
  const index = JSON.parse(text);
  assert.ok(index.models.length >= 9);
  assert.deepEqual(indexShapeProblems(index, text), []);
  // The assertion can fail: each of these faults is named.
  const clone = () => JSON.parse(text);
  const underEarlierKey = clone();
  underEarlierKey.models[2].entities = underEarlierKey.models[2].records;
  delete underEarlierKey.models[2].records;
  assert.match(indexShapeProblems(underEarlierKey).join('\n'), /"entities" of the earlier spelling/);
  assert.match(indexShapeProblems(underEarlierKey).join('\n'), /"records" is not an array/);
  const thirdProperties = clone();
  thirdProperties.models[0].records[2].properties = thirdProperties.models[0].records[2].fields;
  delete thirdProperties.models[0].records[2].fields;
  assert.match(indexShapeProblems(thirdProperties).join('\n'), /"properties" of the earlier spelling/);
  assert.match(indexShapeProblems(thirdProperties).join('\n'), /records\[2\] .*"fields" is not an array/);
  const noFields = clone();
  delete noFields.models[1].records[3].fields;
  assert.match(indexShapeProblems(noFields).join('\n'), /records\[3\] .*"fields" is not an array/);
});

test('describeModel lists fields on every record type and component, in either spelling, including one with no member', () => {
  const earlierSource = 'component "Empty" {\n}\nentity "A" {\n  property "x" {\n    type = "int"\n  }\n}\nentity "B" {\n  property "x" {\n    type = "int"\n  }\n}\nentity "C" {\n  property "x" {\n    entity = "A"\n  }\n}\nentity "D" {\n}\nentity "E" {\n  property "x" {\n    type = "int"\n  }\n}\n';
  const currentSource = earlierSource.replaceAll('entity "', 'record "').replaceAll('property "', 'field "').replaceAll('entity =', 'record =');
  assert.notEqual(currentSource, earlierSource);
  for (const source of [earlierSource, currentSource]) {
    const described = describeModel(parseHcl(source));
    assert.equal(described.records.length, 5);
    assert.deepEqual(described.records[3], { name: 'D', key: [], use: [], fields: [] }, 'a record type with no member still lists fields');
    assert.deepEqual(described.components, [{ name: 'Empty', fields: [] }]);
    const text = JSON.stringify({ models: [{ id: 'x', ...described }] });
    assert.deepEqual(indexShapeProblems(JSON.parse(text), text), []);
    assert.deepEqual(Object.keys(described), ['records', 'components']);
    for (const record of described.records) assert.deepEqual(Object.keys(record), ['name', 'key', 'use', 'fields']);
  }
});

test('the real Chinook model files pass every model check', () => {
  const source = origin('chinook-real', { 'model/chinook.modelspec.hcl': readFileSync(join(fixtures, 'model', 'chinook.modelspec.hcl')), 'model/chinook.modelspec.json': readFileSync(join(fixtures, 'model', 'chinook.modelspec.json')), LICENSE: readFileSync(join(fixtures, 'LICENSE')) });
  const json = JSON.parse(readFileSync(join(fixtures, 'model', 'chinook.modelspec.json'), 'utf8'));
  const record = fixtureRecord(source, { address: `modelspec://example.test/fixtures/chinook-real/chinook`, module: 'chinook', source_file: 'model/chinook.modelspec.hcl', json_file: 'model/chinook.modelspec.json' });
  // The fixture's module.id names the real repository, so the real files are
  // checked as that repository: a record for it, served from the local copy.
  origins.set('https://github.com/demo-db/chinook', origins.get(source.repository));
  const real = { ...record, address: 'modelspec://github.com/demo-db/chinook/chinook', repository: 'https://github.com/demo-db/chinook' };
  const dir = registry({ chinook: real });
  const { problems, entries } = loadModels(options(dir));
  assert.deepEqual(problems, []);
  assert.equal(json.module.id, 'github.com/demo-db/chinook/model/chinook');
  assert.deepEqual(entries[0].records.map((record) => record.name), ['Artist', 'Album', 'Track', 'Genre', 'MediaType', 'Playlist', 'PlaylistTrack', 'Customer', 'Employee', 'Invoice', 'InvoiceLine']);
  assert.deepEqual(check(dir).problems, []);
});

test('a well-formed fixture model passes, so the failures below are about what each test broke', () => {
  const source = modelOrigin('fine');
  const dir = registry({ fine: fixtureRecord(source) });
  assert.deepEqual(check(dir).problems, []);
  const { entries } = loadModels(options(dir));
  assert.deepEqual(entries[0].components, []);
  assert.deepEqual(entries[0].records, [
    { name: 'Artist', key: ['ArtistId'], use: [], fields: [{ name: 'ArtistId', type: 'int', required: true, key: true }, { name: 'Name', type: 'string', required: false, key: false }] },
    { name: 'Album', key: ['AlbumId'], use: [], fields: [{ name: 'AlbumId', type: 'int', required: true, key: true }, { name: 'ArtistId', type: 'reference', references: 'Artist', required: true, key: false }] },
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
    expectProblem(recordProblems({ models: [record], ...context }), /repository must be an https URL of a repository on/);
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
  const records = (extra) => recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data: fixtureRecord(source, extra) }], ...context });
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
  const maintainers = context.maintainers;
  expectProblem(recordProblems({ models: [model('one'), model('two')], ...context }), /address modelspec:\/\/github\.com\/datatug\/chinookdb\/fixture is registered under 2 ids \(one: .*, two: .*, compared ignoring case\)/);
  expectProblem(recordProblems({ models: [model('one'), model('two', { repository: 'https://github.com/Datatug/ChinookDB', address: 'modelspec://github.com/Datatug/ChinookDB/fixture' })], ...context }), /is registered under 2 ids/);
  assert.deepEqual(recordProblems({ models: [model('one'), model('two', { module: 'other', address: 'modelspec://github.com/datatug/chinookdb/other' })], ...context }), [], 'two modules of one repository are two models');
});

test('ids, formats, statuses, commit ids, licences and maintainers are checked', () => {
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const problems = (key, extra) => recordProblems({ models: [{ key, file: `models/$records/${key}.yaml`, data: fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', ...extra }) }], ...context });
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

test('a homepage is optional: with one it is checked and indexed, without one the entry has none', () => {
  const source = modelOrigin('homed');
  const withHomepage = registry({ homed: fixtureRecord(source, { homepage: 'https://models.example.com/fixture/' }) });
  assert.deepEqual(check(withHomepage).problems, []);
  const [entry] = loadModels(options(withHomepage)).entries;
  assert.equal(entry.homepage, 'https://models.example.com/fixture/');
  assert.deepEqual(Object.keys(entry).slice(0, 5), ['id', 'title', 'description', 'status', 'homepage']);
  assert.match(readFileSync(join(withHomepage, 'index.json'), 'utf8'), /^ {6}"homepage": "https:\/\/models\.example\.com\/fixture\/",$/m);
  const without = registry({ plain: fixtureRecord(source) });
  assert.deepEqual(check(without).problems, []);
  const [plain] = loadModels(options(without)).entries;
  assert.equal('homepage' in plain, false);
  assert.doesNotMatch(readFileSync(join(without, 'index.json'), 'utf8'), /homepage/);
  // The checksum covers the entry, so a homepage added to a record with no new index is stale.
  writeFileSync(join(without, 'models', '$records', 'plain.yaml'), stringifyYaml(fixtureRecord(source, { homepage: 'https://models.example.com/fixture/' })));
  expectProblem(check(without).problems, /^index\.json differs/);
});

// What a homepage is allowed to be, as README.md states it for index.json.
const legitimateHomepages = [
  'https://chinook.demodb.dev/model/',
  'https://example.com/',
  'https://models.example.com/fixture/',
  'https://github.com/datatug/chinookdb/',
  'https://datatug.github.io/chinookdb/model',
  'https://en.wikipedia.org/wiki/Chinook_database',
  'https://xn--mnchen-3ya.de/',
  'https://a.b.c.example.org/x/',
  'https://example.co.uk/a/b-c_d.e~f',
  'https://example.com/docs/v1.2/index.html',
  'https://sub-domain.example.com/',
  'https://a--b.example.com/',
  'https://1.example.com/',
  'https://example.com/CamelCase/Path',
  'https://www.modelspec.org/registry/chinook/',
  'https://x.io/',
  `https://example.com/${'a'.repeat(200 - 'https://example.com/'.length)}`,
];
// Spellings that the first version of the check let through and that are refused now, with the reason.
const nowRefusedHomepages = {
  'https://en.wikipedia.org/wiki/Chinook_(database)': /character outside A-Z a-z 0-9 \. _ ~ \/ - in its path/, // parentheses are outside the path set
  'https://example.com/it%27s': /percent escape/, // an apostrophe is written as itself or left out, and itself is refused
  'https://example.com/a+b': /character outside/,
  'https://example.com/a,b': /character outside/,
  'https://example.com/a:b': /character outside/,
  'https://example.com/a@b': /character outside/,
};
const refusedHomepages = {
  // Characters that break out of an HTML attribute, in the host and in the path.
  'https://x"onmouseover="alert(1)"y=".example.com/': /is not a host name/,
  "https://x'onmouseover='alert(1)'y='.example.com/": /is not a host name/,
  'https://exa`mple.com/': /is not a host name/,
  'https://exa{mple.com/': /is not a host name/,
  'https://exa}mple.com/': /is not a host name/,
  'https://exa&mple.com/': /is not a host name/,
  'https://exa!mple.com/': /is not a host name/,
  'https://exa*mple.com/': /is not a host name/,
  'https://exa_mple.com/': /is not a host name/,
  "https://example.com/'onmouseover='alert(1)'y='": /character outside/,
  'https://example.com/"onmouseover="alert(1)': /character outside/,
  'https://example.com/`onmouseover=`': /character outside/,
  'https://example.com/<script>alert(1)</script>': /character outside/,
  'https://example.com/a&b': /character outside/,
  'https://example.com/a&quot;b': /character outside/,
  'https://example.com/a|b': /character outside/,
  'https://example.com/a[0]': /character outside/,
  'https://example.com/a;b': /character outside/,
  'https://example.com/a=b': /character outside/,
  'https://example.com/a!b': /character outside/,
  'https://example.com/a$b': /character outside/,
  'https://example.com/a*b': /character outside/,
  // Percent escapes: none at all, so each URL has one spelling.
  'https://example.com/%': /percent escape/,
  'https://example.com/%zz': /percent escape/,
  'https://example.com/%00': /percent escape/,
  'https://example.com/%0d%0a': /percent escape/,
  'https://example.com/%ff': /percent escape/,
  'https://example.com/%C3%A9': /percent escape/,
  'https://example.com/%c3%a9': /percent escape/,
  'https://example.com/%61': /percent escape/,
  'https://example.com/%2e%2e/x': /percent escape/,
  // No port at all.
  'https://example.com:443/': /must not name a port/,
  'https://example.com:0/': /must not name a port/,
  'https://example.com:22/': /must not name a port/,
  'https://example.com:6379/': /must not name a port/,
  'https://example.com:8443/': /must not name a port/,
  'https://example.com:/': /must not name a port/,
  // Host shapes.
  'https://-a.example.com/': /is not a host name/,
  'https://a-.example.com/': /is not a host name/,
  [`https://${'a'.repeat(64)}.example.com/`]: /is not a host name/,
  'https://münchen.de/': /is not written canonically \(it would be https:\/\/xn--mnchen-3ya\.de\/\)/,
  'https://Models.Example.com/': /is not written canonically/,
  'https://models.example.com': /is not written canonically \(it would be https:\/\/models\.example\.com\/\)/,
  'https://models.example.com./': /ends with a dot/,
  'https://models..example.com/': /has an empty label/,
  'https://localhost/': /single-label name/,
  'https://localhost:8443/': /single-label name/,
  'https://app.localhost/': /\.localhost\)/,
  'https://printer.local/': /\.local\)/,
  'https://wiki.internal/': /\.internal\)/,
  'https://router.home.arpa/': /\.home\.arpa\)/,
  'https://models.test/': /\.test\)/,
  'https://models.example/': /\.example\)/,
  'https://abcdefghij.onion/': /\.onion\)/,
  // Addresses, in every spelling.
  'https://127.0.0.1/': /is an IP address/,
  'https://10.0.0.5/model/': /is an IP address/,
  'https://169.254.169.254/latest/': /is an IP address/,
  'https://2130706433/': /is an IP address/,
  'https://0x7f.1/': /is an IP address/,
  'https://[::1]/': /is an IP address/,
  'https://[::ffff:7f00:1]/': /is an IP address/,
  // Scheme, userinfo, query, fragment.
  'http://models.example.com/': /must be https, not http/,
  'ftp://models.example.com/': /must be https, not ftp/,
  'javascript:alert(1)': /must be https, not javascript/,
  'data:text/html,x': /must be https, not data/,
  '//models.example.com/': /is not a URL/,
  'models.example.com': /is not a URL/,
  'https://user@models.example.com/': /must not contain credentials/,
  'https://user:secret@models.example.com/': /must not contain credentials/,
  'https://@models.example.com/': /is not written canonically \(it would be https:\/\/models\.example\.com\/\)/,
  'https://models.example.com/?a=1': /must not contain a query/,
  'https://models.example.com/?': /must not contain a query/,
  'https://models.example.com/#top': /must not contain a fragment/,
  'https://models.example.com/#': /must not contain a fragment/,
  'https://github.com/org/repo#readme': /must not contain a fragment/,
  'https://models.example.com/#/model': /must not contain a fragment/,
  // Path shapes.
  'https://models.example.com//x': /empty path segment/,
  'https://models.example.com/a/../b': /\. or \.\. segment/,
  'https://models.example.com/a/./b': /\. or \.\. segment/,
  'https://models.example.com/..': /\. or \.\. segment/,
  // Whitespace, control characters, length.
  'https://models.example.com/a b': /whitespace/,
  ' https://models.example.com/': /whitespace/,
  'https://models.example.com/\\x': /backslash/,
  'https://models.example.com/\u0000': /control characters/,
  'https://models.example.com/\u00a0': /whitespace/,
  '': /is not a URL/,
  '   ': /is not a URL/,
  [`https://example.com/${'a'.repeat(200 - 'https://example.com/'.length + 1)}`]: /longer than 200 characters/,
};

test('the URLs a homepage may be, and the ones it may not: legitimate ones are kept, every payload is refused with its reason', () => {
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  const problems = (homepage) => recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data: fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', homepage }) }], ...context });
  assert.equal(legitimateHomepages.length, 17);
  for (const homepage of legitimateHomepages) {
    assert.equal(homepageProblem(homepage), null, homepage);
    assert.deepEqual(problems(homepage), [], homepage);
    // Whatever is accepted is made of letters, digits and - . _ ~ / : only: nothing that needs escaping in HTML, a URL or a shell.
    assert.match(homepage, /^[A-Za-z0-9._~/:-]+$/, homepage);
  }
  for (const [homepage, pattern] of Object.entries({ ...refusedHomepages, ...nowRefusedHomepages })) {
    expectProblem(problems(homepage), new RegExp(`^models/\\$records/x\\.yaml: homepage: .*${pattern.source}`));
    assert.match(homepageProblem(homepage), pattern, JSON.stringify(homepage));
  }
  for (const homepage of [5, 1.5, true, null, '', ['https://models.example.com/'], { url: 'https://models.example.com/' }]) {
    expectProblem(problems(homepage), /^models\/\$records\/x\.yaml: homepage: is not a URL/);
  }
  assert.equal(maxHomepageLength, 200);
  assert.equal(publicHttpsProblem('https://models.example.com/'), null);
  assert.deepEqual(problems(undefined), []);
  // The real thing: every character U+0000 to U+FFFF in the host and in the path, accepted or refused.
  for (let code = 0; code <= 0xffff; code += 1) {
    const character = String.fromCharCode(code);
    if (homepageProblem(`https://a${character}b.example.com/`) === null) assert.match(character, /^[a-z0-9.-]$/, `host character U+${code.toString(16)} accepted`);
    if (homepageProblem(`https://example.com/a${character}b`) === null) assert.match(character, /^[A-Za-z0-9._~/-]$/, `path character U+${code.toString(16)} accepted`);
  }
});

test('a refused homepage fails the whole check and is never requested: the only URL git is asked for is the repository', () => {
  const source = modelOrigin('badhome');
  const dir = registry({ fixture: fixtureRecord(source, { homepage: 'http://models.example.com/' }) }, { index: false });
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the checks must not fetch a homepage'); };
  let result;
  try { result = checkRegistry({ ...options(dir), urlFor: (url) => { asked.push(url); return urlFor(url); } }); } finally { globalThis.fetch = realFetch; }
  expectProblem(result.problems, /^models\/\$records\/fixture\.yaml: homepage: must be https, not http/);
  assert.deepEqual([...new Set(asked)], [source.repository]);
  assert.ok(loadModels(options(dir)).problems.some((problem) => /homepage/.test(problem)), 'build-index.mjs stops on any problem, so nothing is written');
});

test('a record has declared columns only: an undeclared key, an id override and a merge key are refused, and none reaches the entry', () => {
  const source = modelOrigin('keys');
  const record = fixtureRecord(source, { homepage: 'https://models.example.com/fixture/' });
  const recordFile = (dir) => join(dir, 'models', '$records', 'fixture.yaml');
  const columns = readRegistry(root).columns;
  assert.ok(columns.models.includes('homepage') && !columns.models.includes('id') && !columns.models.includes('<<'));
  for (const [name, extra, pattern] of [
    ['an undeclared key', { colour: 'blue' }, /^models\/\$records\/fixture\.yaml: "colour" is not a column of this collection/],
    ['an id override', { id: 'evil' }, /^models\/\$records\/fixture\.yaml: "id" is not a column of this collection/],
    ['a key that is a column of another collection', { name: 'x' }, /"name" is not a column of this collection/],
    ['a key that only differs in case', { Homepage: 'https://models.example.com/' }, /"Homepage" is not a column of this collection/],
  ]) {
    const dir = registry({ fixture: { ...record, ...extra } }, { index: false });
    expectProblem(check(dir).problems, pattern);
    const { entries } = loadModels(options(dir));
    assert.equal(entries[0].id, 'fixture', `${name}: the id is the file name`);
    for (const key of Object.keys(extra).filter((key) => key !== 'id')) assert.equal(key in entries[0], false, `${name}: ${key} is not in the entry`);
  }
  // A YAML merge key hides a homepage from the URL check; it is refused in every spelling the reader
  // would merge: plain, quoted, as a complex key, with an explicit tag, and under a %YAML 1.1 directive.
  const base = stringifyYaml({ ...record, homepage: undefined });
  const merged = "{homepage: 'javascript:alert(1)'}";
  const spellings = {
    'a plain key': `${base}<<: ${merged}\n`,
    'a double-quoted key': `${base}"<<": ${merged}\n`,
    'a single-quoted key': `${base}'<<': ${merged}\n`,
    'a complex key': `${base}? <<\n: ${merged}\n`,
    'a !!merge key': `${base}!!merge <<: ${merged}\n`,
    'a verbatim merge tag': `${base}!<tag:yaml.org,2002:merge> <<: ${merged}\n`,
    'a %YAML 1.1 directive': `%YAML 1.1\n---\n${base}<<: ${merged}\n`,
  };
  assert.ok('homepage' in parseYaml(spellings['a plain key'], { merge: true }), 'positive control: a parser that merges would give the record this homepage');
  assert.equal(parseYaml(spellings['a !!merge key'], { merge: false }).homepage, 'javascript:alert(1)', 'positive control: merge: false alone still merges a !!merge key');
  assert.equal(parseYaml(spellings['a %YAML 1.1 directive'], { merge: false }).homepage, 'javascript:alert(1)', 'positive control: merge: false alone still merges under %YAML 1.1');
  for (const [name, text] of Object.entries(spellings)) {
    const dir = registry({ fixture: record }, { index: false });
    writeFileSync(recordFile(dir), text);
    const problems = check(dir).problems;
    expectProblem(problems, /^models\/\$records\/fixture\.yaml: "<<" merge keys are not allowed/);
    assert.equal(problems.filter((problem) => /merge keys are not allowed/.test(problem)).length, 1, `${name}: reported once`);
    if (name.includes('%YAML')) expectProblem(problems, /^models\/\$records\/fixture\.yaml: a %YAML directive is not allowed/);
    assert.ok(loadModels(options(dir)).problems.some((problem) => /merge keys are not allowed/.test(problem)), `${name}: build-index.mjs stops on any problem, so nothing is written`);
  }
  // A %YAML directive is refused on its own: under 1.1, `title: yes` is the boolean true and `title: 1:30` the number 90.
  for (const directive of ['%YAML 1.1\n---\n', '%YAML 1.2\n---\n']) {
    const dir = registry({ fixture: record }, { index: false });
    writeFileSync(recordFile(dir), `${directive}${stringifyYaml(record)}`);
    expectProblem(check(dir).problems, /^models\/\$records\/fixture\.yaml: a %YAML directive is not allowed/);
  }
  assert.equal(parseYaml('%YAML 1.1\n---\ntitle: yes\n').title, true, 'positive control: 1.1 reads yes as a boolean');
  // An ordinary record, and `title: yes` without a directive, are read as written.
  const plain = registry({ fixture: { ...record, title: 'yes' } }, { index: false });
  assert.equal(readRegistry(plain).models[0].data.title, 'yes');
  assert.deepEqual(readRegistry(plain).problems, []);
  // A maintainer record is held to its collection's columns too, and a record must be a mapping.
  const maint = registry({ fixture: record }, { index: false });
  writeFileSync(join(maint, 'maintainers', '$records', 'trakhimenok.yaml'), 'name: A\nrole: admin\n');
  expectProblem(check(maint).problems, /^maintainers\/\$records\/trakhimenok\.yaml: "role" is not a column of this collection/);
  const scalar = registry({ fixture: record }, { index: false });
  writeFileSync(recordFile(scalar), '- a\n- b\n');
  expectProblem(check(scalar).problems, /^models\/\$records\/fixture\.yaml: a record is a mapping of columns/);
});

test('the order of an index entry is fixed: it does not depend on the order of the keys in the record file', () => {
  const source = modelOrigin('ordered');
  const record = fixtureRecord(source, { homepage: 'https://models.example.com/fixture/' });
  const shuffled = Object.fromEntries(Object.entries(record).reverse());
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(record));
  const [first] = loadModels(options(registry({ fixture: record }))).entries;
  const [second] = loadModels(options(registry({ fixture: shuffled }))).entries;
  assert.deepEqual(Object.keys(second), Object.keys(first));
  assert.equal(buildIndex([second]), buildIndex([first]));
  assert.deepEqual(Object.keys(first).slice(0, 5), ['id', 'title', 'description', 'status', 'homepage']);
});

test('the suite\'s git calls ignore the user\'s git configuration: a decoy global config that breaks every commit changes nothing', () => {
  const home = join(scratch, `decoy-home-${count++}`);
  mkdirSync(home);
  // Every commit signs with a program that always fails, as commit.gpgsign=true with no usable key does.
  writeFileSync(join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[init]\n\tdefaultBranch = decoy\n');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const plain = join(scratch, `decoy-plain-${count++}`);
  mkdirSync(plain);
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  // The control runs git with the process environment minus every GIT_ variable (an inherited GIT_DIR or
  // GIT_WORK_TREE would send it into another repository) and keeps the decoy HOME; and only inside `plain`.
  const controlEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const control = (...args) => {
    assert.ok(realpathSync(plain).startsWith(`${realpathSync(scratch)}${sep}`), 'the control runs only inside the test\'s temporary directory');
    return execFileSync('git', ['-C', plain, ...args], { stdio: 'pipe', env: controlEnv }).toString();
  };
  try {
    // Positive control: git with that environment and no protection does not get a commit through.
    control('init', '-q');
    assert.equal(control('rev-parse', '--absolute-git-dir').trim(), join(realpathSync(plain), '.git'), 'the control repository is the one in the temporary directory');
    assert.throws(() => control('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'x'), /gpg failed to sign the data/, 'the decoy configuration is read by an unprotected git');
    // The fixture helpers commit anyway, on the branch they ask for.
    const source = modelOrigin('decoy');
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.equal(gitIn(source.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(gitEnv().GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(gitEnv().GIT_CONFIG_NOSYSTEM, '1');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('a model file path that is not a plain path inside the repository fails and never reaches git', () => {
  const marker = join(scratch, 'marker-path');
  const bad = ['../x.modelspec.hcl', 'model/../../x.modelspec.hcl', '/etc/x.modelspec.hcl', 'model/*.modelspec.hcl', 'model/?.modelspec.hcl', 'model/[a].modelspec.hcl', ':(top)x.modelspec.hcl', ':(glob)**/x.modelspec.hcl', './x.modelspec.hcl', 'model//x.modelspec.hcl', 'model/', 'x\\y.modelspec.hcl', 'x y.modelspec.hcl', `$(touch ${marker}).modelspec.hcl`, `x;touch ${marker}.modelspec.hcl`, '`touch x`.modelspec.hcl', '-x.modelspec.hcl/', '', undefined, 3];
  const source = { name: 'a', commit: 'a'.repeat(40), repository: 'https://github.com/datatug/chinookdb' };
  for (const path of bad) {
    assert.equal(isRepositoryPath(path), false, String(path));
    const data = fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', source_file: path });
    expectProblem(recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data }], ...context }), /source_file: .* must be a relative path inside the repository/);
    assert.equal(wellFormed({ data }), false);
  }
  for (const path of ['model/fixture.modelspec.hcl', 'a.modelspec.hcl', 'a-b/c_d/e.f.modelspec.hcl']) assert.equal(isRepositoryPath(path), true, path);
  assert.equal(existsSync(marker), false);
  const records = (extra) => recordProblems({ models: [{ key: 'x', file: 'models/$records/x.yaml', data: fixtureRecord(source, { address: 'modelspec://github.com/datatug/chinookdb/fixture', ...extra }) }], ...context });
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
  const plain = execFileSync('git', ['ls-remote', 'https://example.test/fixtures/not-there', 'HEAD'], { stdio: 'pipe', env: { ...plainEnv(), GIT_CONFIG_GLOBAL: cfg, GIT_ALLOW_PROTOCOL: 'https:file' } }).toString();
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
  assert.deepEqual(execFileSync('git', ['-C', source.dir, 'ls-files', '--', 'model/*.hcl'], { env: gitEnv() }).toString().trim().split('\n'), ['model/a.hcl', 'model/b.hcl']);
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
  expectProblem(problemsOf(modelOrigin('not-json', { json: '{ nope' })), /fixture\.modelspec\.json is not JSON, or repeats a name: /);
  expectProblem(problemsOf(modelOrigin('json-array', { json: '[]' })), /model\/fixture\.modelspec\.json: the JSON AST must be an object/);
  expectProblem(problemsOf(modelOrigin('json-null', { json: 'null' })), /the JSON AST must be an object/);
  expectProblem(problemsOf(modelOrigin('json-string', { json: '"x"' })), /the JSON AST must be an object/);
});

test('a JSON AST that breaks the structural checks of the ModelSpec specification fails', () => {
  const cases = [
    ['wrong-version', (json) => { json.modelspec = '2.0'; }, /modelspec must be "1\.0-draft-2" \(or "1\.0-draft", the earlier spelling\)/],
    ['no-version', (json) => { delete json.modelspec; }, /modelspec must be "1\.0-draft-2"/],
    ['no-module-id', (json) => { delete json.module.id; }, /module\.id and module\.version are required/],
    ['no-module-version', (json) => { delete json.module.version; }, /module\.id and module\.version are required/],
    ['module-not-object', (json) => { json.module = 'x'; }, /module must be an object/],
    ['entities-array', (json) => { json.entities = []; }, /entities must be an object keyed by name/],
    ['entity-no-properties', (json) => { delete json.entities.Artist.properties; }, /entities Artist must be an object with properties/],
    ['property-not-object', (json) => { json.entities.Artist.properties.Name = 'string'; }, /Artist\.Name must be an object/],
    ['key-not-list', (json) => { json.entities.Artist.key = 'ArtistId'; }, /entity Artist key must be a list of property names/],
    ['key-not-list-number', (json) => { json.entities.Artist.key = 7; }, /entity Artist key must be a list of property names/],
    ['empty-key', (json) => { json.entities.Artist.key = []; }, /entity Artist key must be a non-empty list when present/],
    ['duplicate-key-property', (json) => { json.entities.Artist.key = ['ArtistId', 'ArtistId']; }, /entity Artist key ArtistId is duplicated/],
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

test('the registry accepts entities without a declared key and does not invent one', () => {
  const hcl = 'entity "HeapRow" {\n  property "value" {\n    type = "string"\n  }\n}\n';
  const json = jsonFor('keyless-entity', hcl);
  assert.equal(Object.hasOwn(json.entities.HeapRow, 'key'), false);
  assert.deepEqual(validateModel(json), []);
  assert.deepEqual(describeModel(parseHcl(hcl)).records, [{ name: 'HeapRow', key: [], use: [], fields: [{ name: 'value', type: 'string', required: false, key: false }] }]);

  const malformed = structuredClone(json);
  malformed.entities.HeapRow.key = [];
  assert.match(validateModel(malformed).join('\n'), /entity HeapRow key must be a non-empty list when present/);
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
    ['recordset', `${fixtureHcl}\nrecordset "r" {\n  key = ["id"]\n}\n`, /line \d+: the recordset block was removed from ModelSpec \(decision 0019\)/],
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
  const described = describeModel(parseHcl('component "Audit" {\n  field "at" {\n    type = "datetime"\n    required = true\n  }\n  field "by" {\n    entity = "B"\n  }\n}\nentity "A" {\n  key = ["x", "y"]\n  use = ["Audit"]\n  property "x" {\n    type = "int"\n    required = true\n  }\n  property "y" {\n    entity = "B"\n  }\n  property "z" {\n    component = "Audit"\n  }\n}\n'));
  assert.deepEqual(described, {
    records: [{ name: 'A', key: ['x', 'y'], use: ['Audit'], fields: [{ name: 'x', type: 'int', required: true, key: true }, { name: 'y', type: 'reference', references: 'B', required: false, key: true }, { name: 'z', type: 'component', component: 'Audit', required: false, key: false }] }],
    components: [{ name: 'Audit', fields: [{ name: 'at', type: 'datetime', required: true }, { name: 'by', type: 'reference', references: 'B', required: false }] }],
  });
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
  assert.deepEqual(problemsOf(modelOrigin('licence-standard-mit-title', { licence: 'The MIT License (MIT)\n\nCopyright (c) 2026 Test\n' })), [], 'the common upstream MIT title is recognised');

  // The record says Apache-2.0, the HCL says MIT, the repository's LICENSE says MIT.
  const source = modelOrigin('licence-differs');
  const problems = problemsOf(source, { licence: 'Apache-2.0' });
  expectProblem(problems, /licence is Apache-2\.0, but model\/fixture\.modelspec\.hcl declares MIT/);
  expectProblem(problems, /licence is Apache-2\.0, but model\/fixture\.modelspec\.json declares MIT/);

  // JSON has no licence field. An explicit HCL declaration applies to its
  // validated JSON twin even when the repository's code licence is different.
  const bsdHcl = fixtureHcl.replace('# Licence: MIT', '# SPDX-License-Identifier: BSD-3-Clause');
  const bsdTwin = modelOrigin('licence-bsd-twin', { hcl: bsdHcl });
  assert.deepEqual(problemsOf(bsdTwin, { licence: 'BSD-3-Clause' }), [], 'the JSON twin inherits the explicit HCL licence');
  expectProblem(problemsOf(bsdTwin, { licence: 'MIT' }), /licence is MIT, but model\/fixture\.modelspec\.hcl declares BSD-3-Clause/);
  const mismatchedJson = jsonFor('licence-bsd-mismatched-twin', bsdHcl);
  mismatchedJson.entities.Artist.properties.Name.max_len = 100;
  const mismatchedTwin = modelOrigin('licence-bsd-mismatched-twin', { hcl: bsdHcl, json: mismatchedJson });
  const mismatchedProblems = problemsOf(mismatchedTwin, { licence: 'BSD-3-Clause' });
  expectProblem(mismatchedProblems, /does not match model\/fixture\.modelspec\.hcl/);
  expectProblem(mismatchedProblems, /licence is BSD-3-Clause, but model\/fixture\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);

  // The HCL declares nothing: it takes the repository's default, like the JSON.
  const undeclared = fixtureHcl.replace('# Licence: MIT\n', '');
  assert.deepEqual(problemsOf(modelOrigin('licence-default', { hcl: undeclared })), []);
  expectProblem(problemsOf(modelOrigin('licence-default-differs', { hcl: undeclared }), { licence: 'CC0-1.0' }), /licence is CC0-1\.0, but model\/fixture\.modelspec\.hcl declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);
  assert.deepEqual(
    problemsOf(modelOrigin('licence-cc-by-sa-default', { hcl: undeclared, licence: 'SPDX-License-Identifier: CC-BY-SA-3.0\n' }), { licence: 'CC-BY-SA-3.0' }),
    [],
    'the SPDX license identifier in the repository LICENSE is recognized as the default for both twins',
  );

  // With no HCL declaration, the JSON inherits the repository default.
  const apache = 'Apache License\n Version 2.0, January 2004\n';
  const noHclLicence = problemsOf(modelOrigin('licence-json-differs', { hcl: undeclared, licence: apache }));
  expectProblem(noHclLicence, /licence is MIT, but model\/fixture\.modelspec\.hcl declares no licence and the repository's default licence \(its LICENSE file\) is Apache-2\.0/);
  expectProblem(noHclLicence, /licence is MIT, but model\/fixture\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is Apache-2\.0/);

  // With neither a repository default nor an HCL declaration, both twins need
  // a recognized source of licence information; the JSON has no licence field.
  expectProblem(problemsOf(modelOrigin('licence-none', { hcl: undeclared, licence: null })), /model\/fixture\.modelspec\.json declares no licence, and the repository's LICENSE files name no licence the check recognises; a JSON file cannot declare one/);
  expectProblem(problemsOf(modelOrigin('licence-unknown', { hcl: undeclared, licence: 'Some custom terms\n' })), /LICENSE file names no licence the check recognises/);
  expectProblem(problemsOf(modelOrigin('licence-hcl-none', { hcl: undeclared, licence: null })), /model\/fixture\.modelspec\.hcl declares no licence, and the repository's LICENSE files name no licence the check recognises; the file must declare its licence/);

  // Several licence files and no unsuffixed one are ambiguous; an unsuffixed LICENSE wins over suffixed ones.
  expectProblem(problemsOf(modelOrigin('licence-ambiguous', { hcl: undeclared, licence: null, files: { 'LICENSE-MIT': mit, 'LICENSE-CC0': cc0 } })), /LICENSE files name several \((MIT, CC0-1\.0|CC0-1\.0, MIT)\)/);
  assert.deepEqual(problemsOf(modelOrigin('licence-suffixed', { files: { 'LICENSE-CC0': cc0 } })), [], 'the unsuffixed LICENSE is the default, as in datatug/chinookdb');
  // A LICENSE that is a symbolic link is the default but is not read.
  expectProblem(problemsOf(modelOrigin('licence-link', { hcl: undeclared, licence: null, files: { 'real-license': mit }, symlinks: { LICENSE: 'real-license' } })), /LICENSE file names no licence the check recognises/);
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
  assert.deepEqual(Object.keys(index.models[0]), ['id', 'title', 'description', 'status', 'address', 'repository', 'commit', 'module', 'module_id', 'module_version', 'modelspec', 'licence', 'files', 'maintainers', 'records', 'components']);
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

// ---- the cache: nothing in it, or near it, is trusted ----------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const freshCache = () => join(scratch, `cache-${count++}`);
// The positive controls need a git that honours replace refs, which gitEnv() turns off; it still
// reads no user or system configuration.
const plainEnv = () => { const { GIT_NO_REPLACE_OBJECTS, ...rest } = gitEnv(); return rest; };
const rawGit = (dir, ...args) => execFileSync('git', ['--git-dir', dir, ...args], { stdio: 'pipe', env: plainEnv() }).toString();
// The repositories the registry makes, built here the same way, so that a test
// can start from a sound one and poison exactly one thing.
const commitEntryDir = (cache, url, commit) => join(cache, 'models', `${sha256(url).slice(0, 24)}-${commit}`);
function commitRepo(url, commit, dir) {
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '--template=', dir], { stdio: 'pipe', env: gitEnv() });
  rawGit(dir, 'fetch', '-q', '--depth', '1', '--end-of-options', url, commit);
}
function historyRepo(url, branch, dir) {
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', '--template=', '--filter=tree:0', '--single-branch', '--branch', branch, '--end-of-options', url, dir], { stdio: 'pipe', env: gitEnv() });
}
const refsOf = (dir, pattern) => rawGit(dir, 'for-each-ref', '--format=%(refname)', pattern).trim();

test('a checkout that tracks a .cache is refused before anything is fetched', () => {
  const source = modelOrigin('tracked-cache');
  const dir = registry({ fixture: fixtureRecord(source) });
  assert.deepEqual(trackedCacheProblems(dir), [], 'a directory that is not a checkout tracks nothing');
  gitIn(dir, 'init', '-q');
  assert.deepEqual(check(dir).problems, [], 'positive control: the same registry passes without a tracked cache');
  mkdirSync(join(dir, '.cache', 'models'), { recursive: true });
  writeFileSync(join(dir, '.cache', 'models', 'planted'), 'planted');
  assert.deepEqual(trackedCacheProblems(dir), [], 'an untracked .cache is not a problem, and is never read');
  gitIn(dir, 'add', '-f', '.cache');
  const cache = freshCache();
  const { problems } = checkRegistry({ ...options(dir), cacheDir: cache });
  assert.equal(problems.length, 1);
  expectProblem(problems, /^\.cache is tracked in this checkout \(\.cache\/models\/planted\); the registry keeps its caches outside the checkout and never reads one from it/);
  assert.equal(existsSync(cache), false, 'nothing was fetched');
  assert.equal(loadModels({ ...options(dir), cacheDir: cache }).entries.length, 0);
  gitIn(dir, 'rm', '-rq', '--cached', '.cache');
  assert.deepEqual(check(dir).problems, []);
});

test('the cache directory is per-user, private and never a link', () => {
  const home = join(scratch, `home-${count++}`);
  mkdirSync(home);
  const dir = defaultCacheDir({ env: {}, home });
  assert.equal(dir, join(home, '.cache', 'modelspec-registry'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(defaultCacheDir({ env: {}, home }), dir, 'a second call reuses it');
  const xdg = join(scratch, `xdg-${count++}`);
  assert.equal(defaultCacheDir({ env: { XDG_CACHE_HOME: xdg }, home }), join(xdg, 'modelspec-registry'));
  assert.equal(defaultCacheDir({ env: { XDG_CACHE_HOME: 'relative/path' }, home }), dir, 'a relative XDG_CACHE_HOME is ignored');
  for (const mode of [0o770, 0o707, 0o777, 0o720]) {
    chmodSync(dir, mode);
    assert.throws(() => defaultCacheDir({ env: {}, home }), /is writable by others; the cache must be private/, mode.toString(8));
  }
  chmodSync(dir, 0o700);
  assert.equal(defaultCacheDir({ env: {}, home }), dir);
  assert.throws(() => defaultCacheDir({ env: {}, home, uid: process.getuid() + 1 }), /is owned by another user; the cache must be yours/);
  // A symbolic link in its place, to a directory that is otherwise fine.
  const base = join(scratch, `linked-${count++}`);
  const target = join(scratch, `target-${count++}`);
  mkdirSync(base);
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(base, 'modelspec-registry'));
  assert.throws(() => defaultCacheDir({ env: { XDG_CACHE_HOME: base }, home }), /is not a directory; the cache must be a real per-user directory/);
  // A file in its place.
  const filed = join(scratch, `filed-${count++}`);
  mkdirSync(filed);
  writeFileSync(join(filed, 'modelspec-registry'), 'x');
  assert.throws(() => defaultCacheDir({ env: { XDG_CACHE_HOME: filed }, home }));
});

test('a cached repository is trusted only when it is one this module made', () => {
  const source = modelOrigin('sound');
  const url = origins.get(source.repository);
  const cache = freshCache();
  const history = historyPath(join(cache, 'history'), url, 'main');
  const commitDir = commitEntryDir(cache, url, source.commit);
  historyRepo(url, 'main', history);
  commitRepo(url, source.commit, commitDir);
  assert.equal(cacheRepoSound(history, { url }), true, 'positive control: a history clone made the way the registry makes it');
  assert.equal(cacheRepoSound(commitDir), true, 'positive control: a commit repository made the way the registry makes it');
  assert.equal(cacheRepoSound(join(cache, 'nothing-here')), false);

  const copy = (dir) => { const to = join(scratch, `copy-${count++}`); cpSync(dir, to, { recursive: true }); return to; };
  const poisoned = {
    'an alternates file': (d) => { mkdirSync(join(d, 'objects', 'info'), { recursive: true }); writeFileSync(join(d, 'objects', 'info', 'alternates'), '/somewhere/else/objects\n'); },
    'a commondir file': (d) => writeFileSync(join(d, 'commondir'), '../other\n'),
    'a hook': (d) => { mkdirSync(join(d, 'hooks'), { recursive: true }); writeFileSync(join(d, 'hooks', 'reference-transaction'), '#!/bin/sh\ntrue\n'); chmodSync(join(d, 'hooks', 'reference-transaction'), 0o755); },
    'core.hooksPath': (d) => rawGit(d, 'config', 'core.hooksPath', '/planted'),
    'core.fsmonitor': (d) => rawGit(d, 'config', 'core.fsmonitor', '/planted/monitor'),
    'core.sshCommand': (d) => rawGit(d, 'config', 'core.sshCommand', '/planted/ssh'),
    'an insteadOf rewrite': (d) => rawGit(d, 'config', 'url.file:///planted.insteadOf', 'https://example.test/'),
    'an include': (d) => rawGit(d, 'config', 'include.path', '/planted/config'),
    'an alias': (d) => rawGit(d, 'config', 'alias.fetch', '!touch /planted'),
    'a credential helper': (d) => rawGit(d, 'config', 'credential.helper', '!planted'),
    'a protocol setting': (d) => rawGit(d, 'config', 'protocol.allow', 'always'),
    'a replace ref': (d) => { rawGit(d, 'update-ref', `refs/replace/${source.commit}`, source.commit); },
    'a corrupt object': (d) => { mkdirSync(join(d, 'objects', 'ab'), { recursive: true }); writeFileSync(join(d, 'objects', 'ab', 'c'.repeat(38)), 'not a git object'); },
    'no HEAD': (d) => rmSync(join(d, 'HEAD')),
  };
  for (const [what, change] of Object.entries(poisoned)) {
    const h = copy(history);
    change(h);
    assert.equal(cacheRepoSound(h, { url }), false, `a history clone with ${what}`);
    const c = copy(commitDir);
    change(c);
    assert.equal(cacheRepoSound(c), false, `a commit repository with ${what}`);
  }
  assert.equal(cacheRepoSound(history, { url: 'file:///another/url' }), false, 'a history clone whose remote is another URL');
  assert.equal(cacheRepoSound(history), false, 'a history clone is not a commit repository (it has a remote)');
  const noRemote = copy(commitDir);
  rawGit(noRemote, 'config', 'remote.origin.url', url);
  assert.equal(cacheRepoSound(noRemote), false, 'a commit repository never has a remote');
});

test('a forged model in the cache is not read: replace refs are discarded and ignored (variant 1)', () => {
  const source = modelOrigin('forged');
  const url = origins.get(source.repository);
  const cache = freshCache();
  const entry = commitEntryDir(cache, url, source.commit);
  commitRepo(url, source.commit, entry);
  assert.equal(cacheRepoSound(entry), true, 'positive control: without the forgery the cache entry is reused');
  const jsonBlob = rawGit(entry, 'rev-parse', `${source.commit}:model/fixture.modelspec.json`).trim();
  const real = rawGit(entry, 'cat-file', 'blob', jsonBlob);
  const forged = real.replaceAll('"Name"', '"Kame"');
  const forgedId = execFileSync('git', ['--git-dir', entry, 'hash-object', '-w', '--stdin'], { input: forged, stdio: 'pipe', env: gitEnv() }).toString().trim();
  rawGit(entry, 'replace', jsonBlob, forgedId);
  assert.match(rawGit(entry, 'cat-file', 'blob', jsonBlob), /"Kame"/, 'positive control: plain git reads the forged file for the real object id');
  assert.equal(git(['--git-dir', entry, 'cat-file', 'blob', jsonBlob]), real, 'the registry\'s git ignores replace refs');
  assert.equal(cacheRepoSound(entry), false);
  const dir = registry({ fixture: fixtureRecord(source) });
  const { problems, entries } = loadModels({ ...options(dir), cacheDir: cache });
  assert.deepEqual(problems, []);
  assert.deepEqual(entries[0].records[0].fields.map((field) => field.name), ['ArtistId', 'Name']);
  assert.equal(refsOf(entry, 'refs/replace'), '', 'the poisoned repository was thrown away and fetched again');
  assert.deepEqual(checkRegistry({ ...options(dir), cacheDir: cache }).problems, []);
});

test('a planted hook in the cache never runs (variant 2)', () => {
  const marker = join(scratch, `hook-ran-${count++}`);
  const source = modelOrigin('hooked');
  const url = origins.get(source.repository);
  const cache = freshCache();
  const history = historyPath(join(cache, 'history'), url, 'main');
  historyRepo(url, 'main', history);
  assert.equal(cacheRepoSound(history, { url }), true);
  mkdirSync(join(history, 'hooks'));
  writeFileSync(join(history, 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(history, 'hooks', 'reference-transaction'), 0o755);
  rawGit(history, 'update-ref', 'refs/heads/probe', source.commit);
  assert.equal(existsSync(marker), true, 'positive control: plain git runs the planted hook');
  rmSync(marker);
  // Whatever got it there, the registry's git does not run it ...
  git(['--git-dir', history, 'update-ref', 'refs/heads/probe2', source.commit]);
  git(['--git-dir', history, 'fetch', '-q', '--force', 'origin', '+refs/heads/main:refs/heads/main']);
  assert.equal(existsSync(marker), false, 'hooks never run through the registry\'s git');
  // ... and the poisoned repository is not used at all: it is replaced.
  const dir = registry({ fixture: fixtureRecord(source) });
  rmSync(marker, { force: true });
  assert.deepEqual(loadModels({ ...options(dir), cacheDir: cache }).problems, []);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(history, 'hooks', 'reference-transaction')), false, 'thrown away and cloned again');
  assert.equal(cacheRepoSound(history, { url }), true);
});

test('a history clone that points at another repository is not used (variant 2, redirected)', () => {
  const source = modelOrigin('redirect-a');
  const fork = modelOrigin('redirect-b', { files: { 'extra.txt': 'only the fork has this' } });
  assert.notEqual(source.commit, fork.commit);
  const url = origins.get(source.repository);
  const forkUrl = origins.get(fork.repository);
  const prepare = () => {
    const histDir = join(freshCache(), 'history');
    const clone = historyPath(histDir, url, 'main');
    historyRepo(url, 'main', clone);
    rawGit(clone, 'config', `url.${forkUrl}.insteadOf`, url);
    return { histDir, clone };
  };
  const control = prepare();
  rawGit(control.clone, 'fetch', '-q', '--force', 'origin', '+refs/heads/main:refs/heads/main');
  assert.equal(refsOf(control.clone, 'refs/heads/main'), 'refs/heads/main');
  assert.equal(rawGit(control.clone, 'rev-parse', 'refs/heads/main').trim(), fork.commit, 'positive control: plain git follows the rewrite to the fork');
  const poisoned = prepare();
  assert.equal(onBranch(url, 'main', fork.commit, poisoned.histDir, new Set()), false, 'the fork\'s commit is not in the history of the registered repository');
  assert.equal(onBranch(url, 'main', source.commit, poisoned.histDir, new Set()), true);
  assert.equal(onBranch(forkUrl, 'main', fork.commit, join(freshCache(), 'history'), new Set()), true, 'positive control: it is in the fork\'s own history');
});

test('a history clone survives the publisher\'s branch moving, and is made again when refreshing it fails', () => {
  const source = modelOrigin('moves');
  const url = origins.get(source.repository);
  const histDir = join(freshCache(), 'history');
  assert.equal(onBranch(url, 'main', source.commit, histDir, new Set()), true);
  const clone = historyPath(histDir, url, 'main');
  assert.match(readFileSync(join(clone, 'config'), 'utf8'), /partialclonefilter = tree:0/, 'it is a partial clone, as GitHub\'s are');
  const advance = (name) => {
    mkdirSync(join(source.dir, name), { recursive: true });
    writeFileSync(join(source.dir, name, 'new.txt'), name);
    gitIn(source.dir, 'add', '-A');
    gitIn(source.dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', name);
    return gitIn(source.dir, 'rev-parse', 'HEAD');
  };
  // The branch moves, with new trees the partial clone has never had.
  const second = advance('later-1');
  assert.equal(onBranch(url, 'main', second, histDir, new Set()), true);
  assert.equal(onBranch(url, 'main', source.commit, histDir, new Set()), true, 'the older commit is still in the history');
  const third = advance('later-2');
  assert.equal(onBranch(url, 'main', third, histDir, new Set()), true);
  assert.equal(rawGit(clone, 'rev-parse', 'refs/heads/main').trim(), third);
  assert.equal(onBranch(url, 'main', 'f'.repeat(40), histDir, new Set()), false);
  // A refresh that cannot work (a ref that is in the way of the branch): the clone is thrown away and made again.
  rawGit(clone, 'update-ref', '-d', 'refs/heads/main');
  rawGit(clone, 'update-ref', 'refs/heads/main/in-the-way', third);
  assert.throws(() => rawGit(clone, 'fetch', '-q', '--force', 'origin', '+refs/heads/main:refs/heads/main'), 'positive control: this refresh fails');
  assert.equal(onBranch(url, 'main', third, histDir, new Set()), true);
  assert.equal(refsOf(clone, 'refs/heads/main/in-the-way'), '', 'the clone was made again');
  assert.equal(rawGit(clone, 'rev-parse', 'refs/heads/main').trim(), third);
  // And a clone that cannot be made at all is reported, naming the repository.
  assert.throws(() => onBranch('file:///no/such/repository', 'main', third, histDir, new Set()), /cannot read the history of main in file:\/\/\/no\/such\/repository/);
});

// ---- the linter: only bytes that match the pinned SHA-256 are run -----------

function archiveOf(script) {
  const dir = mkdtempSync(join(scratch, 'archive-'));
  writeFileSync(join(dir, 'specscore'), script);
  chmodSync(join(dir, 'specscore'), 0o755);
  const file = join(scratch, `archive-${count++}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', dir, 'specscore']);
  return readFileSync(file);
}

test('the pinned linter is verified before every run, and a binary lying in the cache is never run (variant 3)', async () => {
  const marker = join(scratch, `linter-ran-${count++}`);
  const planted = `#!/bin/sh\ntouch '${marker}'\necho planted\n`;
  const good = archiveOf('#!/bin/sh\necho real\n');
  const evil = archiveOf(planted);
  const build = { asset: 'test_amd64', sha: sha256(good) };
  const table = { 'test/x64': build };
  const archiveName = 'specscore_0.55.0_test_amd64.tar.gz';
  let downloads = 0;
  const download = (bytes) => async (name) => { downloads++; assert.equal(name, archiveName); return bytes; };
  const run = async (cache, bytes = good) => {
    const { path, dispose } = await specscoreBinary({ cacheDir: cache, env: {}, platform: 'test/x64', table, download: download(bytes) });
    try { return execFileSync(path).toString(); } finally { dispose(); }
  };

  // Planted: binaries and archives already lying in the cache, in every layout.
  const cache = freshCache();
  mkdirSync(join(cache, 'specscore-0.55.0-test_amd64'), { recursive: true });
  writeFileSync(join(cache, 'specscore-0.55.0-test_amd64', 'specscore'), planted, { mode: 0o755 });
  writeFileSync(join(cache, 'specscore'), planted, { mode: 0o755 });
  assert.equal(execFileSync(join(cache, 'specscore')).toString(), 'planted\n');
  rmSync(marker);
  assert.equal(await run(cache), 'real\n');
  assert.equal(existsSync(marker), false, 'the planted binary was not run');
  assert.equal(downloads, 1);

  // A correct cached archive is used without downloading (positive control) ...
  assert.equal(await run(cache), 'real\n');
  assert.equal(downloads, 1);
  // ... and is verified again before every run: replaced between two runs, it is discarded.
  writeFileSync(join(cache, archiveName), evil);
  assert.equal(await run(cache), 'real\n');
  assert.equal(existsSync(marker), false, 'a tampered archive was not run');
  assert.equal(downloads, 2);
  assert.deepEqual(readFileSync(join(cache, archiveName)), good, 'and replaced by the verified download');
  // Nothing is left unpacked afterwards.
  assert.deepEqual(readdirSync(cache).filter((name) => name.startsWith('.bin-')), []);

  // A download that is not the pinned release is refused, and not cached.
  const empty = freshCache();
  await assert.rejects(() => run(empty, evil), /SHA-256 is [0-9a-f]{64}, expected [0-9a-f]{64}/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(empty, archiveName)), false);
  await assert.rejects(() => verifiedArchive({ cacheDir: empty, build, download: async () => { throw new Error('offline'); } }), /offline/);

  // SPECSCORE names a binary the person running the check chose; a platform with no pin is an error.
  assert.equal((await specscoreBinary({ cacheDir: empty, env: { SPECSCORE: '/usr/bin/true' } })).path, '/usr/bin/true');
  await assert.rejects(() => specscoreBinary({ cacheDir: empty, env: {}, platform: 'plan9/mips', table }), /no pinned specscore build for plan9\/mips/);
});

// ---- own properties: names like the members of Object.prototype ------------

const prototypeHcl = `entity "valueOf" {
  key = ["constructor"]

  property "constructor" {
    type     = "int"
    required = true
  }

  property "toString" {
    type = "string"
  }

  property "__proto__" {
    type = "string"
  }

  property "hasOwnProperty" {
    entity = "valueOf"
  }
}
`;

test('names like constructor, toString and __proto__ are ordinary names', () => {
  const source = modelOrigin('prototype-names', { hcl: prototypeHcl });
  const dir = registry({ fixture: fixtureRecord(source) });
  assert.deepEqual(check(dir).problems, []);
  const { entries } = loadModels(options(dir));
  assert.deepEqual(entries[0].records[0], { name: 'valueOf', key: ['constructor'], use: [], fields: [
    { name: 'constructor', type: 'int', required: true, key: true },
    { name: 'toString', type: 'string', required: false, key: false },
    { name: '__proto__', type: 'string', required: false, key: false },
    { name: 'hasOwnProperty', type: 'reference', references: 'valueOf', required: false, key: false },
  ] });
  // A key that names a property that is not there is still caught, whatever it is called.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const hcl = `entity "T" {\n  key = ["${name}"]\n\n  property "id" {\n    type = "int"\n  }\n}\n`;
    expectProblem(problemsOf(modelOrigin(`key-${name.toLowerCase().replaceAll('_', '')}`, { hcl })), new RegExp(`entity T key ${name} is not a property`));
  }
  // A real duplicate is a duplicate, and a name that only looks like one is not.
  expectProblem(problemsOf(modelOrigin('duplicate-constructor', { hcl: prototypeHcl.replace('"toString"', '"constructor"'), json: jsonFor('duplicate-constructor') })), /duplicate property "constructor" in entity "valueOf"/);
});

test('a JSON AST that repeats a name is refused', () => {
  const text = serializeModel(jsonFor('dup-json'));
  const repeats = {
    'an entity': text.replace('"entities": {', '"entities": {\n    "Artist": { "key": ["ArtistId"], "properties": { "ArtistId": { "type": "int", "required": true } } },'),
    'a property': text.replace('"Name": {', '"Name": { "type": "int" },\n        "Name": {'),
    'a top-level name': text.replace('"modelspec": "1.0-draft",', '"modelspec": "0.1",\n  "modelspec": "1.0-draft",'),
    'an attribute': text.replace('"required": true', '"required": false, "required": true'),
  };
  const expected = { 'an entity': /duplicate name "Artist" in entities/, 'a property': /duplicate name "Name" in entities\.Artist\.properties/, 'a top-level name': /duplicate name "modelspec" in the top-level object/, 'an attribute': /duplicate name "required" in entities\.Artist\.properties\.ArtistId/ };
  let n = 0;
  for (const [what, json] of Object.entries(repeats)) {
    assert.notEqual(json, text, what);
    assert.doesNotThrow(() => JSON.parse(json), 'plain JSON.parse accepts it, which is the problem');
    const problems = problemsOf(modelOrigin(`dup-json-${n++}`, { json }));
    expectProblem(problems, new RegExp(`fixture\\.modelspec\\.json is not JSON, or repeats a name: ${expected[what].source}`));
  }
  assert.deepEqual(problemsOf(modelOrigin('dup-json-none', { json: serializeModel(jsonFor('dup-json-none')) })), []);
});

test('parseJson is JSON.parse that refuses repeated names', () => {
  const same = ['{}', '[]', '0', '-1.5e3', 'true', 'null', '"a\\u0041\\n"', ' { "a" : [ 1 , { "b" : null } ] , "c" : "d" } ', '{"constructor":1,"__proto__":2,"toString":3}', '[[[]]]'];
  for (const text of same) assert.deepEqual(JSON.parse(JSON.stringify(parseJson(text))), JSON.parse(JSON.stringify(JSON.parse(text))), text);
  const parsed = parseJson('{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseJson('{"a":1,"a":2}'), /duplicate name "a" in the top-level object/);
  assert.throws(() => parseJson('{"a":{"b":[{"c":1,"c":2}]}}'), /duplicate name "c" in a\.b\[0\]/);
  assert.throws(() => parseJson('{"a":1,"\\u0061":2}'), /duplicate name "a"/, 'an escaped spelling of the same name');
  for (const bad of ['', '{', '{"a"}', '{"a":}', '{"a":1,}', '[1,]', '[1 2]', '{a:1}', '"x', '01', '1 2', '{"a":1} x', 'nul', '+1', "{'a':1}"]) assert.throws(() => parseJson(bad), undefined, bad);
  assert.throws(() => parseJson(`${'['.repeat(200)}${']'.repeat(200)}`), /nesting too deep/);
});

test('property order is the model\'s own, even for names that look like integers', () => {
  const hcl = `entity "T" {\n  key = ["b"]\n\n${['b', '2', '1', 'a'].map((name) => `  property "${name}" {\n    type = "int"\n  }\n`).join('\n')}}\n`;
  const source = modelOrigin('integer-names', { hcl });
  const dir = registry({ fixture: fixtureRecord(source) });
  assert.deepEqual(check(dir).problems, []);
  assert.deepEqual(loadModels(options(dir)).entries[0].records[0].fields.map((field) => field.name), ['b', '2', '1', 'a']);
});

test('the index lists the components an entity uses and the fields they add', () => {
  const hcl = `component "Audit" {
  field "createdAt" {
    type     = "datetime"
    required = true
  }

  field "createdBy" {
    entity = "T"
  }
}

entity "T" {
  key = ["id"]
  use = ["Audit"]

  property "id" {
    type = "int"
  }

  property "audit2" {
    component = "Audit"
  }
}
`;
  const source = modelOrigin('components', { hcl });
  const dir = registry({ fixture: fixtureRecord(source) });
  assert.deepEqual(check(dir).problems, []);
  const [entry] = loadModels(options(dir)).entries;
  assert.deepEqual(entry.records, [{ name: 'T', key: ['id'], use: ['Audit'], fields: [{ name: 'id', type: 'int', required: false, key: true }, { name: 'audit2', type: 'component', component: 'Audit', required: false, key: false }] }]);
  assert.deepEqual(entry.components, [{ name: 'Audit', fields: [{ name: 'createdAt', type: 'datetime', required: true }, { name: 'createdBy', type: 'reference', references: 'T', required: false }] }]);
});

test('removed constructs and reserved words are refused, in HCL and in JSON, and the message names the word', () => {
  const words = ['collection', 'recordset', 'column', 'projection', 'index', 'migration'];
  for (const word of words) {
    const status = ['collection', 'recordset', 'column'].includes(word) ? /was removed from ModelSpec \(decision 0019\)/ : /is reserved by ModelSpec and has no content \(decision 0019\)/;
    const named = new RegExp(`line \\d+: the ${word} block ${status.source}`);
    // At the top level, and inside a record type.
    const top = `${fixtureHcl}\n${word} "x" {\n}\n`;
    const nested = fixtureHcl.replace('property "Name" {', `${word} "x" {\n  }\n\n  property "Name" {`);
    for (const hcl of [top, nested]) {
      assert.throws(() => toModelspecJson(parseHcl(hcl), moduleFor(word)), named);
      expectProblem(problemsOf(modelOrigin(`refused-${word}`, { hcl, json: jsonFor(`refused-${word}`) })), new RegExp(`model/fixture\\.modelspec\\.hcl: ${named.source}`));
    }
  }
  // A collection with its settings is refused the same way, never converted.
  assert.throws(() => toModelspecJson(parseHcl('collection "tasks" {\n  kind = "editable"\n}\n'), moduleFor('collection')), /the collection block was removed/);
  // In JSON the removed and reserved top-level fields are refused.
  for (const [field, status] of [['collections', 'was removed'], ['recordsets', 'was removed'], ['projections', 'is reserved by ModelSpec and has no content'], ['migrations', 'is reserved by ModelSpec and has no content']]) {
    const json = jsonFor(`refused-${field}`);
    json[field] = {};
    assert.deepEqual(validateModel(json), [`the ${field} field ${status === 'was removed' ? status.replace('was removed', 'was removed from ModelSpec (decision 0019)') : `${status} (decision 0019); remove it`}`]);
    expectProblem(problemsOf(withJson(`refused-json-${field}`, (ast) => { ast[field] = {}; })), new RegExp(`the ${field} field `));
  }
  // `index` is reserved as a block only: the specification names no JSON field for it.
  const json = jsonFor('index-field');
  json.index = {};
  assert.deepEqual(validateModel(json), []);
});

// ---- both spellings ---------------------------------------------------------

const toCurrentJson = (json) => JSON.parse(JSON.stringify(json)
  .replace('"modelspec":"1.0-draft"', '"modelspec":"1.0-draft-2"')
  .replaceAll('"entities":', '"records":').replaceAll('"properties":', '"fields":').replaceAll('"entity":', '"record":'));

test('the two vocabularies are named in one table', () => {
  assert.deepEqual(vocabularies, {
    earlier: { identifier: '1.0-draft', record: 'entity', field: 'property', records: 'entities', fields: 'properties' },
    current: { identifier: '1.0-draft-2', record: 'record', field: 'field', records: 'records', fields: 'fields' },
  });
  assert.equal(vocabularyOf({ modelspec: '1.0-draft' }), vocabularies.earlier);
  assert.equal(vocabularyOf({ modelspec: '1.0-draft-2' }), vocabularies.current);
  assert.equal(vocabularyOf({ modelspec: '2.0' }), undefined);
  assert.equal(vocabularyOf(null), undefined);
});

test('an HCL source in the current spelling converts to a 1.0-draft-2 document the checks accept', () => {
  const json = jsonFor('current', currentHcl);
  assert.equal(json.modelspec, '1.0-draft-2');
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'records']);
  assert.deepEqual(json.records.Album.fields.ArtistId, { record: 'Artist', required: true });
  assert.deepEqual(validateModel(json), []);
  // It is the earlier document with the earlier words replaced, and nothing else.
  assert.deepEqual(astDifferences(json, toCurrentJson(jsonFor('current'))), []);
  assert.equal(hclUsesEarlier(parseHcl(currentHcl)), false);
  assert.equal(hclUsesEarlier(parseHcl(fixtureHcl)), true);
  assert.deepEqual(problemsOf(modelOrigin('current-model', { hcl: currentHcl })), []);
});

test('a source that mixes the spellings converts in the earlier vocabulary, as modelspec export does', () => {
  const mixed = `record "Customer" {
  key = ["id"]
  property "id" {
    type = "uuid"
  }
}

entity "Order" {
  key = ["id"]
  field "id" {
    type = "uuid"
  }
  field "customer" {
    entity = "Customer"
  }
  property "shipTo" {
    record = "Customer"
  }
}
`;
  const json = jsonFor('mixed', mixed);
  assert.equal(json.modelspec, '1.0-draft');
  assert.deepEqual(JSON.parse(JSON.stringify(json.entities.Order.properties)), { id: { type: 'uuid' }, customer: { entity: 'Customer' }, shipTo: { entity: 'Customer' } });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(mixed)), true);
  // One setting of the earlier spelling anywhere is enough, in a component too.
  const inComponent = 'component "C" {\n  field "x" {\n    entity = "A"\n  }\n}\nrecord "A" {\n  field "id" {\n    type = "int"\n  }\n}\n';
  assert.equal(jsonFor('mixed-component', inComponent).modelspec, '1.0-draft');
  assert.deepEqual(jsonFor('mixed-component', inComponent).components.C.fields.x, { entity: 'A' });
  assert.equal(jsonFor('only-component', 'component "C" {\n  field "x" {\n    type = "int"\n  }\n}\n').modelspec, '1.0-draft-2');
  assert.deepEqual(problemsOf(modelOrigin('mixed-model', { hcl: mixed })), []);
  // A field and a property of one name are one name twice.
  assert.throws(() => toModelspecJson(parseHcl('record "A" {\n  field "id" {\n    type = "int"\n  }\n  property "id" {\n    type = "int"\n  }\n}\n'), moduleFor('dup')), /duplicate property "id" in record "A"/);
});

test('a member that carries both reference words is refused; a property in a component is refused', () => {
  const both = currentHcl.replace('    record   = "Artist"', '    record   = "Artist"\n    entity   = "Artist"');
  assert.throws(() => toModelspecJson(parseHcl(both), moduleFor('both')), /line \d+: field "ArtistId" has both entity and record; a member refers to one record type/);
  expectProblem(problemsOf(modelOrigin('both-words', { hcl: both, json: jsonFor('both-words', currentHcl) })), /fixture\.modelspec\.hcl: line \d+: field "ArtistId" has both entity and record/);
  assert.throws(() => toModelspecJson(parseHcl('component "C" {\n  property "x" {\n    type = "int"\n  }\n}\n'), moduleFor('prop')), /component "C" cannot contain a property block \(this converter supports field\)/);
  assert.throws(() => toModelspecJson(parseHcl('record "A" {\n  record = "B"\n}\n'), moduleFor('rec')), /unsupported record attribute record/);
});

test('removed constructs and reserved words are refused in the current spelling too', () => {
  for (const word of ['collection', 'recordset', 'column', 'projection', 'index', 'migration']) {
    const hcl = currentHcl.replace('field "Name" {', `${word} "x" {\n  }\n\n  field "Name" {`);
    expectProblem(problemsOf(modelOrigin(`current-refused-${word}`, { hcl, json: jsonFor('current-refused', currentHcl) })), new RegExp(`fixture\\.modelspec\\.hcl: line \\d+: the ${word} block `));
  }
  for (const field of ['collections', 'recordsets', 'projections', 'migrations']) {
    const json = jsonFor(`current-${field}`, currentHcl);
    json[field] = {};
    assert.match(validateModel(json).join('\n'), new RegExp(`the ${field} field `));
  }
});

test('records is a reserved name beside entities, in both vocabularies', () => {
  for (const [identifier, records, fields] of [['1.0-draft', 'entities', 'properties'], ['1.0-draft-2', 'records', 'fields']]) {
    for (const name of ['records', 'entities']) {
      const json = { modelspec: identifier, module: { id: 'a/b', name: 'b', version: '1' }, [records]: { [name]: { [fields]: {} } } };
      assert.deepEqual(validateModel(json), [`${name} is a reserved name`]);
    }
  }
});

test('a JSON document is in the vocabulary its identifier names; a key of the other one is an error', () => {
  const earlierJson = jsonFor('earlier');
  const currentJson = jsonFor('current', currentHcl);
  assert.deepEqual(validateModel(earlierJson), []);
  assert.deepEqual(validateModel(currentJson), []);
  const cases = [
    ['1.0-draft-2 with entities', (json) => { json.entities = json.records; delete json.records; }, /"entities" is a key of format 1\.0-draft; this document says "1\.0-draft-2", where it is "records"/],
    ['1.0-draft-2 with properties', (json) => { json.records.Artist.properties = json.records.Artist.fields; }, /record Artist: "properties" is a key of format 1\.0-draft; .*where it is "fields"/],
    ['1.0-draft-2 with entity', (json) => { json.records.Album.fields.ArtistId.entity = 'Artist'; }, /Album\.ArtistId: "entity" is a key of format 1\.0-draft; .*where it is "record"/],
    ['1.0-draft-2 with entity in a component', (json) => { json.components = { C: { fields: { x: { entity: 'Artist' } } } }; }, /C\.x: "entity" is a key of format 1\.0-draft/],
  ];
  for (const [name, change, pattern] of cases) {
    const json = structuredClone(currentJson);
    change(json);
    expectProblem(validateModel(json), pattern);
    expectProblem(problemsOf(modelOrigin(`current-json-${name.replaceAll(' ', '-')}`, { hcl: currentHcl, json })), pattern);
  }
  const earlierCases = [
    ['1.0-draft with records', (json) => { json.records = json.entities; delete json.entities; }, /"records" is a key of format 1\.0-draft-2; this document says "1\.0-draft", where it is "entities"/],
    ['1.0-draft with fields', (json) => { json.entities.Artist.fields = json.entities.Artist.properties; }, /entity Artist: "fields" is a key of format 1\.0-draft-2; .*where it is "properties"/],
    ['1.0-draft with record', (json) => { json.entities.Album.properties.ArtistId.record = 'Artist'; }, /Album\.ArtistId: "record" is a key of format 1\.0-draft-2; .*where it is "entity"/],
    ['1.0-draft with record in a component', (json) => { json.components = { C: { fields: { x: { record: 'Artist' } } } }; }, /C\.x: "record" is a key of format 1\.0-draft-2/],
  ];
  for (const [name, change, pattern] of earlierCases) {
    const json = structuredClone(earlierJson);
    change(json);
    expectProblem(validateModel(json), pattern);
    expectProblem(problemsOf(modelOrigin(`earlier-json-${name.replaceAll(' ', '-')}`, { json })), pattern);
  }
  // Each message is the only one about its key: the key is not also an unsupported attribute.
  const stray = structuredClone(currentJson);
  stray.records.Album.fields.ArtistId.entity = 'Artist';
  assert.equal(validateModel(stray).filter((problem) => /unsupported attribute/.test(problem)).length, 0);
});

test('the current vocabulary has the same structural checks as the earlier one, in its own words', () => {
  const cases = [
    ['records-array', (json) => { json.records = []; }, /records must be an object keyed by name/],
    ['no-fields', (json) => { delete json.records.Artist.fields; }, /records Artist must be an object with fields/],
    ['key-not-list', (json) => { json.records.Artist.key = 'ArtistId'; }, /record Artist key must be a list of field names/],
    ['empty-key', (json) => { json.records.Artist.key = []; }, /record Artist key must be a non-empty list when present/],
    ['duplicate-key-field', (json) => { json.records.Artist.key = ['ArtistId', 'ArtistId']; }, /record Artist key ArtistId is duplicated/],
    ['key-not-field', (json) => { json.records.Artist.key = ['Nope']; }, /record Artist key Nope is not a field/],
    ['unknown-record', (json) => { json.records.Album.fields.ArtistId.record = 'Nope'; }, /Album\.ArtistId references unknown record Nope/],
    ['two-kinds', (json) => { json.records.Artist.fields.Name.record = 'Album'; }, /Artist\.Name must have exactly one of type, record, component/],
    ['unknown-component', (json) => { json.records.Artist.use = ['Nope']; }, /record Artist references unknown component Nope/],
    ['use-not-list', (json) => { json.records.Artist.use = 'Nope'; }, /record Artist use must be a list of component names/],
    ['record-and-enum', (json) => { json.enums = { Artist: { values: ['a'] } }; }, /Artist is declared as both records and enums/],
    ['qualified-reference', (json) => { json.records.Album.fields.ArtistId.record = 'core.Artist'; }, /names record core\.Artist of another module/],
    ['no-records', (json) => { json.records = {}; }, /a registered model has at least one record$/],
  ];
  for (const [name, change, pattern] of cases) {
    const json = jsonFor(name, currentHcl);
    change(json);
    const problems = problemsOf(modelOrigin(`current-${name}`, { hcl: currentHcl, json }));
    expectProblem(problems, pattern);
    assert.match(problems[0], /^models\/\$records\/fixture\.yaml: /);
  }
});

test('a JSON twin must be in the vocabulary of its HCL source', () => {
  const earlierJson = jsonFor('earlier');
  const currentJson = jsonFor('current', currentHcl);
  const twinCurrentJson = jsonFor('twin-current', currentHcl);
  assert.deepEqual(astDifferences(currentJson, currentJson), []);
  assert.deepEqual(astDifferences(earlierJson, earlierJson), []);
  const [difference, ...rest] = astDifferences(currentJson, earlierJson);
  assert.deepEqual(rest, []);
  assert.match(difference, /^modelspec is "1\.0-draft-2" in the HCL source but "1\.0-draft" in the JSON AST; the two must be in the same vocabulary \(modelspec rewrite --write brings the pair in line\)$/);
  assert.equal(astDifferences(earlierJson, currentJson).length, 1);
  // Through the registry: both twins are valid documents, and only the pair is wrong.
  expectProblem(problemsOf(modelOrigin('twin-current-source', { hcl: currentHcl, json: earlierJson })), /fixture\.modelspec\.json does not match model\/fixture\.modelspec\.hcl: modelspec is "1\.0-draft-2" in the HCL source but "1\.0-draft" in the JSON AST/);
  expectProblem(problemsOf(modelOrigin('twin-earlier-source', { hcl: fixtureHcl, json: currentJson })), /does not match model\/fixture\.modelspec\.hcl: modelspec is "1\.0-draft" in the HCL source but "1\.0-draft-2" in the JSON AST/);
  assert.deepEqual(problemsOf(modelOrigin('twin-current', { hcl: currentHcl, json: twinCurrentJson })), []);
  // A pair of mixed sources and an earlier twin agree.
  assert.deepEqual(problemsOf(modelOrigin('twin-mixed', { hcl: fixtureHcl.replace('entity "Album"', 'record "Album"').replace('property "AlbumId"', 'field "AlbumId"') })), []);
});

test('a model in the current spelling gives the index entry of the same model in the earlier one, and the index writes records and fields either way', () => {
  const entries = [fixtureHcl, currentHcl].map((hcl, i) => {
    const source = modelOrigin(`index-spelling-${i}`, { hcl });
    const dir = registry({ fixture: fixtureRecord(source) });
    assert.deepEqual(check(dir).problems, []);
    return loadModels(options(dir)).entries[0];
  });
  const [earlierEntry, currentEntry] = entries;
  assert.deepEqual(Object.keys(currentEntry), Object.keys(earlierEntry));
  assert.equal(currentEntry.modelspec, '1.0-draft-2');
  assert.equal(earlierEntry.modelspec, '1.0-draft');
  const { modelspec: _a, address: _b, repository: _c, commit: _d, module_id: _e, ...currentRest } = currentEntry;
  const { modelspec: _f, address: _g, repository: _h, commit: _i, module_id: _j, ...earlierRest } = earlierEntry;
  assert.deepEqual(currentRest, earlierRest);
  assert.ok(Object.hasOwn(currentEntry, 'records') && Object.hasOwn(currentEntry, 'components'));
  assert.equal(Object.hasOwn(currentEntry, 'entities'), false);
  assert.ok(Object.hasOwn(currentEntry.records[0], 'fields'));
  assert.equal(Object.hasOwn(currentEntry.records[0], 'properties'), false);
  assert.equal(currentEntry.records[1].fields[1].references, 'Artist');
  // One switch: neither spelling's entry carries a key of the earlier vocabulary anywhere.
  for (const entry of entries) assert.doesNotMatch(JSON.stringify(entry), /"(entities|properties|entity)":/);
});

test('describeModel gives one description whichever spelling the source uses', () => {
  const earlierSource = 'component "Audit" {\n  field "by" {\n    entity = "B"\n  }\n}\nentity "A" {\n  key = ["x"]\n  use = ["Audit"]\n  property "x" {\n    type = "int"\n    required = true\n  }\n  property "y" {\n    entity = "B"\n  }\n  property "z" {\n    component = "Audit"\n  }\n}\nentity "B" {\n  property "id" {\n    type = "int"\n  }\n}\n';
  const currentSource = earlierSource.replaceAll('entity "', 'record "').replaceAll('property "', 'field "').replaceAll('entity =', 'record =');
  assert.notEqual(currentSource, earlierSource);
  assert.deepEqual(describeModel(parseHcl(currentSource)), describeModel(parseHcl(earlierSource)));
  const mixed = earlierSource.replace('entity "B"', 'record "B"').replace('property "id"', 'field "id"').replace('entity = "B"\n  }\n  property', 'record = "B"\n  }\n  property');
  assert.deepEqual(describeModel(parseHcl(mixed)), describeModel(parseHcl(earlierSource)));
  assert.equal(describeModel(parseHcl(currentSource)).records[0].fields[1].references, 'B');
});

test('a model file in the earlier spelling is a notice, never a problem, one per registry record', () => {
  const earlierSource = modelOrigin('notice-earlier');
  const currentSource = modelOrigin('notice-current', { hcl: currentHcl });
  const halfSource = modelOrigin('notice-half', { hcl: currentHcl, json: toCurrentJson(jsonFor('notice-half')) });
  const mixedSource = modelOrigin('notice-source-only', { hcl: fixtureHcl, json: jsonFor('notice-source-only') });
  const dir = registry({
    earlier: fixtureRecord(earlierSource, { address: 'modelspec://example.test/fixtures/notice-earlier/fixture' }),
    current: fixtureRecord(currentSource),
    half: fixtureRecord(halfSource),
    other: fixtureRecord(mixedSource),
  });
  const result = check(dir);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.notices, [
    'models/$records/earlier.yaml: model/fixture.modelspec.hcl and model/fixture.modelspec.json are in the earlier spelling (entity, property, entity = in HCL; 1.0-draft with entities, properties, entity in JSON), which is still read; modelspec rewrite --write rewrites them',
    'models/$records/other.yaml: model/fixture.modelspec.hcl and model/fixture.modelspec.json are in the earlier spelling (entity, property, entity = in HCL; 1.0-draft with entities, properties, entity in JSON), which is still read; modelspec rewrite --write rewrites them',
  ]);
  assert.equal(earlierSpellingNotice('r.yaml', ['a.hcl']), 'r.yaml: a.hcl is in the earlier spelling (entity, property, entity = in HCL; 1.0-draft with entities, properties, entity in JSON), which is still read; modelspec rewrite --write rewrites it');
  // A broken model gives problems and no notice; a record that is not read gives neither.
  assert.deepEqual(problemsOf(modelOrigin('notice-broken', { json: '{ nope' })).length > 0, true);
  assert.deepEqual(sourceNotices('r.yaml', 'm.hcl', fixtureHcl), ['r.yaml: m.hcl is in the earlier spelling (entity, property, entity = in HCL; 1.0-draft with entities, properties, entity in JSON), which is still read; modelspec rewrite --write rewrites it']);
  assert.deepEqual(sourceNotices('r.yaml', 'm.hcl', currentHcl), []);
  assert.deepEqual(sourceNotices('r.yaml', 'm.hcl', 'entity "A" {'), []);
});

test('a property block in a record block is a word of the earlier spelling, and the document is 1.0-draft as modelspec export writes it', () => {
  const hcl = 'record "A" {\n  key = ["id"]\n  property "id" {\n    type = "int"\n  }\n}\n';
  assert.equal(hclUsesEarlier(parseHcl(hcl)), true);
  const json = jsonFor('property-in-record', hcl);
  assert.equal(json.modelspec, '1.0-draft');
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'entities']);
  assert.deepEqual(Object.keys(json.entities.A), ['key', 'properties']);
  assert.deepEqual(problemsOf(modelOrigin('property-in-record', { hcl })), []);
  assert.equal(sourceNotices('r.yaml', 'm.hcl', hcl).length, 1);
  // The same record type with a field block is the current spelling.
  assert.equal(hclUsesEarlier(parseHcl(hcl.replace('property', 'field'))), false);
});

test('check.mjs prints notices on standard error only, and a notice never changes the exit status', () => {
  const notices = ['models/$records/a.yaml: a.hcl is in the earlier spelling'];
  const passing = checkReport({ problems: [], notices, models: 9 });
  assert.deepEqual(passing, { stdout: ['ok: 9 models checked'], stderr: ['notice: models/$records/a.yaml: a.hcl is in the earlier spelling'], status: 0 });
  assert.deepEqual(checkReport({ problems: [], notices: [], models: 1 }), { stdout: ['ok: 1 model checked'], stderr: [], status: 0 });
  const failing = checkReport({ problems: ['p one', 'p two'], notices, models: 2 });
  assert.equal(failing.status, 1);
  assert.deepEqual(failing.stdout, []);
  assert.deepEqual(failing.stderr, ['notice: models/$records/a.yaml: a.hcl is in the earlier spelling', 'error: p one', 'error: p two', '2 problems in 2 models']);
  assert.equal(checkReport({ problems: ['p'], notices: [], models: 1 }).stderr.at(-1), '1 problem in 1 model');
  // The status is the same with and without notices, for a passing and for a failing run.
  assert.equal(checkReport({ problems: [], notices: [], models: 9 }).status, passing.status);
  assert.equal(checkReport({ problems: ['p'], notices: [], models: 9 }).status, checkReport({ problems: ['p'], notices, models: 9 }).status);
  // What the script does with it: the check on a real fixture registry gives notices that reach standard error.
  const dir = registry({ fixture: fixtureRecord(modelOrigin('report-fixture')) });
  const report = checkReport(check(dir));
  assert.equal(report.status, 0);
  assert.deepEqual(report.stdout, ['ok: 1 model checked']);
  assert.equal(report.stderr.length, 1);
  assert.match(report.stderr[0], /^notice: models\/\$records\/fixture\.yaml: .* modelspec rewrite --write rewrites them$/);
});

test('lint-hcl.mjs: one notice for a source in the earlier spelling, none for the current one, and SpecScore\'s own advisory finding is ignored', () => {
  assert.equal(sourceNotices('models/$records/m.yaml', 'model/m.modelspec.hcl', fixtureHcl).length, 1);
  assert.deepEqual(sourceNotices('r', 'f', currentHcl), []);
  // A source the registry parser cannot read is the linter's to judge: no notice.
  assert.deepEqual(sourceNotices('r', 'f', 'record "A" {'), []);
  // The linter is told to ignore its own finding for the earlier spelling, and only that one, so a source gets one notice.
  assert.deepEqual(lintArguments, ['graph', 'lint', '--severity', 'info', '--ignore', 'graph-model-deprecated-spelling']);
});
