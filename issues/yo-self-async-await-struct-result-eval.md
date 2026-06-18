# yo-self: struct-result async + field access blocked on evaluator await-result-type resolution

## Status

✅ **RESOLVED for `io.await` (struct + any result type) — 2026-06-18.** A bound
`p := io.await(...)` now types concretely and downstream `p.field` compiles;
`tests/codegen-bootstrap/io_async_struct_field.yo` runs → `42`, corpus 66/66,
zero regressions. Fix below. **`JoinHandle.await` (`io.spawn` → `handle.await` →
`Option(T)` → `.unwrap()`) is still open** — it is a separate chain
(`is_join_handle_await_call` + `io.spawn`'s `JoinHandle(T)` return), not
`is_io_await_call`; apply the same mechanism to `io.spawn` (register under the
`JoinHandle(T)` argument id) + the `handle.await` field-fn dispatch.

### JoinHandle.await — DECISIVE finding (2026-06-18): method-resolution, not result-refine

Instrumented `is_join_handle_await_call` at the result arms: `handle.await(io)`
records via the **`out_none`** arm (the no-method-found path) with result type
**`unit`**. So `JoinHandle.await` is NOT a result-type-refinement case like
`io.await` — the `await` impl method on `JoinHandle(T)`
(`impl(forall(T), JoinHandle(T), await : __yo_join_handle_await)` in the prelude)
is **not being resolved** for the receiver `handle`, so the call soft-falls to a
unit-returning generic call. `result := handle.await(io)` is therefore typed
`unit`, no `result` C declaration is emitted, and `result.unwrap()` →
`// Failed to transpile`.

**FULLY ISOLATED (2026-06-18) — generic-impl pattern match fails on struct id.**
Layered instrumentation pinned it exactly:
- `get_receiver_methods_by_name_from_env("await", JoinHandle_3665)` → `hits=0`,
  instance call (`static=N`).
- The non-comptime generic-impl fallback (`env.yo`) calls
  `find_methods_from_generic_impls("await", JoinHandle_3665)` → `results=0`.
- Inside it: `field_entries=1` (the `impl(forall(T), JoinHandle(T), await : …)`
  generic impl IS registered and HAS an `await` field) but `matched=0` —
  `try_match_generic_impl` returns no match.
- `try_match_generic_impl` matches via
  `synthesize_types(entry.receiver_type_pattern = JoinHandle(T), resolved =
  JoinHandle_3665)`; that synthesis FAILS even though the receiver has the right
  shape: `recv_id=struct_yo_id_3665`, `recv_ta=1` (one type argument — correct
  arity for `JoinHandle(T)`).

So matching shape + arity but no match ⇒ the synthesizer rejects it on **struct
identity**: `JoinHandle` is a comptime type-constructor
(`JoinHandle :: (fn(comptime(T) : Type) -> comptime(Type))` in prelude), so the
impl-pattern's `JoinHandle(T)` instantiation and the `io.spawn`-result's
`JoinHandle(<output>)` get **different struct ids**, and `synthesize_types`'
struct case (`synthesizer.yo` ~1347 "Cannot unify incompatible struct types")
throws on the id mismatch. This is the SAME CLASS as the resolved HashMap.new
generic-instantiation blocker (`memory: yo-self-phase3-hashmap-new-blocker` —
struct identity for generic instantiations).

**DEFINITIVE root cause (2026-06-18) — `constructor_func_id` is not stable.**
Instrumented the synthesizer struct case (gated on the `__future` field label):
the impl-pattern JoinHandle has `constructor_func_id = yo_id_3658`, but the
receiver instantiations have `constructor_func_id = yo_id_3819` (or EMPTY).
`synthesize_types`' struct case matches two generic instantiations only when they
share `constructor_func_id` (`exp_cfid == giv_cfid`, synthesizer.yo:1341); since
JoinHandle's is **different across contexts** (3658 vs 3819), `same_constructor3`
is false, the ids differ, and it throws "incompatible struct types" → the await
impl never matches.

So JoinHandle's comptime type-constructor produces result structs stamped with
DIFFERENT `constructor_func_id`s depending on the evaluation context (impl
registration vs `io.spawn` return-type instantiation) — JoinHandle's `FuncVal`
apparently carries different func_ids in those contexts (the same func_id-stability
class as the resolved HashMap.new blocker). `evaluate_comptime_fn_call` stamps the
result with the constructor's func_id (function.yo:2241), but that id isn't
canonical/stable for JoinHandle across contexts.

**STAMPING SITE (2026-06-18): `comptime_fn.yo:843-846`.** When a comptime fn
returns a `Struct` whose `constructor_func_id` is empty, it stamps `func_id_str`
(the CALLED fn's func_id at this call). So `JoinHandle(X)`'s cfid = the JoinHandle
`FuncVal`'s func_id at that call — and that func_id is **3658 in the impl-pattern
context but 3819 in the io.spawn context** (and EMPTY on the pure-`substitute`
return-type path, which never reaches this stamp). I.e. the top-level `JoinHandle`
comptime fn is reached via `FuncVal`s with different func_ids in different
contexts, so its instantiations get different (or empty) cfids and the
generic-impl match's `same_constructor3` never holds.

**WHY the fid differs (bottom of the chain):** `func_id_str` is just the called
`FuncVal`'s `fid` (`comptime_fn.yo:364`). JoinHandle is a top-level binding, but it
is reached via DIFFERENT `FuncVal` instances (different fids: 3658 vs 3819) in the
impl-registration context vs the `io.spawn` return-type context — i.e. the binding
does not resolve to one canonical `FuncVal`. yo-self's `FuncVal` is anonymous (no
stable definition-site identity / name field), so there is no ready canonical id
to stamp. A real fix needs either (a) a stable constructor identity carried on the
`FuncVal` (definition-site id or binding name) that survives cloning/re-eval, or
(b) de-duplicating a top-level comptime-constructor binding to a single `FuncVal`.
Both are deep/central. This is the true bottom of the JoinHandle.await chain.

**The fix is func_id CANONICALIZATION for comptime type-constructors:** stamp (and
match on) a constructor identity that is stable across module/context — e.g. the
constructor binding's original definition-site func_id (carried on the `FuncVal`),
or its export-qualified name — instead of `func_id_str` (the per-context call
func_id). This is deep + central (touches every comptime-type-constructor struct
stamp + the synthesizer match) with regression risk to std/tests, so it warrants a
focused session with full validation; it is the same class as the resolved
HashMap.new func_id blocker. Earlier framing:

stamp `constructor_func_id` from a CANONICAL constructor
identity (stable across module/context — e.g. the constructor's original
definition-site func_id or its export name), so all JoinHandle instantiations
share it and `same_constructor3` holds. (A narrower alternative — match by field
labels + type-arg arity in the generic-impl-match path — is structural and was
previously shown unsound for exact cache keys, so prefer the cfid-stability fix.)

**Earlier (superseded) fix-direction note:** make `JoinHandle(T)` instantiations share a stable struct id
(comptime-type-constructor result caching/identity), OR relax the struct case in
`synthesize_types`/`try_match_generic_impl` to unify two instantiations of the
same generic struct constructor by NAME + type-arguments rather than requiring id
equality (carefully — name-only struct comparison was previously shown unsound for
exact cache keys; scope it to the generic-impl-match path). Once the await impl
matches, `handle.await` resolves to `Option(T)` and the (separate) `Option`-result
nested-SomeType resolution + `.unwrap()` can follow.

**(superseded) The earlier framing — "method-resolution, not result-refine":**
The generic-impl method lookup must find `JoinHandle(T)`'s `await` for a receiver
whose type is `JoinHandle(<future-output>)` (after `io.spawn`). Likely the
receiver's `JoinHandle` type arg `T` is unresolved / the generic-impl match
(`try_match_generic_impl` / `get_receiver_methods_by_name_from_env`) doesn't bind
it, so the method isn't found. Next step: instrument the method-lookup for
`handle.await` (why `get_receiver_methods` returns none for `JoinHandle.await`),
then ensure the `await` impl resolves; only after the method dispatches will the
`Option(T)` result + `.unwrap()` need the (separate) nested-SomeType resolution.

### JoinHandle.await — earlier instrumented findings (superseded by the above)

Probed `is_io_spawn_call` / `is_join_handle_await_call` at the result arms:
- `io.spawn(task, io)` reaches the `try_to_call` runtime-return path (2729) and
  returns `<struct:struct_yo_id_3665>` — the `JoinHandle` struct. The print shows
  no visible type-argument SomeType (need to inspect `JoinHandle`'s
  `type_arguments` — `T` should be the future-output SomeType id already
  registered by `io.async`).
- `handle.await(io)` reaches `evaluate_function_call` (entry probe fires) but
  records its result via NONE of the probed arms (out_op @ ~984, out_m @ ~2961,
  try_to_call rt @ 2729). So it exits through a still-unidentified arm (or throws)
  — `result := handle.await(io)` produces NO C declaration at all (only `handle`
  is declared, then `return // Failed to transpile (result.unwrap)()`).

So two more sub-problems beyond `io.await`:
1. Find `handle.await`'s actual result-recording arm (continue the same
   instrument-the-remaining-`out_*`-sites method; candidates left: out_m@1298
   module, out_u, out_idx, out_none@~3011, the body-exec `out`).
2. Its result is `Option(T)` (not a bare `T`), so the refinement must resolve the
   SomeType NESTED inside `Option`'s type argument — generalize the io.await
   refinement to recurse into enum/struct `type_arguments` (or reuse a
   substitute-by-registered-id walk), so `result : Option(Point)` and
   `result.unwrap()` dispatches.
Also verify `io.spawn`'s `JoinHandle(T)` carries the registered future-output
SomeType id (so step 2's lookup hits).

### The fix that landed (narrow, regression-free)

In `evaluate_function_call`'s `try_to_call_function_with_arguments` runtime-return
path (`function.yo`, where `io.async`/`io.await` extern builtins actually record
their result — located by instrumentation, NOT the FuncVal-forall loop nor the
2446 path):
- `io.async`: extract the future-output SomeType id via `_future_output_some_id`
  (which unwraps the `Impl(Future(T,E))` = a `SomeT` whose `required_trait_types`
  holds the `FutureTraitT`), read the closure's CONCRETE result from the closure
  arg's `ExprInfo.value` `FuncVal` → `get_func_type(func_id).result` (the recorded
  arg type still has a SomeType result; the side-table has the refined `Func`),
  and `register_some_resolved_concrete(output_id, result)`.
- `io.await`: when this call's own result type is that SomeType,
  `lookup_some_resolved_concrete` and set `ret_type_rt` (the bound variable's
  type) to the concrete type — NOTHING ELSE (no env binding, no future-type
  change, no `synthesize_types` change).

Two prior mistakes corrected by this: (a) `cinfo.closure_function_value` is None
for the io.async closure — use `cinfo.value` instead; (b) the result is
`Impl(Future(...))` (a SomeT-with-required-FutureTrait), not a bare `FutureTraitT`
— must unwrap.

## (Historical) Status

PARTIAL. The **codegen** side of resolving an `io.await` result type to its
concrete type is now fixed (two commits below); a struct-returning `io.async`
whose awaited value is **field-accessed** still fails because the **evaluator**
leaves the await result type as an unresolved SomeType, so the field-access
expression downstream never receives ExprInfo.

## Reproducer

```rust
{ println } :: import("std/fmt");
Point :: object(x : i32, y : i32);
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => Point(i32(40), i32(2)));
  p := io.await(task, io);
  p.x + p.y
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```

- **TS reference**: prints `42`.
- **yo-self-bin** (after the two codegen fixes): `p` now declares correctly as
  `__yo_struct_..._Point* p = __sync_await_result;` (was `void* p`), but the tail
  expression emits `return // Failed to transpile (p.x) + (p.y);`.

Direct-use awaited values (i32 / str / bool returned or printed, NOT
field-accessed) already work — `io_async_{await_42,str,bool}` corpus fixtures —
because the awaited value is passed through opaquely; only field access on the
awaited struct exposes the missing ExprInfo.

## What was fixed (codegen, corpus 65/65, zero regressions)

1. `generate_io_async_sync_call` (`exprs/async.yo`) now **registers** the resolved
   concrete result under the future-trait output SomeType id
   (`register_some_resolved_concrete(output_some_id, result_type)`), so the
   matching `io.await` site — same future type → same output SomeType id — can
   resolve the awaited value's type.
2. `get_type_string`'s SomeType branch (`codegen/utils/index.yo`) now resolves a
   registered SomeType via `lookup_some_resolved_concrete(id)` (recursing on the
   concrete type) before falling back to `get_type_c_name` / `void*`. This makes
   the `p :=` binding declare `p` as `Point*` instead of `void*`.

## Remaining gap (evaluator)

The `io.await(task, io)` call's result type is left as the future-trait output
**SomeType** during evaluation. Because `p`'s type is therefore an unresolved
SomeType at eval time, the field-access `p.x` cannot be type-checked, so neither
`p.x` nor the enclosing `(p.x) + (p.y)` receives an ExprInfo entry — and codegen
hits the `get_expr_info == None` → `// Failed to transpile` fallthrough.

**Fix direction:** resolve the `io.await` result type to the concrete future
output **in the evaluator** (mirror the TS await-result-type resolution that pulls
the concrete output from the awaited future's type), so downstream expressions on
the awaited value type correctly and get ExprInfo. This is the evaluator
counterpart of the codegen registration above; once it lands, add a corpus fixture
(`io_async_struct_field` — currently kept OUT of the green corpus).

## COMPLETE ROOT CAUSE + FIX RECIPE (2026-06-18 — systematically traced)

Both blockers share one root: `T` is never bound to the concrete result at
**eval** time, so the future/await/spawn/unwrap chain stays `SomeType`. Traced
the exact dispatch and fix sites by elimination (two speculative attempts in the
FuncVal forall loop were implemented, tested, and reverted — see below):

1. `io.async` / `io.await` / `io.spawn` are `extern("Yo", …)` builtins
   (`std/prelude.yo:8195`). Their signatures use `Impl(Fn(e : E) -> T)` params
   and `Impl(Future(T, E))` / `JoinHandle(T)` returns. **`Impl(Fn(...))` lowers to
   an `FnTraitT`** (there is no `ImplT` TypeValue variant), `call_result = T`.
2. Extern calls do **NOT** go through `evaluate_function_call`'s `forall`
   inference loop (that path is for FuncVals/closures with bodies). They bind
   `forall` vars via **`check_if_function_parameter_matches_argument`**
   (`helper.yo:409`) → **`synthesize_types`** (`helper.yo:536`), unifying the
   declared param type against `arg_type = arg_info.ty`.
3. For the closure arg, `arg_info.ty` still carries a `SomeType` **result** (the
   body-refined concrete result lands in the func_id side-table, readable via
   `get_func_type(closure_func_id)` — the same bridge the async **codegen** uses).
   So `synthesize_types` binds `T = SomeType`.

**Fix (two coordinated sites, central synthesizer — do as a focused session with
full std + tests + corpus validation):**
- `helper.yo` ~530, before the `synthesize_types` call: when the arg VALUE is a
  closure `FuncVal` and `resolved_pt` is fn-like (`FnTraitT`), compute an
  `arg_type_for_synth` from `get_func_type(closure_func_id)` (the refined `Func`
  with the concrete result) and pass THAT to `synthesize_types` (keep `arg_type`
  for the Step-8 compatibility check).
- `synthesizer.yo` `_synthesize_fn_traits` (961-964): it extracts
  `giv_params`/`giv_result` ONLY from a `FnTraitT` given-type; a bare `Func`
  given-type falls through to `TypeValue.Unit`. Add fn-like extraction so a `Func`
  given-type's `param_types`/`result` are read (normalize `Func` + `FnTraitT`),
  so `exp_result = T` unifies against `giv_result = Point` and binds `T`.

Once `T` binds at eval time, `task : Future(Point)`, `io.await → Point`,
`io.spawn → JoinHandle(Point)`, `handle.await → Option(Point)` all resolve
naturally, `p.x` / `result.unwrap()` get ExprInfo, and both fixtures compile.
The async **codegen** registration already in place (prior commits) becomes
belt-and-suspenders.

### ⚠️ CORRECTION (2026-06-18): the "bind T at io.async synthesis" approach
### REGRESSES ALL ASYNC — do NOT implement it as written above.

I implemented exactly the two-site recipe above (helper.yo closure→`Func` bridge
before `synthesize_types` + `_synthesize_fn_traits` reading a `Func` given-type's
params/result) and validated against a rebuilt yo-self-bin. Result: **7 SELF-FAIL
in the corpus (58/65) — every async fixture broke** (`io_async_str`,
`io_async_await_42`, the FSM fixtures, …). Even `task := io.async(...)` then
`// Failed to transpile` (io.async eval now throws and the def-eval trial wrapper
swallows it → no ExprInfo). Both files reverted; corpus back to 65/65.

**Why:** the async pipeline DELIBERATELY keeps the future-trait OUTPUT as an
unresolved `SomeType` through evaluation — the FSM / future-completion / await
machinery keys on that SomeType identity (the `g_some_resolved_concrete`
registration + `get_type_string` resolution done at CODEGEN in the prior commits
is the intended resolution layer). Binding `T` to the concrete result at
io.async's arg-synthesis time collapses that SomeType eagerly and breaks the
downstream async handling for ALL futures, not just struct results.

**Revised direction:** do NOT resolve the future's output SomeType at eval.
Instead resolve ONLY the narrow case that needs it — the type of a binding
`p := io.await(...)` (or `result := handle.await(...)`) — so that DOWNSTREAM
field/method access (`p.x`, `result.unwrap()`) type-checks and gets ExprInfo,
WITHOUT touching the future's output SomeType or the io.async result. Candidate:
in the `io.await` / field-`await` result-type handling, when the awaited future's
output resolves to a concrete type (via the same func_id side-table bridge), set
the AWAIT-CALL's own result type (and thus the bound variable's type) to that
concrete type — a local refinement at the await site, leaving the future type
untouched. Validate that this leaves all async fixtures green (the regression
above is the trap to check against).

### ✅ SAFE MECHANISM confirmed + remaining unknown is the SITE (2026-06-18)

The **narrow** mechanism (distinct from the regressing env-binding) is sound and
SAFE:
- At `io.async` eval: record the closure's CONCRETE result (read via
  `get_func_type(closure_func_id)` — the closure `FuncVal` is on the io.async
  arg's `ExprInfo.closure_function_value`, set in `closure_type.yo:279`) under the
  future-output SomeType id, into `g_some_resolved_concrete`
  (`register_some_resolved_concrete`).
- At `io.await` eval: if the call's result type is that SomeType, refine ONLY this
  call's OWN `resolved_ret`/`ExprInfo.ty` via `lookup_some_resolved_concrete` —
  never the future type, never an env binding, never `synthesize_types`.

Safety is verified: `lookup_some_resolved_concrete` has **no evaluator reader**
(only codegen reads it: async/await/state_machine/utils/closures), and
`register_some_resolved_concrete` is already called from eval (synthesizer.yo). So
registering at io.async eval can't perturb async eval; it only feeds codegen
(idempotent with the existing `generate_io_async_sync_call` registration) plus the
new io.await refinement.

**The remaining unknown is purely the SITE.** I implemented this mechanism at the
plain-FuncVal runtime-return path (`function.yo:2446`, where `out_rt`/`resolved_ret`
are built) — but it produced BYTE-IDENTICAL broken output (no effect), proving
`io.async`/`io.await` results are NOT computed there. Sites eliminated so far:
1. `evaluate_function_call`'s `forall` inference loop — not on the path.
2. `function.yo:2446` plain-FuncVal runtime-return path — not on the path.
3. `synthesize_types` env-binding of `T` — ON a path but REGRESSES all async.

`io.X` is a property-access (`io . async`) resolving to a struct-field `FuncVal`,
then called — so the result type is built on a method/property-callee arm of
`evaluate_function_call` (candidates: the `out_m`/`out_s`/`out_e` arms around
`function.yo:1257/1338/1460`, or the property-access callee handling), NOT the
bare-FuncVal arm.

**NEXT-SESSION METHOD (stop guessing — instrument):** add a module-path-guarded
`eprintln` gated on `is_io_async_call(expr)` / `is_io_await_call(expr)` at each
candidate `new_expr_info(...)` result site in `function.yo`, rebuild yo-self-bin
ONCE, compile `/tmp/as.yo`, and observe which site fires for the io.async/io.await
calls. Then apply the SAFE mechanism above at that exact site and validate against
the corpus (the 7-SELF-FAIL regression from approach #3 is the trap).

## Dispatch-path finding (2026-06-18 — avoid this dead end)

The fix is NOT in the generic FuncVal-call `forall` inference loop in
`evaluate_function_call` (`function.yo`, the `fa_bound` direct-match +
receiver-type-args + capture fallbacks). I implemented and tested a recursive
`_infer_forall_nested` helper there (binds a `forall` from a NESTED position of a
declared param type vs the arg type — `Func` result/params, `FutureTraitT` output,
`Struct` type_arguments) and wired it as a fallback. It is correct in principle,
left the corpus at 65/65 with zero regressions, but fixed **neither** this case
**nor** `JoinHandle.await` — so it was reverted as speculative (no concrete win).

Reason: neither blocker routes through that loop.
- **struct-result async** is **builtin-dispatched** (`io.async`/`io.await` are io
  builtins). The await result type must be resolved on the builtin-call path, and
  the awaited value's type must resolve at EVAL time (not just codegen) so `p.x`
  gets ExprInfo.
- **`JoinHandle.await`** is a **field-fn call** (`await` is a function-typed FIELD
  of `JoinHandle`). `handle.await(io)` returns `Option(T)`; `T` stays SomeType so
  `result := handle.await(io)` is `Option(SomeT)` and `result.unwrap()` →
  `// Failed to transpile`. The `T` must be bound from the receiver
  `handle : JoinHandle(T_concrete)` on the **field-fn-call dispatch path** (the
  receiver's `type_arguments`), which is a different code path from the FuncVal
  forall loop. TS reference prints `42` for:
  ```rust
  run :: (fn(io : Io) -> i32)({
    task := io.async((io : Io) => i32(42));
    handle := io.spawn(task, io);
    result := handle.await(io);
    result.unwrap()
  });
  ```
  (`io.spawn(task, io)` takes 2 args; `handle.await(io)` returns `Option(T)`.)
