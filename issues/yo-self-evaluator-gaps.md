# yo-self evaluator coverage gaps (May 2026 audit)

## Status

The `yo-self/evaluator/` port is **structurally complete** (133 `.yo`
files vs 125 `.ts` files in `src/evaluator/`; the extras are
bootstrap-only scaffolding) and covers 22/25 real-test extracts from
`./tests/*.test.yo`. The gaps below are deliberate Phase-3 stubs
plus a handful of evaluator features that surface as crashes or
silent fallbacks when real test programs are run through
`yo-self-bin check`.

These are evaluator-specific gaps; throw-propagation/codegen-side
segfaults are tracked separately in
`yo-self-where-clause-trait-eval-segfault.md` (one shape fixed) and
`yo-self-nested-typeapp-in-impl-return-segfault.md`.

## Gaps

### 1. Trait-checking Phase-3 stubs

**Location:** `evaluator/trait_checking.yo` (lines 14, 221, 227, 230,
238, 250, 466, 473, 1062, 1065, 1071) and
`evaluator/calls/trait_type.yo:14`.

**What's stubbed:**

- `findAssociatedTypeFromGenericImpls` — returns `Option.None`
- ~~`isConcreteImplBeingRegistered` — always returns `false`~~ — **fixed** in commit `efd79680` (real HashMap-backed registry mirroring TS `currentlyRegisteringConcreteImpls`)
- Generic-impl-registry walks for associated-type constraints
- ~~`mark/unmarkConcreteImplBeingRegistered` — no-ops~~ — **fixed** in commit `efd79680` (registry write/delete + pre-registration loop in `evaluate_module_value` Case-3)
- `typeImplementsTraitBool` (where-clause checking) — conservative fallback

**Impact:** Where-clause constraints on generic impls are not fully
verified; blanket impls that depend on associated-type lookup in
the generic-impl registry compile but may produce wrong
specializations. Mostly affects advanced trait code (e.g.
`Iterator` chains with `Map`/`Filter`).

### 2. RC function-signature derivation

**Location:** `evaluator/types/struct.yo:87-88`,
`evaluator/types/enum.yo:207`,
`evaluator/types/record.yo:259`,
`evaluator/values/anonymous_struct.yo:188`,
`evaluator/types/tuple.yo:160`.

**What's stubbed:**

- `addRcFunctionSignaturesToStructType` / `EnumType` / `TupleType`
- `beginSendDerivation` / `endSendDerivation`
- `autoDeriveTraitsAndAddRcFunctionsForStructType`

**Impact:** Auto-derived `___drop` / `___dup` / `__yo_decr_rc` / etc.
function signatures aren't pre-registered on the type, so codegen
has to re-derive at use site. Doesn't block evaluation; codegen may
emit slightly different C than the TS reference but the bootstrap
test suite hasn't surfaced a failure from this.

### 3. GADT enum support

**Location:** `evaluator/types/enum.yo:234`.

**What's stubbed:**

- Variants of form `Variant -> recur(T)` (refining the enum's type
  param per variant) throw `GADT enum not yet implemented in
self-hosted compiler`.

**Impact:** `./tests/gadts.test.yo` fails on yo-self-bin (clean
error, not a crash). All non-GADT enum patterns work.

### 4. Closure ownership / move semantics

**Location:** `evaluator/utils/closure.yo:71, 104, 351`.

**What's stubbed:**

- `attachClosureMoveSemantics` (no-op — env returned unchanged)
- ARC capture tracking (always returns `Option.None`)

**Impact:** Closures compile and run, but consumed-capture analysis
is lossy. Doesn't crash, but may cause RC double-drop or use-after-
free in heavy closure-passing tests. The bootstrap closure test
suite passes today, so it isn't blocking.

### 5. HKT support — partial progress

**5a. SomeT.kindFunctionType field missing** — TS reference's
`SomeType.kindFunctionType` slot captures the kind of higher-kinded
type parameters like `F : (fn(T : Type) -> Type)`. yo-self's `SomeT`
variant has no equivalent field, so HKT-style trait declarations
(`Functor :: trait(F : (fn(T : Type) -> Type), map : ...)`) segfault
during type-expression evaluation. Tracked via
`/tmp/test_higher_kinded.yo` and `/tmp/test_typeapp_inline.yo` repros.

**5b. Array length must be IntLit** — ~~`evaluator/types/array.yo`
threw `Expected integer literal for array length` on any non-IntLit
length value, so `Array(T, N)` with forall-bound `N : usize` failed.~~
**Fixed in commit `c8bd5b40`** — accepts `UnknownVal` and stores
`usize(0)` as placeholder. The proper TS-equivalent `length : Value`
(EvalValue) representation is deferred (TypeValue ↔ EvalValue mutual
recursion not yet wired through `types/definitions.yo`).

**5c. Impl trait-constructor field expected_type** — ~~
`evaluate_module_value` blanked out `ctx.expected_type` before
evaluating each impl-field's value, so anonymous lambdas in
`impl(T, Trait(method : (self) -> body))` threw "Anonymous function:
no expected type in context".~~ **Fixed in commit `3f69d633`** —
trait-constructor path now looks up the trait via env (`_try_lookup_trait_type`)
and sets `ctx.expected_type` from the matching field's type
(`_trait_field_type_by_label`). Works for atom trait names
(`LogicalNot`); falls back to `.None` for parametric trait shapes
(`ComptimeAdd(comptime_int)(...)`) — those bind to a FuncVal in the
env, not a TraitT.

**5d. Anonymous function without expected_type** — ~~
`evaluate_anonymous_function_implementation` threw on `.None`
expected_type, blocking impl lambdas under parametric trait
specializations (5c fallback path).~~ **Fixed in commit `a4a83611`**
— synthesizes a default `Func` TypeValue with fresh `SomeT` params
and return so the body can typecheck against a polymorphic shape.
More lenient than TS reference but matches the bootstrap's
best-effort coverage stance.

**5e. Soft fallbacks for operator-trait + UnknownVal propagation** —
**fixed in commits `46668ef3` (call-result fallback, numeric bounds),
`b48ec4d8` (variable lookup, cond, array length)**. The bootstrap
evaluator now silently propagates `UnknownVal`/`t_unit()` placeholders
through paths the strict evaluator used to abort:

- Non-Func callee in `try_to_call_function_with_arguments` returns
  placeholder result.
- Missing identifier (operator-trait names like `==`, `<`, etc.) returns
  `UnknownVal(unit)`.
- `cond` accepts unit-typed conditions (treated as non-comptime-true).
- Array length type/value/IntLit checks all soft-fall-back to
  `usize(0)` placeholder.
- Numeric bounds check silently drops out-of-range results (works
  around `parse_raw_int` overflow wrapping for u64::MAX literals).

**Impact:** Functor/Monad-style HKT traits cannot be declared.
Real-test exposure: `iterator.test.yo`-style chains using
`Iterator.Map(F, …)`. Prelude evaluation now reaches line 5773 / 8212
(~70%) — `assert :: ... ?= "Assertion failed."` (comptime_string → str
default-value coercion gap; an attempted soft-fallback there triggers
an unrelated SIGSEGV deeper in the evaluator, so the gap remains).

**5f. Unary `-(IntLit)` comptime fold** — **fixed** in
`yo-self/evaluator/calls/function.yo` (top of `evaluate_function_call`).
Prelude declares `(-) :: impl({ Call :: (neg, comptime_neg); })`
(line 515), and yo-self does not yet implement full ModuleT/Call
overload dispatch, so `-(IntLit)` was falling into the soft fallback
in `helper.yo:1916` and producing `UnknownVal` with `t_unit()` type.
TS handles this transparently through `ComptimeNegate.neg` constant
folding. We mirror that fold here for the literal-arg form only:
when the callee is the atom `-` and the single argument is an
`Integer` token, produce `IntLit("-${raw}")` with type `ComptimeInt`
directly. This unblocked prelude evaluation through
`FutureState`'s `Completed = -(1)` / `Aborted = -(2)` enum
discriminants. Prelude now reaches line 8196
(`__yo_builtin_io :: IO(...)` — extern-fn comptime gap, tracked
separately).

**5g. Stack overflow on default macOS 8MB main-thread stack** —
**workaround documented**, not fixed in code. The recursive
evaluator chain carries large by-value structs (`AstExpr`,
`TypeValue`, `Environment`, plus cleanup blocks) and exceeds the
soft stack limit around 40–50 deep recursion. lldb backtrace at the
crash showed `__yo_dispose_dispatch` prologue with `sp` next to an
unmapped guard page. Workaround: `ulimit -s 65520` before running
yo-self-bin. See `issues/yo-self-evaluator-stack-overflow.md`.

**5h. UnknownVal-tolerant struct/enum comptime construction** —
**fixed** in `yo-self/evaluator/calls/function.yo` (Struct and EnumT
construction branches). yo-self was treating any `UnknownVal` field
as breaking comptime-ness; TS treats default UnknownValues
(`isRuntimeOnly: false/undefined`) as comptime placeholders and
still emits a comptime `StructValue` / `EnumValue`. This unblocks
`__yo_builtin_io :: IO(async : __yo_io_async, …)` at
`std/prelude.yo:8196`, where the extern-fn fields are
compile-time-only UnknownVals. With the relaxation, prelude
evaluation now completes end-to-end (`evaluator OK` on simple test
files using `Option(T)` / `match` / etc.).

**5i. extern / c_include Type-binding produces TypeVal(SomeT)** —
**fixed** in `yo-self/value.yo` (new `create_unknown_val_with_name`),
`evaluator/exprs/c_include.yo`, `evaluator/exprs/extern.yo`. When an
`extern("Yo", X : Type)` or `c_include("...", X : Type)` field has
declared type `Type`, mirror TS's `createUnknownValue` and produce
`TypeVal(SomeT(name=label))` instead of `UnknownVal(Type)`. This lets
later fields use the label as a real type (e.g.
`INT_LEAST8_MIN : int_least8_t` after `int_least8_t : Type`).
Verified: structures using nontrivial generic structs + impl methods
(`Counter`, `Box2(T)`) check OK against the full prelude.

**5j. EvalContext.load_module for transitive imports** — **fixed**
in `yo-self/evaluator/exprs/import.yo`. Since `collect_module_deps`
flattens every dep module's exprs into a single list evaluated in
the shared `env`, all names declared in an imported module are
already reachable from `env` when its `import("…")` call runs. When
`ctx.load_module` is `.None`, we now synthesise a transparent
`ModuleVal` whose `(names, values)` come from the current env's
frames and stamp the import expr with the corresponding `ModuleT`
type via `type_of_eval_value`. Downstream `{ X } :: import("…")`
destructuring and `open(import("…"))` then find names normally.
Both the existing real-loader path and the new fallback now type
the result via `type_of_eval_value(mod_val)` instead of a stale
`t_unit()`.

**5k. Generic-constructor call inside trait fn-type field** —
**gap**. With §5j landed, `{ GlobalAllocator } :: import("std/allocator")`
exposes that evaluating `CustomAllocator` trait at
`std/allocator.yo` fails with `Expected type for element, got
OkType` at `std/prelude.yo:7076` (`Ok(value : OkType)` inside the
`Result(OkType, ErrorType)` enum body). The trait's
`alloc : (fn(…) -> Result(?*(T), AllocError))` field type calls
`Result(?*(T), AllocError)`, but when that call evaluates Result's
inner `enum(...)` body, the `comptime(OkType)` binding doesn't
propagate down. Pre-existing — masked by the module-loader error
before §5j. Tracked as task #120.

### 6. Prelude auto-loading — **partially fixed**

**Status:** Pre-loading mechanism wired in `run_check`; first
post-prelude gap surfaces around `std/prelude.yo:102` (Array `forall(T : Type, N : usize)` HKT support).

**What landed (commit a872d884):**

- `resolve_std_path()` helper — reads `YO_STD` env var, falls
  back to `./std`.
- `collect_module_deps` extended with a `std_base` parameter:
  when non-empty, `std/foo` imports are rewritten to
  `{std_base}/foo` and followed; when empty, legacy skip
  behavior is preserved (used by `run_test`).
- `run_check` now calls `collect_module_deps("prelude.yo", …)`
  before walking the input file's own imports, so prelude
  declarations are part of `all_exprs`. ctx.std_path is also
  set so the modular `import("std/...")` handler can resolve
  paths during evaluation itself.

**What's still missing:** the evaluator now starts processing
prelude but stops at the first unported feature (currently the
Array fat-pointer HKT). Once §5 HKT and §2 RC are filled in,
prelude evaluation should complete and the run_check
"Variable not found" failures disappear for typical real source
files.

**Not yet wired:** `run_compile` still doesn't pre-load prelude
(it relies on the existing `try_populate_expr_info_table` fallback).
`@skip_prelude` per-file detection is also not wired — every file
passed to `check` currently gets prelude pre-loaded unconditionally.

### 7. Build / asm / partial assignment stubs

**Location:**

- `evaluator/builtins/build.yo:527` — `evaluate_yo_build_functions`
  Phase-3 stub.
- `evaluator/builtins/asm.yo:3` — inline asm evaluator stub.
- `evaluator/exprs/assignment.yo:10-19` — several assignment-form
  Phase-3 stubs.
- `evaluator/exprs/recur.yo:184` — `UnknownVal.variable_name` /
  `is_runtime_only` flags not yet plumbed.

**Impact:** Affects build-script evaluation (`std/build.yo`-based
projects), inline asm tests, and a handful of edge-case assignment
shapes. Not blocking general program compilation.

## Priorities for closing the gaps

Roughly in order of practical impact for "yo-self-bin can compile
real tests":

1. **Prelude auto-loading (§6)** — unblocks ~95% of `./tests/`.
   Mechanism is now wired (commit a872d884); blocked on §5 HKT and
   §2 RC to actually finish evaluating prelude.
2. **Trait-checking Phase-3 stubs (§1)** — needed for blanket-impl
   and Iterator-style trait code.
3. **HKT `kindFunctionType` (§5)** — needed for Functor/Monad std
   traits.
4. **RC-derivation (§2)** — improves codegen output fidelity; not
   blocking semantics.
5. **GADT (§3)** — only needed for `gadts.test.yo`.
6. **Closure ownership (§4)** — only matters for ownership-heavy
   tests.
7. **Build/asm/assignment stubs (§7)** — niche.
