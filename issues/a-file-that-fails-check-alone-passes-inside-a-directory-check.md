# A file that fails `yo check` alone passes inside a directory check when a sibling loaded the provider

**Status:** FIX BUILT 2026-09-21, gating (branch `fix/imported-def-forces-in-its-own-impl-scope`); measured 2026-09-21 (seed v0.2.38 and a tree-built compiler
at eb91f7510 agree on the verdicts). Surfaced while bisecting a `check`
slowdown: `src/types/intern.yo` as of develop cannot be checked on its own
(`i64.to_string()` with only `std/string` imported), yet `yo check ./src`
reports it `evaluator OK`.

## Repro

`b.yo`, the file under test — no `std/fmt` import:

```rust
{ String } :: import("std/string");
h :: (fn(x : i64) -> String)(x.to_string());
export(h);
```

Alone, it is rejected — correctly, since integer `to_string` is the
`ToString` impl in `std/fmt/to_string.yo`, not a prelude method:

```
$ yo check ./b.yo
error[E0610]: No matching call found with arguments:
(x.to_string)()
```

Put ANY of these `a.yo` next to it and check the directory: `2/2 file(s)
passed`, `b.yo — evaluator OK`, rc=0.

| `a.yo` (checked first, alphabetical)                                 | seed | tree-built |
| -------------------------------------------------------------------- | ---- | ---------- |
| imports `std/fmt` and CALLS `i64(7).to_string()`                     | pass | pass       |
| imports `std/fmt` and imports `./b.yo`, calls `h(i64(1))`            | pass | pass       |
| imports `{ println } :: import("std/fmt")`, never touches an integer | fail | **pass**   |

The same file therefore has two verdicts depending on which files sit beside
it. `yo check ./src` is green today with at least one file (`src/types/intern.yo`)
that does not check on its own; the upper bound of the blast radius is the
80 of 134 `src/` files that call `.to_string()` without importing `std/fmt`
(not all of those are integer receivers — measured only as a grep).

## Mechanism (read from the code, confirmed by the table; not instrumented)

- Trait methods are recorded in a PROCESS-GLOBAL registry keyed by the
  receiver's type id (`src/evaluator/values/type_trait_methods.yo`,
  `_type_trait_methods`), tagged with an OWNER module but never filtered by
  it on lookup. `get_receiver_methods_by_name_from_env` (`src/env.yo`) and
  the generic-impl fallback consult the whole table.
- The provider module is DEMAND-LOADED and its impls are registered when it
  is evaluated. `check <dir>` evaluates every file in one process
  (`run_check` → `check_single_file` → `mm_load_file`, `src/main.yo`) and
  clears the module cache ONCE up front, so the registry accumulates across
  files. Under the tree-built compiler the third row passes as well: the
  `std/fmt` import alone brings the impl in; under the seed the impl still
  needed a forcing call (lazy top-level bindings — the `impl` def stayed
  Unforced until a method miss reached it, and `force_pending_impls_for_type_name`
  only walks ACTIVE walks, never a finished one).
- The owner tags exist for the LSP's per-edit purge (`mm_invalidate_document`
  → `purge_type_trait_methods_owned_by`), which is the only place they are
  read.

## Why it matters

- `check` is the gate everyone runs first; a green `check ./src` does not
  mean every file compiles from its own imports. A file promoted to an entry
  point, checked in isolation by the LSP, or moved into a smaller batch can
  fail with E0610 for code that "always checked".
- The test runner has the same exposure in the other direction: a
  `*.test.yo` batch is one program, so a test file missing an import passes
  as long as a sibling in its batch brings the provider
  (`yo-admin-merge-needs-the-internal-shards-locally`: batches are different
  programs).

## Fix (2026-09-21)

Method resolution only sees impls whose owner module is reachable from the
current module's import closure:

- `owner_visible_from_current(owner)` (`src/evaluator/values/type_trait_methods.yo`):
  no current module (owner tag `""` — codegen, the CLI, bootstrap) sees
  everything; an entry with owner `""` is always visible; otherwise the owner
  must be in the current module's closure. `get_visible_type_trait_methods_by_name`
  is the filtered getter; codegen, the LSP and the registries' own bookkeeping
  keep the unfiltered one.
- `import_closure_of(module)` (`src/evaluator/module_loader.yo`): the
  transitive closure over the loader's import edges, canonical spelling,
  memoized and dropped on any edge change; the prelude is marked
  always-visible at preload (`mark_owner_always_visible`), since it is loaded
  through the entry path but implicitly in scope everywhere.
- `env.yo`'s two resolution entry points use the filtered getter (7 sites);
  the generic-impl fallback (`find_methods_from_generic_impls`, impl.yo)
  skips entries whose owner is not visible.
- `_force_pending_def_impl` (anonymous_module.yo) sets the registration owner
  to the DEFINITION's module for the duration of the force
  (`loading_key_for_module`), so a definition forced from another module's
  lookup registers and resolves as its own module.

Measured with a compiler built from the branch:

| gate                                                  | result                          |
| ----------------------------------------------------- | ------------------------------- |
| `yo check ./src`                                      | 277/277 (0 files newly red)     |
| `yo check ./std`                                      | 176/176                         |
| cli-case `check-directory-verdict-matches-standalone` | E0610 + `1/2 file(s) passed`, rc=1 (seed: 2/2, rc=0 → GOLDEN-DIFF) |

The blast radius predicted above (80 files) did not materialize: in `src/`
and `std/` the provider is reachable TRANSITIVELY (`utils.yo` and friends
import `std/fmt`), which the closure honours — the grep counted direct
imports only. The standalone failure of `src/types/intern.yo` under the seed
was the seed's lazy-forcing behaviour, not a missing transitive path.

## Fix direction (as written before the fix)

Method resolution must only see impls whose owner module is reachable from
the CURRENT module's import closure (prelude-owned entries, owner `""`,
always visible). The data is already there: every registry entry carries its
owner, and the module manager holds the import graph (`invalidate_module`
computes the reverse closure). The forcing path must attribute the lookup to
the DEFINITION's own module, not the module that forced it (row 2: `h`'s
body is forced from `a.yo`'s walk). Landing this will turn every file that
relies on a sibling's import RED; each of those gets its explicit import,
which is the honest state — the same `check` verdict alone and in a
directory. Gate: a `tests/internal` test that checks `b.yo` alone and inside
a directory beside `a.yo` and asserts the two verdicts are EQUAL (both
E0610), plus `yo check ./src`, `./std`, `./tests` green after the import
sweep.
