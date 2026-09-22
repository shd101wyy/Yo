# `yo context` — the agent context surface (language pack + API discovery)

**Status: ACTIVE 2026-09-22 — design settled, implementation not started
(phases C1–C6).** Subsumes
[`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
B3 tasks 1–2 (`yo guide`, `yo std`); B3 task 3's `AGENTS.md` recipe lands here
as phase C6, B4–B5 are untouched. Delivers
[`ROADMAP.md`](ROADMAP.md) Phase 4.1 (the canonical context pack) plus the
API-discovery half that roadmap item doesn't name. **No compiler change**: no
syntax, no builtins, no `std/` change, therefore **no seed gate** (the one
constraint: `src/` implementation may use only std APIs the current
`SEED_VERSION` already carries).

---

## 1. The problem: recall, not completion

Yo is not in any model's pretraining (ROADMAP Phase 4: "nothing has Yo in
pretraining; everything rides on context"). The first question an agent hits
is **recall** — "which module do I import to hash a string?" — and no shipped
surface answers it:

- **`yo lsp` is the wrong shape for the agent loop.** It is session-shaped
  (initialize / didOpen / didChange), position-shaped (a cursor in an open
  document), and popup-shaped (a label + detail string, not a context-sized
  blob). Its own header (`src/lsp/completion.yo`) states the deliberate v1
  gaps: no text-based type re-parse, `foo().` receivers answer nothing.
  Completion enumerates identifiers already in the document, prelude names,
  dot-receivers with known types, and import-list members **once the module
  path is already known**. That serves the last 10% of discovery (member
  lookup) after recall has already happened; it cannot answer "what exists".
  LSP stays the right surface for the editor and for agents that keep a
  resident session — this plan does not touch it.
- **The skills cheatsheets are hand-curated** (`.github/skills/`, ~2.6k lines)
  and drift from `std/` silently; they teach language rules well but cannot
  enumerate an API surface that changes every release.
- **Reading `std/` sources** works (the agent has the files) but burns tokens
  on implementation bodies the model doesn't need.
- **`yo doc`** renders a whole tree to HTML/Markdown/JSON — but it is a
  two-step workflow (`-o dir`, then read files), has no search, and a full
  std build costs **26.1 s** (measured below).

The design splits cleanly into two halves sharing one verb:

1. **The pack** — a small, curated, versioned *language* guide (grammar,
   idioms, sharp edges) shipped with the toolchain and printed by the binary.
   This is ROADMAP Phase 4.1 as written; `bend guide` (~600 lines) is the
   precedent, and the BEND lessons doc names the gap exactly: "Missing:
   anything that *prints* the guide or the std from the binary".
2. **API discovery** — a *query* surface over the existing documentation IR:
   index, describe, search, scoped to the bundled std plus the project's
   declared dependencies. Never a pack: std is too big (§2) and too
   version-dependent, so wholesale loading is off the table by measurement.

## 2. Measured baseline

All numbers from this tree, 2026-09-22, `develop` `f76780f8a`, Mac Mini M4:

| Fact                                              | Value                                  |
| ------------------------------------------------- | -------------------------------------- |
| `yo doc ./std --std-path ./std --format json`     | **26.1 s**, exit 0                     |
| Modules / documented items                        | **175 modules, 2,069 items**           |
| `doc.json` size                                   | **3.4 MB**                             |
| One-line-per-item index, estimated tokens         | 2,069 lines ≈ **~30k tokens** — too big to load wholesale |
| Module list (the browsable unit)                  | 175 lines ≈ **~4k tokens** — loadable  |
| `std/json.parse`                                  | takes a **static `str`, not a runtime `String`** (`src/doc_command.yo` header) — a cached JSON index could not be parsed back at runtime |
| Cache root (`yo cache path`, `src/cache.yo` L36)  | `$YO_CACHE_DIR` → `$XDG_CACHE_HOME/yo` → `~/.cache/yo` (Windows: `%LOCALAPPDATA%\yo\cache`) |
| Release bundle layout (`.github/workflows/release.yml` ~L376, ~L444) | `bin/yo + std/ + vendor/mimalloc/ + LICENSE` |
| Bundled-skills lookup (`src/skills_command.yo` ~L186) | env pin (`YO_SKILLS`) → `current_exe()` ancestors → cwd ancestors |

Consequences, each forced by a number above:

- **26.1 s per query is unacceptable** → build the index once, cache it
  content-addressed, query from the cache (D3).
- **~30k tokens for the full item index** → the interfaces are *search* and
  *per-module listing*, never "print everything"; `--list` prints the
  175-line module list (D4).
- **`std/json.parse` is static-str** → the cached index is a line-oriented
  text format, not JSON (D3).
- **The doc pipeline degrades silently on a mismatched std** (90/173 modules
  token-only when `--std-path` is wrong; `.github/instructions/documentation.instructions.md`)
  → the index builder resolves std exactly as the running binary does
  (`resolve_std_path`), so an installed toolchain never indexes a foreign
  tree by accident (D3).

## 3. Design

### D1 — One verb, two halves: `yo context`

```bash
yo context                                  # the pack (curated language guide)
yo context --list                           # module index of the bundled std
yo context <module>                         # one module's item index
yo context <module> <name>                  # one item, full entry
yo context <name>                           # unique → full entry; else ranked hits
yo context --search <query>                 # ranked search over names + docs
yo context ... --format text|json           # every query mode
yo context ... --deps                       # + the project's yo.toml dependencies
yo context ... --path <dir>                 # index an arbitrary tree instead
yo context ... --refresh                    # force an index rebuild
```

**Alternatives considered and rejected:**

- *BEND B3's two verbs* (`yo guide` + `yo std`): rejected in favor of one —
  an agent with no pretraining must discover the command from `--help` or an
  `AGENTS.md` line; one verb with predictable argument shapes halves that
  discovery cost, and the pack and the queries share every lookup mechanism
  (bundle resolution, env pins, CLI wiring). B3 tasks 1–2 are subsumed; if
  the maintainer prefers the two-verb spelling, only D4's argument grammar
  changes — the machinery (D2/D3) is name-agnostic.
- *Extending `yo lsp` with custom requests*: rejected — couples the agent
  surface to the session model for no gain; agents that want LSP already
  have LSP.
- *An MCP server now*: deferred (D6). The query layer is built as pure
  functions from query → text/json so an MCP wrapper, if ever wanted, is a
  thin shim over `src/context_command.yo`.

### D2 — The pack: `pack/context.md`

- **Source of truth**: one file, `pack/context.md` in the repo root. It is a
  product artifact like `std/`, not a doc: **English-only by ruling** — the
  bilingual rule covers `docs/` user documentation; the pack's audience is a
  model, and a second language doubles the token cost for zero benefit. The
  bilingual *CLI strings* still go through `tr(...)` like every subcommand.
- **Hard byte cap: 24 KB (~6k tokens)** — "small enough to sit in any model's
  context" (ROADMAP 4.1), enforced in CI by B5's `repo-shape` job when that
  lands; until then, `wc -c` in the PR checklist below.
- **Anti-drift rule**: the pack is about the **language**, never the API
  surface. No function listings, no per-module inventories — those come from
  the generated index. This is what keeps a curated file honest across
  releases; the skills cheatsheets' drift is the cautionary precedent.
- **Content outline** (distilled from `.github/skills/`, root `AGENTS.md`,
  and `docs/en-US/`):
  1. What Yo is — one paragraph: Yo→C11 via the system C compiler, RC + cycle
     GC, single-threaded async, designed for LLM authorship.
  2. The syntax rules that break Rust-trained instincts — no operator
     precedence (parenthesize every infix chain), `::` definitions and
     `impl` order-independence, `{ ... } :: import("m")` glob vs
     `{ a, b } :: import("m")` destructuring, records vs `struct(...)` (a
     brace group is a record unless it has a `;`), typed statement binds
     `(x : i32) = ...`, `if(...)` desugars to `cond(...)`, no overloading.
  3. Ownership and failure — dup/drop, the manufactured move, the `_`-prefix
     member privacy (E0405), the safe-mode class-1 panic vocabulary ban
     (`unwrap` & co. are compile errors in safe files), `unwind` vs `return`
     in effect handlers vs C `abort`.
  4. Async — single-threaded event loop (never add mutexes to async runtime
     state), `FutureState.Aborted`, `spawn_blocking`.
  5. Errors and diagnostics — throw/IoExn, `--error-format json`, `yo explain
     E0xxx`, `yo fix`.
  6. The agent loop recipe — `yo check` after every edit, `yo test` forms,
     `yo fmt`, when `--optimize 2` matters (deep recursion at `-O0`).
  7. Pointers, not copies — `yo context --search`, `yo doc`, `yo lsp`,
     `docs/en-US/`. Each pointer is one line.
- **Distribution**: release bundles add `pack/` next to `std/`
  (`release.yml`'s bundle-layout comments at ~L376 and ~L444 name the layout;
  update both, and the tar step). `scripts/install.sh` unpacks the bundle as
  a unit — verify it needs no separate change.
- **Lookup** mirrors `_find_bundled_skills_dir` (`src/skills_command.yo`
  ~L186), same three steps: `$YO_CONTEXT_PACK` env pin (the harness pin, like
  `YO_SKILLS`/`YO_STD`, so a staged binary in CI can find the checkout) →
  `current_exe()` ancestors (dev flow: `yo-out/<target>/bin/yo`) → cwd
  ancestors (installed binary run from a checkout). Missing pack = the same
  packaging-error shape `yo skills install` uses: name the lookup tried,
  exit 1.
- Version header inside the file (`pack-version: N; yo X.Y.Z`) — printed as
  the first output line so an agent can cite what it read.

### D3 — The index: prebuilt once, content-addressed, queryable in milliseconds

**Build** reuses the doc pipeline unchanged: per module, `mm_load_file` +
`build_doc_module` (the `run_doc` evaluator path in `src/doc_command.yo`),
with two deviations:

- **Fixed version string** — never `detect_git_version()`; git state must
  not leak into a cache keyed on content.
- **Degradation is marked, never silent** — the token-only fallback
  (`build_doc_module_from_tokens`) records the module as `degraded`, the
  index line carries `(untyped)`, and `--list` footnotes the count. Std
  resolution goes through `resolve_std_path()` so the installed toolchain
  always indexes its own bundled std (the `--std-path` pitfall cannot fire).

**Cache layout**, under the global cache root (`src/cache.yo`):

```text
<cache>/context/<std-key>/index.txt      # one line per item (the corpus)
<cache>/context/<std-key>/modules/<module>.md   # render_module_md output per module
<cache>/context/<std-key>/manifest.txt   # key inputs + build yo version
<cache>/context.lock                     # flock during build (store.lock pattern, src/cache.yo L152)
```

`<std-key>` = first 12 hex of SHA-256 over the sorted list of
`(relative-path, file-content-hash)` for every `.yo` file under the indexed
root. Any std edit mints a new key; old key directories are reclaimed by
`yo cache gc`, which learns the `context/` sibling (a small addition to
`src/cache.yo`; NOT the `store/sha256` layout — an index is not a package
tree, the verified-marker machinery is irrelevant).

**`index.txt` format** — line-oriented (tab-separated), *because
`std/json.parse` cannot read a runtime String* (§2):

```text
<module>\t<name>\t<kind>\t<signature>\t<doc-first-line>[\torigin=<defining-module>]
```

- `module` is the std-relative import path the agent would type
  (`collections/array_list`, not a filesystem path — the module-manager's
  `_canonical_module_path` is the normalizer).
- `signature` is the single-line form the model already renders.
- `doc-first-line` = first non-empty line of the doc comment, tabs/newlines
  collapsed to spaces; the full doc lives in `modules/<module>.md`.
- `origin=` appears **only for barrel re-exports**: a name re-exported by
  `std/string/index.yo` gets one index line per exposure (barrels are how
  agents import), but `origin=` names the defining module, and *describe*
  reads the entry from the origin's rendered file. This fixes, for `yo
  context` only, the "doc does not follow a re-export" hole yo doc has
  (`.github/instructions/documentation.instructions.md`) — yo doc's own
  behavior is untouched.

**Query cost model**: a query loads `index.txt` (≈ 2,069 lines, a few
hundred KB) and does String scans — milliseconds warm. Module describe reads
one cached `.md` (avg ≈ 20 KB). Nothing in the query path runs the
evaluator, so queries work identically on a cold checkout with a warm cache.

**Determinism rules** (a golden-diffed CLI needs them): every listing sorted
(module path, then name); no timestamps, wall-times, or git state in any
output or cache; identical input trees produce byte-identical caches.

### D4 — The query surface

Module addressing accepts `std/collections/array_list`,
`collections/array_list`, or a unique last segment (`array_list`); an
ambiguous bare segment lists the candidates and exits 1. Output samples
(illustrative — exact wording settles during implementation):

```text
$ yo context --list
std/assert                    test/assertion vocabulary (9 items)
std/collections/array_list    growable array-backed list (31 items)
std/collections/hash_map      hash map keyed by Hash + Eq (24 items)
... (175 modules total; yo context <module> for its items)
```

```text
$ yo context collections/array_list
std/collections/array_list — ArrayList(T): a growable array-backed list.
Stability: stable

  ArrayList        type     ArrayList(T)
  new              fn       (fn() -> ArrayList(T))
  push             method   (fn(self : ArrayList(T), item : T) -> unit)
  ...
```

````text
$ yo context collections/array_list ArrayList.push
std/collections/array_list — ArrayList(T)

push :: (fn(self : ArrayList(T), item : T) -> unit)

  Appends `item` at the end. Amortized O(1).

  ## Examples
  ```rust
  list := ArrayList(String).new();
  list.push(String.from("hi"));
  ```
````

- **Bare `<name>`**: exactly one index hit → print its full entry (the
  `kubectl explain` feel); several → ranked hit list with module provenance;
  `--verbose` prints the full entries of the top hits.
- **`--search <q>`**: case-insensitive substring over name, signature, and
  doc-first-line from `index.txt`. Ranking: exact name > name prefix > name
  substring > signature/doc match; ties broken by (module, name) sort.
  Deterministic. **`--deep`** additionally linear-scans the cached
  `modules/*.md` bodies (≈ 3.4 MB of String scans — fast enough, and it is
  opt-in so the default stays predictable).
- **`--format json`** for every query mode (mirrors `--error-format json`):
  one object per hit with stable field names `module`, `origin`, `name`,
  `kind`, `signature`, `doc`; errors as `{"error": "...", "suggestions":
  [...]}`.
- **Exit codes**: 0 results; 1 no match (stderr carries up to three
  did-you-mean names from the ranking); 2 usage/packaging error — the same
  family as `yo verify`'s exit paths.
- All strings bilingual through `tr(...)` (`src/cli_lang.yo`); `--help` text
  for the subcommand.

### D5 — Scope: the bundled std, the project's deps, or any tree

- **Default corpus**: the running binary's std (`resolve_std_path`).
- **`--deps`**: adds every dependency of the nearest `yo.toml` — manifest
  and lock read via `src/manifest.yo` / `src/lock_file.yo`, package trees
  from the content-addressed store (`store_tree_dir`, `src/cache.yo` L97),
  each indexed by its lock `integrity` hash under the same `context/`
  scheme, so a dep is indexed once per version, not per project. Requires
  `yo install` to have run (same rule as every non-build command —
  `plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`); a missing store
  tree is the standard "run yo install" error.
- **`--path <dir>`**: index an arbitrary tree instead (the dev flow — `yo
  context --path ./src Main` works on the compiler itself); keyed by the
  same content-hash scheme so foreign trees don't collide with std's cache.
- **Env pins for tests and CI**: `$YO_CONTEXT_PACK` (D2) and
  `$YO_CONTEXT_CACHE` (cache-dir override), mirroring `YO_SKILLS`/`YO_STD`.

### D6 — Deliberate non-goals

- **No MCP server** — revisit after real usage shows which queries agents
  actually make (the query layer is shim-ready by construction, D1).
- **No LSP changes.**
- **No embeddings / semantic ranking** — substring + prefix first; a
  deterministic lexical ranking is debuggable and needs no model.
- **No indexing of the current project's own sources** — agents read
  sources; the corpus is std + declared deps.
- **No context auto-injection** into prompts or editors.
- **No `yo doc` behavior changes** — the index builder *consumes* the doc
  pipeline; barrel/re-export and any other doc rendering stay as they are.

## 4. Implementation phases

Each phase is an independently shippable PR. Every phase's checklist:
`yo fmt` on touched `.yo` files; `yo check ./src`; `yo compile src/main.yo
--skip-c-compiler` whenever `src/` changed; the named tests (internal tests
one file at a time, `--parallel 1`; cli-cases recorded with `--record` and
reviewed by hand); user-visible changes documented in **both**
`docs/en-US/` and `docs/zh-CN/`; only std APIs the current `SEED_VERSION`
carries. Wiring anchors in `src/main.yo`: `SUBCOMMAND_NAMES` (~L7268), the
per-subcommand usage/help block (~L8426 region), the dispatch chain
(~L8715).

### C1 — The pack ships (`yo context` bare)

> **Status: LANDED (PR `feat/yo-context-c1`).** `pack/context.md` (12.7 KB,
> pack-version 1) + `src/context_command.yo` wired as the `context`
> subcommand; bundles carry `pack/` and the smoke legs assert `yo context`
> answers from outside the checkout. One deliberate deviation from the D2
> sketch: **`$YO_CONTEXT_PACK` is AUTHORITATIVE when set** — an invalid pin
> is a loud error, never a silent fallback — because a wrong explicit pin
> failing quietly would print some unrelated pack and would make the
> `context-pack-missing` cli-case non-deterministic on machines whose
> directory ancestry happens to contain a `pack/`. The pack-version
> citation is token-parsed from anywhere in the header prose, not a
> fixed-position line.

**Scope.** The static half, no doc-pipeline dependency.

1. Write `pack/context.md` per D2's outline and cap (≤ 24 KB; the writing is
   the bulk of the phase — distill, don't link).
2. `src/context_command.yo`: `run_context` skeleton — pack lookup
   (`_find_bundled_context_pack` mirroring `_find_bundled_skills_dir`,
   `src/skills_command.yo` ~L186), print, packaging error.
3. `src/main.yo` wiring (three anchors above); `src/cli_lang.yo` strings;
   `--help`.
4. Release bundle carries `pack/`: `release.yml` bundle-layout comments
   (~L376, ~L444) and the tar step; verify `scripts/install.sh` unpacks it
   (it unpacks the bundle as a unit — confirm, don't assume).
5. `docs/en-US/CONTEXT.md` + `docs/zh-CN/CONTEXT.md` — the command page,
   extended by each later phase.

**Tests**: cli-cases `context-pack` (sandbox pins `$YO_CONTEXT_PACK` to the
checkout's pack, the way the skills cases pin `YO_SKILLS`),
`context-pack-missing` (override pointing nowhere → packaging error, exit 1).

**Exit**: a fresh install prints the guide; `wc -c pack/context.md` ≤ 24576.

**Estimate**: 4–5 days (1 for code + bundling, 3–4 for writing the pack).

### C2 — The index builds and caches (`--list`, `--path`, `--refresh`)

> **Status: LANDED (PR `feat/yo-context-c2`, stacked on C1).**
> Measured: cold std build 28.3 s (target ≤ 40 s), warm `--list` **45 ms**
> (target < 300 ms), 175 modules. **Open decision resolved (D4/C3):** the
> per-module describe cost measured 0.7–1.2 s cold / ~0.15 s amortized —
> both cheap, so C3 may slice the cached markdown (a) freely.
> **Barrels:** the doc pipeline's evaluator path DOES document
> house-shaped barrels (`_x :: import(...)` + `export(...(_x))`) — the
> plan's `origin=` is set directly from each spread source module (the
> name-matching fallback the sketch proposed was dead machinery and was
> deleted). `std/string` indexes at 295 items with origins.
> **Safe-mode discovery:** this phase surfaced that safe-mode 3 (#837)
> broke every `HashMap` insert compiled by a #837-carrying compiler —
> `mix_u64`'s wrap-by-design multiply traps (layer 1), and the prelude's
> `wrapping_mul` fallback looped `rhs` times, i.e. ~2^64 for hash operands
> (layer 2), plus `src/utils.yo`'s own FNV. Fixed in
> `issues/hash-map-mix-u64-relies-on-wrapping.md` with a std regression
> test; CI never saw it because every CI binary was built by the
> pre-#837 seed.

**Scope.** The data half's foundation. New file `src/doc/context_index.yo`.

1. Builder: `context_index_build(root : String, cache_dir : String)` — walk
   `.yo` files, per module `mm_load_file` + `build_doc_module` (fixed
   version string, degradation marked), emit `index.txt` +
   `modules/<module>.md` + `manifest.txt`, per D3's format including the
   barrel `origin=` rule.
2. `context_std_key(root)` — the sorted (path, content-hash) digest;
   manifest records inputs so a stale cache is detectable, not just keyable.
3. Cache plumbing: `<cache>/context/<key>/…`, `context.lock` flock around
   builds (the `store.lock` pattern), `yo cache gc` learns `context/`
   (`src/cache.yo`), `$YO_CONTEXT_CACHE` override.
4. Scanner: `context_index_load` + the rank helpers of D4 (pure, unit-tested
   without any evaluator).
5. CLI: `--list`, `--path`, `--refresh`. First query with no valid cache
   builds it (one ≈ 26 s std build), printing progress the way `yo doc`
   does.

**Tests**: `tests/internal/context_index.test.yo` — key stability (same
tree twice → same key; one edit → new key), build/scan round-trip over a
fixture mini-std, degraded marking, determinism (two builds byte-identical);
cli-case `context-list` over a fixture tree via `--path` + a pinned
`$YO_CONTEXT_CACHE` (keeps the case off the 26 s real-std build).

**Exit**: `yo context --list` cold ≈ 26 s (build) / warm < 300 ms; `yo cache
gc` reclaims an orphaned key dir.

**Estimate**: 1 week.

### C3 — Describe (`yo context <module>`, `<module> <name>`, bare `<name>`)

> **Status: LANDED (PR `feat/yo-context-c3`, stacked).** Describe slices the
> item's section from the cached `modules/<module>.md` (decision (a) — the
> heading anchors are regular: `` ### `anchor` ``, methods deeper inside
> type sections; the slice runs to the next same-or-higher heading). Module
> resolution: exact > unique last segment > unique suffix; ambiguity lists
> candidates (exit 1); misses offer up to three did-you-mean names.
> `Type.method` addresses methods by plain name — the index stores them
> unqualified.

1. Module index rendering from the cache (D4 sample).
2. Item describe. **Open decision, measured in C2**: (a) slice the item's
   section out of the cached `modules/<module>.md` (fastest; depends on
   `render_module_md`'s heading structure being stable), or (b) re-render
   the single item by running `build_doc_module` on the one origin module
   (cost: a per-module evaluator load — measure; the prelude is cached, so
   this is likely 1–2 s). Pick (a) if the headings are regular, else (b);
   record the choice and the number in this doc.
3. Name resolution: module addressing forms, bare-name uniqueness, ambiguity
   → candidates + exit 1, not-found → exit 1 + three did-you-mean names on
   stderr.

**Tests**: cli-cases `context-module`, `context-item` (a barrel re-export
described from its origin), `context-not-found`, `context-ambiguous`.

**Estimate**: 3–4 days.

### C4 — Search + JSON (`--search`, `--deep`, `--format json`)

> **Status: LANDED (PR `feat/yo-context-c4`, stacked).** Lexical ranking
> (exact 400 / prefix 300 / name-substring 200 / signature 100 / doc 50 /
> deep-body 10), ties by (module, name); deterministic selection sort.
> `--format json` covers list/module/item/search with stable keys.
> **Codegen hole found en route** (issue:
> `issues/str-literal-as-string-arg-miscompiles-in-template-interpolation.md`):
> a str literal passed as a String argument inside template interpolation
> type-checks but emits no str→String conversion — the C rejects it.
> Worked around with the house `String.from(...)` idiom; proper fix
> (codegen materialization or a check-time rejection) is open.

1. Index scan + ranking (D4), `--deep` body scan over cached module files.
2. `--format json` for every query mode, stable field names (D4); error
   objects with suggestions.
3. Ranking unit tests: the rank table (exact/prefix/substring/body), tie
   determinism, case-insensitivity.

**Tests**: cli-cases `context-search`, `context-json`.

**Estimate**: 3–4 days.

### C5 — Dependencies (`--deps`)

1. Nearest-manifest + lock walk (`src/manifest.yo`, `src/lock_file.yo`);
   per-dep index build over store trees (`store_tree_dir`), keyed by lock
   `integrity`; merged corpus for `--list`/`--search` under `--deps`, dep
   hits provenance-tagged (`mydep!pkg/mod` — settle the exact separator
   during implementation, it must not collide with module paths).
2. Missing store tree → the standard "run yo install" error.

**Tests**: cli-case `context-deps` — fixture project + a **local-path
dependency** (`yo add ./path`), so the case is network-free like the other
manifest/cli cases; internal test for the manifest→store walk.

**Estimate**: 4–5 days.

### C6 — Consolidation sweep

1. `yo init`'s `AGENTS.md` template (`src/init.yo` ~L186): the four-line
   recipe — `yo context` to learn, `yo check` after every edit, `yo test`
   forms, `yo verify --strict ./spec` before committing (BEND B3 task 3
   folded here); re-record the `init-*` cli-case goldens (the `AGENTS.md`
   hash is in `expected_tree`).
2. Skills cheatsheets: drop per-API listings in favor of `yo context`
   pointers; keep the language-rule cheatsheets (the pack now carries their
   distilled core — reconcile so there is ONE authoritative statement per
   rule: pack for rules, skills for workflow).
3. Root `AGENTS.md` project-commands list gains `yo context`.
4. Bookkeeping: ROADMAP Phase 4.1 annotated LANDED (pack) with this doc
   linked; `plans/README.md` — BEND bullet amended (B3 tasks 1–2 subsumed
   here), this doc promoted/moved per conventions; `pack/context.md` added
   to B5's `repo-shape.allow` when B5 lands (coordination note there).

**Estimate**: 2–3 days.

## 5. Campaign exit criteria

1. Fresh machine, binary-only: `yo context` prints the pack (< 50 ms);
   `yo context --list` cold ≤ 40 s (one index build), warm < 300 ms; every
   describe/search warm < 300 ms.
2. `yo context --search hash` answers with the hash module and the
   string-hash fn — the recall question that opened §1 — in one call.
3. An agent with zero Yo pretraining, given only the pack, writes a working
   program importing ≥ 3 std modules **without opening `std/` sources**
   (falsifiable once B4's evals harness exists; until then, dogfood in this
   repo's own agent sessions).
4. No hand-maintained API listing anywhere in the agent-facing surface
   drifts — the skills carry rules and workflow only.

## 6. Risks and open questions

- **Per-module describe cost** (C3's open decision) — measure in C2, decide
  before C3 starts.
- **`yo cache gc` shape** — the `context/` sibling is a new cache citizen;
  gc must treat a key dir as one unit (never collect half of one). Small,
  but it is the one place this plan touches existing storage code.
- **Bundle-layout comments** — two places in `release.yml` narrate the
  layout; both must change in C1's PR or the next release engineer trusts a
  stale comment.
- **Portable-C distribution** — the single-file `yo.c.gz` artifacts carry no
  `std/`; a portable-C-built `yo` has pack-only context plus `--path`
  queries. Acceptable (documented); revisit only if someone actually uses
  it.
- **Pack maintenance** — the anti-drift rule (D2: language, never APIs) is
  the control; the byte cap is the enforcement.
- **Naming** — `context` is the ROADMAP's reserved name; if the maintainer
  prefers BEND B3's `guide`/`std` spelling, D4 is the only section that
  changes.
- **Index size growth** — std grows ~a module a release; at 2× today's size
  the full index is ~60k tokens, still fine for search (it's scanned, not
  loaded) and `--list` stays 175→~350 lines. No cliff in sight.
