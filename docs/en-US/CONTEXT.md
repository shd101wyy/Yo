# The `yo context` command

`yo context` is the agent context surface. With no arguments it prints the
**context pack**, the curated, language-only guide that ships with the `yo`
toolchain. With a query it looks the **API** up: the modules and items of the
bundled standard library, of any directory, and of the project's
dependencies. It is written for AI coding agents (which have no Yo in
pretraining), but it is also the fastest orientation for a person.

```bash
yo context                                   # the pack (language guide)
yo context --list                            # every std module, one line each
yo context collections/array_list            # one module's items
yo context collections/array_list ArrayList.push   # one item's full entry
yo context push                              # a name across the corpus
yo context --search hash                     # ranked search
```

## The pack

The pack is one markdown file, capped at 24 KB so it fits in any model's
context window. It covers **language facts only**:

- the declaration forms and the brace rule (a `{ ... }` group is a record
  unless it has a `;`),
- the no-precedence rule (parenthesize every infix chain),
- control flow (`cond`, `match`, `if`), pattern matching, traits, impls,
  derives,
- ownership, failure (`Option`/`Result`/exceptions), async and effects,
- the toolchain loop (`yo check` after every edit, `yo test`, `yo fmt`).

It deliberately carries **no API listings**. APIs change every release, and
the pack must not drift with them; the queries below answer API questions
from the toolchain itself.

Output starts with a citation header naming the toolchain version and the
pack revision, so an agent can cite what it read:

```text
yo 0.2.40 — pack-version: 1
# Yo — context pack for coding agents
...
```

### Where the pack is found

1. `$YO_CONTEXT_PACK`: an explicit path to the `context.md` file or its
   `pack` directory. When set it is **authoritative**: an invalid value is an
   error, never a silent fallback to some other pack.
2. Beside the running executable, walking up its ancestors. A release bundle
   unpacks to `bin/yo` + `std/` + `pack/`, so an installed toolchain finds its
   own pack.
3. Beside the working directory, walking up its ancestors. Running an
   installed `yo` inside a Yo checkout finds the checkout's `pack/`.

If none of them has a pack, the command names the locations it tried and
exits 2.

## Queries

| Query                         | Answer                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `yo context --list`           | Every module with its doc's first line and item count         |
| `yo context <module>`         | The module's items, sorted by name: name, kind, signature     |
| `yo context <module> <name>`  | One item's full entry: signature, complete doc, examples      |
| `yo context <name>`           | The name across the corpus (see below)                        |
| `yo context --search <query>` | Ranked hits over names, signatures and doc lines              |

A **module** argument is the full path (`std/collections/array_list`), a
unique last segment (`array_list`) or a unique suffix
(`collections/array_list`). An argument that matches several modules lists
them and exits 1.

An **item** is a plain name, or `Type.name` for a method (`ArrayList.push`).
When a module has several items of one name (two types' `new`), the plain
name lists their qualified forms and exits 1.

A **bare name** that is no module is looked up across the whole corpus. One
hit prints its full entry. Several print the ranked list of
`module  name  kind  signature` rows and exit 0; add `--verbose` to also
print the full entries of the top three. A name a barrel module re-exports
(`std/string` re-exports its submodules) counts once: the entry is described
from the module that defines it, with a `re-exported from` note.

**Search** is lexical and deterministic: an exact name match ranks first,
then a name prefix, a name substring, a signature match and a doc match,
with ties broken by module path. `--deep` also matches the text of each
item's full documentation. The same query always returns the same hits for
a given library version.

### Misses and exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Results                                                         |
| 1    | No match, or an ambiguous module or item                        |
| 2    | A usage error, a packaging error, or a missing `yo install`     |

A miss prints up to three did-you-mean names on stderr:

```text
yo: error: context: no module or item 'hashmap' in the corpus
  Did you mean: std/collections/hash_map
```

### JSON output

`--format json` works with every query, and stdout then holds exactly one
JSON document (progress goes to stderr). Every item object has the same
fields: `module`, `origin` (the defining module of a re-export, `""`
otherwise), `name`, `kind`, `signature` and `doc`.

- `--list`: `{"modules": [{"module", "doc", "items", "degraded"}, ...]}`
- `<module>`: `{"module", "doc", "degraded", "items": [item, ...]}`
- `<module> <name>`: the item, plus `text`, its full rendered documentation
- `<name>` and `--search`: `{"query", "count", "hits": [...]}`; search hits
  add a `score`
- a miss: `{"error": "...", "suggestions": [...]}` on stdout, with exit
  code 1

## The index

The first query builds an index of the corpus: one evaluation of the tree,
the same work `yo doc` does (about 28 s for the bundled std). Later queries
read it from the cache in milliseconds. It lives under the global yo cache
(`yo cache path`), or `$YO_CONTEXT_CACHE`, as `context/<key>/`. The key is a
digest of the corpus name, the index format, the toolchain version, and
every indexed file's path and content, so editing any file, or upgrading
`yo`, builds a fresh index. `--refresh` rebuilds regardless.

`--path <dir>` indexes an arbitrary directory instead of the bundled std; a
relative path resolves against the working directory, and module names are
prefixed with the directory's name. A module the evaluator cannot load falls
back to token-only documentation and is marked `(untyped)`: degradation is
marked, never silent.

`yo cache gc` keeps the index of the running toolchain's own std and removes
every other index (old versions, `--path` trees, dependencies); they rebuild
on demand. Builds, queries and gc share one lock, so none of them sees
another's work half done.

## Dependencies

```bash
yo install                         # git dependencies must be installed first
yo context --deps --list           # std + the project's yo.toml dependencies
yo context --deps mylib            # a dependency module
yo context --deps --search double
```

`--deps` adds every package in the nearest `yo.lock` to the corpus. Git
dependencies are read from the content-addressed store, and path
dependencies live from their directories. Their modules are named by the
dependency's import name (`mylib/util`), the first path component you would
write in `import("mylib/util")`. A missing `yo.toml`, a missing or
unparsable `yo.lock`, and a git dependency that is not installed are errors
that say what to run (exit 2).
