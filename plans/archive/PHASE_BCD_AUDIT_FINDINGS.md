# Phase B/C/D audit findings — what we discovered, what's broken, what's next

Status: **REPAIRED.** Phases B, C, and D (for-macro) work end-to-end on `Array(T, N)`, `Slice(T)`, `ArrayList(T)`, and `String` at runtime as of commit `cd1e9eaf`. The pre-existing Slice slicing-typing bug was resolved by updating Array/Slice `Index` impl bodies to pass `&(self)` to the `*(T)`-expecting builtins (mirroring the Indexable.project fix from commit `c36429c8`).

## Tl;dr (history)

Phases B, C, and D of `plans/ITERATOR_REDESIGN.md` were committed (`ebe910a6`, `ca518556`, `d9ddb7d3`, `c36429c8`, `9b089395`, `e9143f5e`) and reported as "all tests passing." **All those test reports were phantom.** Since `a3510d20` (2026-05-19), the Yo test framework had been silently skipping test bodies — emitting `/* "match" expression is not evaluated */` in the generated `__yo_user_main`, running an empty `main`, exiting 0, and reporting "passed." Commit `7b3b788b` repaired the test framework. With real test signal, three concrete bugs surfaced and have now been fixed:

- ~~**Phase C's `Indexable(usize).project(...)` impls compile but fail to type-check at the call site.**~~ **FIXED** by `4bee3bc3` (extend `*(T)` body-typing to the generic-impl specialization path in `impl.ts`) + updating `Array.project` and `Slice.project` bodies to pass `&(self)` rather than bare `self` to `__yo_array_index`/`__yo_slice_index`.
- ~~**Phase D's for-macro expands to `coll.project(pos)` where `coll` is a local. Phase B's flowability rule R3 rejects this**~~ **FIXED** by `75f43055` (relax R1 at the binding site: same-frame locals are flowable, while the strict ref-bound-only rule still applies at function-return sites where the soundness argument actually matters). For-macro also updated in `afede287` to skip the intermediate `__for_coll := coll` copy so writes propagate through value-typed collections.
- ~~The `ref(name) := projection_call(...)` binding has additional gaps further along the auto-deref / type-propagation chain~~ **FIXED** by `3b66f07b` (flowability R3 recognizes method-dispatch calls — `outer.project(...)`) and `9fcda34c` (init-assignment codegen declares the call's intermediate temp as `T*` when the variable is marked `isRef`).

## What works end-to-end now

- `tests/ref_binding.test.yo` — 4/4 passing. `ref(r) := flowable_call(...)` reads and writes through a chain of `ref`-bound function parameters.
- `tests/indexable_runtime.test.yo` — 9/9 passing. Covers `arr.project` (Array), `list.project` (ArrayList), `s.project` (String), `slice.project` (Slice) — all with read AND write semantics.
- `tests/for_macro_borrow.test.yo` — 10/10 passing. `for(coll, ref(x) => body)` on Array, ArrayList, String, Slice — iteration, write-through, empty collections, capture-interaction, byte iteration on Strings.
- `tests/closure_capture_rc_leak.test.yo` — 7/7 passing. Migrated to `.into_iter()` value form.
- `./yo-cli check ./std` — 148/148 passes throughout the repair.

## Task #94 — Slice.project — RESOLVED

The original symptom: `s := arr(usize(0) .. usize(3))` evaluates to `i32` instead of `Slice(i32)`, so `s.len()`, `s(usize(1))`, and `s.project(...)` all failed with "Invalid function call on type i32".

**Root cause:** The Array/Slice `Index(usize/Range/RangeInclusive)` impl bodies in `std/prelude.yo` passed `self` (value-typed in the body's view of a `ref(self) : Self` parameter) to `__yo_array_index`/`__yo_slice_index`/etc, which expect `*(Array(T,N))`/`*(Slice(T))`. The evaluator's specialization step couldn't satisfy the type-check, so the impl method was never bound to the dispatch, and `arr(range)` fell back to the element-by-position overload.

**Fix:** Commit `cd1e9eaf` — change every Array/Slice Index impl body to use `&(self)` (mirroring the Indexable.project fix from commit `c36429c8`). `generateIndexTraitCall` inlines `&calleeCode` directly at every call site, so the standalone-emitted Index method body is only used by the evaluator's body-typing pass, not by the call site.

## Broader test-suite picture

The test-framework silent-skip repair (commit `7b3b788b`) made the entire test suite — not just iterator tests — actually run for the first time since `a3510d20`. That exposed a large number of latent failures **orthogonal to the iterator redesign**. Of the ~1253 failures observed in the first sweep after `7b3b788b`, the following structural fixes have landed in this branch:

- ~~`comptime(name) : T` binding form no longer parsed~~ **FIXED** by `f4758e8b` (restore the `comptime(...)` wrapper unwrap in `evaluateBinding` — removed alongside `given(...)` in `a3510d20`).
- ~~Auto-derived `to_string` for enums fails to compile because the match-subject codegen emits `Type self = (*self);` on top of the `T*`-typed parameter, causing C "redefinition of self with a different type"~~ **FIXED** by `f4758e8b` (skip the temp-var assignment when the subject is a `ref`-bound parameter atom; same guard already used in begin.ts / return.ts / cond.ts).
- ~~`imm.Vec(T)` had no `Index(usize)` impl~~ **FIXED** by `c820d2b5`.
- ~~`panic(...)` was eagerly typed as the function's overall return, so divergent panic arms inside nested matches couldn't unify with sibling-arm types (blocked LinkedList Index, ImmList Index, etc.)~~ **FIXED** by `b7688519`: `panic` now reads `context.expectedType` first and falls back to the function return only when nothing closer is available; `match` arm evaluation now passes the running `resultType` as `expectedType` so divergent arms pick up the unified type.
- ~~`LinkedList(T)` had no `Index(usize)` impl~~ **FIXED** by `b7688519` using the above panic/match unification.
- ~~`imm.List(T)` had no `Index(usize)` impl~~ **FIXED** by `d1a07bdc` (same pattern).
- ~~`JsonValue` had no `Index(String)` / `Index(usize)` impls~~ **FIXED** by `1399106a` (uses `ArrayList.project` under the hood; impl-only — tests still blocked because `json_parse` has the Exception-forward-decl issue below).
- ~~`asm(...)` operand `ref(reg, x)` parsed as a variable lookup~~ **FIXED** by `81ba6874` (rename slip-through; the asm operand parser now accepts `ref` as an alias for `inout`).
- ~~`HashMap` had no `Indexable`/for-macro support~~ **FIXED** by `e5a21392` — closes task #88 and resolves the plan's Open Question 3. `HashMap.iter()` now returns the position-iter `HashMapPosIter` (was the pointer-iter `HashMapIterPtr`, kept as `iter_ptr()` for low-level callers); `Indexable(usize).project(pos)` returns `ref(Bucket(K, V))`; user destructures `b.key` / `b.value` inside `for(map, ref(b) => body)`.
- ~~Auto-derived `Clone` for `HashMap` broke after the iter migration~~ **FIXED** by `8a705b58` (use `iter_ptr()` explicitly).
- **Attempted: closure bodies skipped by generation heuristic** (commit `a256da32`, reverted in `14fcc6d1`). The codegen-side skip via `typeContainsSomeType(Io) == true` was loosened to use a struct-field-aware variant for closure params only. Closure bodies then reached `generateFunction`, but surfaced a separate spawn-wrapper-vs-body signature mismatch (wrapper passes `(closure)` with one arg while body declares `(closure_context, io)` with two), and the body itself failed to codegen `shared.*` deref because its env lacks proper type info for captured variables. Both downstream issues need solving before this skip-loosening is useful, so it was reverted to avoid swapping the linker error for the wrapper/body signature error.
- ~~Iterator combinator chains infinite-looped because `self._inner.next()` operated on a copied local temp instead of mutating the actual stored inner iterator~~ **FIXED** by `c29580fa`. The codegen `other-fn-call.ts` materialized any complex arg expression (e.g. `(*self)._inner`) into a local temp before the isRef-wrapping took its address — so `next(&(temp))` mutated the temp, which was discarded after the call, leaving the inner iterator's index unchanged. Fix: skip the temp-var materialization for args whose corresponding parameter is `ref`-bound, and return the place expression directly so isRef-wrapping emits `&((*self)._inner)`. Unblocks `iterator_combinators.test.yo` (10/19 → 19/19), HashMap `keys()`/`values()` iter, BTreeMap iter, and `iter_filter_closure` tests.

Test-suite status after these fixes: **1753/2508 passing** (up from 1253 immediately after `7b3b788b`, a +500-test improvement across this session). Remaining 755 failures cluster into the following orthogonal root causes:

- **Async/await generic inference** (~120 tests in `async_await.test.yo`, `sys/bufio.test.yo` etc.): `io.async`/`io.await` fails to unify the lambda's return type with the trait's `T` parameter. `Impl(Future)` types lack registered concrete types. Deep evaluator/specialization work.
- **Auto-derived `___dup` for structs that transitively contain `ctl(...)`-typed fields** (~71 tests in `algebraic_effects.test.yo`): ctl-bound values can't be returned, but the derived dup tries to. Needs the derive-rule logic to detect transitively-ctl fields and either skip-dup or generate a stub.
- **Missing forward declarations for non-generic functions with Exception parameters** (`base64_decode`, `Url.parse`, `json_parse`, etc. — ~100 tests in `encoding/*`, `url/url`, `fn`): `typeContainsSomeType(Exception)` returns true because of the nested `throw : (fn(forall(T, E), ...))` field, which makes the over-aggressive declarations/generation skip heuristics treat every function taking Exception as "generic" and skip its declaration AND its body. The natural fix is to make `typeContainsSomeType` not recurse into struct fields' forall parameters — but a previous attempt (later reverted) cascaded into call-site lowering failures, suggesting the call-site emitter also needs adjustment in tandem.
- **Missing forward declarations for thread/channel/worker closure bodies** (~80 tests in `sync/*`, `imm_threading`, `arc`): closure body cName referenced by `__yo_spawn_wrapper_*` but the closure's `static inline` body is never emitted.
- **Tree-collection Index impl dispatch** (`imm.Map`, `imm.SortedMap`, `imm.Set`, `imm.SortedSet` — ~80 tests): the Index trait body type-checks fine and `yo-cli check ./std` accepts it, but at user-call-site `m(key)` the dispatcher fails to find the impl. Differs structurally from HashMap (which dispatches fine) only in the type constructor's `where` constraints + `struct(...)` vs `object(...)` wrapping. Needs `tryMatchGenericImpl` debugging.
- ~~**Iterator combinator chains**~~ **RESOLVED** by `c29580fa` (see above).

All buckets pre-date the iterator redesign and are tracked separately. They are documented for follow-up work — each requires its own focused effort with regression-safe scope.

Once `Slice.project` works at runtime, the existing `tests/indexable.test.yo` Slice tests should pass without further changes.

## Original tl;dr (preserved for context)

Phase D needs a design revision before the implementation can be repaired. Phase C's body shape needs a different approach to dereferencing `self`. Phase B's flowability rule needs an additional case to admit common use cases.

## How we got here

Phase E ("user-facing migration" — docs + remaining `.iter()` callsite cleanups + HashMap Indexable) was started. Migrating the combinator/closure tests from `src.iter().for_each((x) => x.*)` to the new shape, I noticed several tests were passing under suspicious circumstances: assertions whose lambdas referenced `x.*` on a `usize` position somehow still gave the right numerical answers. That looked like a coincidence-of-arithmetic. Probing `assert(i32(1) == i32(2))` reported "passed." A guaranteed-fail test passing is a tell.

Working back from there:

- `src/codegen/exprs/match.ts:185` emits `/* "match" expression is not evaluated */` when `expr.$` is not set on a match expression.
- Generated `__yo_user_main` C bodies (in `tests/.yo_test_batch_*.c`) consistently contained that stub since around 2026-05-20.
- May 18 test-batch C files (e.g. `tests/.yo_test_batch_1779105915847_rks2ms.c`, ~548 KB) contained real test bodies. May 20 files (~36 KB) were empty.
- `git bisect` on commits between the two pointed at `a3510d20` ("Remove implicit param. Remove using/given keywords. Add ctl keyword back. Rename escape to unwind.").

## Root cause of the test-framework regression

`src/test-runner.ts` generates a batched main per file:

```yo
main :: (fn(io : Io, exn : __yo_test_exn.Exception) -> unit)({
  match(__yo_batch_env.env.get(`YO_TEST_INDEX`),
    .Some(__yo_test_idx) => cond(
      (__yo_test_idx == `0`) => { /* test body 0 */ },
      ...
    ),
    .None => ()
  );
});
```

Pre-`a3510d20`, the signature was `fn(using(io : Io))`. Implicit params went into a separate `implicitParameters: FunctionParameter[]` array. `using` was removed in `a3510d20`; both `io : Io` and a newly-added `exn : Exception` were placed in the regular `parameters` array.

In `src/evaluator/calls/function-type.ts`:

```ts
const shouldDeferBodyEvaluation =
  newFunctionType.forallParameters.length > 0 ||
  newFunctionType.parameters.some((p) => typeContainsSomeType(p.type)) ||
  (newFunctionType.SelfType && typeContainsSomeType(newFunctionType.SelfType));
```

`Io` is a struct whose fields are `async`, `await`, `spawn`, `state`, each typed `fn(forall(T : Type, E : Type.Struct), …)`. `typeContainsSomeType` recurses into struct fields, hits the function types, sees `forallParameters.length > 0`, and reports the parameter type as "containing SomeType." Same for `Exception` (`throw : ctl(forall(ResumeType), …)`). The predicate fires, `main`'s body is deferred, no specialization ever happens because `main` is the entry point, and codegen falls through to the empty-stub branch.

The deferral predicate's behavior is technically a separate evaluator bug — it should distinguish "free" SomeTypes (referring to outside) from those locally bound by a nested function's `forall(...)`. I sketched a `typeContainsUnboundSomeType` walker that tracks "locally bound" SomeType names; with it, `Io` and `Exception` no longer trigger deferral on the test runner main, but **14 unrelated stdlib files break** because they contain code that _only worked under the deferred body path_ (e.g., `std/async.yo`'s `yield :: fn(io : Io) -> Impl(Future(unit))` has `io.async(() => …)` where the closure is 0-arg but `io.async`'s `action : Impl(Fn(e : E) -> T)` expects 1 arg — the mismatch was masked by deferred evaluation). So a "principled" evaluator fix has a wide blast radius.

The workaround that landed in `7b3b788b` is narrower: the test runner now generates `main :: (fn() -> unit)({ io :: __yo_builtin_io; … })`. No params, no `exn`. The `io` binding aliases `__yo_builtin_io` (already defined in `std/prelude.yo`); tests using `io.async`/`await`/`spawn` continue to work. Tests using `exn` already construct their own `Exception` value locally (verified in `tests/error.test.yo` line 36–48, etc.), so dropping the injected `exn` is safe.

## What the test framework fix reveals

Once tests actually run their bodies, the following are now reproducible bugs:

### Bug A: Phase C `Indexable.project` body type-check fails at call

```yo
arr := [i32(1), i32(2), i32(3)];
ref(r) := arr.project(usize(1));
```

```
Error: Cannot unify incompatible types:
Expected: "*([T; N])"
Given: "[i32; 3]"
at std/prelude.yo:5609:31 (__yo_array_index(self, pos))
```

The impl body is:

```yo
project : (fn(ref(self) : Self, pos : usize) -> ref(T))(
  unsafe(__yo_array_index(self, pos))
)
```

`__yo_array_index`'s declared signature (prelude line 147):

```yo
__yo_array_index :
  fn(forall(T : Type, N : usize), self : *(Array(T, N)), idx : usize) -> *(T),
```

It expects `self : *(Array(T, N))`. Inside `project`'s body, `self` is bound with type `Self = Array(T, N)` (the value type), not `*(Self)`. The evaluator does not auto-take-address for `ref` parameters when calling functions that expect a pointer.

The existing `Index(usize)` impl on `Array` (prelude line 5571–5577) has the **same body shape** (`__yo_array_index(self, idx)`) and would fail the same way. It hadn't been observed because users invoke it via the paren-form sugar (`arr(usize(1))`), which short-circuits through `src/evaluator/calls/index-trait.ts::tryToCallWithIndexTrait` — that path returns `IndexCallResult` metadata for codegen _without_ evaluating the impl body. Only explicit `arr.index(...)` / `arr.project(...)` method calls reach the body evaluator.

I tried `unsafe(__yo_array_index(&(self), pos))` as a local fix. It passes the in-body type check but then fails downstream: `ref(r) := arr.project(usize(1)); r == i32(2)` errors with `Expected: *(i32), Given: i32`, indicating the auto-deref-on-read for `ref`-bound locals isn't fully wired through equality operators (or the chain otherwise leaks). Did not pursue.

Same body shape is used by Slice (`std/prelude.yo:5671–5680`), ArrayList (`std/collections/array_list.yo:511–522`), String (`std/string/string.yo:2116–2131`). All four impls compile but none has actually been validated at runtime.

### Bug B: Phase D for-macro vs Phase B flowability rule are inconsistent

For-macro expansion (Phase D — `std/prelude.yo:7796–7853` after the most recent edit):

```yo
{
  __for_coll := unquote(coll);                  // local
  __for_iter := __for_coll.iter();
  while(runtime(true), {
    match(__for_iter.next(),
      .Some(__for_pos) => {
        ref(name) := __for_coll.project(__for_pos);   // (*)
        body
      },
      .None => break
    );
  });
}
```

The line marked `(*)`: `ref(name) := __for_coll.project(__for_pos)`. Phase B's flowability rule R3 (`src/evaluator/types/flowability.ts:170–192`) says `expr(args)` is flowable iff:

- callee return slot is `ref(T)` ✓
- every `ref`-typed argument is itself flowable

`project`'s first parameter is `ref(self) : Self`. The argument is `__for_coll`, which is a plain `:=` local bound in the for-macro expansion (not `ref`-bound). Locals do not satisfy R1 (`isRef: true`). The flowability check rejects the RHS:

```
Error: 'ref(name) := ...' requires a ref-yielding right-hand side that
  roots back to a 'ref'-bound parameter. The expression on the right is not flowable:
    __for_coll.project(__for_pos)
```

(Reproduced via `/tmp/probe_phase_b.yo` — see workflow notes below.)

This means Phase D's for-loop cannot work as long as Phase B's flowability rule is enforced as written. The two phases were never simultaneously exercised at runtime, so the contradiction sat unnoticed. The plan example in `plans/ITERATOR_REDESIGN.md` describes exactly this expansion as if it works.

### Bug C: `ref` deref chain has gaps beyond the immediate parameter binding

Even with `unsafe(__yo_array_index(&(self), pos))` smuggling past the in-body type check, the read `r == i32(2)` where `r` is `ref`-bound fails to unify with `Expected: *(i32), Given: i32`. The C-ABI plan said reads of a `ref` binding emit `(*r)`, so `r` in expression position should produce `T`, not `*(T)`. Either the evaluator-level type-check tracks `r` as `*(T)` and the read site doesn't deref, or the `==` operator's overload resolution doesn't apply the deref. Did not trace further.

## Why phantom passes hid this

A genuinely-running Phase B test would have surfaced bug B on the first run. A genuinely-running Phase C test would have surfaced bug A. The test framework's empty-stub generation meant _every_ assertion in _every_ test body since `a3510d20` was a no-op: the binary did nothing, exited 0, was reported "passed."

`./yo-cli check ./std` continued to pass during this period because the OUTER function types (e.g. trait method declarations, impl-time signatures) checked fine; the BODY evaluation that would have surfaced the type mismatch was being silently deferred (Phase C generic impls) or in the case of `main` was being elided to the stub.

Standalone `/tmp/*.yo` probes that I used during Phase A/B development happened to exercise the working paths (paren-form sugar, simple Phase A `ref(T)` return slots, isolated `ref(name) := unsafe(...)` bindings without the projection-chain) and never hit the broken cases. So the bugs went unobserved through Phase C and Phase D landings.

## Files / commits involved

Commits on the `improve-memory-safety` branch implicated in the design and now needing repair or revision:

```
746b4f60 rename: inout keyword → ref across the codebase
9f34114d rename: isInout flag → isRef across the codebase
f3cfbb53 iterator: Phase A — ref(T) return slot parsing + signature codegen
ebe910a6 iterator: Phase B (parser side) — ref(name) := expr; local binding
ca518556 iterator: Phase B (codegen) — end-to-end ref(name) := call(...)
d9ddb7d3 iterator: Phase B flowability rule (R1–R4) on RHS + return exprs
c36429c8 iterator: Phase C — Indexable trait + Array/Slice/ArrayList impls
9b089395 iterator: Phase C — String Indexable impl + ref-return body typing
e9143f5e iterator: Phase D — for-macro dispatch + position-iter migration
7b3b788b test-runner: fix silent-skip — drop io/exn from main signature, inject io as local
```

Key source files involved:

- `src/test-runner.ts` (~line 329–410) — `generateBatchedTestProgram`. Fixed in `7b3b788b`.
- `src/evaluator/calls/function-type.ts` (~line 388–408) — `shouldDeferBodyEvaluation`. Permissive `typeContainsSomeType(param.type)` is the underlying deferral over-trigger.
- `src/evaluator/values/anonymous-function.ts` (~line 555–570) — same `shouldDeferBodyEvaluation` logic for lambdas.
- `src/types/utils.ts:288–381` — `typeContainsSomeType`. The function-type case unconditionally returns true on `forallParameters.length > 0` without considering that those foralls bind their SomeTypes locally to that function.
- `src/codegen/exprs/match.ts:184–185` and `src/codegen/exprs/cond.ts:496` — fall-through stubs for unevaluated match/cond. The codegen knows there's no `$`; the test framework just runs the result and gets exit 0.
- `src/evaluator/calls/helper.ts:558–578` — `tryToCallFunctionWithArguments` parameter binding. `bindingType = argType` regardless of `parameter.isRef`. To fix Bug A, this is where `bindingType = createPtrType(argType)` for `ref` params would need to happen (and every `self.field` / `self(...)` site in bodies would need a complementary auto-deref).
- `src/evaluator/calls/index-trait.ts:182–311` — `tryToCallWithIndexTrait`. The special paren-form path that bypasses body evaluation; the reason Phase B/C Index impls "worked" at compile time despite the in-body type mismatch.
- `src/evaluator/types/flowability.ts:170–192` — R3 implementation. The rule that makes Phase D's for-macro structurally impossible.

## Recommended paths

I see three credible directions; none is fast.

### Direction A: Fix at the evaluator level, top-down

1. Replace `typeContainsSomeType` in `shouldDeferBodyEvaluation` with a `forall`-scope-aware walker that doesn't over-recurse into nested function types. Restores `main :: fn(io : Io, exn : Exception)` evaluability without the test-runner workaround.
2. Fix `tryToCallFunctionWithArguments` so `ref` parameters bind with `bindingType = createPtrType(argType)`. Wire auto-deref-on-read for `ref`-bound locals across all reading sites (atoms, field access, index, `==`, etc.). This likely requires changes in many evaluator files.
3. Audit and fix the ~14 stdlib files whose evaluation now actually runs and exposes pre-existing type mismatches (per the earlier `typeContainsUnboundSomeType` experiment).
4. Decide what to do about R3 / Phase D — either relax R3 to admit locals at the immediate enclosing scope, or rewrite the for-macro to avoid `ref(name) := …` with a local-rooted projection.

Cost: multi-day evaluator surgery with high risk of further unmasked latent bugs. Best long-term.

### Direction B: Revert iterator phases, restart on the now-working test framework

Revert `746b4f60` through `e9143f5e`. The test-runner fix (`7b3b788b`) stays. Re-attempt the iterator redesign with TDD discipline: every claim of "Phase X works" must rest on an actually-running assertion.

Cost: loses the design notes captured inline in the commits, but the prose lives in `plans/ITERATOR_REDESIGN.md`. Lower risk because every step gets real validation.

### Direction C: Stop iterating on this branch; treat it as a learning artifact

Mark `plans/ITERATOR_REDESIGN.md` as superseded. Open a new design doc that accepts the constraints we've now learned about (auto-deref through method dispatch, flowability + locals, deferral predicate scope). Decide whether the projection-style design is still the right one, or whether the value/index/callback alternatives (rejected earlier) deserve another look given the implementation cost.

Cost: throws away ~10 commits of work; lowest implementation cost from here.

## What I'd do

If I were continuing this myself: **Direction B**, with the following discipline:

- For every new phase, write the "minimal end-to-end test" — a `pragma(Pragma.AllowUnsafe)` test file with a `main` that exercises the phase end-to-end at runtime — and verify it FAILS without the implementation (intentional sanity-check that the test framework is running real bodies), then verify it PASSES with the implementation. Land the test together with the implementation.
- For Phase B specifically, the first test should be `ref(r) := some_call(); assert(r == ...); r = ...; assert(arr(...) == ...)` exercising read AND write through a ref binding sourced from a function that returns `ref(T)`. The bug-C unification issue surfaces here immediately.
- For Phase D, the design must be reconciled with R3 BEFORE implementation. The for-macro can't both (a) bind the collection as a local and (b) call `coll.project(pos)` and expect flowability to admit it.

## Open tasks at the time of writing

- `#86` Phase E: migrate combinator/closure tests using `.iter()` to `.into_iter()` — work-in-progress; useful once we know the underlying iterator design isn't going to change. Stashed.
- `#87` Phase E: update docs — pending; obviously contingent on what the design ends up being.
- `#88` Phase E: HashMap Indexable + for-loop support — deferred; depends on resolving the Phase D contradiction.
- `#89` Fix test framework regression — ✅ completed (`7b3b788b`).
- `#90` Audit Phase C/D damage — this memo.

## Reproductions

Minimal repros are preserved in `/tmp/` (will be wiped on reboot; copy them somewhere durable if you want them around):

- `/tmp/probe_fix.yo` — guaranteed-fail assertion that now correctly fails.
- `/tmp/probe_phase_c.yo` — `ref(r) := arr.project(usize(1))`; demonstrates bug A.
- `/tmp/probe_phase_b.yo` — `ref(r) := get_ref(a, usize(1))`; demonstrates bug B (flowability) when the helper is user-written, and bug C when smuggled past via `&(self)` and assertions are added.
- `/tmp/probe_index_arr.yo` — `v := arr(usize(1))`; shows the paren-form path works (and explains why bug A wasn't caught earlier).

Each compiles with `./yo-cli compile <file> -o /tmp/out`; the failure paths print Yo evaluator errors with the relevant source location.
