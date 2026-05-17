# yo-self evaluator coverage gaps

> Living document. The **Current state** section describes what yo-self-bin
> can evaluate today. The **Open gaps** section lists what still needs to be
> ported, in rough priority order. The **Closed gaps log** at the bottom is
> append-only, for traceability and credit; each entry points at the commit
> that fixed it.

## Current state (May 2026)

The `yo-self/evaluator/` port is **structurally complete** (133 `.yo` files
vs. 125 `.ts` files in `src/evaluator/`; the extras are bootstrap-only
scaffolding). On the `bootstrap/phase-4` branch yo-self-bin can `check`:

- The full `std/prelude.yo` end-to-end (1040+ exprs).
- Simple user programs: i32 / str literals, function definitions, `assert`,
  struct + impl + method dispatch (`Counter`), generic structs with
  `forall(T : Type)` (`Box2(T)`), `Option(T)` + `match` patterns,
  `Result(T, E)` + `?*(T)` shapes, traits with generic-constructor fn-type
  fields.
- Files that `import("std/...")` resolve at parse/dep-collection time via
  `collect_module_deps`; at evaluator time they resolve through a transparent
  env-synthesised `ModuleVal` (no separate per-module sub-evaluator yet).

Self-tests passing: lexer (33/33), binding (7/7), assignment (9/9), and the
other bootstrap-only suites. **22/25** of the real-test extracts from
`./tests/*.test.yo` (per the audit log).

**Hard requirement to run yo-self-bin:** `ulimit -s 65520` before invoking
the binary on non-trivial input. The recursive evaluator carries large
by-value structs and blows macOS's default 8 MB stack at ~40–50 frames.
See [`yo-self-evaluator-stack-overflow.md`](./yo-self-evaluator-stack-overflow.md).

What is NOT yet working:

- `yo-self-bin compile` produces invalid C for non-trivial programs (the
  evaluator OKs them, but codegen emits undeclared identifiers for `Self`,
  locals, etc.). Tracked under `yo-self-codegen-*.md`.
- Cross-module isolation: yo-self uses a flatten-all-exprs shortcut instead
  of TS's per-module sub-evaluation + caching. Works for the prelude and
  simple deps; not equivalent to TS for module privacy or for circular
  imports.
- Several real test programs (HKT-heavy, GADT, RC-stress) — see §5a, §3, §2.

---

## Open gaps (in priority order)

### §A. HKT support — `SomeT.kindFunctionType` not wired

**Where:** `yo-self/types/definitions.yo` (field added in `d78e5e14`),
`yo-self/evaluator/types/function.yo::evaluate_function_parameter`,
`yo-self/evaluator/types/synthesizer.yo` (TypeApplication path).

**What's missing:** The `kind_function_type : Option(Box(Self))` slot was
added to the `SomeT` variant to mirror TS `SomeType.kindFunctionType`, but
nothing populates or reads it yet. When a forall parameter has a kind like
`F : (fn(T : Type) -> Type)` (i.e. F is itself type-of-types-to-types),
the evaluator binds F as a plain `SomeT` with no record of the kind, and a
later `F(A)` `TypeApplication` has no way to know that F is HKT-shaped.

**Symptom:** Trait declarations using `Functor :: trait(F : (fn(T : Type) -> Type), map : …)`
segfault during type-expression evaluation (the bare `F` is treated as
runtime-only and a downstream dereference goes off the rails). Repros:
`/tmp/test_higher_kinded.yo`, `/tmp/test_typeapp_inline.yo`.

**TS reference:** `src/value.ts:573-619` (`createUnknownValue` branches on
the param's declared type: `TypeUni(0)` → `SomeType`, `Func(... → comptime Type)`
→ `SomeType` with `kindFunctionType` set). Then `src/evaluator/calls/numeric-type.ts`
and the type-application path consult `kindFunctionType` to drive `F(A)` eval
to a fresh applied `SomeType` instead of a raw lookup.

**Fix sketch:**

1. Extend `create_unknown_val_with_name` (already in `yo-self/value.yo`)
   with a third branch: when `ty` is a `Func(...)` whose return is
   comptime-`Type` and whose params are comptime-`Type`, emit
   `TypeVal(t_some_t_with_kind(name, …, ty))`.
2. Update `evaluate_function_parameter` (`yo-self/evaluator/types/function.yo`)
   to call this helper for forall HKT params.
3. Implement TypeApplication in `evaluator/types/synthesizer.yo`: when
   the callee in a type position is a `SomeT` carrying `kind_function_type`,
   produce a fresh applied SomeT (rather than failing the call).

**Tasks:** #113 (wire), #114 (TypeApplication eval).

**Real-test exposure:** Functor / Monad / Iterator chains. Affects any test
that builds traits parametric over a type constructor.

---

### §B. Trait-checking Phase-3 stubs

**Where:** `evaluator/trait_checking.yo` (lines 14, 221, 227, 230, 238,
250, 466, 473, 1062, 1065, 1071), `evaluator/calls/trait_type.yo:14`.

**What's stubbed:**

- `findAssociatedTypeFromGenericImpls` — returns `Option.None`. Used by
  associated-type-equality constraint checking.
- Generic-impl-registry walks for associated-type constraints.
- `typeImplementsTraitBool` — conservative fallback (returns true when in
  doubt; can pick an over-broad impl).

Already in place (commit `efd79680`): a real `HashMap`-backed
`currentlyRegisteringConcreteImpls` registry for the
`isConcreteImplBeingRegistered` / `mark/unmark…` pair.

**Symptom:** Where-clause constraints on generic impls aren't fully
verified; blanket impls that depend on associated-type lookup compile but
can produce wrong specializations. Mostly affects advanced trait code
(e.g. `Iterator` chains with `Map`/`Filter`).

**Fix sketch:** Port `findAssociatedTypeFromGenericImpls` from
`src/evaluator/trait-checking.ts` (~80 lines of registry walk + type
substitution). Once the generic-impl registry is fully populated by
`evaluator/values/impl.yo`, the trait_checking walks become straightforward.

---

### §C. Per-module sub-evaluation (true `ctx.load_module`)

**Where:** `yo-self/main.yo::check_single_file`,
`yo-self/evaluator/exprs/import.yo`.

**What's missing:** yo-self flattens every transitively-imported module's
exprs into one list evaluated in a shared env. For runtime
`import("path")` it currently returns a synthetic `ModuleVal` built from
the current env (so destructuring works), but there is no per-module
scope: any binding declared in `./a.yo` is visible to `./b.yo` even if
`b.yo` never imported `a.yo`.

**TS reference:** `src/module-manager.ts::loadModule` (each module gets its
own `Evaluator` instance, caches `(path → ModuleValue)`, supports circular
imports via a `loadingModules` partial-population set).

**Symptom:** Tests that rely on module privacy or on circular-import
partial population will not behave like TS. Imports of `std/...` paths
also currently fail at evaluator time with "Module not found / dependency
name resolution not yet implemented" — that's the dependency-resolution
half, separate but adjacent.

**Fix sketch (longer-term):** Replace the flatten in `check_single_file`
with a per-module loop that evaluates each module's exprs in its own
sub-env, captures exports as a `ModuleVal`, and caches by absolute path.
Then register `ctx.load_module` to look up from that cache (and the
synthetic env-based fallback can be removed). Track circular imports the
way TS does.

---

### §D. RC function-signature derivation

**Where:** `evaluator/types/struct.yo:87-88`, `evaluator/types/enum.yo:207`,
`evaluator/types/record.yo:259`, `evaluator/values/anonymous_struct.yo:188`,
`evaluator/types/tuple.yo:160`.

**What's stubbed:**

- `addRcFunctionSignaturesToStructType` / `EnumType` / `TupleType`.
- `beginSendDerivation` / `endSendDerivation`.
- `autoDeriveTraitsAndAddRcFunctionsForStructType`.

**Symptom:** Auto-derived `___drop` / `___dup` / `__yo_decr_rc` function
signatures aren't pre-registered on the type, so codegen has to re-derive
at the use site. **Doesn't block evaluation.** Codegen may emit slightly
different C than the TS reference; the bootstrap test suite hasn't
surfaced a failure from this yet.

**Fix sketch:** Port the four functions from `src/evaluator/types/*.ts`.
Mostly mechanical — they generate `Func` TypeValues from a struct's RC
shape and register them on the type's id.

---

### §E. GADT enum support

**Where:** `evaluator/types/enum.yo:234`.

**What's stubbed:** Variants of form `Variant -> recur(T)` (refining the
enum's type param per variant) throw `GADT enum not yet implemented in
self-hosted compiler`.

**Symptom:** `./tests/gadts.test.yo` fails on yo-self-bin (clean error,
not a crash). All non-GADT enum patterns work.

**Fix sketch:** Port the GADT path from `src/evaluator/types/enum.ts`.
Independent of other gaps; estimate small-medium.

---

### §F. Closure ownership / move semantics

**Where:** `evaluator/utils/closure.yo:71, 104, 351`.

**What's stubbed:**

- `attachClosureMoveSemantics` is a no-op (env returned unchanged).
- ARC capture tracking always returns `Option.None`.

**Symptom:** Closures compile and run, but consumed-capture analysis is
lossy. Doesn't crash, but may cause RC double-drop or use-after-free in
heavy closure-passing tests. The bootstrap closure test suite passes
today, so it isn't currently blocking.

---

### §G. Build / asm / partial assignment stubs

**Where:**

- `evaluator/builtins/build.yo:527` — `evaluate_yo_build_functions` Phase-3 stub.
- `evaluator/builtins/asm.yo:3` — inline asm evaluator stub.
- `evaluator/exprs/assignment.yo:10-19` — several assignment-form Phase-3 stubs.
- `evaluator/exprs/recur.yo:184` — `UnknownVal.variable_name` / `is_runtime_only` flags not yet plumbed.

**Symptom:** Affects build-script evaluation (`std/build.yo`-based
projects), inline asm tests, and a handful of edge-case assignment shapes.
Not blocking general program compilation.

---

### §H. Operator-trait ModuleT/Call dispatch (`(-)`, `(+)`, etc.)

**Where:** `yo-self/evaluator/calls/function.yo` (top-of-function prefold),
`yo-self/evaluator/calls/helper.yo:1905-1932` (soft fallback).

**What's missing:** Prelude declares operator overloads as
`(op) :: impl({ Call :: (overload1, overload2); })` (e.g. lines 515, 6496
for `-` and `?*`). yo-self doesn't yet implement the ModuleT/Call overload
dispatch path that picks the right overload based on the arg's
comptime/runtime status. Currently:

- `-(IntLit)` is special-cased (constant-folded at the top of
  `evaluate_function_call`, see §5f in the closed log). Works for the
  common prelude shape (`enum discriminant = -(1)`).
- All other operator-on-module-callee shapes fall into the soft fallback
  in `helper.yo:1916` and return `t_unit()` / Unknown.

**Fix sketch:** Implement proper Call-member overload resolution in
`try_to_implement_module_with_arguments_by_module_type`
(`evaluator/calls/record_type.yo`). For each declared `Call` overload,
match argument arity + comptime-ness, dispatch to the best match. Replace
the §5f literal-arg prefold with the real dispatch once it works.

**Symptom today:** Anything more elaborate than `-(literalInt)` for the
prelude's `(-)` and similar ops will yield `UnknownVal`.

---

### §I. Stack overflow on default macOS 8 MB stack (workaround only)

Tracked separately in
[`yo-self-evaluator-stack-overflow.md`](./yo-self-evaluator-stack-overflow.md).
Workaround: `ulimit -s 65520`. Real fix is one of: explicit `setrlimit` in
the binary's `main`, boxed parameter passing for hot recursive sites, or
an iterative eval driver instead of native recursion. Not blocking
present work since the workaround is one line.

---

## Closed gaps log (chronological, oldest first)

Each entry is an audit trail for a fix that landed during the port. Entries
are append-only — do **not** edit them when re-opening a gap; add a new
entry instead.

### a872d884 — Prelude auto-loading wired

`run_check` now calls `collect_module_deps("prelude.yo", …)` before
walking the input file's imports, so prelude declarations are part of
`all_exprs`. `ctx.std_path` is set so the modular `import("std/...")`
handler can resolve paths during evaluation itself. (Still doesn't apply
to `run_compile`; `@skip_prelude` per-file detection not wired.)

### c8bd5b40 — Array length accepts UnknownVal placeholder (§5b)

`evaluator/types/array.yo` used to throw `Expected integer literal for
array length` on any non-IntLit; now accepts `UnknownVal` and stores
`usize(0)` placeholder. Proper TS-equivalent `length : EvalValue`
representation deferred (would require TypeValue ↔ EvalValue mutual
recursion through `types/definitions.yo`).

### 3f69d633 — Trait-constructor field expected_type (§5c)

`evaluate_module_value` blanked out `ctx.expected_type` before evaluating
each impl-field's value, breaking anonymous lambdas in
`impl(T, Trait(method : (self) -> body))`. The trait-constructor path now
looks up the trait (`_try_lookup_trait_type`) and sets `ctx.expected_type`
from the matching field's type. Works for atom trait names; falls back to
`.None` for parametric trait shapes — those go through §5d.

### a4a83611 — Anonymous function default Func when no expected_type (§5d)

`evaluate_anonymous_function_implementation` used to throw on `.None`
expected_type; now synthesizes a default `Func` TypeValue with fresh
`SomeT` params and return so the body can typecheck against a polymorphic
shape.

### 46668ef3, b48ec4d8 — Soft-fallback chain (§5e)

Non-Func callee in `try_to_call_function_with_arguments` returns
placeholder result; missing identifier (operator-trait names like `==`,
`<`) returns `UnknownVal(unit)`; `cond` accepts unit-typed conditions;
array-length checks soft-fall-back to `usize(0)`; numeric-bounds check
silently drops out-of-range results.

### 65f3b99a — comptime_string → str coercion at default-value sites

`evaluate_function_parameter` now coerces `comptime_string` literals to
`str` at default-value sites, mirroring TS behaviour for shapes like
`assert :: (fn(flag : bool, (msg : str) ?= "Assertion failed.") -> unit)`.

### 0a5f806c, aaa57d7c, 440489ca, 05024179, a13585d5 — `evaluate_expression_raw` propagation

Switched ~10 eval sites (Fn-trait return, default-value expr,
array/record/enum/field/comptime_list type-eval sub-calls, \_get_expr_type,
\_eval_and_update_env, trait constraint eval, begin-body / return / escape)
from the panic-wrapper `evaluate_expression` to the throw-propagating
`evaluate_expression_raw`. Fixes a class of "fake SIGSEGV" crashes where
the panic wrapper corrupted memory before a downstream throw could
unwind.

### d78e5e14 — `SomeT.kindFunctionType` field added (§5a, partial)

Added `kind_function_type : Option(Box(Self))` as the 10th field of
`SomeT`. Wired through all `~104` SomeT constructor / pattern sites.
**Not yet read** by `evaluate_function_parameter` or TypeApplication —
that's the remaining §A work above.

### 8bf8a1ad — `-(IntLit)` prefold (§5f)

`evaluate_function_call` checks at entry: when callee is the atom `-` and
the single arg is an `Integer` token, produce
`IntLit("-${raw}")` with `ComptimeInt` directly. Unblocks prelude's
`FutureState.Completed = -(1)` discriminant. (Replace with real
operator-trait dispatch when §H is done.)

### f14d5bfa — Stack-overflow diagnosis + workaround docs (§5g, §I)

lldb backtrace at "iter 924" pinpointed `__yo_dispose_dispatch` prologue
crashing with `sp` past an unmapped page — stack overflow, not a memory
bug. `ulimit -s 65520` documented in `yo-self/README.md` and
`issues/yo-self-evaluator-stack-overflow.md`.

### efec44dc — UnknownVal-tolerant struct/enum construction (§5h)

Struct and enum-variant construction branches in `evaluator/calls/function.yo`
used to abort comptime construction on any `UnknownVal` field; TS only
aborts on `isRuntimeOnly: true`. Relaxed to match TS default. Unblocks
`__yo_builtin_io :: IO(async : __yo_io_async, …)` at `std/prelude.yo:8196`.

### a63ecce0 — `TypeVal(SomeT)` for extern/c_include Type-typed fields (§5i)

Added `create_unknown_val_with_name(ty, name)` in `yo-self/value.yo`:
when `is_type_0(ty)`, return `TypeVal(t_some_t(name, 0))` instead of
`UnknownVal(Type)`. Used by `evaluator/exprs/c_include.yo` and `extern.yo`
so later fields can refer to the label as a real type
(`INT_LEAST8_MIN : int_least8_t` after `int_least8_t : Type`).

### 58d87708 — env-synthesised ModuleVal for transitive imports (§5j)

`evaluator/exprs/import.yo`: when `ctx.load_module` is `.None` (the
flatten-eval path), synthesise a transparent `ModuleVal(names, values)`
from the current env's frames and stamp the import expr with the matching
`ModuleT` type. Both the real-loader path and the new fallback now type
the result via `type_of_eval_value(mod_val)` instead of a stale `t_unit()`,
fixing destructuring `{ X, Y } :: import("…")`. (Proper per-module
isolation is the §C work above.)

### a200b773 — capture caller env in top-level FuncVals (§5k)

`try_to_implement_function_by_function_type` was building FuncVals for
top-level `::`-defined functions with empty
`cap_names`/`cap_tys`/`cap_vals`, on the wrong premise that "regular
functions do not capture". Top-level bodies need to resolve OTHER
top-level identifiers at call time, since `evaluate_function_call`'s
FuncVal dispatch builds a `fresh_env` containing only captures + params
with no module-level fallback. Now mirrors the capture loop in
`evaluator/values/anonymous_function.yo`. Unblocks `Result(?*(T), AllocError)`
in trait declarations and any fn whose body calls another fn.

---

## Related issue files

- [`yo-self-evaluator-stack-overflow.md`](./yo-self-evaluator-stack-overflow.md) — `ulimit` workaround + lldb backtrace.
- [`yo-self-impl-fn-parametric-return-sigsegv.md`](./yo-self-impl-fn-parametric-return-sigsegv.md) — original "iter 924 SIGSEGV" diagnosis; misdiagnosis chain resolved.
- [`yo-self-typevalue-variants-too-narrow-for-stub-ports.md`](./yo-self-typevalue-variants-too-narrow-for-stub-ports.md) — TypeValue shape mismatches with TS.
- [`yo-self-where-clause-trait-eval-segfault.md`](./yo-self-where-clause-trait-eval-segfault.md) — one specific where-clause crash (fixed shape).
- [`yo-self-nested-typeapp-in-impl-return-segfault.md`](./yo-self-nested-typeapp-in-impl-return-segfault.md) — nested TypeApplication crash class.
- [`yo-self-evaluator-enum-memory-leak.md`](./yo-self-evaluator-enum-memory-leak.md) — RC leak observed in evaluator.
- [`yo-self-codegen-typeid-needs-typed-ast.md`](./yo-self-codegen-typeid-needs-typed-ast.md), [`yo-self-codegen-parallelism-needs-closure-metadata.md`](./yo-self-codegen-parallelism-needs-closure-metadata.md), [`yo-self-bin-rebuild-segfaults-after-may14-src-codegen-changes.md`](./yo-self-bin-rebuild-segfaults-after-may14-src-codegen-changes.md) — codegen-side issues (separate from this evaluator port).

---

## Priority summary

For "yo-self-bin can compile real tests" the rough order is:

1. **§A HKT `kindFunctionType` wiring** — unblocks Functor/Monad/Iterator.
2. **§B Trait-checking Phase-3 stubs** — needed for blanket-impl and Iterator-style code.
3. **§C Per-module sub-evaluation** — needed for non-trivial multi-file projects and module privacy.
4. **§H Operator-trait ModuleT/Call dispatch** — removes the literal-arg prefold hack and enables full operator overloading.
5. **§D RC-derivation** — improves codegen fidelity; not blocking semantics.
6. **§E GADT** — only `gadts.test.yo`.
7. **§F Closure ownership** — only matters for ownership-heavy tests.
8. **§G Build/asm/assignment stubs** — niche.

§I (stack overflow) has a one-line workaround and can be revisited any time.
