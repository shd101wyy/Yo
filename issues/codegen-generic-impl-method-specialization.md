# Codegen: generic-impl method calls need specialization (Gap 6 / monomorphization)

## Status: OPEN — the largest remaining Phase-3 codegen-port piece

This is the true blocker for `String.from("AB").len()` (the m1 target) and any
program that calls a method from a generic impl (`impl(forall(T), C(T), ...)`)
on a concrete instantiation. Confirmed 2026-06-15 after the Gap-6 cascade
(void* fallback, value-struct ctor, comptime-only skip, skip-predicate unify —
commits e3b3297e9 / cfb84cff1 / d374f8875 / 9bae51c8e).

## Minimal reproducer (16 lines — use instead of the String path)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
MyBox :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(value : T)
);
impl(
  forall(T : Type),
  MyBox(T),
  get : (fn(self : Self) -> T)(self.value)
);
make_box :: (fn(n : i32) -> MyBox(i32))(
  MyBox(i32)(value : n)
);
main :: (fn() -> unit)({
  b := make_box(i32(65));
  unsafe(_a := putchar(int(b.get())));
});
export(main);
```

- **TS reference**: compiles + runs, prints `A` (char 65), rc=0.
- **self-bin (9bae51c8e)**: `// Failed to transpile (b.get)()` in `__yo_user_main`
  → C error `expected expression`.

(`Box` collides with a prelude type — must use a different name like `MyBox`.)

## Root cause

`b.get()` dispatch in `yo-self/codegen/exprs/other_fn_call.yo`
(concrete-method branch, ~line 597) resolves the method via
`get_type_trait_methods_by_name(type_id_or_empty(recv_ty), mname)`. For a
generic impl, the methods are registered under `MyBox(T)`'s id (the generic
struct), but `recv_ty` is `MyBox(i32)` with a *fresh* instantiation id → the
lookup misses → returns `None` → falls through to "Failed to transpile".

Even if resolution fell back to `find_methods_from_generic_impls(recv_ty,
mname, env)` (in `evaluator/values/generic_impl_registry.yo`, which DOES match
`MyBox(T)` against `MyBox(i32)` via `synthesize`), the candidate it returns is
the UNSPECIALIZED method `get : (fn(self : Self) -> T)` — `T` is still a SomeT.
`should_skip_function_codegen` (declarations.yo) correctly skips it (generic
return), so it would be undeclared at the call site. **Resolution alone is
insufficient — the method must be SPECIALIZED.**

## What TS does (the target)

TS specializes the generic-impl method per concrete instantiation. For this
repro it emits:

```c
static inline int32_t
fn_<hash>_id_68_get_specialized_T_i32_Self_MyBox_u40_i32_u41__(
    __yo_struct_<hash>_id_81* self);   // (MyBox(i32)) fn(self : MyBox(i32)) -> i32
```

i.e. a concrete FuncVal with:
  - `T` substituted to `i32` (return type `int32_t`, `self.value` → i32 field),
  - `Self` substituted to `MyBox(i32)`,
  - a NEW funcId (base `_specialized_T_i32_Self_MyBox(i32)` suffix),
  - registered in `context.functions` and emitted normally (no SomeT, so
    `should_skip_function_codegen` keeps it).

The call site references the specialized funcId's C name.

In TS this specialization happens in the EVALUATOR call path
(`src/evaluator/calls/…` — `specializeFunction`/instantiation), and the
dot-access ExprInfo (`expr.func.$`) carries the resolved *specialized*
FuncVal so codegen just consumes `funcId`. yo-self's method-call ExprInfo does
NOT carry this (the callee dot-access has no ExprInfo), and the specialization
machinery itself is unported.

## Prior art / caution

Memory `yo-self-phase3-generic-impl-funcid`: a fix attempt for exactly this
(generic-instantiation method resolution → unit; "synthesize compares struct
ids, but generic instantiations get fresh random_ids; TS uses
functionValue.funcId, yo-self omits it") was made and **reverted** (dead
`evaluate_comptime_fn_call` + TypeValue clash + struct-clone id churn). So this
is known-hard and needs care — likely a `funcId` field on the specialized
struct/FuncVal, not name-based identity.

## Next steps (for a fresh budget)

1. Decide where specialization lives: faithfully, the evaluator call path
   (mirror TS `specializeFunction`) so the call's ExprInfo carries the
   specialized FuncVal; codegen then needs only to read it + the
   collection/emission already works for concrete FuncVals.
2. Alternatively (codegen-local, lower fidelity): in collection.yo +
   other_fn_call.yo, on a generic-impl method call, build the substitution
   T→concrete from `synthesize(MyBox(T), MyBox(i32))`, clone the method FuncVal
   with substituted type + a derived funcId, register + emit it. Risk:
   diverges from TS identity model.
3. Validate with this repro (TS-differential: prints `A`, rc=0) + corpus stays
   green, THEN re-test the full `String.from("AB").len()` (m1) path.

## Deep trace (2026-06-15 session — layers ruled out, all reverted)

Probed the failure chain end-to-end. Findings (each verified with eprintln, then
the speculative edits reverted because `b.get()` never reaches the paths I
modified):

- **The CALL `b.get()` has NO ExprInfo at codegen time.** `generate_func_call`
  (codegen/exprs/generation.yo:246) looks up `get_expr_info(expr)` for the whole
  call and finds nothing → emits `// Failed to transpile (b.get)()` (the
  generation.yo:250 site, NOT the :371 fallback). So the evaluator records
  nothing for the call expr. (`make_box()` and `b` DO get ExprInfo and transpile
  fine — only the method call is missing.)
- **`try_to_call_function_with_arguments` step-12b specialization never runs for
  the method.** A probe on `(is_method_call && is_func_generic)` right before the
  FuncCallResult never fired for `b.get()`. So the method call doesn't reach the
  specialization/FuncCallResult builder.
- **`_try_find_receiver_method` (function.yo:153) is NEVER called with
  method_name=="get"** during the entire compile (probe empty). So method
  resolution for `b.get()` doesn't happen via the receiver-method path at all at
  codegen-eval time. The `.Some(method_info)` branch (function.yo:~2580) that
  builds + sets the call's ExprInfo (2683-2686) is therefore never taken; the
  `.None` branch (2691) is, and it does not produce a usable call ExprInfo.
- The generic-impl callback IS registered (impl.yo:2029
  `set_find_methods_from_generic_impls_fn`), and `check` passes (but check does
  NOT eval fn bodies, so it never exercises `b.get()`).

OPEN QUESTION for next session: WHY isn't `_try_find_receiver_method` reached for
`b.get()` during the codegen body-eval? Either (a) the codegen-time evaluation of
`main`'s body resolves the callee `.`(b,get) via a different property-access path
that throws/returns before the method-call dispatch at function.yo:2549, or (b)
the callee property-access eval silently fails (no printed error). START HERE:
probe at the TOP of `evaluate_function_call` and at the `.`(b,get) property-access
eval to see what the callee resolves to and whether it throws. The fix is upstream
of specialization — method RESOLUTION for a generic-impl method on a concrete
instantiation must succeed first (produce `method_info`), THEN specialization +
ExprInfo recording (the genericity check needs `is_function_type_generic(ft) ||
return-is-SomeT`, since the resolved method arrives with `self` concretized but
return `T` still a bare SomeT and forall dropped — verified via probe:
ret_some=true, p0_some=false, forall=0 for 231 method calls).

NOTE: the faithful infra changes attempted this session (record spec FuncVal on
the callee's ORIGINAL ExprInfo node id mirroring TS helper.ts:2272; broaden the
specialization genericity guard to include return-SomeT) are CORRECT but were
reverted because `b.get()` fails upstream (resolution) before reaching them —
re-apply them only AFTER resolution produces `method_info`.

## CORRECTED diagnosis (2026-06-15 session 2 — the above "resolution fails" was WRONG)

Re-probed with exact string filters. The prior conclusion that method RESOLUTION
fails is FALSE. Verified chain for `b.get()` (MyBox(i32)):

1. `b.get` reaches the callee-value dispatch (function.yo:~1027) with
   `callee_value = NONE` → routes to the `.None` arm (method path, line 2548).
2. `_try_find_receiver_method` (function.yo:153) IS reached; `recv_has_info=true`
   (b's ExprInfo present); **`hits=1`** (recv_ty=`<struct MyBox(i32)>`,
   is_static=false). RESOLUTION SUCCEEDS.
3. The method path (function.yo:~2556 `.Some(method_info)`) runs; the resolved
   **return type is concrete `i32`** (`call_result_m.return_type=i32` — the
   evaluator already concretizes the generic return!); it sets the CALL expr's
   ExprInfo at line ~2698 (verified: probe `methodset b.get: call_id=… ret_ty=i32`
   fires).
4. Codegen FINDS the call's ExprInfo — the generation.yo:246 `.None` (no-info)
   bail does NOT fire for `(b.get)()`.
5. Codegen fails at the OTHER site, generation.yo:**371** (the
   `generate_other_function_call → None` fallback): `// Failed to transpile
   (b.get)()`. Root: `generate_other_function_call` needs the CALLEE dot-access
   `.`(b,get) to have ExprInfo (`func_ei`, other_fn_call.yo:668) — but the method
   path set ExprInfo only on the CALL, not on the callee dot-access → `func_ei`
   returns None → whole call returns None.

So the gap is NARROW and precise: **record the resolved method on the CALLEE
dot-access's ExprInfo** so codegen's `func_ei` can dispatch. NOT a resolution
bug, NOT (only) a specialization bug.

### Fix attempts this session that FAILED (don't repeat):
- **Broaden genericity guard** `is_func_generic := is_function_type_generic(ft)
  || (return is bare SomeT)` → **REGRESSES std eval**: "Expected a type for
  function return type", "Argument count mismatch: expected 1, got 0" in
  stdio.yo. Over-triggers specialization on functions that must not specialize.
  DO NOT extend genericity to return-SomeT globally.
- **Record resolved func on callee dot-access** (narrowed to dot-callee with no
  existing ExprInfo, value = spec_func_val ?? func_val) → gc2 STILL failed.
  OPEN: either the callee dot-access already carries a value-less ExprInfo (so
  the `!has_info` guard skips it, yet codegen's func_ei finds info-without-value
  and still can't dispatch), OR codegen's func_ei path needs more than value+ty.

### PRECISE ROOT (likely the real faithful fix):
A probe of `get`'s resolved method Func type showed **`forall=0`** (plus
ret_some=true, p0_some=false: `self` concretized, return `T` still bare SomeT).
TS's `isFunctionTypeGeneric` returns true for `get` because the method's
`functionType.forallParameters` still contains `[T]` (the impl's forall is
attached to each method). **yo-self DROPS the impl's `forall(T)` when resolving a
generic-impl method**, so the method type looks non-generic → specialization
never runs → the body stays generic (`self.value` on a `void*` self → uncompilable
C). This is ALSO why the return-SomeT genericity hack over-triggers (it's the
wrong lever) and why `ArrayList`'s methods (registered differently) behave
differently from a fresh user `MyBox` impl.

THE FIX: make generic-impl method resolution PRESERVE the impl's `forall(T)` on
the resolved method's Func type (in `find_methods_from_generic_impls` /
`get_receiver_methods_by_name_from_env` / the method-resolution path —
`forall=0` is the smoking gun). Then `is_function_type_generic(func_type)` (which
checks `forall_labels`) returns true with NO broadening, specialization runs and
re-evaluates the body with `T=i32` (concrete return + concrete `self.value`), and
the specialized FuncVal flows to codegen. THEN record it on the callee dot-access
ExprInfo (method path, function.yo:~2683) so `generate_other_function_call`'s
`func_ei` can dispatch.

### Next session START HERE:
1. Find where the resolved generic-impl method's Func type is built (does
   `find_methods_from_generic_impls` return `entry.field_types[i]` verbatim? that
   field type is the method type WITHOUT the impl forall). Compare with how TS
   attaches `forallParameters` to impl method types.
2. Preserve `forall(T)` (+ the impl's SomeT binders) on the resolved method type.
3. Verify `is_function_type_generic` → true → spec runs (probe step12b) → gc2
   compiles+runs (prints `A`, rc=0) + corpus 32/32 + std/tests green.
4. Record resolved/specialized FuncVal on the callee dot-access (method path).
