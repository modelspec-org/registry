// The registry's own checks, CC0-1.0 like everything else here.
//
// inGitDB validates the records against the collection definitions (types,
// required columns, enums, lengths, foreign keys). This module checks what a
// column definition cannot say, and everything that needs the model's own
// repository: it opens each model at its commit through the hardened git
// module (git.mjs), and checks the files, the JSON AST, the HCL source, the
// module, the address and the licence against the record. It also writes
// index.json (buildIndex) and checks that the committed one is what the records
// and the repositories say.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isScalar, parse as parseYaml, parseDocument, visit } from 'yaml';
import { addressOf, commitPattern, defaultBranch, defaultCacheDir, isRepositoryPath, lastLine, modulePattern, onBranch, openCommit, repositoryHosts, repositoryKey, trackedCacheProblems } from './git.mjs';
import { homepageProblem } from './urls.mjs';
import { astDifferences, describeModel, modelspecVersion, parseHcl, parseJson, toModelspecJson, validateModel } from './modelspec.mjs';

export const registryFormat = 'modelspec-registry/draft-1';
export const statuses = ['draft', 'published', 'deprecated'];

// Lower case, digits and single hyphens, at most 80 characters: the id rule of
// meaninggraph/registry, so a model and its graph can share an id.
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

const recordsDir = (root, collection) => join(root, collection, '$records');

// YAML merge keys are switched off, so a plain `<<` is an ordinary key. That
// is not enough: the reader still merges when the key carries an explicit tag
// (`!!merge <<:`) and when the file starts with a `%YAML 1.1` directive, which
// also changes how scalars such as `yes` or `1:30` are read. So a record is
// read as a document, and refused when it has any YAML directive or any key
// whose source text is `<<`, whatever its quoting or tag (readRecord).
const yamlOptions = { merge: false };

// Parses one record file: { data, problems }. Throws when the text is not
// YAML (an error, a duplicate key, an unresolved alias, a second document).
export function readRecord(text, file) {
  const doc = parseDocument(text, yamlOptions);
  if (doc.errors.length > 0) throw doc.errors[0];
  const problems = [];
  if (doc.directives.yaml.explicit) problems.push(`${file}: a %YAML directive is not allowed: it changes how values and merge keys are read`);
  let merges = 0;
  visit(doc, { Pair(_, pair) { if (isScalar(pair.key) && pair.key.source === '<<') merges += 1; } });
  if (merges > 0) problems.push(`${file}: "<<" merge keys are not allowed; write every column out, so that every value is checked`);
  return { data: doc.toJS(), problems };
}

// The columns a collection declares in its definition (the keys of `columns`),
// or a problem when the definition cannot be read.
export function readColumns(root, collection) {
  const file = `${collection}/.collection/definition.yaml`;
  try {
    const definition = parseYaml(readFileSync(join(root, file), 'utf8'), yamlOptions);
    const columns = Object.keys(definition?.columns ?? {});
    if (columns.length === 0) return { columns, problems: [`${file}: declares no columns`] };
    return { columns, problems: [] };
  } catch (error) {
    return { columns: [], problems: [`${file}: cannot read the collection definition: ${error.message}`] };
  }
}

// Reads one collection's records as [{ key, file, data }] sorted by key, with a
// problem for any file in $records that is not <key>.yaml.
export function readCollection(root, collection) {
  const dir = recordsDir(root, collection);
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems };
  for (const name of readdirSync(dir).sort()) {
    const file = `${collection}/$records/${name}`;
    if (!name.endsWith('.yaml')) { problems.push(`${file}: a record is a <key>.yaml file; remove or rename it`); continue; }
    let read;
    try { read = readRecord(readFileSync(join(dir, name), 'utf8'), file); } catch (error) { problems.push(`${file}: not YAML: ${error.message}`); continue; }
    problems.push(...read.problems);
    records.push({ key: name.slice(0, -'.yaml'.length), file, data: read.data ?? {} });
  }
  return { records, problems };
}

export function readRegistry(root) {
  const models = readCollection(root, 'models');
  const maintainers = readCollection(root, 'maintainers');
  const columns = { models: readColumns(root, 'models'), maintainers: readColumns(root, 'maintainers') };
  return {
    models: models.records,
    maintainers: maintainers.records,
    columns: { models: columns.models.columns, maintainers: columns.maintainers.columns },
    problems: [...models.problems, ...maintainers.problems, ...columns.models.problems, ...columns.maintainers.problems],
  };
}

// A record is a mapping of declared columns and nothing else: no key the
// collection does not declare (which would otherwise go unchecked). A `<<` key
// is skipped here because readRecord refuses it, in every spelling.
function keyProblems(file, data, declared) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [`${file}: a record is a mapping of columns`];
  const problems = [];
  for (const key of Object.keys(data)) {
    if (key === '<<') continue; // refused when the file is read (readRecord), once, in whatever spelling
    if (!declared.includes(key)) problems.push(`${file}: ${JSON.stringify(key)} is not a column of this collection (${declared.join(', ')}); the collection definition declares every column`);
  }
  return problems;
}

// A record whose repository, address, module, commit and paths are well formed:
// the only kind whose values are ever handed to git.
export const wellFormed = (record) => {
  const { data } = record;
  return Boolean(record) && addressOf(data.repository, data.module) === data.address && commitPattern.test(data.commit ?? '')
    && isRepositoryPath(data.source_file) && isRepositoryPath(data.json_file) && data.source_file !== data.json_file;
};

// Rules on the records alone (no network): the parts of the format that the
// inGitDB collection definitions cannot express.
export function recordProblems({ models, maintainers, columns }) {
  const problems = [];
  for (const { file, data } of maintainers) problems.push(...keyProblems(file, data, columns.maintainers));
  const byAddress = new Map();
  const handles = new Set(maintainers.map((maintainer) => maintainer.key));
  for (const { key, file, data } of models) {
    problems.push(...keyProblems(file, data, columns.models));
    if (!idPattern.test(key) || key.length > 80) problems.push(`${file}: id "${key}" must be lower-case letters, digits and single hyphens, at most 80 characters`);
    if (data.format !== registryFormat) problems.push(`${file}: format must be ${registryFormat}`);
    if (!statuses.includes(data.status)) problems.push(`${file}: status must be one of ${statuses.join(', ')}`);
    if (data.homepage !== undefined) {
      const problem = homepageProblem(data.homepage);
      if (problem) problems.push(`${file}: homepage: ${problem}`);
    }
    if (!commitPattern.test(data.commit ?? '')) problems.push(`${file}: commit must be a full 40-character lower-case commit id`);
    if (!repositoryKey(data.repository)) problems.push(`${file}: repository must be an https URL of a repository on ${[...repositoryHosts.keys()].join(', ')}, such as https://github.com/{org}/{repo} (no trailing slash, .git, "." or ".." segments)`);
    if (typeof data.module !== 'string' || !modulePattern.test(data.module)) problems.push(`${file}: module must be a ModelSpec module name: a letter, then letters, digits and "_"`);
    else if (repositoryKey(data.repository) && data.address !== addressOf(data.repository, data.module)) problems.push(`${file}: address must be ${addressOf(data.repository, data.module)}: modelspec:// and the repository without https://, then / and the module`);
    if (typeof data.address === 'string') byAddress.set(data.address.toLowerCase(), [...(byAddress.get(data.address.toLowerCase()) ?? []), { key, value: data.address }]);
    if (typeof data.licence !== 'string' || !spdxPattern.test(data.licence)) problems.push(`${file}: licence must be an SPDX licence identifier`);
    for (const [column, suffix] of [['source_file', '.modelspec.hcl'], ['json_file', '.modelspec.json']]) {
      if (!isRepositoryPath(data[column])) problems.push(`${file}: ${column}: ${JSON.stringify(data[column])} must be a relative path inside the repository (letters, digits, ".", "_", "-" and "/"; no "..", no "*" or other pattern characters)`);
      else if (!data[column].endsWith(suffix)) problems.push(`${file}: ${column}: ${data[column]} must be a *${suffix} file`);
    }
    if (data.source_file !== undefined && data.source_file === data.json_file) problems.push(`${file}: source_file and json_file must be two different files`);
    if (!Array.isArray(data.maintainers) || data.maintainers.length === 0) problems.push(`${file}: maintainers must name at least one maintainer`);
    for (const handle of Array.isArray(data.maintainers) ? data.maintainers : []) {
      if (!handles.has(handle)) problems.push(`${file}: maintainer ${handle} has no record in maintainers/$records/${handle}.yaml`);
    }
  }
  // Hosts and most forges ignore case in org and repository names, so
  // modelspec://github.com/Datatug/ChinookDB/chinook is chinookdb again.
  for (const owners of byAddress.values()) {
    if (owners.length > 1) problems.push(`models/$records/${owners.at(-1).key}.yaml: address ${owners.at(-1).value} is registered under ${owners.length} ids (${owners.map((owner) => `${owner.key}: ${owner.value}`).join(', ')}, compared ignoring case); a model is registered once`);
  }
  return problems;
}

// Licence texts the check recognises in a repository's LICENSE files.
const licenceTexts = [
  ['MIT', /^\s*(?:The )?MIT License\b/m],
  ['CC0-1.0', /CC0 1\.0 Universal/],
  ['Apache-2.0', /Apache License\s+Version 2\.0/],
  ['CC-BY-4.0', /Attribution 4\.0 International/],
  ['CC-BY-SA-3.0', /SPDX-License-Identifier:\s*CC-BY-SA-3\.0|Attribution-ShareAlike 3\.0 International/],
  ['BSD-3-Clause', /BSD 3-Clause/],
];

// The SPDX ids that the regular LICENSE* files in the repository root identify:
// { all, main, hasMain } where `main` comes from the unsuffixed file (LICENSE,
// LICENCE or COPYING, optionally .md or .txt), the repository's default, and
// `hasMain` says whether such a file exists at all (a link or a text the check
// does not recognise still counts as the default).
export function repositoryLicences(view) {
  const all = new Set();
  const main = new Set();
  let hasMain = false;
  for (const { name, mode } of view.rootNames()) {
    if (!/^(LICEN[CS]E|COPYING)/i.test(name) || !isRepositoryPath(name)) continue;
    const unsuffixed = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(name);
    hasMain ||= unsuffixed;
    if (!['100644', '100755'].includes(mode)) continue;
    const text = view.read(name);
    for (const [id, pattern] of licenceTexts) {
      if (!pattern.test(text)) continue;
      all.add(id);
      if (unsuffixed) main.add(id);
    }
  }
  return { all, main, hasMain };
}

// The licence a file states about itself: a `Licence:` / `License:` /
// `SPDX-License-Identifier:` line in its first lines, or null.
export function declaredLicence(text) {
  for (const line of text.split('\n').slice(0, 10)) {
    const match = /(?:SPDX-License-Identifier|Licen[cs]e):\s*([A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9+])/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

// A file's licence must be the one the record states: the licence the file
// declares itself, or, when it declares none, the repository's default
// licence. The default is the licence of the unsuffixed LICENSE file when
// there is one (even if the check does not recognise its text); with no such
// file, the one licence all LICENSE files name. When that is not exactly one
// recognised licence, the file must declare its licence itself. ModelSpec JSON
// has no licence field, so a validated JSON twin inherits an explicit HCL
// declaration; otherwise it takes the repository's default.
function licenceProblems(file, view, path, declared, expected) {
  const { all, main, hasMain } = repositoryLicences(view);
  const fallback = hasMain ? main : all;
  if (declared !== null) return declared === expected ? [] : [`${file}: licence is ${expected}, but ${path} declares ${declared}`];
  const licenceFiles = hasMain ? 'LICENSE file names' : 'LICENSE files name';
  if (fallback.size !== 1) return [`${file}: ${path} declares no licence, and the repository's ${licenceFiles} ${fallback.size ? `several (${[...fallback].join(', ')})` : 'no licence the check recognises'}; ${path.endsWith('.json') ? 'a JSON file cannot declare one, so the repository needs one LICENSE file naming the licence' : 'the file must declare its licence (a Licence: or SPDX-License-Identifier: line at the top)'}`];
  if (!fallback.has(expected)) return [`${file}: licence is ${expected}, but ${path} declares no licence and the repository's default licence (its LICENSE file) is ${[...fallback][0]}`];
  return [];
}

const maxDifferences = 10;

// Checks one model at its commit and returns { problems, entry }, where `entry`
// is the model's index entry (absent when the model could not be read). `urlFor`
// maps a repository URL to the URL git fetches (tests point it at local
// repositories).
export function readModel({ record, urlFor = (url) => url, cacheDir, historyDir, fetched = new Set(), branches = new Map() }) {
  const { key, file, data } = record;
  const problems = [];
  const fail = (message) => { problems.push(`${file}: ${message}`); return { problems }; };
  if (!wellFormed(record)) return { problems }; // reported by recordProblems; never handed to git
  const url = urlFor(data.repository);

  let view;
  try { view = openCommit(url, data.commit, cacheDir); } catch (error) { return fail(error.message); }
  try {
    if (!branches.has(url)) branches.set(url, defaultBranch(url));
    const branch = branches.get(url);
    if (!onBranch(url, branch, data.commit, historyDir, fetched)) return fail(`commit ${data.commit} is not in the history of ${branch}, the default branch of ${data.repository} (a commit only a fork or another branch has); register a commit from ${branch}`);
  } catch (error) { return fail(error.message); }

  const texts = {};
  let readable = true;
  for (const column of ['source_file', 'json_file']) {
    const path = data[column];
    try {
      const status = view.lookup(path);
      if (status === 'missing') problems.push(`${file}: ${column}: ${path} does not exist at commit ${data.commit}`);
      else if (status !== 'file') problems.push(`${file}: ${column}: ${path} is not a regular file at commit ${data.commit} (${status === 'directory' ? 'a directory' : 'a symbolic link or submodule'}); list files of the repository`);
      else texts[column] = view.read(path);
    } catch (error) { problems.push(`${file}: ${column}: ${error.message}`); }
    if (texts[column] === undefined) readable = false;
  }
  if (!readable) return { problems };

  let ast;
  try { ast = parseJson(texts.json_file); } catch (error) { return fail(`${data.json_file} is not JSON, or repeats a name: ${error.message}`); }
  const structural = validateModel(ast);
  for (const problem of structural) problems.push(`${file}: ${data.json_file}: ${problem}`);
  if (structural.length > 0) return { problems };
  if (ast.modelspec !== modelspecVersion) problems.push(`${file}: ${data.json_file}: modelspec must be "${modelspecVersion}"`);
  if (Object.keys(ast.entities ?? {}).length === 0) problems.push(`${file}: ${data.json_file}: a registered model has at least one entity`);

  // The module the files declare is the module in the record and in the address.
  const repoKey = repositoryKey(data.repository);
  if (ast.module.name !== data.module) problems.push(`${file}: module is ${data.module}, but ${data.json_file} declares module.name ${JSON.stringify(ast.module.name)}`);
  const id = ast.module.id;
  if (typeof id !== 'string' || !id.toLowerCase().startsWith(`${repoKey.toLowerCase()}/`) || id.split('/').at(-1) !== data.module) {
    problems.push(`${file}: ${data.json_file} declares module.id ${JSON.stringify(id)}, which must start with ${repoKey}/ and end with /${data.module}, so that the address ${data.address} names the module the file declares`);
  }

  // The JSON AST is what the HCL source says. There is no ModelSpec tool that
  // does this yet; see scripts/lib/modelspec.mjs for what is compared.
  let document;
  let hclJsonTwin = false;
  try {
    document = parseHcl(texts.source_file);
    const differences = astDifferences(toModelspecJson(document, ast.module), ast);
    hclJsonTwin = differences.length === 0;
    for (const difference of differences.slice(0, maxDifferences)) problems.push(`${file}: ${data.json_file} does not match ${data.source_file}: ${difference}`);
    if (differences.length > maxDifferences) problems.push(`${file}: ${data.json_file} does not match ${data.source_file}: ${differences.length - maxDifferences} more differences`);
  } catch (error) { problems.push(`${file}: ${data.source_file}: ${error.message}`); }

  try {
    const hclLicence = declaredLicence(texts.source_file);
    problems.push(...licenceProblems(file, view, data.source_file, hclLicence, data.licence));
    problems.push(...licenceProblems(file, view, data.json_file, hclJsonTwin ? hclLicence : null, data.licence));
  } catch (error) { problems.push(`${file}: licence: ${lastLine(error)}`); }

  if (problems.length > 0) return { problems };
  return {
    problems,
    entry: {
      id: key,
      title: data.title,
      description: data.description,
      status: data.status,
      ...(data.homepage === undefined ? {} : { homepage: data.homepage }),
      address: data.address,
      repository: data.repository,
      commit: data.commit,
      module: data.module,
      module_id: ast.module.id,
      module_version: ast.module.version,
      modelspec: ast.modelspec,
      licence: data.licence,
      files: { source: data.source_file, json: data.json_file },
      maintainers: [...data.maintainers],
      ...describeModel(document),
    },
  };
}

// Code-unit order, the same in every locale.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// index.json: every model sorted by id, and a sha256 of the models array as
// written (compact JSON) so a consumer can verify one fetch. Deterministic: the
// same entries always give the same bytes.
export function buildIndex(entries) {
  const models = [...entries].sort(byId);
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(models)).digest('hex')}`;
  return `${JSON.stringify({ format: registryFormat, checksum, models }, null, 2)}\n`;
}

// Reads every model at its commit: { problems, entries, registry }. A model
// that fails its checks has no entry and gives problems.
export function loadModels({ root, urlFor, cacheDir = defaultCacheDir(), fetched = new Set(), branches = new Map() } = {}) {
  const registry = readRegistry(root);
  const tracked = trackedCacheProblems(root);
  const problems = [...tracked, ...registry.problems, ...recordProblems(registry)];
  const entries = [];
  // Nothing is fetched into, or read from, a checkout that tracks a cache.
  if (tracked.length > 0) return { problems, entries, registry };
  const historyDir = join(cacheDir, 'history');
  for (const record of registry.models) {
    const result = readModel({ record, urlFor, cacheDir: join(cacheDir, 'models'), historyDir, fetched, branches });
    problems.push(...result.problems);
    if (result.entry) entries.push(result.entry);
  }
  return { problems, entries, registry };
}

// Every check: records, then each model at its commit, then index.json.
// `fetched` and `branches` remember, across calls, which branch histories were
// fetched and which default branches were read; by default each call starts afresh.
export function checkRegistry(options = {}) {
  const { root } = options;
  const { problems, entries, registry } = loadModels(options);
  const path = join(root, 'index.json');
  if (!existsSync(path)) problems.push('index.json is missing; run npm run index and commit it');
  else if (problems.length === 0 && readFileSync(path, 'utf8') !== buildIndex(entries)) problems.push('index.json differs from the records and the models they pin; run npm run index and commit it');
  return { problems, models: registry.models.length };
}
