// Tests that inGitDB itself rejects broken records (CC0-1.0): each case copies
// the registry, breaks one constraint of a collection definition, and expects
// `ingitdb validate` to exit 2. INGITDB_CLI names the binary (CI installs the
// release the workflow pins); the tests fail, rather than skip, without it.
//
//   INGITDB_CLI=/path/to/ingitdb node --test scripts/test-ingitdb.mjs
//
// The URL forms of `address` and `repository` are not here: inGitDB does not
// validate a column's `format`, so scripts/check.mjs checks them (scripts/test.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.INGITDB_CLI;
const scratch = mkdtempSync(join(tmpdir(), 'registry-ingitdb-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const record = (dir, collection, key) => join(dir, collection, '$records', `${key}.yaml`);
const edit = (collection, key, change) => (dir) => {
  const path = record(dir, collection, key);
  const data = parseYaml(readFileSync(path, 'utf8'));
  change(data);
  writeFileSync(path, stringifyYaml(data));
};

function validate(change) {
  const dir = join(scratch, `db-${count++}`);
  mkdirSync(dir);
  for (const name of ['.ingitdb', 'models', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  change?.(dir);
  try {
    execFileSync(cli, ['validate', `--path=${dir}`, '--safe-diagnostics'], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('INGITDB_CLI names the inGitDB binary', () => {
  assert.ok(cli, 'set INGITDB_CLI to the ingitdb binary');
  assert.match(execFileSync(cli, ['version']).toString(), /\d+\.\d+\.\d+/);
});

test('the registry as committed is a valid inGitDB database', () => {
  assert.equal(validate(), 0);
});

const cases = {
  'models: title missing (required)': edit('models', 'chinook', (x) => { delete x.title; }),
  'models: description missing (required)': edit('models', 'chinook', (x) => { delete x.description; }),
  'models: status outside its enum': edit('models', 'chinook', (x) => { x.status = 'live'; }),
  'models: format outside its enum': edit('models', 'chinook', (x) => { x.format = 'x'; }),
  'models: format missing (required)': edit('models', 'chinook', (x) => { delete x.format; }),
  'models: commit of 39 characters (length)': edit('models', 'chinook', (x) => { x.commit = x.commit.slice(1); }),
  'models: commit of 41 characters (length)': edit('models', 'chinook', (x) => { x.commit += 'a'; }),
  'models: commit missing (required)': edit('models', 'chinook', (x) => { delete x.commit; }),
  'models: empty title (min_length)': edit('models', 'chinook', (x) => { x.title = ''; }),
  'models: title of 121 characters (max_length)': edit('models', 'chinook', (x) => { x.title = 'a'.repeat(121); }),
  'models: title that is a number (type)': edit('models', 'chinook', (x) => { x.title = 123; }),
  'models: address missing (required)': edit('models', 'chinook', (x) => { delete x.address; }),
  'models: repository missing (required)': edit('models', 'chinook', (x) => { delete x.repository; }),
  'models: module missing (required)': edit('models', 'chinook', (x) => { delete x.module; }),
  'models: empty module (min_length)': edit('models', 'chinook', (x) => { x.module = ''; }),
  'models: source_file missing (required)': edit('models', 'chinook', (x) => { delete x.source_file; }),
  'models: json_file missing (required)': edit('models', 'chinook', (x) => { delete x.json_file; }),
  'models: json_file that is a list (type)': edit('models', 'chinook', (x) => { x.json_file = ['a.modelspec.json']; }),
  'models: licence missing (required)': edit('models', 'chinook', (x) => { delete x.licence; }),
  'models: unknown maintainer (foreign_key)': edit('models', 'chinook', (x) => { x.maintainers = ['nobody']; }),
  'models: unknown second maintainer (foreign_key on a list)': edit('models', 'chinook', (x) => { x.maintainers = ['trakhimenok', 'nobody']; }),
  'models: empty maintainers (min_length)': edit('models', 'chinook', (x) => { x.maintainers = []; }),
  'models: maintainers missing (required)': edit('models', 'chinook', (x) => { delete x.maintainers; }),
  'models: homepage of 201 characters (max_length)': edit('models', 'chinook', (x) => { x.homepage = `https://example.com/${'a'.repeat(201 - 'https://example.com/'.length)}`; }),
  'models: homepage that is a number (type)': edit('models', 'chinook', (x) => { x.homepage = 123; }),
  'models: homepage that is a list (type)': edit('models', 'chinook', (x) => { x.homepage = ['https://example.com/']; }),
  'models: unknown column': edit('models', 'chinook', (x) => { x.colour = 'blue'; }),
  'maintainers: name missing (required)': edit('maintainers', 'trakhimenok', (x) => { delete x.name; x.nick = 'a'; }),
  'maintainers: empty name (min_length)': edit('maintainers', 'trakhimenok', (x) => { x.name = ''; }),
};

for (const [name, change] of Object.entries(cases)) {
  test(`inGitDB rejects ${name}`, () => {
    assert.equal(validate(change), 2, 'ingitdb validate exits 2 on invalid data');
  });
}
