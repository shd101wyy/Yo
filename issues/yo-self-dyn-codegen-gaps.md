# yo-self dyn() codegen gaps (binary)

**Status: Gap 2 ✅ FIXED (commit 2f857d7a6); Gap 1 OPEN.** Two distinct gaps in
the self-compiled binary's `dyn()` codegen, surfaced by differential testing the
binary against TS on small `dyn`/trait programs (2026-06-30). The evaluator-side
dyn coercion + method dispatch were fixed earlier (commits 2f91537c / 02315945);
these were the remaining CODEGEN gaps. Gap 2 (method dispatch for `self:*(Self)`)
is now fixed; Gap 1 (value-type auto-box, needs SomeT→concrete resolution) remains.

## Gap 1 — value-type `dyn()` auto-box (SomeT not resolved to concrete)

Repro `/tmp/cgbugs/16_dyn.yo`:

```rust
Shape :: trait(area : (fn(self : *(Self)) -> i32));
Sq :: struct(s : i32);                                  // VALUE struct
impl(Sq, Shape(area : (fn(self : *(Self)) -> i32)(self.s * self.s)));
use_shape :: (fn(sh : Dyn(Shape)) -> i32)(sh.area());
main :: (fn() -> unit)({ unsafe(printf("area=%d\n", use_shape(dyn(Sq(5))))); });
```

TS prints `area=25`. Binary emits:

```c
__yo_dyn_trait_yo_id_3726 t = /* Error: dyn() requires an object type (use box() for value types) */;
```

Root cause (confirmed by instrumenting generate_dyn_call): the dyn payload's
codegen type is `void*` — i.e. the inner `Sq(5)`, evaluated with the
SomeT-Shape expected type (evaluate_dyn_value lines 202-232), keeps the **SomeT**
(type-variable) type rather than resolving to the concrete `Sq`. TS auto-boxes
the inner (evaluateDynValue dyn.ts:250-310, `expr.args[0] = box(...)`), and TS's
inner resolves to the concrete `Sq` so `box(Sq) -> Box(Sq)` (a ref struct) passes
the codegen object-type guard.

In yo-self:

- TS's `evaluateDynValue` has NO executing/validating split; it always boxes.
  yo-self added an early-return validating path (evaluate_dyn_value ~233-262)
  that skips the auto-box — and yo-self evaluates fn bodies in validating mode,
  which is the ExprInfo codegen reads.
- Even after adding the auto-box to the validating path + recording the boxed
  expr in `runtime_arg_exprs_in_order` (the field generate_dyn_call prefers),
  the inner stays SomeT-typed (`void*`), so `box()` of a SomeT silently produces
  no usable box function (0 box fns emitted) and the guard still fires.

CORRECTION (2026-06-30, after the Gap-2 fix): the SomeT diagnosis above was
WRONG. Re-instrumented `evaluate_dyn_value`'s validating path: the inner
`Sq(5)` types as the concrete value struct `Sq` (`is_some=N`,
`inner=Struct:Sq`), NOT a SomeT. The `void*` seen earlier was an artifact of the
since-reverted experiment, not the real inner type. Gap 1 is actually TWO layers:

1. **Auto-box not in the validating path.** TS's `evaluateDynValue` always boxes;
   yo-self only boxes in the executing path (the validating path — which is what
   codegen reads — returns early without boxing). So codegen sees the bare value
   struct `Sq` → "requires an object type". Adding the auto-box to the validating
   path is necessary but not sufficient (see layer 2).

2. **`box()` return-type doesn't resolve via the SYNTHETIC auto-box call.** When
   the validating path synthesises `box(eval_inner)` and evaluates it, the result
   type comes back as neither a `Struct` nor any common variant (`boxed=other`) —
   i.e. the generic `box`'s `-> Box(V)` return is not monomorphised to `Box(Sq)`.
   Yet an EXPLICIT `box(Sq(9))` in source DOES type as a `Box` ref-struct (the
   auto-box condition skips it), so `box()` itself works — the synthetic
   pre-evaluated-arg call path is what fails to resolve `V`. TS sidesteps this by
   constructing `Box(valueType)` directly (`createBoxedType`) and passing it as
   the box call's EXPECTED type (dyn.ts:256) — yo-self's auto-box evaluates
   `box(..)` with no expected type, so `V` must be inferred and isn't.

3. **vtable-wrapper emission for a boxed dyn.** Even `dyn(box(Sq(9)))` (explicit
   box, gets past the object guard) then fails C compile with an undeclared
   `__yo_wrap_<box>_<dyn>_area` — the vtable wrapper that unboxes `Box(Sq)` and
   calls `Sq.area` is referenced but never emitted. This affects the reasonable
   `dyn(box(valueStruct))` pattern too, independent of auto-box.

   **DEFINITIVE ROOT CAUSE (2026-06-30).** `is_boxed_type` (types/guards.yo:574)
   returns true only for a single-`*`-field ref-struct **whose `name` starts with
   `"Box("`** (mirrors TS `typeName?.startsWith("Box(")`). But yo-self gives a
   `Box(Sq)` instantiation an ANONYMOUS struct name — the emitted C shows
   `struct __yo_gs_yo_id_3506_struct_yo_id_3727_struct { //  : <struct:struct_…>`,
   i.e. name `<struct:…>`, not `"Box(Sq)"` (yo-self identifies structs by id, not
   name — see [[yo-self-phase3-hashmap-new-blocker]] "name-only struct comparison
   is unsound"). So `is_boxed_type(Box(Sq)) == false`, which breaks BOTH:

   - the evaluator's trait-method resolution (it looks up `area` on `Box(Sq)`'s id
     instead of unwrapping to `Sq` → field value `None` → no wrapper emitted), and
   - the codegen wrapper's `is_boxed` branch (would mis-cast `self_ptr` even if the
     wrapper were emitted).
     A reverted experiment added an `is_boxed`-gated box-unwrap to
     `_resolve_dyn_trait_values` (`method_lookup_type = unwrap(Box) → Sq`); it built
     clean but was a NO-OP because `is_boxed_type` is false. Confirmed the unwrap
     helper itself is correct; the blocker is purely the `is_boxed_type` name check.

   **Fix options** (both non-trivial, deferred): (a) name generic struct
   instantiations (`Box(Sq)`) so the name check works — but yo-self deliberately
   avoids name-based struct logic (unsound per the HashMap blocker), so this risks
   regressions; (b) make box-detection name-INDEPENDENT via generic-origin
   tracking — record that a struct was produced by the prelude `Box` fn (by the
   generic-struct origin id, e.g. `gs_yo_id_3506`) and have `is_boxed_type` check
   that origin instead of the name. (b) is the sounder path. A purely structural
   "single `*` field ref-struct" check is NOT safe — user types like
   `MyBox :: ref(struct((*) : i32))` would false-positive and get wrongly unboxed.

   NB: the merge checker (during TS-compiles-yo-self def-time body eval) is
   unusually hostile to instrumentation in `evaluator/values/dyn.yo`: match arms
   that BIND a var and let it escape as the arm value (e.g.
   `.Some(ut) => ut`) alongside a non-binding sibling arm throw "Frame level N has
   different number of values for different cases". Use the assign-to-outer-`(x:T)=`
   pattern (arms return unit) instead. This cost several rebuilds before the C
   type-name comment (`// : <struct:…>`) gave the root cause without any probe.

Fix sketch: (1) mirror TS `createBoxedType` — build `Box(value_type)` directly
and pass it as the box call's expected type so `V` binds; (2) port the
boxed-dyn vtable-wrapper emission. Deferred — value-type dyn is less common than
the ref-struct dyn dispatch fixed in Gap 2; both layers are non-trivial.

## Gap 2 — dyn method dispatch through the fat pointer — ✅ FIXED

**FIXED 2026-06-30.** `16b`/`16c` now match TS; the binary emits
`(sh).vtable->area((sh).data)`. Regression-clean: 16-program differential sweep

- 89/89 codegen-bootstrap corpus + the self-build all pass. Added corpus fixture
  `tests/codegen-bootstrap/dyn_dispatch_ptr_self.yo` (prints `Q`, differential-clean).

ROOT CAUSE: in `other_fn_call.yo`, the dyn-method-dispatch branch gated on
`recv_is_dyn` (is the prepended runtime-arg[0] a Dyn?). For a `self : *(Self)`
trait method the prepended receiver is WRAPPED in `&(..)` (needs_pointer_conversion),
so runtime-arg[0] is a `*(Dyn)` pointer, not a Dyn → `recv_is_dyn = false` → the
dispatch was skipped, and the sibling concrete-dispatch branch (gated on
`!recv_is_dyn`) fired instead, found no concrete impl for the DynT receiver, and
fell through to "Failed to transpile". (The pre-existing `dyn_dispatch.yo` corpus
fixture uses `self : Self` by-value, so its receiver is NOT wrapped and
`recv_is_dyn` was true — which is why the by-value case already worked.)

FIX (mirrors TS other-fn-call.ts:478+, which keys `isDynMethodCall` off
`expr.func.args[0].$.type` — the dot-receiver): gate the dyn dispatch on
`dot_recv_is_dyn && method_atom_ok` and emit the vtable call off the DOT-receiver
(`dmethod_args[0]`), not the `&`-wrapped prepended arg. `recv_is_dyn` is retained
ONLY for the concrete branch's `exn.throw(dyn(err))` exclusion (ctl-field call
whose dyn ARGUMENT sits at runtime-arg[0] with a non-Dyn dot-receiver). The dyn
branch runs first and returns, so the concrete branch is never reached for a real
dyn call.

NB: the EARLIER diagnostics in this section (no-throw / missing-ExprInfo / id-
mismatch) were a mis-localization — the call expr DOES get an ExprInfo (eval's
method-found branch sets it); codegen reached `generate_other_function_call` fine
and the failure was the dispatch GATE, surfaced via the second "Failed to
transpile" site (`generation.yo:577`, the `.None` fallback), not the
`get_expr_info=None` site at `generation.yo:405`.

### Original investigation notes (superseded by the fix above)

Repro `/tmp/cgbugs/16b_dyn_ref.yo` (same as above but `Sq :: ref(struct(s:i32))`
so no boxing is needed). The `dyn(Sq(5))` construction now succeeds, but
`use_shape`'s body fails:

```c
static inline int32_t yo_id_3731(__yo_dyn_trait_yo_id_3726 sh) {
  return // Failed to transpile (sh.area)();
}
```

TS dispatches `sh.area()` through the vtable (`sh.vtable->area(sh.data)`).

REFINED ROOT CAUSE (2026-06-30): this is NOT a missing codegen emitter and NOT a
swallowed eval throw:

- The dyn-method-dispatch EMITTER already exists in yo-self
  (`other_fn_call.yo` ~860-919: lowers `(recv).vtable->method((recv).data, …)`,
  gated on `recv_is_dyn && dot_recv_is_dyn && method_atom_ok`).
- The "Failed to transpile" actually fires earlier, at `generation.yo:405-412`:
  `get_expr_info(expr)` returns **None** for the `sh.area()` call expr, so codegen
  bails before reaching the dyn-dispatch branch.
- It is not a swallowed throw: instrumenting `_trial_eval_fn_body`'s swallow
  handler (`function_type.yo:217`) to `eprintln` every swallowed error produced
  **zero** TTERR lines for this compile — the body eval does not throw.

So the call expr simply has no findable ExprInfo at codegen time. This is the
same hard class as the earlier P1 work ("ExprInfo lookup failing due to
expression-id mismatch" / "get_expr_info=None during binary compile").

NARROWED FURTHER with a richer body `{ base := 100; r := sh.area(); base + r }`
(`/tmp/cgbugs/16c.yo`): the binary emits

```c
int32_t base = 100;                              // OK
int32_t r = // Failed to transpile (sh.area)();  // only the dyn call
return ((base) + (r));                           // OK
```

Two facts pin it down:

1. The body IS def-time evaluated (base/return transpile fine).
2. The assignment knows `r : int32_t` — i.e. the dyn method `area` WAS resolved
   and its return type (i32) propagated. So this is NOT a 0-hit method-lookup
   failure (`get_receiver_methods_by_name_from_env` does find `area`).

Conclusion: the dyn method-call eval resolves the method + result type (feeds the
assignment) but does not leave an ExprInfo on the ORIGINAL `sh.area()` call node
under the id codegen walks — it is recorded under a different ast_expr_id or on a
rewritten/resolved node. The fix is in the dyn method-call eval path
(`evaluator/calls/function.yo`, the `_try_find_receiver_method` → call-eval
handoff): ensure the final ExprInfo is `expr_info_table_set` on the original call
expr's id. Needs a two-sided id trace (eval-recorded id vs codegen-looked-up id).
Evaluator-side, deeper than an emitter fix.

## Working (for contrast)

Differential testing confirmed these categories compile + run identically to TS
in the binary: struct, enum + match, generic fn, generic struct + methods,
nested generics, Option/Result + match, recursion (recur), inherent impl
methods, HashMap get/set, struct-variant match destructuring, algebraic effects
(ctl/handler), to_string, String concat. The dyn/trait-object path is the
outlier.
