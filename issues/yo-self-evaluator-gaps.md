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
- `isConcreteImplBeingRegistered` — always returns `false`
- Generic-impl-registry walks for associated-type constraints
- `mark/unmarkConcreteImplBeingRegistered` — no-ops
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

### 5. HKT support — `SomeT.kindFunctionType` field missing

**Location:** `evaluator/types/...` (SomeT shape in
`types/definitions.yo`).

**What's missing:** TS reference's `SomeType.kindFunctionType` slot
that captures the kind of higher-kinded type parameters like
`F : (fn(T : Type) -> Type)`. yo-self's `SomeT` variant has no
equivalent field, so HKT-style trait declarations
(`Functor :: trait(F : (fn(T : Type) -> Type), map : ...)`)
segfault during type-expression evaluation.

**Impact:** Functor/Monad-style HKT traits cannot be declared.
Tracked via `/tmp/test_higher_kinded.yo` and
`/tmp/test_typeapp_inline.yo` repros (both segfault). Real-test
exposure: `iterator.test.yo`-style chains that use
`Iterator.Map(F, …)` patterns.

### 6. Prelude auto-loading

**Location:** `yo-self/main.yo:run_check` (and elsewhere where
`std_path : String.from("")` is passed to `eval_context_new`).

**What's missing:** The bootstrap evaluator doesn't auto-load
`std/prelude.yo`. As a result, references to prelude-defined
identifiers in any context that the evaluator can't satisfy
inline (`Box`, `Option`, `Result`, `str`, primitive operators
`+ - * / & |` etc.) fail with `Variable "X" not found`.

**Impact:** This is THE biggest practical blocker. Most real
`./tests/*.test.yo` files exercise prelude types and operators, so
they can't be `check`-ed end-to-end without local re-definitions.
TS reference auto-loads prelude in `evaluator/index.ts:138-180`.

**Suggested fix path:** In `run_check` (and the compile pipeline),
look up `std_path` via env var (`YO_STD`) or relative to the
bootstrap binary's location, then load `std/prelude.yo` once at
evaluator init and inject its exports into the root env.

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
