# A payload-free `ref(enum)` variant constructed inline leaks (FIXED 2026-08-05)

**Found** from CI run 30999170651, job `Compiler internal tests`, where LeakSanitizer
failed `tests/internal/context.test.yo`:

```
Direct leak of 96 byte(s) in 1 object(s) allocated from:
    #1 __yo_new___yo_enum_yoc91e9aa9_id_28_UnitVal .yo_test_batch_….c
    #2 __yo_user_main
SUMMARY: AddressSanitizer: 96 byte(s) leaked in 1 allocation(s).
```

The leaking line is `tests/internal/context.test.yo:189` — `EvalValue.UnitVal` passed
inline as an argument:

```rust
body_ctx := create_function_body_evaluation_context(func_type, EvalValue.UnitVal, env, ctx);
```

`EvalValue` is `ref(enum(…))` and `UnitVal` is one of its payload-free variants.

## Minimal reproducer

```rust
{ assert } :: import("std/assert");
MyVal  :: ref(enum(UnitVal, IntVal(v : i32)));
Holder :: struct(v : MyVal);
make   :: (fn(x : MyVal) -> Holder)(Holder(v : x));
main   :: (fn() -> unit)({
  h := make(MyVal.UnitVal);
  h;
  assert(true, "built");
});
export(main);
```

`leaks --atExit` after `yo-cli compile … --release --sanitize address --allocator libc`:
**1 leak for 32 total leaked bytes.** Replacing `MyVal.UnitVal` with the
payload-carrying `MyVal.IntVal(v : i32(7))`, or binding it to a local first, is clean.

## Root cause

A payload-free variant of a reference-semantics enum **heap-allocates** exactly like the
payload-carrying form. `generateComptimeValue` emits
`__yo_new_<cName>_<Variant>()` when `enumType.isReferenceSemantics === true`
(`src/codegen/exprs/comptime-value.ts:149-154`), and that constructor mallocs with
`header.ref_count = 1`.

But the evaluator folded the expression to a comptime `EnumValue` and **never called
`attachTempVariableToExpr`** — `src/evaluator/exprs/property-access.ts:226-239` (the
expected-type form `.UnitVal`) and `:516-527` (the `Type.Variant` form). The
payload-carrying form is a function _call_, so it gets its owning temp from the call
path (`src/evaluator/calls/function.ts:2555`).

Drops are synthesised **exclusively** from environment `Variable`s —
`getVariablesNeedingDrop` (`src/env.ts:2272-2306`) filters on
`isOwningTheRcValue && typeContainsRcType && !consumedAtToken`. No Variable ⇒ no drop,
ever. Everything downstream is `variableName`-gated too: the caller-side argument hoist
(`src/codegen/exprs/other-fn-call.ts:508`) and `setExprAsNeedsToCallDup`
(`src/expr.ts:2459-2461`, which returns immediately when there is no `variableName`).

So nobody owned the constructor's +1:

```c
// caller (pre-fix)
Holder _temp = fn_make((MyVal*)(__yo_new___yo_enum_…_UnitVal()));  // rc 1, unowned
…
fn_…___drop((Holder)(h));                                          // rc 2 -> 1
// callee — correct, unchanged
MyVal* _t = fn_…___dup((MyVal*)(x));   // borrowed param, dup-to-store: rc 1 -> 2
```

The callee is right to dup: a plain `x : MyVal` parameter is **borrowed**
(`src/evaluator/calls/helper.ts:411` only moves ownership for `own(…)` params), so the
caller keeps ownership of whatever it materialised. The fix supplies the caller's
missing release; it does not touch the callee's acquire.

Same defect class and same fix template as
`issues/fixed/recur-call-result-not-hoisted-as-arg.md`.

## The fix

Two parts, because the evaluator half alone is inert.

**1. `src/evaluator/exprs/property-access.ts`** — new `attachOwnedTempForRcUnitVariant`,
called from both payload-free branches. It attaches an owning temp only when the enum is
reference-semantics AND at least one variant carries fields.

The second conjunct matters. Gating on `typeContainsRcType(expr.$.type)` — the obvious
first attempt — is **too broad**: that predicate recurses into variant fields, so it is
also true for a _value_ enum whose other variants carry RC payloads. `Option(String).None`
then acquired a temp and a `___drop` even though it renders as a zero-allocation
`{ .tag = … }` compound literal. Measured consequences of the broad gate:

- pure overhead on the most pervasive expression shape in `std`;
- `check ./yo-self` fell from **238/238 to 71/238**, starting with
  `yo-self/types/definitions.yo:100`, `(origin_id : Option(String)) ?= Option(String).None`
  → _"Variable `_yo…_temp_62159` was not consumed."_

The "some variant has fields" conjunct mirrors `canOptimizeAsSimpleEnum`
(`src/codegen/utils/index.ts:961`): an all-payload-free enum collapses to a plain C enum
constant and also allocates nothing.

**2. `src/codegen/exprs/generation.ts`** — new `materializeOwnedRcComptimeValue`, applied
at the `$.value`-first shortcut. The comptime path returned a bare expression string and
never emitted a declaration, so an evaluator-registered temp would have been skipped by
the drop emitters' `declaredCVarNames` gate and the fix would have been a silent no-op.
The helper declares the temp and returns its name.

It is itself gated on the new predicate `comptimeValueAllocatesRcObject`
(`src/codegen/exprs/comptime-value.ts`). `attachTempVariableToExpr(…, true)` has ~20
producers and deliberately keeps `expr.$.value` intact while blanking only the
_Variable_'s value (`src/expr.ts:1781-1782`), so a CTFE-folded RC value can reach the
helper with a **non-allocating** rendering — e.g. a folded `String` goes through the
newtype cast path. Declaring and dropping that would `___drop` memory that was never
allocated. The predicate is true only for the two shapes `generateComptimeValue`
actually mallocs for: a ref-enum variant, and a ref-struct / `object` value.

`storeTempVarToStateMachineIfNeeded` in `src/codegen/exprs/other-fn-call.ts` became
`export` so the new helper can call it, matching every other temp-declaring site.

`yo-self/` carries the strict 1-to-1 port: `_attach_owned_temp_for_rc_unit_variant` in
`yo-self/evaluator/exprs/property_access.yo`,
`_materialize_owned_rc_comptime_value` in `yo-self/codegen/exprs/generation.yo`, and
`comptime_value_allocates_rc_object` in `yo-self/codegen/exprs/comptime_value.yo`.

## Post-fix C

```c
MyVal* _temp_40669 = __yo_new___yo_enum_…_UnitVal();       // rc 1, temp OWNS
Holder _temp_40670 = fn_make((MyVal*)(_temp_40669));        // callee dup -> rc 2
Holder h = _temp_40670;
…
fn_…_id_44___drop((Holder)(h));                             // rc 2 -> 1
fn_…_id_21___drop((MyVal*)(_temp_40669));                   // rc 1 -> 0, freed
```

Early-return paths come for free: `generatePendingDeferredDrops` picks the temp up
because it is a real env Variable, so the drop also appears inside each
`if (__yo_effect_escaped) { … }` block.

`a := MyVal.UnitVal` does **not** double-drop: the binding marks the temp
`consumedAtToken` (`src/expr.ts:2467-2495`), which removes it from
`getVariablesNeedingDrop`, so only `a` is released.

## Regression tests

`tests/rc.test.yo`, two tests.

The deterministic gate is `rc()`, not a sanitizer. The argument temp is released at the
producing helper's scope end, so a caller that reads the retained field afterwards sees
`rc == 1` when the release happened and `rc == 2` when it leaked:

```rust
mk_unit :: (fn() -> Held)({
  h := keep(Val.UnitVal);
  h
});
u := mk_unit();
assert(rc(u.v) == 1, "payload-free variant: the caller must release its argument temp");
```

The explicit `{ … }` body is deliberate. Written as a bare tail expression the
self-hosted compiler emits no scope-end drop for the argument temp at all, so both arms
report rc == 2 under it — a separate pre-existing divergence that also reproduces on the
payload-carrying form this fix never touched
(`issues/yo-self-tail-expression-arg-temp-drop-missing.md`). The block body keeps the
test gating THIS bug on both compilers.

Measured: **pre-fix `got 2` → SIGABRT; post-fix passes.** This works on every platform,
which matters because neither sanitizer does:

- LeakSanitizer is Linux-only (macOS has no LSan);
- macOS `leaks` at `-O2` misses the _discarded_ positions entirely — LLVM deletes an
  allocation whose result is never read, so `MyVal.UnitVal;` as a bare statement and
  `consume(MyVal.UnitVal)` with an elided callee both reported **0 leaks pre-fix** while
  their emitted C plainly contained an undropped `__yo_new_…()`. Read the emitted C; do
  not trust `leaks` alone for this family.

A second test exercises the positions with no observable count (discarded statement,
match subject, cond condition, `&&` operands, loop, `Option` payload) so Linux CI LSan
gates them.

## Verification

| check                                                   | result                                    |
| ------------------------------------------------------- | ----------------------------------------- |
| minimal repro, `leaks --atExit`                         | 32 B → **0**                              |
| method receiver `E.UnitVal.kind()`                      | leaked pre-fix → **0**                    |
| `rc()` gate in `tests/rc.test.yo`                       | pre-fix SIGABRT → **passes**              |
| `tests/rc.test.yo`                                      | 18/18                                     |
| `./yo-cli test ./tests --exclude tests/internal`        | 2657/2657                                 |
| `check ./std`                                           | 153/153                                   |
| `check ./yo-self`                                       | 238/238                                   |
| `Option(String).None` emitted C                         | inline compound literal, no temp, no drop |
| battery + corpus diff-test + `check ./std` (gates_fast) | 20/20 hollow=0, PASS 155 DIFF 0, 153/153  |
| stage-2 ≡ stage-3                                       | FIXPOINT_HOLDS                            |
| `tests/internal` under both compilers                   | 826/826 each                              |

## Adjacent gaps found and deliberately left out of scope

- `issues/ctfe-elided-unit-call-arg-temp-leak.md` — when the callee is _fully_ elided by
  CTFE (unit return, trivial body), the argument temp is declared but no drop is emitted.
  Pre-existing, not a regression, needs a separate look at the call's
  `deferredDropExpressions`.
- `issues/fieldless-ref-enum-simple-enum-collapse.md` — an all-payload-free
  `ref(enum(On, Off))` does not compile at all (9 clang errors): `canOptimizeAsSimpleEnum`
  collapses it to a plain C enum while the constructors and parameter types still treat it
  as `T*`. Independent pre-existing codegen bug; the "some variant has fields" conjunct
  above keeps this fix from adding to that pile.
