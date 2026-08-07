# yo-self: a SECOND compile in the same process emits FTT for std internals (FIXED 2026-08-05)

**Found 2026-08-05** from CI run 30975201804, then reproduced locally on macOS — so
this is NOT platform-specific. It is why the self-hosted `test` subcommand fails on any
directory that produces more than one batch, while every per-file run is green.

## Minimal reproducer

```bash
# PASSES alone — 21/21
<self-hosted-bin> test ./tests/string/string_builder.test.yo --parallel 1

# FAILS as the second batch of a directory run — 47 FTT markers in batch 2
<self-hosted-bin> test ./tests/string --parallel 1
```

`tests/string` is five ORDINARY language tests — nothing to do with `tests/internal`.
`tests/internal` shows the same thing with 59 markers.

The decisive observation: **batch 1 and batch 2 import an IDENTICAL module list**
(`std/fmt/to_string std/assert std/string std/collections/array_list std/env`). So the
trigger is purely "second compile in one process", not which modules are involved.

The FTT markers are all in std internals — `ArrayList._length/_ptr/_capacity`,
`String._bytes`, `Option.unwrap`, `std/env`'s `getenv` — never in the test's own code.

## Root cause

`run_test` calls `run_compile(cargv, io, exn)` **in-process**, once per batch.
`run_compile` creates a FRESH `ExprInfoTable` (`expr_info_table_new()`), but several
global caches OUTLIVE it. On the second batch the cached std/prelude ASTs are reused
while their ExprInfo lives in the first batch's discarded table, so codegen finds no
info for those nodes and emits `// Failed to transpile`.

**TS needs no equivalent for two reasons**, and both matter:

1. It stores node info ON the AST node (`expr.$`), so a cached AST carries its
   annotations. yo-self keys a SIDE TABLE by expr id — cached AST + fresh table = lost
   info.
2. `src/test-runner.ts:503` does `moduleManager = new ModuleManager()` **per batch**, so
   its compiler state is per-instance. yo-self's equivalent state is module-level
   globals, so there is no instance to re-create.

TS's intent is therefore explicit: **each batch compiles with fresh compiler state.**

## Step 1: cache clearing (kept, but NOT sufficient)

`run_compile` now clears the two caches it is easiest to be sure about — matching what
`run_check` already did for the same reason:

```rust
clear_module_cache();
g_cached_prelude_env = Option(Environment).None;
```

Measured effect on `tests/string`: **FTT 47 -> 18.** Correct direction, not sufficient.

The remaining 18 are all GENERIC/specialized members (`String.from`, `ArrayList.get`,
`Option.unwrap`, `Self(_bytes : ...)`), which points at the specialization and
registry globals rather than the module cache:

| global                                                 | file                             |
| ------------------------------------------------------ | -------------------------------- |
| `g_func_type_registry`                                 | `function_value.yo:271`          |
| `g_specialized_fn_caches`                              | `evaluator/calls/helper.yo:1323` |
| `g_fid_specs`                                          | `expr_info.yo:1170`              |
| `g_method_callee_types` / `g_method_callee_values`     | `expr_info.yo:721,776`           |
| `g_impl_registry_keys` / `g_impl_registry_entry_lists` | `evaluator/values/impl.yo:200`   |

## Two ways to finish it

**A. Reset every cache between compiles.** Faithful to TS's "fresh state per batch".
Risk: the globals are a MIX of caches and WIRING — `g_type_implements_trait_full_fn`,
`g_find_assoc_from_impls_fn`, `g_compat_type_implements_trait_fn` are registered
function pointers, and clearing one of those breaks the compiler outright. Needs each
global classified correctly, and the list is long.

**B. Spawn a child process per batch in `run_test`.** The batch compile is already
argv-driven (`cargv`), so this swaps `run_compile(cargv, io, exn)` for a spawn of
`argv(0) compile ...`. It gets fresh state by construction and needs no classification
of globals. It reproduces EXACTLY the standalone path, which is the verified-green one
(all 58 `tests/internal` files and all 187 `./tests` files pass standalone on both
compilers). Cost: one process spawn per batch, negligible against a multi-second
compile. Constraint: relies on `argv(0)` being a usable path — true for CI and the gate
scripts, which always invoke the binary by explicit path.

**B was chosen and is now LANDED.** It is smaller, cannot silently miss a cache, and
lands on the behaviour already proven green. A is the "proper" fix but is a large,
high-risk sweep through compiler globals for no additional user-visible benefit.

### Verification of the landed fix

| check                                                | result                             |
| ---------------------------------------------------- | ---------------------------------- |
| `test ./tests/string` (was 47 FTT on file 2)         | **348/348, every batch FTT=0**     |
| `test ./tests/internal` whole directory, self-hosted | **826/826, 0 FTT, rc=0, 22 min**   |
| battery 20 files (incl. the six io_uring ones)       | 20/20 rc=0 hollow=0                |
| corpus diff-test                                     | PASS 155 DIFF 0                    |
| `check ./std`                                        | 153/153                            |
| stage-2 emit + clang, stage-2 ≡ stage-3              | hollow=0, 0 errors, FIXPOINT_HOLDS |

22 min matches the 22.2 min per-file baseline, so one spawn per batch costs
essentially nothing against a multi-second compile.

The cache clearing in `run_compile` is kept as defence in depth: it makes
`run_compile` self-contained, which is the invariant the child-process design relies
on, and it is free because a one-compile process starts with those caches empty.

## Why every gate missed this

Everything that exercises the self-hosted binary runs ONE file, hence one batch:

- `gates_fast.sh`'s 20-file battery loops file-by-file.
- `scripts/diff-test.sh` runs the corpus per file.
- The `tests/internal` differential harness runs per file (that is how it reported
  58/58 while directory mode was broken).
- `check ./std` never reaches codegen.
- The fixpoint compiles ONE program (`yo-self/main.yo`).

The new `compiler-internal-tests` CI job is the first thing that ever ran the
self-hosted binary over a whole directory, and it failed on its first run. Worth
keeping in mind for any future "it passes locally" claim about the self-hosted `test`
subcommand: per-file green says nothing about directory mode.
