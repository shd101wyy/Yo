# yo-self dyn() codegen gaps (binary)

**Status: ✅ ALL FIXED (2026-06-30). The entire dyn() subsystem now matches TS.**
Surfaced by differential testing the self-compiled binary against TS on small
`dyn`/trait programs. Every dyn pattern compiles + runs identically to TS:

- `dyn(refStruct)` + method dispatch (`self:*(Self)`) — Gap 2, commit 2f857d7a6
- `dyn(box(valueStruct))` — vtable wrapper (07e7fbba8) + concrete unwrap (c8058712d)
- `dyn(valueStruct)` auto-box — Gap 1, commit d0d55e69a (the 5-layer chain below)

corpus 92/92; fixtures dyn_dispatch_ptr_self / dyn_dispatch_boxed_value /
dyn_dispatch_autobox_value. The sections below retain the investigation history.

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

   **✅ FIXED (commit d0d55e69a) — it was a 5-layer chain, all landed together.**
   Ported `createBoxedType` → `_create_boxed_type` and wired the validating-path
   auto-box (evaluate synthetic `box(value)` with the EXPECTED `Box(Sq)`). Five
   stacked faithful-port gaps, each verified by the error changing; the final fix
   (e) was found by reading the code (collection registers the dyn impl off the
   SOURCE arg, not the boxed payload) and all five were applied together:

   - **(a) `Variable "V" not found`.** `_create_boxed_type` called
     `evaluate_comptime_fn_call(Box, …)` but that evals the body in the passed
     `callee_env` and does NOT bind params — TS `createBoxedType` (dyn.ts:90-105)
     pre-binds `V` in the callee env. FIX: build a callee env (`push_frame` +
     `add_variable_to_env(V = inner_type, comptime)`), pass it.
   - **(b) enclosing-expr disruption.** Before (a), the throw unwound past the
     enclosing `printf` to the trial wrapper → `// Failed to transpile printf(…)`
     → main compiled to a silent no-op. Fixed by (a).
   - **(c) synthetic `box()` call didn't resolve to `Box(Sq)`** (→ "requires an
     object type"). The synthetic atom/call used `id = usize(0)`; the call's
     ExprInfo/forall setup keys on the id. FIX: mint real ids with
     `alloc_global_expr_id()` for the synthetic atom + call. (The pre-existing
     executing-path auto-box has the same `usize(0)` latent bug.)
   - **(d) box-construction fn uncollected** (`no C function name for func value
yo_id_…_Sq`). The synthesized box lives in `runtime_arg_exprs_in_order`, not
     the source AST, so the codegen collection pass never walks it (TS mutates
     `expr.args[0]`, which collection walks). FIX: collection (`collection.yo`)
     walks `runtime_arg_exprs_in_order[0]` for dyn calls (gated on
     `dyn_call_trait_values`).
   - **(e) `__yo_dyn_box_<Sq>` typedef missing** (referenced by its new/dispose).
     `register_dyn_impl` runs in TWO places: the collection PRE-PASS
     (`collection.yo`, before the dyn-box TYPE emitter) and codegen
     (`exprs/dyn.yo`, after). The pre-pass read the dyn's SOURCE arg `cargs[0]` —
     for `dyn(Sq)` that's the bare value `Sq` (not ref/boxed) → its guard skipped
     registration → the TYPE emitter saw no impl → typedef missing; codegen
     registered it later → new/dispose present. FIX: the pre-pass reads
     `runtime_arg_exprs_in_order[0]` (the synthesized boxed payload) first, so it
     registers off `Box(Sq)` → unwrapped concrete `Sq` → `__yo_dyn_box_<Sq>` type
     emitted in the pre-pass, consistent with new/dispose. (Same change also
     recurs into the boxed payload so the box-construction fn — layer (d) — is
     collected.)

   **Workaround available today:** `dyn(box(valueStruct))` (explicit `box`) works
   end-to-end (layers 3-4 fixed), and `dyn(valueStruct)` errors cleanly directing
   the user to `box()`. So the only divergence is the missing auto-box convenience.

3. **vtable-wrapper emission for a boxed dyn — ✅ FIXED (commit 07e7fbba8).**
   `dyn(box(Sq(9)))` used to fail C compile with an undeclared
   `__yo_wrap_<box>_<dyn>_area`. Two coupled faithful-port gaps, both fixed:

   - **`is_boxed_type` name dependency.** It keys off a `Box(`-prefixed struct
     name (mirrors TS `typeName?.startsWith("Box(")`), but yo-self left generic
     instantiations ANONYMOUS — the comptime-fn type-name back-patching
     (`comptime-fn.ts:261-265`) was skipped (`comptime_fn.yo` header even
     documented the omission). Fix: stamp the returned struct's name in
     `comptime_fn.yo`'s existing constructor-id rebuild, **scoped to `Box` only**.
     Naming ALL instantiations like TS regressed the corpus 90→55 because
     yo-self's `compatibility.yo:430` treats the struct name as nominal identity
     (the "name-only comparison unsound" issue) — but `Box(T)` is structurally
     unambiguous (single `*` field) and never unifies with user types, so naming
     only `Box` is safe (corpus stays 90/90).
   - **trait-method resolution on the box, not the underlying.**
     `_resolve_dyn_trait_values` looked up `area` on `Box(Sq)`'s id → no FuncVal →
     no wrapper. Fix: `_unwrap_box_for_method_lookup` (dyn.yo) unwraps a boxed
     payload to its `*` field type for the registry lookup (now that
     `is_boxed_type` works). The wrapper now emits correctly.

4. **dyn-box concrete-type unwrap — ✅ FIXED (commit c8058712d).** After the
   wrapper fix, `dyn(box(Sq))` still failed C compile on a `__yo_dyn_box_<Box(Sq)>`
   typedef/new mismatch: `generate_dyn_call` (`codegen/exprs/dyn.yo:82`) set
   `concrete_type = value_type` (`Box(Sq)`) with no unwrap, so the dyn-box /
   impl_key / vtable were keyed inconsistently between the box and the underlying
   type. Fix mirrors TS `dyn.ts:66`/`:95-96`: `_unwrap_box_concrete` sets the impl
   `concrete_type` to the underlying (`Sq`, the box's `*` field) while `data_type`
   stays `Box(Sq)` and `.data` still points at the `Box(Sq)` pointer directly (the
   dyn-box functions are dead code here — never called — but now keyed
   consistently on `Sq`). `dyn(box(Sq(9)))` compiles + runs → `Q` (matches TS).
   Corpus fixture `dyn_dispatch_boxed_value.yo`; corpus 91/91, no regressions.

   **NET: `dyn(box(valueStruct))` works end-to-end.** The only remaining dyn gap
   is the value-type AUTO-box (`dyn(Sq)` with no explicit `box()`) — Gap 1
   layers 1-2 below.

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
