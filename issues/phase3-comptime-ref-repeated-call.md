# Phase 3: `comptime(ref(n))` param mis-binds on the SECOND call

## Status

Open — pre-existing (fails identically on the 53-baseline), niche (1 test:
`tests/comptime_ref.test.yo`). TS passes it. Distinct from the resolved
knot/circular blockers.

## Repro + discriminator

```rust
bump :: (fn(comptime(ref(n)) : usize) -> comptime(usize))({ n = (n + usize(1)); n });
comptime_assert(bump(usize(5)) == usize(6), "5+1");  // OK
comptime_assert(bump(usize(0)) == usize(1), "0+1");  // FAIL after the line above
```

- `bump(usize(0))` **alone** → OK.
- `bump(usize(5))` **alone** → OK.
- `bump(usize(5))` THEN `bump(usize(0))` → the SECOND call fails:
  `Expected bool value for "comptime_assert", got: bump(usize(0)) == usize(1)`
  (i.e. `bump(usize(0))` returned a non-value → `==` stayed unevaluated).

## Mechanism (narrowed)

Instrumented `evaluate_comptime_fn_call` (func id + arg/result value kinds):

- NOT the comptime-fn cache-collision class. `bump`'s args are concrete +
  distinct (`usize(5)` vs `usize(0)`), so `_ctfe_args_equal` would not collide;
  `should_cache` is keyed correctly by the distinct args.
- `bump(usize(5))` alone returns `6` — its body (`n = n + usize(1); n`) evaluates
  `n` to the concrete arg on the FIRST call.
- `bump(usize(0))` AFTER `bump(usize(5))` returns `UnknownVal` — so on the SECOND
  call the `comptime(ref(n))` parameter `n` is NOT bound to the concrete arg
  (`0`); it resolves to `UnknownVal`, and `UnknownVal + 1` → `UnknownVal`.

So the bug is in **`comptime(ref(name))` parameter binding across repeated calls**:
the first call binds `n` correctly, but state left after it (a stale ref binding
in the FuncVal's captured env / a comptime-ref side-table, or the
binding-update/mutation path for `comptime(ref)` not being reset per call) makes
the second call's `n` unresolved. The `ref` mutation (`n = n + 1`) propagating
back to the caller's compile-time value is the special machinery here (see the
test's doc comment: "mutations through the binding propagate back to the caller's
compile-time value via the evaluator's binding-update path").

## Recommended next step

Instrument the `comptime(ref(...))` parameter binding + the binding-update path
for two sequential `bump` calls. Check why the 2nd call's `n` is `UnknownVal`:
likely the FuncVal's captured-env (or a ref side-table) retains the FIRST call's
mutated/consumed `n` binding and the 2nd call reuses it instead of binding the
fresh arg. The fix is to bind a FRESH `comptime(ref)` parameter per call (not
reuse stale state). Repro is fast (3 lines, no prelude noise beyond
comptime_assert).

## CORRECTION (deeper instrumentation) — NOT a mis-bind; stale body re-eval

Instrumented the FuncVal param binding (`function.yo` ~1234) on `bump(5)` then
`bump(0)`:

```
DBG NBIND n = 5 is_ct=T     (1st call — correct)
DBG NBIND n = 0 is_ct=T     (2nd call — ALSO correct)
```

So the `comptime(ref(n))` parameter IS bound to the fresh, correct arg on BOTH
calls (`5`, then `0`). The earlier "mis-binds on the second call" framing is
WRONG. The 2nd call's _body evaluation_ (`n = n + usize(1); n`) returns
`UnknownVal` despite `n` being correctly bound to `0`.

Structural note: in `function.yo`'s FuncVal arm, the comptime gate
(`is_th || rico || all_args_types`) and the over-CTFE skip (`!is_th && !rico`)
are jointly exhaustive, so the inline **body-exec path is effectively DEAD CODE** —
a comptime-only-return fn like `bump` (`-> comptime(usize)`, `rico=true`) takes
the comptime gate → `evaluate_comptime_fn_call`, which re-evaluates the SAME body
AST nodes each call. `comptime_fn.yo`'s header explicitly assumes "No cloneExpr
needed (Yo uses ExprInfoTable — AST re-evaluation is safe)" — but TS DOES
`cloneExpr` the body per comptime call. The prime remaining suspect is that the
ExprInfoTable retains the FIRST call's node values (n=5→6), so the SECOND call's
re-eval of the same nodes is stale/inconsistent → `UnknownVal`.

UNRESOLVED CONTRADICTION (needs more tracing): `bump(usize(5))` ALONE returns `6`
(works), which means it does NOT take the `!rico` skip — yet the
`evaluate_comptime_fn_call` arg-trace showed no `bump` call with a `usize` arg
reaching its tail. So either (a) `bump` reaches `evaluate_comptime_fn_call` but
early-returns before the trace point, or (b) `comptime_assert` evaluates its
argument via a distinct comptime-forcing path that handles `bump` outside
`function.yo`'s gate. The next effort must first pin WHICH path `bump` takes
(instrument `comptime_assert`'s arg evaluation + `evaluate_comptime_fn_call`'s
entry, not just its tail), then address the body-AST re-eval staleness — most
likely by cloning the comptime fn body per call (matching TS `cloneExpr`) or
clearing the body's ExprInfo before re-evaluation. NOT a param-binding fix.

## PINNING (more instrumentation) — bump reaches CFN with correct args but never completes it

Instrumented `evaluate_comptime_fn_call` (CFN-entry after arg collection,
cache-hit, and tail) on `bump(5)` then `bump(0)`:

```
DBG CFN func=yo_id_1992 arg0=5     (bump's 1st call — reaches CFN with the correct usize arg)
DBG CFN func=yo_id_1992 arg0=0     (bump's 2nd call — reaches CFN with the correct usize arg)
```

- **bump DOES reach `evaluate_comptime_fn_call`** (`func=yo_id_1992`) with the
  correct `usize` arg (`5`, then `0`) on BOTH calls. (Earlier "never reaches CFN"
  was a tracing artifact — the tail wasn't reached.)
- **NO cache-hit** for either call (no `DBG CFHIT`), so `bump(0)` does NOT collide
  with `bump(5)`'s cache.
- **NEITHER call logs the tail `DBG CFRET`** — not even `bump(5)`, which produces
  the correct `6`. And there is NO early `return(` between the cache lookup and
  the tail (verified by scanning the source). So `evaluate_comptime_fn_call` for
  `bump` does not return through its own tail.

CONCLUSION (the real shape, still not fully cracked): `bump` enters
`evaluate_comptime_fn_call` correctly, but the body-eval path
(`evaluate_begin_expression` at ~line 618) does not return control to the
function's tail — it either unwinds via the exception/control-flow mechanism, or
`comptime_assert`'s argument evaluation drives `bump` in a pass whose result is
produced/consumed elsewhere (a two-pass or re-entrant flow), so the single
`evaluate_comptime_fn_call` frame never completes normally. The 1st-vs-2nd-call
asymmetry (both reach CFN with correct args; 1st yields 6, 2nd yields UnknownVal)
must come from state accumulated during the 1st call's body eval that the 2nd
call's body eval re-reads (still consistent with ExprInfoTable / comptime-body
re-eval staleness — the omitted `cloneExpr`).

NEXT: trace the BODY-EVAL itself for `bump` — instrument `evaluate_begin_expression`
and the assignment (`n = n + usize(1)`) + return (`n`) node evaluations across the
two calls, and check whether the 2nd call's body nodes return stale ExprInfo from
the 1st. If so, the fix is to clone the comptime fn body per call (or clear its
ExprInfo subtree before re-eval), matching TS `cloneExpr`. This is the deepest
open thread; it needs body-node-level tracing, not call-level.
