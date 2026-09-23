# The `yo context` command

`yo context` prints the **agent context pack**: the curated, language-only
guide that ships inside the `yo` binary's distribution. It is written for AI
coding agents — which have no Yo in pretraining — but it doubles as the
fastest orientation for humans too.

## What the pack contains

The pack is one markdown file, capped at 24 KB so it fits any model's
context window. It covers **language facts only**:

- the declaration forms and the brace rule (a `{ ... }` group is a record
  unless it has a `;`),
- the no-precedence rule (parenthesize every infix chain),
- control flow (`cond`, `match`, `if`), pattern matching, traits, impls,
  derives,
- ownership, failure (`Option`/`Result`/exceptions), async and effects,
- the toolchain loop (`yo check` after every edit, `yo test`, `yo fmt`).

It deliberately carries **no API listings** — APIs drift every release, and
the pack must not. API discovery is the query half of the command.

## Usage

```bash
yo context                                  # the pack (language guide)
yo context --list                           # module index of the bundled std
yo context --list --path <dir>              # index an arbitrary tree instead
yo context --list --refresh                 # force an index rebuild
```

Output starts with a citation header naming the toolchain version and the
pack revision, so an agent can cite what it read:

```text
yo 0.2.40 — pack-version: 1
# Yo — context pack for coding agents
...
```

## Where the pack is found

The lookup order mirrors `yo skills install`'s:

1. `$YO_CONTEXT_PACK` — an explicit path to the `context.md` file or its
   `pack` directory. **Authoritative**: when set, it is THE pack — an
   invalid value is a loud error, never a silent fallback (useful in CI,
   and how the cli-cases pin it);
2. beside the running executable, walking up ancestors — a release bundle
   unpacks to `bin/yo` + `std/` + `pack/`, so an installed toolchain always
   finds its own pack;
3. beside the working directory, walking up ancestors — running an
   installed `yo` from inside a Yo checkout finds the checkout's own
   `pack/`.

If nothing is found (a broken packaging), the command names the locations
it tried and exits 1.

The pack source of truth is `pack/context.md` in the compiler tree; the
release workflow copies it into every bundle, and the bundle smoke tests
assert that `yo context` answers from outside the checkout.

## Dependencies

```bash
yo install                      # deps must be installed first (git deps live in the store)
yo context --deps --list        # std + the project's yo.toml dependencies
yo context --deps mylib         # describe a dependency module
yo context --deps --search double
```

`--deps` merges the nearest `yo.toml`'s lockfile packages into the corpus.
Git dependencies resolve through the content-addressed store (each version
indexed once per project — the key is the tree's content); path
dependencies are read live from their directories. Modules are named by
the dependency's import name (`mylib/util`), so hits are self-provenancing.
A git dependency whose store tree is missing asks for `yo install`.

## Search

```bash
yo context --search push          # ranked hits across names, signatures, docs
yo context --search push --deep   # also scan rendered module bodies
yo context --search add --format json
```

Ranking is deterministic and lexical — exact name, then name prefix, then
name substring, then signature match, then doc match; ties break by module
path. No embeddings, no model — the same query always returns the same
hits for a given std version.

## Describe: modules and items

`yo context <module>` prints a module's one-screen index; adding an item
name prints that item's full entry (signature, doc, examples — sliced from
the rendered module page):

```bash
yo context collections/array_list              # module index
yo context collections/array_list ArrayList.push   # one item (Type.method or plain name)
yo context ArrayList.push                      # unique across the corpus
yo context push                                # ambiguous -> ranked candidates, exit 1
```

Module arguments accept the full corpus path (`std/collections/array_list`)
or a unique last segment (`array_list`); an ambiguous segment lists the
candidates and exits 1, a miss offers up to three did-you-mean names.


## `--list`: the API index

`yo context --list` indexes the bundled std (175 modules, ~2,069 items) and
prints one row per module — the module's doc first line and its item count:

```text
std/allocator  Memory allocation abstractions and global allocator interface. (5 items)
std/assert     Runtime assertion and panic functions. (5 items)
...
— 175 modules; yo context <module> for its items
```

The index is built once per std version into a content-addressed cache —
`$YO_CONTEXT_CACHE` or the global yo cache (`yo cache path`), under
`context/<key>/`, where the key is a digest of every indexed file's path +
content. A cold build costs one `yo doc`-grade evaluation of the tree
(~28 s for the bundled std); every later query reads the cache in
milliseconds. `yo cache gc` sweeps the whole `context/` cache — it is pure
and rebuilds on demand.

`--path <dir>` indexes an arbitrary tree instead (relative paths resolve
against the working directory); module names are then prefixed with that
directory's name. Modules the evaluator could not load fall back to
token-only docs and are marked `(untyped)` in the output — degradation is
marked, never silent.

Per-module and per-item views, and full-text search, are the next phases
(`plans/YO_CONTEXT.md` C3–C5): `yo context <module> [name]` and
`yo context --search <query>`.
