// ModelSpec helpers for the registry checks, CC0-1.0 like everything else here.
//
// What exists of ModelSpec tooling, audited 2026-10-03 against
// specscore/modelspec@82dfe38 (spec/json-format.md, schema/, decisions 0006,
// 0010, 0014):
//
// - ModelSpec's JSON AST is specified (spec/json-format.md), and decision 0010
//   promises JSON Schema files at schema/modelspec-ast-1.0-draft.schema.json,
//   but schema/ holds only a README: no schema is published yet. So there is
//   no schema to validate the JSON AST against.
// - ModelSpec has no parser or validator of its own. The HCL parser that
//   exists is SpecScore's (`specscore graph lint`, a Go binary); it checks
//   syntax and references but does not write JSON.
//
// So this module implements what the specification states, and nothing more:
// the structural checks of spec/json-format.md "Validation Requirements"
// (validateModel), and a converter from the HCL subset that ModelSpec v0
// uses to the JSON AST (parseHcl, toModelspecJson), which the registry uses to
// check that a model's JSON AST is what its HCL source says. The code is the
// one in meaninggraph/core (scripts/lib/modelspec.mjs at cb97dbc, CC0-1.0, also
// used by datatug/chinookdb), without its comparison with published data. It
// supports entities, components and enums; a source with collections,
// recordsets or projections is refused rather than guessed at. When ModelSpec
// publishes its JSON Schema and a parser, replace this module with them.
//
// The parser accepts only what ModelSpec v0 HCL allows: named blocks, and
// attributes whose values are strings, numbers, booleans or lists of those. It
// rejects expressions, interpolation and map-style containers rather than
// guessing, so an unsupported construct fails loudly.

export const modelspecSpecCommit = '82dfe38cef1dbdd88b915734502b14b6df0a8f39';
export const modelspecVersion = '1.0-draft';
export const primitiveTypes = ['string', 'int', 'float', 'bool', 'decimal', 'uuid', 'date', 'time', 'datetime', 'document', 'json', 'any'];
export const reservedNames = ['entities', 'components', 'enums', 'collections', 'recordsets'];
const constraintTypes = { required: 'boolean', unique: 'boolean', min_len: 'integer', max_len: 'integer', pattern: 'string', format: 'string' };
const referenceAttributes = ['type', 'entity', 'component', 'enum'];

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

function members(block, memberType, allowed) {
  const out = Object.create(null);
  for (const child of block.blocks) {
    if (!allowed.includes(child.type)) throw new Error(`line ${child.line}: ${block.type} "${block.name}" cannot contain ${/^[aeiou]/.test(child.type) ? 'an' : 'a'} ${child.type} block (this converter supports ${allowed.join(', ')})`);
    if (child.type !== memberType) continue;
    if (child.blocks.length > 0) throw new Error(`line ${child.line}: ${child.type} "${child.name}" cannot contain blocks`);
    if (Object.hasOwn(out, child.name)) throw new Error(`line ${child.line}: duplicate ${child.type} "${child.name}" in ${block.type} "${block.name}"`);
    out[child.name] = { ...child.attributes };
  }
  return out;
}

// Serializes parsed HCL to the ModelSpec JSON AST. `module` is { id, name, version }:
// standalone HCL has no place for module identity, so the caller supplies it.
export function toModelspecJson(document, module) {
  const json = { modelspec: modelspecVersion, module };
  const add = (kind, name, value, line) => {
    json[kind] ??= Object.create(null);
    if (Object.hasOwn(json[kind], name)) throw new Error(`line ${line}: duplicate ${{ entities: 'entity', components: 'component', enums: 'enum' }[kind]} "${name}"`);
    json[kind][name] = value;
  };
  for (const block of document.blocks) {
    if (block.type === 'entity') {
      const { key, use, ...rest } = block.attributes;
      if (Object.keys(rest).length > 0) throw new Error(`line ${block.line}: unsupported entity attribute ${Object.keys(rest).join(', ')}`);
      add('entities', block.name, { ...(key ? { key } : {}), ...(use ? { use } : {}), properties: members(block, 'property', ['property']) }, block.line);
    } else if (block.type === 'component') {
      add('components', block.name, { fields: members(block, 'field', ['field']) }, block.line);
    } else if (block.type === 'enum') {
      if (block.blocks.length > 0) throw new Error(`line ${block.line}: enum "${block.name}" cannot contain blocks`);
      add('enums', block.name, { ...block.attributes }, block.line);
    } else {
      throw new Error(`line ${block.line}: top-level ${block.type} blocks are not supported by this converter (entity, component, enum)`);
    }
  }
  return json;
}

export const serializeModel = (json) => `${JSON.stringify(json, null, 2)}\n`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The shape the structural checks below rely on, so that a malformed file is
// a problem and never an exception. Returns problems.
function shapeProblems(json) {
  if (!isObject(json)) return ['the JSON AST must be an object'];
  const problems = [];
  if (!isObject(json.module)) problems.push('module must be an object');
  for (const [kind, member] of [['entities', 'properties'], ['components', 'fields']]) {
    if (json[kind] === undefined) continue;
    if (!isObject(json[kind])) { problems.push(`${kind} must be an object keyed by name`); continue; }
    for (const [name, concept] of Object.entries(json[kind])) {
      if (!isObject(concept) || !isObject(concept[member])) { problems.push(`${kind} ${name} must be an object with ${member}`); continue; }
      for (const [memberName, value] of Object.entries(concept[member])) if (!isObject(value)) problems.push(`${name}.${memberName} must be an object`);
      if (kind === 'entities') {
        if (concept.key !== undefined && !(Array.isArray(concept.key) && concept.key.every((item) => typeof item === 'string'))) problems.push(`entity ${name} key must be a list of property names`);
        if (concept.use !== undefined && !(Array.isArray(concept.use) && concept.use.every((item) => typeof item === 'string'))) problems.push(`entity ${name} use must be a list of component names`);
      }
    }
  }
  if (json.enums !== undefined) {
    if (!isObject(json.enums)) problems.push('enums must be an object keyed by name');
    else for (const [name, value] of Object.entries(json.enums)) if (!isObject(value)) problems.push(`enum ${name} must be an object`);
  }
  return problems;
}

// Structural checks from ModelSpec spec/json-format.md "Validation
// Requirements", for entities, components and enums. Returns problems.
export function validateModel(json) {
  const shape = shapeProblems(json);
  if (shape.length > 0) return shape;
  const problems = [];
  if (json.modelspec !== modelspecVersion) problems.push(`modelspec must be "${modelspecVersion}"`);
  if (!json.module?.id || !json.module?.version) problems.push('module.id and module.version are required');
  const trio = new Map();
  for (const kind of ['entities', 'components', 'enums']) {
    for (const name of Object.keys(json[kind] ?? {})) {
      if (reservedNames.includes(name)) problems.push(`${name} is a reserved name`);
      if (name.includes('.')) problems.push(`${name}: concept names cannot contain dots`);
      if (trio.has(name)) problems.push(`${name} is declared as both ${trio.get(name)} and ${kind}`);
      trio.set(name, kind);
    }
  }
  const resolves = (name, kind) => trio.get(name) === kind;
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
  const checkMember = (where, member) => {
    const kinds = referenceAttributes.filter((attribute) => Object.hasOwn(member, attribute) && attribute !== 'enum');
    if (kinds.length !== 1) problems.push(`${where} must have exactly one of type, entity, component`);
    if (Object.hasOwn(member, 'type') && !primitiveTypes.includes(member.type)) problems.push(`${where} has unsupported type ${JSON.stringify(member.type)}`);
    if (Object.hasOwn(member, 'entity') && !resolves(member.entity, 'entities')) problems.push(unresolved(where, 'entity', member.entity));
    if (Object.hasOwn(member, 'component') && !resolves(member.component, 'components')) problems.push(unresolved(where, 'component', member.component));
    if (Object.hasOwn(member, 'enum') && typeof member.enum === 'string' && !resolves(member.enum, 'enums')) problems.push(unresolved(where, 'enum', member.enum));
    if (Object.hasOwn(member, 'enum') && typeof member.enum !== 'string' && !(Array.isArray(member.enum) && member.enum.length > 0)) problems.push(`${where} enum must name an enum or list values`);
    for (const [attribute, value] of Object.entries(member)) {
      if (referenceAttributes.includes(attribute)) continue;
      const expected = constraintTypes[attribute];
      if (!expected) { problems.push(`${where} has unsupported attribute ${attribute}`); continue; }
      const ok = expected === 'integer' ? Number.isInteger(value) && value >= 0 : typeof value === expected;
      if (!ok) problems.push(`${where}.${attribute} must be ${expected === 'integer' ? 'a non-negative integer' : `a ${expected}`}`);
    }
  };
  for (const [name, component] of Object.entries(json.components ?? {})) {
    for (const [field, member] of Object.entries(component.fields ?? {})) checkMember(`${name}.${field}`, member);
  }
  for (const [name, entity] of Object.entries(json.entities ?? {})) {
    if (entity.key !== undefined && (!Array.isArray(entity.key) || entity.key.length === 0)) problems.push(`entity ${name} key must be a non-empty list when present`);
    const keys = new Set();
    for (const keyProperty of Array.isArray(entity.key) ? entity.key : []) {
      if (keys.has(keyProperty)) problems.push(`entity ${name} key ${keyProperty} is duplicated`);
      keys.add(keyProperty);
      if (!Object.hasOwn(entity.properties ?? {}, keyProperty)) problems.push(`entity ${name} key ${keyProperty} is not a property`);
    }
    for (const used of entity.use ?? []) if (!resolves(used, 'components')) problems.push(unresolved(`entity ${name}`, 'component', used));
    for (const [property, member] of Object.entries(entity.properties ?? {})) checkMember(`${name}.${property}`, member);
  }
  return problems;
}

// The differences between the JSON AST an HCL source produces and the JSON AST
// a repository publishes, as readable lines, ignoring `module` (standalone HCL
// has no place for module identity; the registry checks it separately). Object
// keys are compared without regard to order, because names are unique and order
// is not semantic; list order is compared, because `key` and enum `values`
// carry it.
export function astDifferences(fromHcl, published) {
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

// A property or field of the HCL source as the index lists it: `type` (a
// reference has type "reference" and `references` names the entity it points
// at; an embedded component has type "component" and `component` names it),
// whether it is required, and, for an entity property, whether it is part of
// the entity's key.
function memberEntry(block, key) {
  const { attributes } = block;
  let shape;
  if (typeof attributes.type === 'string') shape = { type: attributes.type };
  else if (typeof attributes.entity === 'string') shape = { type: 'reference', references: attributes.entity };
  else shape = { type: 'component', component: attributes.component };
  return { name: block.name, ...shape, required: attributes.required === true, ...(key ? { key: key.includes(block.name) } : {}) };
}

// The entities and components of a model for the index, read from the parsed
// HCL source in declaration order, as arrays (a JSON object would list
// integer-like names first). The registry has already checked that the JSON AST
// is what this source says, so this is the model. Each entity has its `key`,
// the components it embeds with `use`, and its `properties`; each component has
// its `fields`. A property's `type` is a primitive, "reference" (with
// `references`) or "component" (with `component`).
export function describeModel(document) {
  const ofType = (type) => document.blocks.filter((block) => block.type === type);
  return {
    entities: ofType('entity').map((block) => {
      const key = block.attributes.key ?? [];
      return { name: block.name, key: [...key], use: [...(block.attributes.use ?? [])], properties: block.blocks.filter((child) => child.type === 'property').map((child) => memberEntry(child, key)) };
    }),
    components: ofType('component').map((block) => ({ name: block.name, fields: block.blocks.filter((child) => child.type === 'field').map((child) => memberEntry(child)) })),
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
