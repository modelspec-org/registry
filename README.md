# ModelSpec registry

The public list of [ModelSpec](https://modelspec.org) models: for each one, the
address people write to refer to it, the repository it lives in, the commit
that is its current reviewed version, its two model files (the HCL source and
the JSON AST), its licence and its maintainers.

| Id | Address | Repository at commit | Status |
|---|---|---|---|
| `adventureworks` | `modelspec://github.com/demo-db/adventureworks/adventureworks` | [demo-db/adventureworks@5028a27](https://github.com/demo-db/adventureworks/tree/5028a27189b487d6fd8025fafc1307aada707fd2) | draft |
| `chinook` | `modelspec://github.com/demo-db/chinook/chinook` | [demo-db/chinook@26e852c](https://github.com/demo-db/chinook/tree/26e852cca00101f53a84ef8ee1f1ae389067f5cf) | draft |
| `ecb-daily` | `modelspec://github.com/openvaultdb/ovdb/ecb` | [openvaultdb/ovdb@6751a14](https://github.com/openvaultdb/ovdb/tree/6751a14ae12bfeadbcc9a7c6aa6174c81d697e20) | draft |
| `employees` | `modelspec://github.com/demo-db/employees/employees` | [demo-db/employees@2069e26](https://github.com/demo-db/employees/tree/2069e26e8fdb60bdb16507f75569a579cf3da7cf) | draft |
| `geonames` | `modelspec://github.com/ingitdb/geo-ingitdb/geonames` | [ingitdb/geo-ingitdb@6f4cf12](https://github.com/ingitdb/geo-ingitdb/tree/6f4cf1269bc393048f6b204069135a62f0bb6c02) | draft |
| `northwind` | `modelspec://github.com/demo-db/northwind/northwind` | [demo-db/northwind@e747265](https://github.com/demo-db/northwind/tree/e74726515c3833620b54b7a50d1d273276dd23c1) | draft |
| `pubs` | `modelspec://github.com/demo-db/pubs/pubs` | [demo-db/pubs@6c06c5c](https://github.com/demo-db/pubs/tree/6c06c5c7395b03ff1a02c2b1a21485add3e1b65b) | draft |
| `ror` | `modelspec://github.com/ingitdb/ror-ingitdb/ror` | [ingitdb/ror-ingitdb@dc78c1e](https://github.com/ingitdb/ror-ingitdb/tree/dc78c1e929f1f10018f8c39e690351059a50c71f) | draft |
| `sakila` | `modelspec://github.com/demo-db/sakila/sakila` | [demo-db/sakila@cb9a81a](https://github.com/demo-db/sakila/tree/cb9a81a8cbedcd8831737f281f888d5d584fae85) | draft |

Browse the generated registry at <https://modelspec.org/registry/>.
This repository is the data behind that page.

## What a model registry is for

A ModelSpec model says what shape some data has: its entities, their fields,
types and links, written once whatever stores it. Registering a model gives it
one public address and a pinned, checked version. That makes three things
possible:

- **Start a project from a published model.** Instead of defining Chinook's
  eleven entities again, a new project looks the address up, reads the two
  files at the pinned commit and starts from them.
- **Show that several databases are the same model.** If two hosters each
  serve a database of Chinook, and both name `modelspec://github.com/demo-db/chinook/chinook`
  at the same commit, anyone can see they share a model without comparing the
  databases field by field.
- **Run many isolated databases of one model.** One engine, such as an
  OpenVaultDB service, can hold one registered model
  and run any number of separate databases of it. The model is registered once;
  each database is a private copy of its shape.

[MeaningGraph](https://meaninggraph.io) attaches meanings to a model's
entities and properties, so one meaning file serves every database of the
model. The OpenVaultDB Directory lists databases. This registry lists the
models in between.

## This repository is the registry

The registry is this Git repository, not a database service. Registering a
model, or moving it to a new commit, is a pull request; CI fetches the model at
that commit and runs the checks below, so a model that does not check cannot be
registered.

Why Git and not a database as the source of truth:

- **Review and history come free.** Every registration is a reviewed pull
  request with an author, a diff and a permanent record.
- **Nothing broken gets in.** The check runs before the merge, in the same
  place as the change.
- **It is where the models are.** Models live in Git repositories and are
  pinned by commit. A registry in Git uses the same words.
- **Anyone can read, fork or mirror it** without an account or a key, and it
  costs nothing to run.

A Firestore copy, if one is ever added, is only a search index: CI rebuilds it
from this repository and nobody edits it. It is never the authority; when the
two disagree, this repository is right.

## It is an inGitDB database

The registry is an [inGitDB](https://github.com/ingitdb/ingitdb-cli) database:
plain YAML files in Git, with collection definitions that say which columns
each record has. It can be read as plain files, written by pull request, and it
is validated in two layers (see [Checks](#checks)). It has the same layout as
the MeaningGraph registry.

```
.ingitdb/root-collections.yaml      the two collections and their directories
models/.collection/definition.yaml  the columns of a model record
models/$records/<id>.yaml           one record per model, keyed by registry id
maintainers/$records/<github-handle>.yaml
index.json                          every model in one file, generated
scripts/                            the model checks and the index.json writer
```

Ways to read it:

- **Plain files.** Fetch `models/$records/<id>.yaml`, or `index.json` for
  everything at once.
- **The inGitDB CLI**, in a clone:
  `ingitdb select --path . --from models --where 'address==modelspec://github.com/demo-db/chinook/chinook' --fields '$id,repository,commit'`
- **Go, through [DALgo](https://github.com/dal-go/dalgo)**, with the
  [`dalgo2ingitdb`](https://github.com/ingitdb/dalgo2ingitdb) adapter.

## Format: `modelspec-registry/draft-1`

A draft: it may change before `modelspec-registry/1`.

### `models`: one record per model

The file name is the registry id: `models/$records/chinook.yaml` registers
`chinook`.

| Column | Required | Meaning |
|---|---|---|
| (key) | yes | Registry id: lower-case letters, digits and single hyphens, at most 80 characters. |
| `format` | yes | `modelspec-registry/draft-1`. |
| `title` | yes | A short name. |
| `description` | yes | What the model covers, in a few sentences. |
| `status` | yes | `draft`, `published` or `deprecated`. |
| `homepage` | no | The publisher's own page for the model, to be shown as **Website** on the model's page at <https://modelspec.org/registry/> once that page shows it. A public https URL; see [What `index.json` guarantees about `homepage`](#what-indexjson-guarantees-about-homepage). It need not be on `github.com`. |
| `address` | yes | What consumers write: `modelspec://{host}/{org}/{repo}/{module}`, see [Addresses](#addresses). |
| `repository` | yes | The repository's https URL on an allowed host (today only `github.com`), as `https://github.com/{org}/{repo}`: no `.git`, trailing slash, `.` or `..` segments. Two spellings that differ only in case are the same repository. |
| `commit` | yes | Full 40-character commit id of the current reviewed version. It must be in the history of the repository's default branch. |
| `module` | yes | The ModelSpec module's short name, the one the files declare as `module.name` and the last part of the address. A letter, then letters, digits and `_`. |
| `source_file` | yes | The HCL source, a path in the repository ending `.modelspec.hcl`. |
| `json_file` | yes | The JSON AST of that source, a path ending `.modelspec.json`. |
| `licence` | yes | SPDX id of the model files' licence. |
| `maintainers` | yes | GitHub handles; each one has a `maintainers` record. |

Paths are exact: letters, digits, `.`, `_`, `-` and `/`, relative to the
repository root, with no `..` and no pattern characters. A model is one HCL
file and its JSON AST; a repository with several models has several records.

### `maintainers`: one record per maintainer

Keyed by GitHub handle, with a `name`.

### Addresses

The address is `modelspec://` and the repository without `https://`, then `/`
and the module: `https://github.com/demo-db/chinook` and the module `chinook`
make `modelspec://github.com/demo-db/chinook/chinook`. A model is pinned the
way MeaningGraph pins a concept, with `?ref=<40-character commit id>`, and an
entity of it is `modelspec://github.com/demo-db/chinook/chinook.Invoice`.
That grammar is not invented here: `meaning/draft-1`
([`FORMAT.md` of `meaninggraph/core`](https://github.com/meaninggraph/core/blob/main/FORMAT.md))
already reserves `modelspec://{host}/{org}/{repo}/{module}.{Entity}` for a
binding to a model in another repository, and the registry's address is that
without `.{Entity}`.

ModelSpec itself names a module with `module.id`, a string it says should be
"stable and globally meaningful", and defines no URL form (its
[decision 0014](https://github.com/specscore/modelspec/blob/main/spec/decisions/0014-module-qualified-references.md)
keeps URLs out of the language). The registry therefore adds a rule, not a
conflict: the files' `module.name` is the record's `module`, and `module.id`
starts with `{host}/{org}/{repo}/` and ends with `/{module}`. Chinook's is
`github.com/demo-db/chinook/model/chinook`: the directory the files live in
sits between the repository and the module and is not part of the address.
Draft 1 registers every model once, under one address.

### Status

`draft` means the model is usable and checked, but ModelSpec itself is still a
draft (`1.0-draft-2`, or `1.0-draft` for the earlier spelling) and the model
can change shape. `published` is for models
in a stable ModelSpec, so consumers can rely on them not changing shape.
`deprecated` keeps the record (old pins stay resolvable) but tells consumers to
move on.

## How to register a model

Open a pull request that adds:

1. `models/$records/<id>.yaml` with the columns above.
2. `maintainers/$records/<handle>.yaml` if a maintainer is new here.
3. The regenerated `index.json`: `npm ci && npm run index`.

The model's repository must already have the commit on its default branch,
with the HCL source, its JSON AST and a licence (a `Licence:` line at the top of
the HCL, and a `LICENSE` file for the repository).

Run the checks locally with `ingitdb validate`, `npm run check` and
`npm run lint:hcl`; CI runs them on the pull request. The checks run git over
https only and ignore your global and system git configuration (so an
`insteadOf` rewrite to ssh does not apply) and any inherited `GIT_*`
repository variables. Behind a proxy or a private certificate authority, set
`HTTPS_PROXY` or `GIT_SSL_CAINFO`.

## How to use it

To resolve an address, look it up: `address` gives `repository` and `commit`,
then read `files.source` or `files.json` at that commit. `index.json` has every
model in one file, format `modelspec-registry/draft-1`:

```json
{
  "format": "modelspec-registry/draft-1",
  "checksum": "sha256:…",
  "models": [{
    "id": "chinook",
    "title": "Chinook music store",
    "description": "…",
    "status": "draft",
    "homepage": "https://chinook.demodb.dev/model/",
    "address": "modelspec://github.com/demo-db/chinook/chinook",
    "repository": "https://github.com/demo-db/chinook",
    "commit": "26e852cca00101f53a84ef8ee1f1ae389067f5cf",
    "module": "chinook",
    "module_id": "github.com/demo-db/chinook/model/chinook",
    "module_version": "0.1.0",
    "modelspec": "1.0-draft",
    "licence": "MIT",
    "files": { "source": "model/chinook.modelspec.hcl", "json": "model/chinook.modelspec.json" },
    "maintainers": ["trakhimenok"],
    "entities": [{
      "name": "Album",
      "key": ["AlbumId"],
      "use": [],
      "properties": [
        { "name": "AlbumId", "type": "int", "required": true, "key": true },
        { "name": "ArtistId", "type": "reference", "references": "Artist", "required": true, "key": false }
      ]
    }],
    "components": []
  }]
}
```

- The index says `entities` and `properties` for a model's record types and
  their fields, whichever spelling the model is written in; an entry's
  `modelspec` is the identifier its JSON declares (`1.0-draft` or
  `1.0-draft-2`).
- A property is either a scalar (`type`: `string`, `int`, …), a **reference** to
  another entity (`type` is `reference` and `references` names the entity), or an
  embedded component (`type` is `component` and `component` names it).
- `required` and `key` say whether the property is required and whether it is
  part of the entity's key.
- An entity may have no key when the model does not assert stable record
  identity; the index represents this as `key: []` and marks no property as a key.
- `use` lists the components an entity embeds, and `components` lists each
  component the model declares with its `fields` (each with `name`, `type`,
  `references` or `component`, and `required`), so a page can show the fields
  an entity gets from a component. Chinook has none.
- Models are sorted by `id`; entities, properties, components and fields keep
  the order of the HCL source, also when a name looks like an integer (the index
  is built from the source as lists, not from a JSON object, whose integer-like
  names would come first). The file is the same bytes every time it is built
  from the same records and commits.
- `checksum` is `sha256:` and the SHA-256 of the `models` array written as
  compact JSON (`JSON.stringify(index.models)`), so a consumer can check that
  it read the whole file.

### What `index.json` guarantees about `homepage`

When an entry in `index.json` has a `homepage`, it is a string that is all of:

- at most 200 characters, ASCII only, and made of no characters other than the
  letters `A-Z a-z`, the digits `0-9`, and `- . _ ~ / :`. So it contains no
  whitespace, control character, quote (`"` or `'`), backtick, `<`, `>`, `&`,
  `%`, `?`, `#`, `@` or backslash, and can be written into a link as it stands;
- `https://`, in lower case, then a host, then a path:
  - the **host** is dot-separated labels of lower-case letters, digits and
    hyphens (1 to 63 characters each, none starting or ending with a hyphen),
    at least two labels, no trailing dot. It is not an IP address in any
    spelling, not `localhost`, and not a local, internal or reserved name
    (`.local`, `.internal`, `.test`, `.example`, `.onion` and similar). An
    international name is written in its `xn--` form (`https://xn--mnchen-3ya.de/`,
    not `https://münchen.de/`);
  - **no port** (not even `:443`), **no userinfo, no query and no fragment**
    (so `https://github.com/org/repo#readme` and `https://example.com/#/model`
    cannot be used);
  - the **path** starts with `/` and uses only `A-Z a-z 0-9 . _ ~ / -`: no
    percent escape (`%xx`), no empty segment (`//`), no `.` or `..` segment. A
    bare host is written with its slash, `https://example.com/`. Parentheses,
    `+`, `,`, `;`, `=`, `:` and `@` in a path are not accepted either;
- written exactly as the WHATWG URL parser would write it, so each page has one
  spelling.

An entry without a homepage has no `homepage` key (never `null` or `""`). The
checks read the text and **never fetch** the URL. They cannot tell whether the
page exists or what a public-looking name resolves to (`127.0.0.1.nip.io` is a
public name that points at a private address, and a look-alike `xn--` name is
valid): a site should show the ASCII form it is given, and whatever fetches a
homepage must check the address itself.

## Versioning

Moving a model to a new version is a pull request that changes `commit`; the
checks run against the new commit. Older commits stay valid for anyone who pins
them: a `?ref=` pin names an immutable commit, and the registry never rewrites
a model's history, it only says which commit is current. The model's own
`module.version` is in the JSON AST and in `index.json`.

## Checks

Three layers run in CI ([`.github/workflows/check.yml`](.github/workflows/check.yml)):

1. **inGitDB** ([`ingitdb/ingitdb-action`](https://github.com/ingitdb/ingitdb-action),
   at a pinned commit and CLI release) validates every record against its
   collection definition: column types, required columns, the `status` and
   `format` values, the 40-character `commit`, no unknown columns, and the
   foreign keys (`maintainers` name maintainer records).
2. **The model checks** (`npm run check`, [`scripts/check.mjs`](scripts/check.mjs))
   cover what a collection definition cannot express, and everything that
   needs the model's repository:
   - a `homepage`, when a record has one, passes the rules in
     [What `index.json` guarantees about `homepage`](#what-indexjson-guarantees-about-homepage).
     It is checked as text and **never fetched**: the checks make no request to
     the homepage's host, so a page that is down, moved or not yet deployed does
     not fail them. The only hosts the checks contact are the allow-listed git
     hosts of each record's `repository`;
   - every key of a record is a column its collection definition declares: an
     undeclared key (an `id`, a typo, a column of another collection) is
     refused. So is a YAML merge key, in any spelling (`<<`, `"<<"`, `? <<`,
     `!!merge <<`, or a `<<` under a `%YAML 1.1` directive), because a merged
     value is not a value written in the record; and so is any `%YAML` directive,
     which changes how values such as `yes` or `1:30` are read. An index entry is
     built from fixed fields in one order, and its `id` is always the record's
     file name;
   - ids follow the rule above; commits are lower-case hex; the licence is
     SPDX-shaped; the address is the repository plus the module, and no
     address is registered twice (compared ignoring case);
   - the repository is an https URL on an allowed host with exactly two path
     segments, none of them `.` or `..`, no `.git`, no trailing slash. Anything
     else is refused before git runs;
   - each model's commit can be fetched, and is in the history of the
     repository's default branch. GitHub serves a fork's commits through the
     parent repository's URL, so "can be fetched" alone would let a fork's
     commit be registered under the parent's address;
   - both files are tracked regular files at that commit: not missing, not
     symbolic links or submodules, not directories, not larger than 5 MiB;
   - the JSON AST passes the structural checks that ModelSpec's
     [JSON format](https://github.com/specscore/modelspec/blob/main/spec/json-format.md)
     lists (version, module, unique names, references that resolve, supported
     types and constraints, keys, enum values) and has at least one entity (a
     record type, in the current spelling). The
     JSON is read with a reader that refuses a name used twice in one object
     (`JSON.parse` would keep the last one), and a name such as `constructor`
     or `toString` is an ordinary name;
   - the module the files declare is the record's `module`, and `module.id`
     fits the address (see [Addresses](#addresses));
   - the JSON AST is what the HCL source says (see below);
   - the licence is the one the record states: what the HCL declares in a
     `Licence:` or `SPDX-License-Identifier:` line at the top, or, when it
     declares none, and for the JSON, the licence of the repository's
     unsuffixed `LICENSE` file (or, without one, the one licence all its
     `LICENSE` files name);
   - `index.json` is what `npm run index` writes.

   Git is run the same hardened way as in the MeaningGraph registry:
   argument lists and never a shell; every URL and revision after
   `--end-of-options`, so a value starting with `-` cannot be an option; https
   only (`GIT_ALLOW_PROTOCOL`); global and system git configuration ignored and
   every inherited `GIT_*` variable dropped; repositories created without
   templates; hooks, file-system monitors and replace refs switched off
   (`core.hooksPath`, `core.fsmonitor`, `core.useReplaceRefs`,
   `GIT_NO_REPLACE_OBJECTS`), so no repository can run code of its own or make
   an object id read as something else; literal pathspecs, with the path git
   returns compared with the path asked for; and files read from the object
   store by object id, never checked out.

   **The cache is never in the checkout.** Fetched repositories are kept in a
   per-user directory, `$XDG_CACHE_HOME/modelspec-registry` or
   `~/.cache/modelspec-registry`, created private (`0700`) and refused when it
   is a symbolic link, owned by someone else, or writable by others. A pull
   request cannot plant anything there, and a checkout that tracks a `.cache`
   is refused outright (`git rm -r --cached .cache`). Even in that directory
   nothing is trusted: a cached repository is reused only when its
   configuration holds only what the registry writes (for a history clone, with
   the expected URL as its remote), it has no alternates, hooks or replace
   refs, and `git fsck` passes; otherwise it is deleted and fetched again. A
   history clone is refreshed through its own remote, and is cloned again when
   that fails, so a publisher moving its default branch never breaks the check.
3. **SpecScore's linter** (`npm run lint:hcl`, [`scripts/lint-hcl.mjs`](scripts/lint-hcl.mjs))
   runs `specscore graph lint` over each HCL source. It reads both spellings of
   ModelSpec and uses SpecScore's HCL parser to check the syntax, references
   (to a record type or a component), reserved names, duplicate record types and
   enum values, and to refuse the removed and reserved constructs. It does not
   check duplicate field names, a key that names no field, an unsupported field
   type, or a setting it does not know on a record type or a field; `npm run
   check` does, with the registry's own parser. For a source in the earlier
   spelling the script prints the registry's `notice:` (naming `modelspec rewrite
   --write`); SpecScore's own advisory finding for it is ignored
   (`--ignore graph-model-deprecated-spelling`), so that the notice appears once.
   A notice never changes the exit status.
   The SpecScore release is pinned by version and SHA-256, and
   the hash is checked before every run, not only after a download: the cached
   archive must match it (or is downloaded again), and the binary is unpacked
   fresh from those verified bytes into a private directory that is removed
   afterwards. A binary lying in the cache is never executed. `SPECSCORE=<path>`
   runs a binary you name instead.

`npm test` proves each of these fails on a broken entry, offline, with local
git repositories standing in for https URLs: every kind of repository value
that is refused, an option-shaped URL or revision, a file URL when only https is
allowed, a global git configuration that tries to redirect a fetch, inherited
`GIT_*` variables, glob and magic pathspecs, an unknown commit, a commit only a
side branch has, a missing, symbolic-link, submodule, directory or oversized
file, a JSON file that is not JSON or breaks each structural rule, a module or
`module.id` that disagrees with the record, a JSON AST that differs from its
HCL source in each way, an HCL source the registry cannot read, each licence
mismatch, a missing, stale or edited `index.json`, and the cache: a tracked
`.cache`, an unsafe cache directory, a cached repository carrying a forged
replace ref, a planted hook, a redirecting configuration, an alternates file or
a corrupt object, a publisher's branch that moves between two runs, a planted or
tampered linter binary or archive, and names such as `constructor`, `__proto__`
and a name used twice in the JSON. `npm run test:ingitdb`
(with `INGITDB_CLI` set to the CLI) proves inGitDB rejects each broken
constraint of the collection definitions.

### What ModelSpec gives the checks, and what it does not yet

ModelSpec's specification renamed three words in October 2026: `entity` became
`record`, `property` became `field` and the `entity =` setting became `record =`
in HCL, and the JSON identifier `1.0-draft` became `1.0-draft-2` with the keys
`records`, `fields` and `record` for `entities`, `properties` and `entity`. The
registry reads both spellings, as the specification asks of every reader
([`specscore/modelspec@133134b`](https://github.com/specscore/modelspec/tree/133134b255ad7e94c9c838011605bb62c9675888),
`spec/core-model.md`, "Deprecated Spellings"):

- **Both spellings are accepted.** A model pinned in the earlier spelling stays
  valid. `npm run check` and `npm run lint:hcl` print one `notice:` line for each
  registry record whose files are in the earlier spelling, naming
  `modelspec rewrite --write`; a notice never changes the exit status. A JSON
  twin must be in the vocabulary of its HCL source (an HCL file that holds any
  earlier word is exported as `1.0-draft`, one in the current spelling alone as
  `1.0-draft-2`, as `modelspec export` does), and a JSON document that mixes
  the two vocabularies is refused.
- **`index.json` is unchanged.** It still has the keys `entities` and
  `properties`, whatever the spelling of the model; only a model's own
  `modelspec` value shows the identifier its JSON declares.
- **Removed and reserved words are refused**, with a message that names the word:
  `collection`, `recordset` and `column` were removed, and `projection`, `index`
  and `migration` are reserved with no content, as HCL blocks and, where the
  specification names one, as top-level JSON fields. `records` joins the reserved
  concept names.

What the checks implement and what they do not:

- **They do not validate against the JSON Schemas ModelSpec publishes**
  ([`modelspec-ast.schema.json`](https://modelspec.org/schema/modelspec-ast.schema.json),
  the latest vocabulary, and the two versioned files
  [`modelspec-ast-1.0-draft-2.schema.json`](https://modelspec.org/schema/modelspec-ast-1.0-draft-2.schema.json) and
  [`modelspec-ast-1.0-draft.schema.json`](https://modelspec.org/schema/modelspec-ast-1.0-draft.schema.json)).
  They implement the structural checks that the JSON format document lists
  (`scripts/lib/modelspec.mjs`) in both vocabularies. This file started as the
  one in `meaninggraph/core` and is also copied into other repositories
  (`datatug/chinookdb` among them); those copies read the earlier spelling only
  until they are updated.
- **The HCL-to-JSON converter is a small one, in this file**, for the HCL
  ModelSpec v0 allows (records, components and enums, with literal values); the
  reference CLI (`modelspec export`) is the other converter. It writes the JSON
  AST from the source and compares it with the published one, ignoring the
  module (HCL has nowhere to state it), the order of names and the layout. A
  source with a removed or reserved block, an expression or a top-level setting
  is refused rather than guessed at, and so is a module-qualified reference to
  another module (ModelSpec's
  [decision 0014](https://github.com/specscore/modelspec/blob/main/spec/decisions/0014-module-qualified-references.md)
  leaves finding modules to the consumer, and the registry has no resolver
  yet).
- **Known limits, unchanged by the support for both spellings.** A removed or
  reserved word written as a setting on a component or an enum is not refused,
  and the validator accepts keys it does not know inside a record type, a
  component or an enum; the reference CLI refuses both.

## Notifying the sites

A change to `index.json` on `main` notifies the sites built from it, so they redeploy. `.github/workflows/notify-sites.yml` starts the `deploy.yml` workflow, on `main`, of each site listed in `scripts/notify-sites.json`, sending only a reason; each site works out for itself what changed and stops at once when nothing did. The workflow can also be run by hand on `main`.

**Tokens.** Each site is started with a token, stored as a repository secret whose name `scripts/notify-sites.json` gives per site, one secret per site owner. A token is a fine-grained personal access token whose resource owner is that owner, limited to the one site repository, with the single permission Actions: read and write. A site whose secret is missing is skipped with a notice and the run stays green; a secret that is present but rejected turns the run red at the end, after every site was attempted. The workflow runs only for a push to `main` or a manual run on `main` in this repository, never for a pull request or a fork, and each token reaches only the one `gh` call for its site.

**Landing order.** Land the deploy workflows of the sites first (until a site has one, starting it fails), then this change, then add the secrets.

## Licence

Everything in this repository (the records, the collection definitions,
`index.json`, the scripts) is [CC0-1.0](LICENSE). The models keep their own
licences, which each entry states.
