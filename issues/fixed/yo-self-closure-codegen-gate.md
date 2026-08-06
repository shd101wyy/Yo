# yo-self closure codegen gate (blocks the async BASELINE)

**Status: ✅ RESOLVED 2026-06-18 (commit 100f1c3c4).** The async BASELINE compiles
end-to-end via `yo-self-bin` and runs → prints `42` (matches the TS reference);
added as the permanent corpus fixture `tests/codegen-bootstrap/io_async_await_42.yo`
(corpus 59/59, differential-clean). Resolution (all in the commit): mark every `=>`
closure for codegen (capture-param convention); build its capture struct
(`capture_type`); FORCE body def-eval for marked closures (was deferred as generic
→ "Failed to transpile"); re-register the closure Func type with the concrete body
RESULT (`t_func_simple`); don't skip marked closures in codegen; and resolve the
sync-future result type via the closure `value` FuncVal body. NB: a separate
PRE-EXISTING `yo-self-bin check ./std` crash on `std/imm/map.yo` (rc=138, bisected
to before any of this work) remains — tracked independently; it does not affect the
BASELINE or the corpus. The history below is retained for context.

**io.spawn / JoinHandle.await (2026-06-18, partial — root-caused).** `io.spawn(task, io)`
now emits its full cold-start + JoinHandle block correctly. The remaining issue on
`result := handle.await(io)` is ROOT-CAUSED: `handle.await(io)`'s result type
resolves to **unit** (not `Option(i32)`), so `generate_initialization_assignment`
takes its `is_unit_type(lhs_type)` branch and emits NO `result` declaration, and the
trailing `match(result, …)` on the unit-typed `result` falls to "Failed to
transpile". JoinHandle.await's signature is `forall(T)(self : JoinHandle(T), io) ->
Option(T)`; for `handle.await(io)` the `T` in `JoinHandle(T)` is not inferred to
`i32`, so `Option(T)` collapses (to unit/unresolved). So this is a generic-method
return-type INFERENCE issue (resolve `T` from the `JoinHandle(T)` receiver so the
return is `Option(i32)`), upstream of `generate_join_handle_await` — NOT a codegen
emitter bug.
NARROWED FURTHER: `await` is a function-typed FIELD of the `JoinHandle` struct
(`await : forall(T)(self : JoinHandle(T), io) -> Option(T)`), so `handle.await(io)`
is a FIELD-FN call, NOT a method call — it does NOT go through the function.yo
forall-inference path (whose static-receiver `recv_type_args` fallback + shallow
name-matched arg inference don't bind `T` from a `self : JoinHandle(T)` arg whose
value is `JoinHandle(i32)`). The fix must (a) live on the field-fn-call path AND (b)
do NESTED-generic forall unification — bind `T` by unifying the parameter type
`JoinHandle(T)` against the argument type `JoinHandle(i32)` (read `T` from the arg's
`type_arguments`), not just match a param whose type name IS the forall name. (Tried
a quick instance-receiver fallback in the method-call path — reverted: that path is
never reached for a field-fn call; corpus stayed 63/63.)
(Older note below; superseded by this root cause.) The JoinHandle.await dispatch arm
(`is_join_handle_await_call` → `generate_join_handle_await`) is early in
`generate_func_call`, yet the codegen emits no `__jh_*` markers — so either the
evaluator rewrites the `.await` method call into a resolved form that the structural
`is_join_handle_await_call` check no longer matches, or `result`'s init-assignment is
mis-handled (the value may be folded/typed such that codegen skips it). NEXT: trace
whether `handle.await(io)` reaches `is_join_handle_await_call` as a `.await` dot-call
at codegen (it may have been lowered during eval), and why the `result` binding +
`match` don't emit. The five compile-path async fixtures (baseline, capture-return,
capture+operator, single-await FSM, multi-await FSM) are unaffected and pass.

**CAPTURE WORKS END-TO-END; remaining issue is the `+` OPERATOR body type (2026-06-18,
commit 6085f2b2f).** A capturing closure that RETURNS the captured value runs → 42
(corpus fixture `io_async_capture_42.yo`). The remaining `void*` issue is NOT the
capture machinery: a NO-CAPTURE operator body `io.async((io)=>(i32(20)+i32(22)))`
ALSO lowers to void*. The closure body is def-evaluated with the synthesized closure
return type (`SomeT _ret`) as the EXPECTED type, which coerces the `+` result to
SomeT → the body type is SomeT → the concrete result-refine (guarded on
`has_some==0`) is skipped → closure return + future result are void*. The fix is to
let the operator-bodied closure type naturally: either clear the expected type for a
marked closure's body def-eval (so `i32+i32` → i32), or resolve the body SomeT to its
concrete in the result-refine. A plain-value body (`x := i32(42); x` or a captured
value) already types concretely, which is why the BASELINE + capture-return fixtures
pass. This is a def-eval expected-type / operator-resolution interaction, separate
from the (now-working) capture codegen.

**CAPTURING-CLOSURE CODEGEN LANDED 2026-06-18 (commit e7ba72e7e).** The capture
machinery now works: the capture-struct literal `(<cap>){ .base = base }` is built
(from the capture struct field labels — each is the same-named in-scope var), and
the closure body reads captured vars via `((<cap>*)closure_context)->base`
(g_closure_capture_info side-table + generate_function's closure-capture context).
The capture struct correctly types `base : int32_t`. ONE issue remains on the
capturing fixture: the closure's REGISTERED return type and the sync_fut `result`
field lower to `void*` — during the closure's body def-eval, captured `base` types
as a `SomeT` (so `base + i32(32)` is `SomeT` → the concrete result-refine, guarded
on `has_some==0`, is skipped), EVEN THOUGH the value-level capture is the concrete
i32. So it is a value/type mismatch: the captured value is i32 but the evaluator
types the body expression as SomeT. The fix is evaluator-side: type a captured
variable by its ACTUAL outer type (i32) during the closure body def-eval (the body
eval resolves the captured `base` with a SomeT type, not the i32 binding from the
outer snapshot env). Then the body type is concrete → the result-refine fires →
closure return + future result are i32.

**NEXT LAYER — CAPTURING closures (2026-06-18).** The BASELINE is a NO-CAPTURE
closure. The next async cases need closures that CAPTURE outer variables — e.g.
`base := i32(10); io.async((io : Io) => (base + i32(32)))` (TS → 42), and `yield`'s
internal closures (so every await-bearing FSM test hits this). For a capturing
closure yo-self currently emits three errors:

1. `__capture = /* skip generating value */` — `generate_io_async_sync_call` (and
   the FSM ctor) must build the capture-struct LITERAL `(<cap>){ .base = <value> }`
   from the closure's captured vars (FuncVal `cap_names`/`cap_tys`/`cap_vals`; a
   runtime capture is a `VarRef(name)` → emit the in-scope variable). The
   capture_field_count==0 path already emits `(<cap>){0}`; the >0 path still uses
   the anon-fn `value` (a function reference, not a struct).
2. `use of undeclared identifier 'base'` in the closure body — `generate_function`
   must set the closure-capture codegen context (`current_closure_capture_type_c_name`
   - captured names) for marked closures so the atom emitter rewrites a captured
     `base` to `((<cap>*)closure_context)->base` (atom.yo already has
     `check_variable_is_closure_captured`; the context just needs wiring).
3. `int32_t = void*` at the await result — the result-type refinement must still
   resolve (it does for no-capture; verify it holds when the body captures).
   This is the `allocateClosureCapture` / `generateClosureConstruction` port (closures.ts)
   plus the closure-body capture-access context — the deferred closure-capture
   machinery. It is the gate for capturing/await-bearing async (incl. the full
   `tests/async_await.test.yo`, which TS passes 116/116).

**Original status (now resolved):** OPEN — the next blocker after the async/await
emitter ports + wiring.

## Summary

The Phase-5 async port (`exprs/async.ts` → `async.yo`, `exprs/await.ts` →
`await.yo`) is complete and wired into `codegen_c`. The canonical BASELINE async
fixture now runs the FSM transformation end to end — yo-self emits real C — but the
C does not compile because the `io.async` closure's C **function** and **capture
struct** are never emitted.

## Reproducer

```rust
{ println } :: import("std/fmt");
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => { x := i32(42); x });
  io.await(task, io)
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```

`./yo-cli compile` (TS) → prints `42`.
`/tmp/yo-self-bin compile` → emits C, but `clang` fails:

```
void* task = /* Error: no closure function or capture type for io.async sync path */;
... __sync_future->state;  // member reference base type 'void' ...
```

The closure body (`x := i32(42); x`) appears as NO C function in the output, and
the `io.async` call falls into `generate_io_async_sync_call`'s error branch.

## Root cause (pinned 2026-06-18)

The io.async closure arg is evaluated as a **plain anon-fn value** (its ExprInfo
carries `value = FuncVal`, set by `anonymous_function.yo`), NOT as an **Impl(Fn)
closure construction** (which would set `closure_function_value` AND `capture_type`
via `closure_type.yo`'s `try_to_implement_closure_by_fn_module_type`). Consequences
for `generate_io_async_sync_call`:

- closure C function name: RESOLVED — the emitter now falls back to `cei.value`
  (commit e5ee5e93f), and the closure function IS collected via the anon-fn-value
  path (collection.yo:541).
- capture struct: STILL MISSING — `cei.capture_type` is `None` (only the Impl(Fn)
  closure path sets it), so there is no capture struct C name, and
  `_call_generate_expr(closure_arg)` returns the function-name reference
  (`_anon_fn_value`), not a capture struct VALUE like TS's
  `generateClosureConstruction` would.

So the faithful fix is **evaluator-side**: route io.async closure args through the
Impl(Fn) closure path so they carry `closure_function_value` + an (empty-for-no-
capture) `capture_type`, and wire `is_closure_construction → generateClosureConstruction`
in the codegen dispatch (so the arg emits the capture VALUE). A codegen-only hack
that synthesizes an empty capture for the anon-fn-value case would be a shortcut that
breaks for captured closures — avoid it.

**NARROWED 2026-06-18 (commit after e5ee5e93f).** io.async's parameter IS
`action : Impl(Fn(e : E) -> T)` (std/prelude.yo:8182), so the closure SHOULD route
through `try_to_implement_closure_by_fn_module_type` (closure_type.yo), which sets
`closure_function_value` + `capture_type`. But the emitter finds `capture_type` is
`None` on BOTH the runtime-arg expr AND the original `args[0]` expr (a fallback was
added to consult args[0] — harmless, kept). So the evaluator is NOT invoking the
closure-typing path for this arg; it types the anon-fn as a plain function value
instead. The remaining work is to find WHY the closure-against-`Impl(Fn)`-param path
is skipped during io.async arg evaluation (the generic-fn-call arg-coercion path not
triggering closure implementation) and fix it so `capture_type` (empty struct for
no-capture) + `closure_function_value` are set — then `generate_io_async_sync_call`
resolves the capture struct and the construction emitter produces its value.

**FURTHER (2026-06-18, commit 65ff909cf).** Added the evaluator groundwork:
`evaluate_anonymous_function_implementation` now marks io.async `=>` closures as
closures (`mark_as_closure_fn`) and builds their capture struct (`capture_type`),
scoped to `ctx.is_inside_io_async_call`. Validated SAFE (std 152/152, corpus 58/58).
BUT the BASELINE still emits `/* Error: no CAPTURE type */`, AND the closure
function body (`x := i32(42)`) does not appear in the emitted C at all. So either:
(a) `is_io_async_call(expr)` (function.yo:1770) does not fire for the baseline's
`io.async(...)` method call, so `is_inside_io_async_call` is never set during the
closure arg eval (→ the new code is skipped); or (b) the closure ExprInfo that
codegen reads (`runtime_arg_exprs_in_order[0]` / `args[0]`) is a different node than
the one the eval set `capture_type` on; or (c) the closure function is dropped by
`should_skip_function_codegen` (treated as generic). NEXT: instrument which of
(a)/(b)/(c) holds — first confirm `is_io_async_call` returns true for the baseline
call and that the closure fn is collected+emitted, then trace the ExprInfo identity
from eval to the codegen read. The marker + capture-param convention + capture_type
plumbing are all in place; the remaining work is making them connect on the actual
codegen-read node.

**SYNC-FUTURE INFRA COMPLETE 2026-06-18 (commit 82233c5a5).** The io.async
sync-future path now emits its full C (capture struct, **yo_param slot, set_effect,
resume, dispose, constructor); the future var lowers to the correct `<struct>*`
pointer (get_type_string SomeT branch consults the registry; future c_name
registered with `*`); the no-capture `**capture`is`(<cap>){0}`. Validated std
152/152, corpus 58/58.

**FINAL ROOT CAUSE of the last 2 C errors** (closure fn `closure_yo_id_*`
undeclared; await result `int32_t = void*`): the closure's SYNTHESIZED Func type
uses SomeT params + return. At the io.async call, `expected_type` is set to None for
the `Impl(Fn(e:E)->T)` param (function.yo:1807, because it `is_some_type`), so
`evaluate_anonymous_function_implementation` falls back to
`_synthesize_default_func_type`, which makes every param + the return a FRESH SomeT
(closure.yo `_synthesize_default_func_type`). Consequences:

- `is_function_type_hard_generic` is true (any SomeT param ⇒ generic), so
  `should_skip_function_codegen` SKIPS the closure function — it is never emitted,
  yet the resume calls it. (NB: hard-generic checks only PARAMS, not the return —
  so fixing the params alone would un-skip it.)
- the result type `T` is an unresolved SomeT ⇒ `void*`, so the await result
  extraction emits `int32_t = void*`.

The closure is NOT actually generic — its source is `(io : Io) => { … i32 }`
(concrete param annotation + i32 body). The fix is evaluator-side concrete typing of
the closure: either (a) thread the resolved `Impl(Fn(e:E)->T)` expected type to the
closure arg (needs io.async to resolve E=Io,T=i32 — generic specialization), or
(b) have `evaluate_anonymous_function_implementation` derive the closure's param
types from the SOURCE annotations (`io : Io`) and its return type from the
def-time-evaluated body (i32), instead of synthesizing fresh SomeTs. Option (b) is
the more localized, lower-risk path: make the closure's own concrete signature
authoritative when annotations/body are available, so it is neither skipped as
generic nor lowered to void\*. This is the final, narrowly-scoped step to emit `42`.

**PRE-EXISTING `check ./std` CRASH (bisected 2026-06-18).** While validating with
`yo-self-bin check ./std`, the full-directory run crashes deterministically
(rc=138, SIGBUS) on `std/imm/map.yo` (80 `=>` closures, ZERO io.async — so the
scoped closure change cannot be involved). Bisect: a binary built from `337bf534d`
(BEFORE `TypeField.is_effect_param` in `486c90741`, and before all closure-capture
work) ALSO crashes on `imm/map.yo`. So this is **pre-existing**, not a regression
from this session — the `yo-self-bin check ./std 152/152` gate was already not green
on this heavy generic file. Individual std files (async/error/path/log) check fine;
the codegen-bootstrap corpus is 58/58. Tracked as a separate pre-existing bug
(likely a heavy-generic-file def-eval crash, akin to the known-heavy
eval_basics/eval_tail trio). The closure change here stays SCOPED to io.async
closures (does NOT build a capture struct for every `=>`, which would add load to
this already-fragile path and regressed the full-dir run when tried unscoped).

## Original root cause

`io.async((io)=>{…})` with no `await` inside routes to the sync-future path
(`generate_io_async_sync_call`). That emitter needs two things from the closure
argument:

1. The closure's **C function name** — TS reads it from `implClosureCallMap`
   (populated by a closure-discovery pre-pass in `src/codegen/exprs/closures.ts`);
   yo-self has NO `implClosureCallMap`. The yo-self adaptation reads the closure
   arg's `closure_function_value` FuncVal → `func_id` → `get_function_entry`, but
   the closure function is **never collected into `context.base.functions`**, so the
   lookup returns `None`.
2. The closure's **capture struct C name** — TS reads `context.types[concreteType.id]`
   (the monomorphized Impl(Fn) capture type, registered even for no-capture
   closures). yo-self's `capture_type` ExprInfo field is `None` for a no-capture
   closure, and there is no registered capture struct.

Both gaps live in the **closure codegen subsystem** (`exprs/closures.ts`, ~358 LOC,
Phase-3-deferred in `plans/archive/BOOTSTRAPPING_CODEGEN.md`): closure-function discovery +
collection, capture-struct type creation/registration, and closure-function
emission. `closures.yo` currently ports only `check_variable_is_closure_captured`.

## Not in scope of this issue

`async.yo` / `await.yo` are faithful and complete; the dispatch + `codegen_c`
wiring + runtime emission are done (corpus 58/58 with the sys-runtime now active for
every program). The async-with-AWAIT path (`generate_async_block`) has the same
closure dependency for captured async blocks. This gate is purely the closure
codegen subsystem.

## Fix plan (precise entry points)

The closure CALLING CONVENTION is the keystone. TS keys it on
`functionType.isClosure` (declarations.ts:405): a closure function's C prototype
prepends `void* closure_context` as the FIRST parameter, and the body casts it to
the capture struct. yo-self's closure functions are emitted by the ordinary
`generate_function` / `generate_function_prototype` with ONLY their declared params
— no capture param — so the sync-future resume's `cfn(&sm->__capture, …)` call
(capture-pointer first) does not match the callee. This mismatch holds even for
NO-CAPTURE closures (TS still prepends the param; the capture struct is empty).

Steps:

1. **Closure marker.** Add an `is_closure` signal for a Func — either a field on the
   `Func` TypeValue variant (large blast radius, ~all Func ctor sites) or a side-table
   keyed by `func_id` (`g_closure_func_ids`, mirroring `g_struct_field_comptime_flags`).
   Set it where closures are typed (`evaluator/calls/closure_type.yo`,
   `try_to_implement_closure_by_fn_module_type`).
2. **Capture param.** In `functions/declarations.yo` (`generate_function_prototype`)
   and `functions/generation.yo` (`generate_function`), prepend `void* closure_context`
   when the function is a closure; in the body, establish the capture-access context
   (`current_closure_capture_type_c_name` already exists) so captured-var atoms emit
   `((CaptureT*)closure_context)->field`.
3. **Capture struct registration.** Ensure every closure's capture struct (empty for
   no-capture) is collected into `context.types` with a C name, so the sync-future
   `__capture` field type and `generateClosureConstruction` can resolve it. (A
   no-capture closure currently has `capture_type = None`, closure.yo:212.)
4. **Capture-expr-per-field machinery.** `allocateClosureCapture` (and async.yo's
   `_build_async_capture_struct_literal`) need each capture field's source ATOM expr
   to emit `.field = <atom access>`. yo-self's capture `TypeField` does not carry the
   capture expr; this is the recurring gap (see the PHASE3_CAPTURE_PENDING marker in
   `async.yo`). Either store the capture expr on the registered struct fields or
   reconstruct the atom from the captured-var token + its ExprInfo.
5. **Construction emitter + registry.** Port `generateClosureConstruction` +
   `allocateClosureCapture` + `registerImplClosureCallMappings` into `closures.yo`,
   adding an impl-closure-call registry to the context (yo-self has no
   `implClosureCallMap`). Wire the closure-construction dispatch in `generation.yo`
   (`isClosureConstruction` → `generateClosureConstruction`).

Then re-run the BASELINE fixture → expect `42`, and add closure corpus fixtures
(non-async first: a captured-variable closure called directly) to lock the
convention before the async paths.

Leaf helpers already ported in `closures.yo`: `check_variable_is_closure_captured`,
`resolve_some_type_to_concrete`, `is_closure_construction`.

---

## Sync `Impl(Fn)` closure as a value-param to a user fn (2026-06-30)

Surfaced by differential testing the self-compiled binary on
`apply :: (fn(f : Impl(Fn(x:i32)->i32), x:i32)->i32)(f(x))` with
`add_k := Impl(Fn(x:i32)->i32)({return(x+k);})` (repro `/tmp/cgbugs/04*.yo`).
This is the SYNC static-dispatch closure path (closure_type.yo), distinct
from the async `=>` path resolved above. The function-POINTER param path
(`tests/codegen-bootstrap/fn_pointer_param.yo`) works; the Impl(Fn)
capture-struct calling-convention path does not.

**FIXED (commit 60d55c7c4) — two upstream prerequisites** that closure_type.yo
omitted vs anonymous_function.yo:

- `register_func_type(closure_id, synthetic_func_ty)` — was missing, so
  `get_func_type` → `t_unit()` → closure emitted as `void closure(void)`
  (params, return type, and `void* closure_context` all dropped).
- `register_closure_capture_info(closure_id, {capture_type, frame_level})` —
  was missing, so the body emitted captures raw (undeclared `k`) and
  `register_impl_closure_call_mappings` skipped the closure.

After the fix the closure signature + body are correct:
`int32_t closure(void* closure_context, int32_t x)` with
`x + ((cap*)closure_context)->k`.

**STILL DEFERRED (gaps B + C)** — the closure-param specialization subsystem
for a concrete (non-forall) user fn:

- **B**: the closure-value variable is typed `void*` not the capture struct
  (`void* add_k = (__yo_capture…){…}` — type mismatch). TS types it as the
  capture struct (`__yo_struct… inc = …`).
- **C**: `apply` is specialized as `…_rtparam0_Impl____Fn…` (the Impl(Fn) type
  is NOT lowered to the capture struct) and the specialized function is never
  emitted/declared (referenced once at the call site → implicit-decl error).
  TS lowers rtparam0 to the capture struct id and emits the body
  (`closure(&(f), x)`).

`register_impl_closure_call_mappings` + `generate_closure_construction` ARE
implemented in yo-self and now receive data (via the capture-info fix); the
remaining work is the eval-side specialization that lowers an `Impl(Fn)`
value-param to its concrete capture struct and registers the specialized
function for codegen emission.

---

## Direct closure-value call `add := Impl(Fn)({...}); add(5)` (2026-06-30)

Surfaced by differential testing (`/tmp/cgbugs/25_nested_closure.yo`): a captured
closure stored in a var and CALLED directly (not via a higher-order `apply`).
TS emits:

```c
__yo_struct_<cap> add = (<cap>){ .a = a };          // add typed as the CAPTURE STRUCT
int32_t r = closure_<id>(&(add), 5);                 // static dispatch: closure_fn(&add, 5)
```

Binary emits (both wrong):

```c
void* add = (__yo_capture_<id>){ .a = a };           // (1) add typed void*, not the capture struct
int32_t r = (((int32_t (*)(int32_t))add)(5));        // (2) cast struct->fn-ptr, NO closure_context
```

ROOT CAUSE (both symptoms, one cause): the `Impl(Fn)` closure value's `SomeT`
type is never resolved/lowered to its capture struct.

- (1) the init-assignment types `add` via `get_variable_type_string(Impl(Fn))`,
  which lowers to `void*` instead of the capture struct C name.
- (2) the closure-value-call path (`other_fn_call.yo:1436-1483`) IS implemented and
  WOULD emit the correct `closure_fn(&(add), args)` — it looks up
  `impl_closure_call_map.get(cc_id)` where `cc_id =
resolve_some_type_to_concrete(func_expr.ty).id`. But `func_expr` (`add`) has
  type `Impl(Fn)` (a `SomeT`) whose resolved-concrete is NOT recorded as the
  capture struct, so `cc_id` ≠ the map key (the capture-struct id) → MISS → falls
  to the wrong fn-ptr cast.

So the fix is the same gap B as the `apply` case: record/lower the closure's
`Impl(Fn)` SomeT → its capture struct (TS's `resolvedConcreteType`), via
`register_some_resolved_concrete(impl_fn_sid, capture_struct)` at closure creation
(closure_type.yo / anonymous_function.yo). Then `get_variable_type_string` lowers
`add` to the capture struct AND `resolve_some_type_to_concrete` makes `cc_id`
match `impl_closure_call_map` → correct static dispatch. This is a deep
closure-type-lowering subsystem (comparable to the 5-layer dyn auto-box chain),
deferred to a focused pass. NB: `impl_closure_call_map` + the call-site dispatch
(piece C) + `generate_closure_construction` are all already implemented — the
missing piece is the SomeT→capture-struct resolution that feeds them.

---

## ✅ RESOLVED (commit 255f4e59c) — Impl(Fn) closure value/param subsystem

The whole sync `Impl(Fn)` closure value/param family (the deferred gaps B/C above
AND the direct `add(x)` value-call) is FIXED by a SINGLE targeted registration,
once the prereqs (register_func_type + register_closure_capture_info, 60d55c7c4)
were in place. It was NOT a multi-layer chain after all.

Root cause: the closure's `Impl(Fn)` wrapper `SomeT` was never lowered to its
capture struct. TS carries `SomeType.resolvedConcreteType`; yo-self side-tables it
(`register_some_resolved_concrete` / `lookup_some_resolved_concrete`). With no
entry, `get_type_string(SomeT)` → `void*` (so the value mis-typed) and
`resolve_some_type_to_concrete` (the `cc_id` for `impl_closure_call_map`) → the
bare SomeT id (so the value-call missed the closure-call map and fell to a bad
fn-ptr cast). All the consumers — `generate_closure_construction`,
`register_impl_closure_call_mappings`, the value-call dispatch (piece C) — were
ALREADY implemented; the only missing piece was the resolved-concrete entry.

Fix (closure_type.yo, in the existing capture-info registration block):
`register_some_resolved_concrete(wrapper_SomeT.id, capture_struct)`. Now closure
values type as the capture struct, and both `add(x)` and `apply(add, x)` dispatch
through `impl_closure_call_map` as `closure_fn(&capture, x)`. Verified:
`04`/`04a` (apply, capture + no-capture), `25` (direct value-call),
`closure_impl_fn_capture.yo` (both) all match TS; corpus 93/93.

LESSON: a gap documented as a "deep multi-layer subsystem" can collapse to one
registration once its prereqs land — re-check before assuming depth.
