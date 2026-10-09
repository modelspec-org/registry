// ModelSpec helpers for the registry checks, CC0-1.0 like everything else here.
//
// Written against the ModelSpec specification at specscore/modelspec@133134b
// (spec/core-model.md "Deprecated Spellings" and "Removed Constructs And Reserved
// Words", spec/hcl-authoring.md, spec/json-format.md, decisions 0014, 0018, 0019
// and 0020), and checked against the reference CLI, `modelspec` 0.2.0. ModelSpec
// publishes JSON Schemas for its JSON AST at https://modelspec.org/schema/ (one for
// each vocabulary below); this module does not validate against them, it
// implements the structural checks of spec/json-format.md "Validation
// Requirements" itself (validateModel). ModelSpec has no parser of its own that
// writes JSON besides the reference CLI, so this module also converts the HCL
// subset that ModelSpec v0 uses to the JSON AST (parseHcl, toModelspecJson), which
// the registry uses to check that a model's JSON AST is what its HCL source says.
// The code started as the one in meaninggraph/core (scripts/lib/modelspec.mjs at
// cb97dbc, CC0-1.0, also used by datatug/chinookdb), without its comparison with
// published data. It supports records (entities in the earlier spelling),
// components and enums. When a consumer can run the reference CLI or validate
// against the published schemas, replace this module with them.
//
// The parser accepts only what ModelSpec v0 HCL allows: named blocks, and
// attributes whose values are strings, numbers, booleans or lists of those. It
// rejects expressions, interpolation and map-style containers rather than
// guessing, so an unsupported construct fails loudly.

export const modelspecSpecCommit = '133134b255ad7e94c9c838011605bb62c9675888';
export const primitiveTypes = ['string', 'int', 'float', 'bool', 'decimal', 'uuid', 'date', 'time', 'datetime', 'document', 'json', 'any'];
export const reservedNames = ['records', 'entities', 'components', 'enums', 'collections', 'recordsets'];
const constraintTypes = { required: 'boolean', unique: 'boolean', min_len: 'integer', max_len: 'integer', pattern: 'string', format: 'string' };

// The two vocabularies, the whole of what differs between them (decisions 0018 and
// 0020). `record` is the HCL block of a record type, the HCL setting of a member that
// names a record type, and the JSON key of that setting; `field` is the HCL block of a
// member of a record type; `records` and `fields` are the JSON keys of a document's
// record types and of a record type's members. The JSON identifier decides which
// vocabulary a document is in; in HCL the words may be mixed in one file. A component
// has `fields` and a `field` block under both. The earlier vocabulary is deprecated
// and still read.
export const vocabularies = {
  earlier: { identifier: '1.0-draft', record: 'entity', field: 'property', records: 'entities', fields: 'properties' },
  current: { identifier: '1.0-draft-2', record: 'record', field: 'field', records: 'records', fields: 'fields' },
};
const { earlier, current } = vocabularies;
const both = [current, earlier];
const recordBlocks = both.map((words) => words.record);
const fieldBlocks = both.map((words) => words.field);
// The vocabulary a JSON document's identifier names, or undefined.
export const vocabularyOf = (json) => both.find((words) => words.identifier === json?.modelspec);
// The vocabulary the other way round.
const otherThan = (vocabulary) => (vocabulary === earlier ? current : earlier);

// Constructs of earlier drafts that a reader refuses, with the word that names them in
// HCL (a block) and, where there is one, in JSON (a top-level field): removed ones were
// part of the language, reserved ones are kept free for a later version (decision 0019).
const refusedWords = [
  { word: 'collection', status: 'removed', json: 'collections' },
  { word: 'recordset', status: 'removed', json: 'recordsets' },
  { word: 'column', status: 'removed' },
  { word: 'projection', status: 'reserved', json: 'projections' },
  { word: 'index', status: 'reserved' },
  { word: 'migration', status: 'reserved', json: 'migrations' },
];
const refusal = ({ word, status }, noun) => (status === 'removed'
  ? `the ${word} ${noun} was removed from ModelSpec (decision 0019)`
  : `the ${word} ${noun} is reserved by ModelSpec and has no content (decision 0019); remove it`);

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`line ${line}: unterminated comment`);
      line += text.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if ('{}[]=,'.includes(c)) { tokens.push({ kind: c, line }); i++; continue; }
    if (c === '"') {
      let value = '';
      i++;
      while (text[i] !== '"') {
        if (i >= text.length || text[i] === '\n') throw new Error(`line ${line}: unterminated string`);
        if (text[i] === '$' && text[i + 1] === '{') throw new Error(`line ${line}: string interpolation is not ModelSpec v0`);
        if (text[i] === '\\') {
          const escaped = { n: '\n', t: '\t', '"': '"', '\\': '\\' }[text[i + 1]];
          if (escaped === undefined) throw new Error(`line ${line}: unsupported escape \\${text[i + 1]}`);
          value += escaped;
          i += 2;
        } else value += text[i++];
      }
      i++;
      tokens.push({ kind: 'string', value, line });
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (number) { tokens.push({ kind: 'number', value: Number(number[0]), line }); i += number[0].length; continue; }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
    if (ident) { tokens.push({ kind: 'ident', value: ident[0], line }); i += ident[0].length; continue; }
    throw new Error(`line ${line}: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// Parses ModelSpec HCL into { blocks: [{ type, name, line, attributes, blocks }] }.
export function parseHcl(text) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const expect = (kind) => {
    const token = tokens[p];
    if (!token || token.kind !== kind) throw new Error(`line ${token?.line ?? 'EOF'}: expected ${kind}, found ${token ? token.value ?? token.kind : 'end of file'}`);
    p++;
    return token;
  };
  const value = () => {
    const token = tokens[p++];
    if (!token) throw new Error('unexpected end of file in a value');
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'ident' && (token.value === 'true' || token.value === 'false')) return token.value === 'true';
    if (token.kind === '[') {
      const list = [];
      while (peek()?.kind !== ']') {
        const item = value();
        if (Array.isArray(item)) throw new Error(`line ${token.line}: nested lists are not ModelSpec v0`);
        list.push(item);
        if (peek()?.kind === ',') p++;
        else break;
      }
      expect(']');
      return list;
    }
    if (token.kind === '{') throw new Error(`line ${token.line}: map-style values are not ModelSpec v0 syntax; use named blocks`);
    throw new Error(`line ${token.line}: ${token.value ?? token.kind} is not a literal (expressions are not ModelSpec v0)`);
  };
  const body = (closing) => {
    const attributes = Object.create(null);
    const blocks = [];
    while (peek() && peek().kind !== closing) {
      const name = expect('ident');
      if (peek()?.kind === '=') {
        p++;
        if (Object.hasOwn(attributes, name.value)) throw new Error(`line ${name.line}: duplicate attribute ${name.value}`);
        attributes[name.value] = value();
      } else {
        const label = expect('string');
        expect('{');
        const inner = body('}');
        expect('}');
        blocks.push({ type: name.value, name: label.value, line: name.line, ...inner });
      }
    }
    return { attributes, blocks };
  };
  const document = body(undefined);
  if (Object.keys(document.attributes).length > 0) throw new Error('top-level attributes are not ModelSpec v0');
  return document;
}

// Throws for a removed or reserved block anywhere in the source, naming the word.
function refuseRemovedBlocks(blocks) {
  for (const block of blocks) {
    const refused = refusedWords.find(({ word }) => word === block.type);
    if (refused) throw new Error(`line ${block.line}: ${refusal(refused, 'block')}`);
    refuseRemovedBlocks(block.blocks);
  }
}

// ---- HCL to JSON -----------------------------------------------------------

// A source that holds any word of the earlier spelling is exported in the earlier
// vocabulary, as `modelspec export` does, so that a model and its JSON twin stay in
// step until both are rewritten. Only a source in the current spelling alone is
// exported as `1.0-draft-2`.
export const hclUsesEarlier = (document) => document.blocks.some((block) => block.type === earlier.record
  || block.blocks.some((child) => child.type === earlier.field || Object.hasOwn(child.attributes, earlier.record)));

// A member's settings, with its reference to a record type spelled as `vocabulary` spells it.
// One member that carries both spellings of the reference is an error.
function memberSettings(member, vocabulary) {
  if (both.every((words) => Object.hasOwn(member.attributes, words.record))) {
    throw new Error(`line ${member.line}: ${member.type} "${member.name}" has both ${earlier.record} and ${current.record}; a member refers to one record type`);
  }
  return Object.fromEntries(Object.entries(member.attributes).map(([name, value]) => [both.some((words) => words.record === name) ? vocabulary.record : name, value]));
}

// The members of a record type or a component, keyed by name. `allowed` are the block
// types a member may have.
function members(block, allowed, vocabulary) {
  const out = Object.create(null);
  for (const child of block.blocks) {
    if (!allowed.includes(child.type)) throw new Error(`line ${child.line}: ${block.type} "${block.name}" cannot contain ${/^[aeiou]/.test(child.type) ? 'an' : 'a'} ${child.type} block (this converter supports ${allowed.join(', ')})`);
    if (child.blocks.length > 0) throw new Error(`line ${child.line}: ${child.type} "${child.name}" cannot contain blocks`);
    if (Object.hasOwn(out, child.name)) throw new Error(`line ${child.line}: duplicate ${child.type} "${child.name}" in ${block.type} "${block.name}"`);
    out[child.name] = memberSettings(child, vocabulary);
  }
  return out;
}

function recordJson(block, vocabulary) {
  const { key, use, ...rest } = block.attributes;
  if (Object.keys(rest).length > 0) throw new Error(`line ${block.line}: unsupported ${block.type} attribute ${Object.keys(rest).join(', ')}`);
  return { ...(key ? { key } : {}), ...(use ? { use } : {}), [vocabulary.fields]: members(block, fieldBlocks, vocabulary) };
}

// Serializes parsed HCL to the ModelSpec JSON AST. `module` is { id, name, version }:
// standalone HCL has no place for module identity, so the caller supplies it.
export function toModelspecJson(document, module) {
  refuseRemovedBlocks(document.blocks);
  const vocabulary = hclUsesEarlier(document) ? earlier : current;
  const json = { modelspec: vocabulary.identifier, module };
  const add = (kind, block, value) => {
    json[kind] ??= Object.create(null);
    if (Object.hasOwn(json[kind], block.name)) throw new Error(`line ${block.line}: duplicate ${block.type} "${block.name}"`);
    json[kind][block.name] = value;
  };
  for (const block of document.blocks) {
    if (recordBlocks.includes(block.type)) {
      add(vocabulary.records, block, recordJson(block, vocabulary));
    } else if (block.type === 'component') {
      add('components', block, { fields: members(block, ['field'], vocabulary) });
    } else if (block.type === 'enum') {
      if (block.blocks.length > 0) throw new Error(`line ${block.line}: enum "${block.name}" cannot contain blocks`);
      add('enums', block, { ...block.attributes });
    } else {
      throw new Error(`line ${block.line}: top-level ${block.type} blocks are not supported by this converter (${[...recordBlocks, 'component', 'enum'].join(', ')})`);
    }
  }
  return json;
}

export const serializeModel = (json) => `${JSON.stringify(json, null, 2)}\n`;

// ---- JSON ------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The shape the structural checks below rely on, so that a malformed file is
// a problem and never an exception. Returns problems.
function shapeProblems(json, vocabulary) {
  const problems = [];
  for (const refused of refusedWords.filter((candidate) => candidate.json && Object.hasOwn(json, candidate.json))) problems.push(refusal({ ...refused, word: refused.json }, 'field'));
  if (!isObject(json.module)) problems.push('module must be an object');
  for (const [kind, member] of [[vocabulary.records, vocabulary.fields], ['components', 'fields']]) {
    if (json[kind] === undefined) continue;
    if (!isObject(json[kind])) { problems.push(`${kind} must be an object keyed by name`); continue; }
    for (const [name, concept] of Object.entries(json[kind])) {
      if (!isObject(concept) || !isObject(concept[member])) { problems.push(`${kind} ${name} must be an object with ${member}`); continue; }
      for (const [memberName, value] of Object.entries(concept[member])) if (!isObject(value)) problems.push(`${name}.${memberName} must be an object`);
      if (kind === vocabulary.records) {
        if (concept.key !== undefined && !(Array.isArray(concept.key) && concept.key.every((item) => typeof item === 'string'))) problems.push(`${vocabulary.record} ${name} key must be a list of ${vocabulary.field} names`);
        if (concept.use !== undefined && !(Array.isArray(concept.use) && concept.use.every((item) => typeof item === 'string'))) problems.push(`${vocabulary.record} ${name} use must be a list of component names`);
      }
    }
  }
  if (json.enums !== undefined) {
    if (!isObject(json.enums)) problems.push('enums must be an object keyed by name');
    else for (const [name, value] of Object.entries(json.enums)) if (!isObject(value)) problems.push(`enum ${name} must be an object`);
  }
  return problems;
}

// The identifier decides the vocabulary: a key of the other vocabulary is an error.
// Components use `fields` under both identifiers, so only their members are checked.
// Run after shapeProblems, so every record type and component is an object with its members.
function foreignKeyProblems(json, vocabulary) {
  const foreign = otherThan(vocabulary);
  const wrong = (where, foreignKey, ownKey) => `${where}"${foreignKey}" is a key of format ${foreign.identifier}; this document says "${vocabulary.identifier}", where it is "${ownKey}"`;
  const problems = [];
  if (Object.hasOwn(json, foreign.records)) problems.push(wrong('', foreign.records, vocabulary.records));
  const memberSets = [
    ...Object.entries(json.components ?? {}).map(([name, component]) => [name, component.fields]),
    ...Object.entries(json[vocabulary.records] ?? {}).map(([name, record]) => [name, record[vocabulary.fields]]),
  ];
  for (const [name, record] of Object.entries(json[vocabulary.records] ?? {})) {
    if (Object.hasOwn(record, foreign.fields)) problems.push(wrong(`${vocabulary.record} ${name}: `, foreign.fields, vocabulary.fields));
  }
  for (const [name, set] of memberSets) {
    for (const [memberName, member] of Object.entries(set)) {
      if (Object.hasOwn(member, foreign.record)) problems.push(wrong(`${name}.${memberName}: `, foreign.record, vocabulary.record));
    }
  }
  return problems;
}

// Structural checks from ModelSpec spec/json-format.md "Validation
// Requirements", for records, components and enums, in the vocabulary that the
// document's identifier names. Returns problems.
export function validateModel(json) {
  if (!isObject(json)) return ['the JSON AST must be an object'];
  const vocabulary = vocabularyOf(json);
  if (!vocabulary) return [`modelspec must be "${current.identifier}" (or "${earlier.identifier}", the earlier spelling)`];
  const shape = shapeProblems(json, vocabulary);
  if (shape.length > 0) return shape;
  const problems = foreignKeyProblems(json, vocabulary);
  if (!json.module?.id || !json.module?.version) problems.push('module.id and module.version are required');
  const declared = new Map();
  for (const kind of [vocabulary.records, 'components', 'enums']) {
    for (const name of Object.keys(json[kind] ?? {})) {
      if (reservedNames.includes(name)) problems.push(`${name} is a reserved name`);
      if (name.includes('.')) problems.push(`${name}: concept names cannot contain dots`);
      if (declared.has(name)) problems.push(`${name} is declared as both ${declared.get(name)} and ${kind}`);
      declared.set(name, kind);
    }
  }
  const resolves = (name, kind) => declared.get(name) === kind;
  // A module-qualified name (decision 0014) needs a module resolver, which
  // draft 1 of the registry does not have: it is reported, never guessed at.
  const unresolved = (where, kind, name) => (String(name).includes('.')
    ? `${where} names ${kind} ${name} of another module; the registry cannot resolve module-qualified references yet`
    : `${where} references unknown ${kind} ${name}`);
  for (const [name, enumDef] of Object.entries(json.enums ?? {})) {
    const values = enumDef.values;
    if (!Array.isArray(values) || values.length === 0) problems.push(`enum ${name} needs a non-empty values list`);
    else if (new Set(values).size !== values.length) problems.push(`enum ${name} has duplicate values`);
  }
  const referenceAttributes = ['type', vocabulary.record, 'component', 'enum'];
  const checkMember = (where, member) => {
    const kinds = referenceAttributes.filter((attribute) => Object.hasOwn(member, attribute) && attribute !== 'enum');
    if (kinds.length !== 1) problems.push(`${where} must have exactly one of type, ${vocabulary.record}, component`);
    if (Object.hasOwn(member, 'type') && !primitiveTypes.includes(member.type)) problems.push(`${where} has unsupported type ${JSON.stringify(member.type)}`);
    if (Object.hasOwn(member, vocabulary.record) && !resolves(member[vocabulary.record], vocabulary.records)) problems.push(unresolved(where, vocabulary.record, member[vocabulary.record]));
    if (Object.hasOwn(member, 'component') && !resolves(member.component, 'components')) problems.push(unresolved(where, 'component', member.component));
    if (Object.hasOwn(member, 'enum') && typeof member.enum === 'string' && !resolves(member.enum, 'enums')) problems.push(unresolved(where, 'enum', member.enum));
    if (Object.hasOwn(member, 'enum') && typeof member.enum !== 'string' && !(Array.isArray(member.enum) && member.enum.length > 0)) problems.push(`${where} enum must name an enum or list values`);
    for (const [attribute, value] of Object.entries(member)) {
      // A key of the other vocabulary has been reported already.
      if (referenceAttributes.includes(attribute) || attribute === otherThan(vocabulary).record) continue;
      const expected = constraintTypes[attribute];
      if (!expected) { problems.push(`${where} has unsupported attribute ${attribute}`); continue; }
      const ok = expected === 'integer' ? Number.isInteger(value) && value >= 0 : typeof value === expected;
      if (!ok) problems.push(`${where}.${attribute} must be ${expected === 'integer' ? 'a non-negative integer' : `a ${expected}`}`);
    }
  };
  for (const [name, component] of Object.entries(json.components ?? {})) {
    for (const [field, member] of Object.entries(component.fields ?? {})) checkMember(`${name}.${field}`, member);
  }
  for (const [name, record] of Object.entries(json[vocabulary.records] ?? {})) {
    if (record.key !== undefined && (!Array.isArray(record.key) || record.key.length === 0)) problems.push(`${vocabulary.record} ${name} key must be a non-empty list when present`);
    const keys = new Set();
    for (const keyField of Array.isArray(record.key) ? record.key : []) {
      if (keys.has(keyField)) problems.push(`${vocabulary.record} ${name} key ${keyField} is duplicated`);
      keys.add(keyField);
      if (!Object.hasOwn(record[vocabulary.fields] ?? {}, keyField)) problems.push(`${vocabulary.record} ${name} key ${keyField} is not a ${vocabulary.field}`);
    }
    for (const used of record.use ?? []) if (!resolves(used, 'components')) problems.push(unresolved(`${vocabulary.record} ${name}`, 'component', used));
    for (const [field, member] of Object.entries(record[vocabulary.fields] ?? {})) checkMember(`${name}.${field}`, member);
  }
  return problems;
}

// The differences between the JSON AST an HCL source produces and the JSON AST
// a repository publishes, as readable lines, ignoring `module` (standalone HCL
// has no place for module identity; the registry checks it separately). A twin
// in the other vocabulary than its source is one difference, and nothing else is
// compared: `modelspec rewrite --write` on both files brings the pair in line.
// Otherwise object keys are compared without regard to order, because names are
// unique and order is not semantic; list order is compared, because `key` and enum
// `values` carry it.
export function astDifferences(fromHcl, published) {
  if (fromHcl.modelspec !== published.modelspec) {
    return [`modelspec is ${JSON.stringify(fromHcl.modelspec)} in the HCL source but ${JSON.stringify(published.modelspec)} in the JSON AST; the two must be in the same vocabulary (modelspec rewrite --write brings the pair in line)`];
  }
  const differences = [];
  const strip = ({ module: _module, ...rest }) => rest;
  const walk = (a, b, path) => {
    if (isObject(a) && isObject(b)) {
      for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const where = path ? `${path}.${name}` : name;
        if (!Object.hasOwn(a, name)) differences.push(`${where} is in the JSON AST but not in the HCL source`);
        else if (!Object.hasOwn(b, name)) differences.push(`${where} is in the HCL source but not in the JSON AST`);
        else walk(a[name], b[name], where);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${path} is ${JSON.stringify(a)} in the HCL source but ${JSON.stringify(b)} in the JSON AST`);
  };
  walk(strip(fromHcl), strip(published), '');
  return differences;
}

// ---- the index description ---------------------------------------------------

// A field of the HCL source as the index lists it: `type` (a reference has
// type "reference" and `references` names the record type it points at; an
// embedded component has type "component" and `component` names it), whether it
// is required, and, for a field of a record type, whether it is part of the key.
function memberEntry(block, key) {
  const { attributes } = block;
  const reference = attributes[current.record] ?? attributes[earlier.record];
  let shape;
  if (typeof attributes.type === 'string') shape = { type: attributes.type };
  else if (typeof reference === 'string') shape = { type: 'reference', references: reference };
  else shape = { type: 'component', component: attributes.component };
  return { name: block.name, ...shape, required: attributes.required === true, ...(key ? { key: key.includes(block.name) } : {}) };
}

// The record types and components of a model for the index, read from the parsed
// HCL source in declaration order, as arrays (a JSON object would list
// integer-like names first), in either spelling of the source. The index writes
// the keys `records` and `fields` whatever the spelling; readers still accept an
// index with the earlier keys `entities` and `properties`. The registry has
// already checked that the JSON AST is what this source says, so this is the
// model. Each record type has its `key`, the components it embeds with `use`,
// and its `fields`; each component has its `fields`. A field's `type` is a
// primitive, "reference" (with `references`) or "component" (with `component`).
export function describeModel(document) {
  const ofType = (types) => document.blocks.filter((block) => types.includes(block.type));
  return {
    records: ofType(recordBlocks).map((block) => {
      const key = block.attributes.key ?? [];
      return { name: block.name, key: [...key], use: [...(block.attributes.use ?? [])], fields: block.blocks.filter((child) => fieldBlocks.includes(child.type)).map((child) => memberEntry(child, key)) };
    }),
    components: ofType(['component']).map((block) => ({ name: block.name, fields: block.blocks.filter((child) => child.type === 'field').map((child) => memberEntry(child)) })),
  };
}

// ---- JSON that refuses duplicate names ---------------------------------------

const maxJsonDepth = 100;

// Parses JSON like JSON.parse, but throws on a name that occurs twice in one
// object (JSON.parse keeps the last, so a duplicated entity or property would
// pass unseen; the ModelSpec specification requires unique names). Objects have
// no prototype, so any name, `constructor` and `__proto__` included, is just a
// name.
export function parseJson(text) {
  let i = 0;
  const fail = (message) => { throw new Error(`${message} at position ${i}`); };
  const space = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const string = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (depth, path) => {
    if (depth > maxJsonDepth) fail('nesting too deep');
    space();
    const c = text[i];
    if (c === '{') {
      i++;
      const object = Object.create(null);
      space();
      if (text[i] === '}') { i++; return object; }
      for (;;) {
        space();
        if (text[i] !== '"') fail('expected a name');
        const name = string();
        if (Object.hasOwn(object, name)) throw new Error(`duplicate name ${JSON.stringify(name)} in ${path || 'the top-level object'}`);
        space();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        object[name] = value(depth + 1, path ? `${path}.${name}` : name);
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return object; }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const list = [];
      space();
      if (text[i] === ']') { i++; return list; }
      for (;;) {
        list.push(value(depth + 1, `${path}[${list.length}]`));
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return list; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 400));
    if (!literal) fail('unexpected character');
    i += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const result = value(0, '');
  space();
  if (i < text.length) fail('unexpected text after the value');
  return result;
}
