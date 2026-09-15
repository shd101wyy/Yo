# `c_include(...)` and `extern(...)` are module values

**Status:** ACTIVE 2026-09-15 — implemented on `feat/c-include-module-value`.
**Owner:** compiler (evaluator + parser desugar + codegen name resolution).
**Breaking:** yes, by decision (single user, no compatibility scaffolding). A
patch release is cut once this lands.

## 1. Problem

`c_include("<h>", a : T, ...)` and `extern("c"|"Yo", a : T, ...)` pushed their
fields straight into the enclosing environment with a raw `add_variable_to_env`
call. Two consequences, both measured on 2026-09-15 with the v0.2.33 seed:

1. **They bypassed the no-shadowing rule.** A Yo `abs` followed by
   `c_include("<stdlib.h>", abs : ...)` compiled without complaint and the C
   binding silently won (the only diagnostic was the `unsafe(...)` wrap demand
   at the call site). The reverse order errored correctly. The same hole
   turned out to exist for EVERY destructuring binding: `p2 :: 1;` followed by
   `{ println : p2 } :: import("std/fmt")` was accepted, as was importing the
   same name twice. The check lives at the atom-binding sites
   (`binding.yo`, `initialization_assignment.yo`) and the destructurer never
   ran it.
2. **A collision had no resolution.** There was no way to give a C symbol a
   different Yo name, so `std/libc/sys/stat.yo` carries a commented-out
   `struct_stat : Type` ("conflicts with function") and `src/manifest.yo`'s
   `read_file_sync` fell back to module-qualified `fcntl.open` / `unistd.read`
   to say which `open` it meant.

## 2. Decision

`c_include(...)` and `extern(...)` **evaluate to a module value** — the same
source-namespace struct an `import(...)` produces (`EvalValue.StructVal` with a
`source_namespace_*` id, typed `TypeValue.Struct(..., is_source_namespace :
true)`). Names enter scope only through the binding forms the language already
has, which brings selection, qualification and renaming for free:

```rust
c :: c_include("<stdio.h>", printf : (fn(fmt : *char) -> int), stdout : *FILE);
unsafe(c.printf(...)); c.stdout;                       // qualified
{ printf, stdout : out } :: c_include("<stdio.h>", ...); // selective + rename
{ ... } :: c_include("<stdio.h>", ...);                 // glob
rt :: extern("Yo", __yo_errno : (fn() -> i32));         // same for extern
```

No dedicated rename syntax is added: `{ stat : stat_fn } :: ...` is the
documented destructuring rename (`docs/en-US/DESIGN.md`, "Import test function
from test.yo and rename it to test2").

**Bare statement position is sugar for the glob.** A `c_include(...)` or
`extern(...)` call that is a statement — a top-level program entry or an
element of a `{ ...; }` block — is desugared **at parse time** to
`{ ... } :: c_include(...)`, next to the existing `if`→`cond` desugar in
`src/expr.yo`. The formatter works on tokens and never sees it, so `yo fmt`
round-trips the source. Rationale:

- It is the only form the **seed** can build. `yo build` evaluates `src/`
  (43 `extern("Yo", ...)` sites) with the released compiler, so `src/` cannot
  be rewritten to `{ ... } :: extern(...)` until a seed ships this change, and
  the tree-built compiler must in turn accept the form the seed accepts.
  Without the desugar the change needs two releases and an interim compiler
  that accepts both; with it the change is one PR and `std/`, `src/` and
  `tests/` need no edits.
- Rust and Zig both declare `extern` items into the current namespace, and
  both run the duplicate-definition check while doing so. Here that check is
  the destructurer's new no-shadowing rule (§3.3), so the bare form is
  exactly as safe as the explicit one.
- It is NOT the removed `open(...)`: the names a bare `extern(...)` brings in
  are written in the statement itself.

**DECIDED 2026-09-15 (user): the bare form is the canonical declaration
spelling and stays; no migration of `std/`/`src/` to `{ ... } :: extern(...)`
is planned, now or after the seed bump.** The explicit forms exist for what
the bare form cannot express — qualification, selection, renaming. (Removing
the sugar would be a one-line deletion in the desugar plus a rewrite of ~90
sites; it buys no semantic change and is rejected.)

## 3. Implementation

### 3.1 Parser desugar (`src/expr.yo`)

`desugar_if_calls` gains a second target: at statement position a
`c_include`/`extern` FnCall `e` becomes
`FnCall("::", [FnCall("_", ["..."]), e])` with fresh ids for the synthesized
nodes and `e` kept intact (its id carries the ExprInfo the evaluator writes).
Statement position = every entry of the program list
(`desugar_program_if_calls`) and every argument of a `begin` FnCall. The
copy-on-write pre-scan (`_contains_if_call`) is widened to `_contains_desugar_target`
so an untouched subtree is still returned unchanged.

### 3.2 Evaluators (`src/evaluator/exprs/c_include.yo`, `extern.yo`)

Fields are bound in the **current frame** while the list is walked, so a
later field can still name an earlier one (`FILE : Type, stdin : *FILE`);
the bindings are then removed (`truncate` + `invalidate_frame_index`, the
idiom `comptime_expect_error` and the pending-def reset use) and the collected
labels / types / per-field values become the module value. Not a pushed
scratch frame: a generic parameter's SomeT is keyed on its frame LEVEL, so a
field type evaluated one frame deeper no longer unified with the identical
type written at module level (the prelude's `Io.async` against
`__yo_io_async` — the first build's failure). Per-field values are unchanged:
`TypeVal(SomeT)` or the ADOPTED Yo type for `Name : Type`,
`create_unknown_val_with_name` for functions (codegen identifies an extern
callee by that shape), `create_runtime_unknown_val_with_name` for globals.
The ExprInfo of the call now carries the module type and value instead of
`unit`. Registries keyed by the C name (`g_extern_c_includes`,
`g_extern_c_globals`, `register_extern_type_name`, adoption) are populated
exactly as before.

The sns id is `stable_module_id("source_namespace_extern_<fnv(module)>_", module)`
— `source_namespace_` prefixed so the value is recognised as a module, a
distinct prefix so it never collides with the module's own id, and NOT
registered in `g_sns_module` (it is not a module on disk, so no member-read
attribution is recorded against it). A `c_include` id is additionally
recorded in a new `g_extern_c_module_ids` set (`expr_info.yo`) — the
destructurer's gate for §3.4.

### 3.3 Destructurer no-shadowing (`src/evaluator/exprs/destructuring_assignment.yo`)

Both binding sites of `handle_member_destructuring` — the `...` spread and
the named / renamed / positional field — now run the same check as
`binding.yo`: a name visible in ANY frame is a hard error
(`Variable "x" is already defined here (variable shadowing is not allowed)`),
with the `__yo_self` exemption. This closes the hole for every RHS kind, not
only extern modules. One field kind binds nothing: an ADOPTED type
(`Point : Type` where `Point` already names a Yo struct — the by-value C
struct feature, `tests/c_include_struct_by_value.test.yo`). Its value IS the
existing type, so the glob (and a selection under the same name) leaves the
existing binding in place instead of re-creating it; only a selection under
a NEW name (`{ Point : CPoint }`) binds. Any `std/`/`src/` file that re-destructured a name it
already had in scope is corrected in the same PR (measured with the
tree-built compiler; see §5).

### 3.4 Renamed extern-C GLOBALS (`src/expr_info.yo`, codegen)

A renamed FUNCTION works as-is (the C symbol is `FuncMeta.extern_name`) and so
does a renamed opaque TYPE (the SomeT is named after the C type). A GLOBAL
(`stdout : *FILE`) had its C name only in the Yo variable name. The registry
gains a Yo-name → C-name map: when the destructurer binds field `label` of a
module whose id is in `g_extern_c_module_ids` under a different `var_name`, it
calls `register_extern_c_global_alias(var_name, label, ty)`.
`get_variable_name_for_codegen` emits `extern_c_global_c_name(name)` for a
matched extern-C global and `_register_extern_global_header` looks the header
up by that C name. A module-qualified read (`c.stdout`) emits the raw C name
and registers its header from the collection pass (the atom arm now also
accepts a property-access atom whose type matches the registered global —
previously `M_PI`-style reads through a module value pulled in no header).

### 3.5 Lazy top-level walk (`src/evaluator/context.yo`)

`classify_pending_def` treated a bare `extern(...)` statement as a pending
definition with `members` = its labels (forward references from bodies above
it). The desugared shape is `::` with a `_` LHS, which was classified as an
ordered statement. The classifier now recognises `{ pattern } :: extern(...)`
and `{ pattern } :: c_include(...)`: members are the names the pattern BINDS
(all RHS labels for `...`, the atom for `a`, the new name for `a : b`).
`c_include` members thereby become forward-referenceable too, which the old
ordered form never was.

## 4. What does NOT change

- The privilege gate (`pragma(Pragma.AllowUnsafe)`) and the `unsafe(...)`
  call-site wrap.
- `std/`, `src/`, `tests/` sources — they keep the bare form (§2) and are
  seed-compatible. Value-position forms may be used in `tests/` immediately
  (tests run under the tree-built compiler) and in `std/`/`src/` only after
  `SEED_VERSION` carries this change (`plans/backlog/SEED_VERSION_AUTOMATION.md`).
- ~~A C symbol that is not a Yo identifier still cannot be spelled.~~ LANDED
  as a follow-up (2026-09-15): `label : c_type("struct stat")` declares an
  opaque type with an explicit C spelling (`register_extern_type_c_name`,
  `src/types/guards.yo`; codegen lowers the SomeT to the spelling); an
  adopted Yo struct takes the spelling too. SEED-GATED for `std/` —
  `std/libc/sys/stat.yo` and `time.yo` keep `*(void)` until a release carries
  it. `tests/c_include_c_type.test.yo`.
- ~~The name-keyed extern registries overwrite each other.~~ LANDED as a
  follow-up (2026-09-15): the registries stay name-keyed but hold EVERY
  declaration; codegen matches a binding by `type_key` against all of them
  (`extern_c_global_matches`) and `#include`s every header a symbol was
  declared under. Measured on the seed: two modules declaring `LC_ALL` as
  `int` and `i64` left the first without `<locale.h>` ("use of undeclared
  identifier"). `tests/c_include_registry_collision.test.yo`.
- Also landed in the same follow-up: the prelude env cache is a PRIVATE
  `clone_env` snapshot and `mm_fresh_module_env` treats growth of its frame
  count as an internal error — the class behind
  `issues/fixed/comptime-expect-error-re-pushed-the-module-frame-into-the-prelude-env.md`,
  not just the instance.

## 5. Gates

- `tests/c_include_module_value.test.yo`: qualified call / global / type
  through a bound module value; selective import with a renamed function;
  a renamed GLOBAL (`M_PI : c_pi`) read through the alias; a qualified
  global read; the glob; an `extern("Yo", ...)` module value; a `c_include`
  member called from a definition ABOVE the declaration (forward reference);
  a bare `extern` statement inside a block.
- cli-cases `check-c-include-redeclares-a-yo-name` (bare `c_include` of a name
  the module already binds → rc=1, "already defined") and
  `check-destructure-rename-shadows` (`{ a : b } :: import(...)` onto an
  existing `b` → rc=1). Both passed rc=0 on the v0.2.33 seed.
- Existing: `tests/extern_unsafe_wrap.test.yo` (bare form, forward reference,
  two externs of one signature), `tests/c_include_struct_by_value.test.yo`
  (adoption), `tests/safe_code_structural_gates.test.yo` (privilege gate).
- `tests/expected_error_keeps_prelude_env_clean.test.yo`: the no-shadowing
  rule's first catch outside its own scope — a failing typed binding inside
  `comptime_expect_error` leaked the entry module's frame into the cached
  prelude env, so every module loaded afterwards saw the entry's bindings
  (`issues/fixed/comptime-expect-error-re-pushed-the-module-frame-into-the-prelude-env.md`).
- `yo check ./src` + `./std` with the tree-built compiler, the fast language
  suite, and the bootstrap fixpoint (the desugar allocates AST ids, so
  emission is identical MODULO `yo_id_N` renumbering).

## 6. Measured (2026-09-15)

- Seed v0.2.33 `check ./src`: 275/275. Tree-built `check ./std` 175/175,
  `check ./src` 275/275.
- Tree defects the rule exposed and this PR fixes: duplicate imports in
  `std/fmt/spec.yo`, `std/fmt/format.yo`, `std/url/index.yo`, `std/net/addr.yo`,
  `std/collections/hash_set.yo`, `std/collections/ordered_map.yo`,
  `tests/internal/parser.test.yo`; a libc `stdout`/`stderr` import silently
  shadowed by `std/io/stdio`'s in `tests/io/async_traits.test.yo`; three local
  `extern("Yo", __yo_ptr_eq …)` re-declarations of a prelude symbol
  (`std/string/string.yo`, `src/env.yo`, `src/expr_info.yo`); and the
  `comptime_expect_error` env leak above.
- cli-diff scorecard: PASS 134; the seven goldens that hash the bundled
  `yo-syntax` cheatsheet re-recorded (only that path moved).
