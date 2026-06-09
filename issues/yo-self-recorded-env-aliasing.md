# yo-self: recorded `ExprInfo.env` aliases the live env → begin-local bindings lost after `pop_frame`

## Summary

`new_expr_info(env, ty)` (expr_info.yo:393) stores `env : env` — and `Environment`
is an `object` (reference semantics in Yo), so the stored env is the SAME live
object, not a snapshot. `begin` (begin.yo) pushes a scope frame (`env.push_frame`,
line 200) and at the end does `env.pop_frame()` (line 647), which is an in-place
`self.frames.pop()` (env.yo:245-253). Therefore every `ExprInfo` recorded for a
sub-expression INSIDE a begin block aliases an env whose begin frame is removed
once the block finishes — so any consumer that later reads
`get_variables_from_env(info.env, <begin-local name>)` finds NOTHING.

## How it surfaced

`slice_flowability.test.yo` positive `comptime_str :: (fn() -> str)({ s :: "world"; s })`.
The slice/raw-ptr return flow check (is_flowable_expr) examines the evaluated
body's final atom `s`. Confirmed by instrumentation:

- body does NOT throw (no def-time swallow);
- the returned expr IS the bare atom `s` (`FLOW-ENTER tok=s is_atom=true`);
- R1 reaches `var_name = "s"` but `get_variables_from_env(info.env, "s")` is EMPTY
  (`R1-EARLY vars-empty name=s`).

`s` is bound by `s :: "world"` in the begin frame; that frame is popped
(begin.yo:647) before the flow check runs, and `info.env` for the `s` atom aliases
that popped env. R1''' (`allow_comptime_source && v.is_compile_time_only`) is
present and correct — it just never sees `s` because the lookup is empty.

## Why std/most code doesn't hit it

- Params live in the frame pushed by `_build_def_time_body_env` (function_type.yo),
  which begin does NOT pop — so flowability on params (`p`, `list`) works
  (ref_flowability passes; `list.project(i)` passes after the R3 side-table fix).
- Normal evaluation reads variables DURING eval (while the frame is live), not
  from a recorded `info.env` AFTER the block closed. Only consumers that inspect a
  recorded `info.env` post-hoc (the flowability check on a begin-local) are bitten.
  So `check ./std` (151) is green despite the latent aliasing.

## Confirmed mechanism

- `new_expr_info` (expr_info.yo:393): `ExprInfo(env : env, ...)` — by reference.
- `Environment.pop_frame` (env.yo:245): `self.frames.pop()` — in-place mutation.
- `begin` (begin.yo:200 push, :647 pop; threads via `env.frames = ret.env.frames`
  at :334/:499).

## Faithful fix options (all central / regression-prone — do with full sweeps)

1. **Snapshot the env at record time.** Make `new_expr_info` (or the atom/identifier
   evaluator, identifer_and_operator.yo:213) store a shallow clone of `env.frames`
   (a fresh `ArrayList` of the same `Frame` refs) so the recorded list is immune to
   later `pop`. The `Frame` objects themselves persist after pop, so a shallow list
   clone is enough to keep begin-local bindings visible. RISK: `begin` threads
   bindings forward by reading `ret_info.env.frames` (begin.yo:334/499); if those
   become snapshots the threading must still observe post-statement bindings — verify
   carefully. Also a per-expr clone has a perf cost.
2. **Child-env model for begin scopes** (mirrors how TS keeps `expr.$.env` stable):
   evaluate a begin block in a fresh child env instead of push/pop-mutating the
   shared env, so recorded `info.env`s of inner exprs point to a persistent child.
   Bigger refactor of begin.yo + env threading.

TS does not have this bug: its `expr.$.env` is stable (scope handling does not
retroactively mutate the env captured by already-evaluated sub-expressions).

## Impact / status

- Blocks `slice_flowability` positive `comptime_str` (one of several positive-case
  gaps in that test — see issues/yo-self-flowability-swallow.md §2c).
- Latent for any future consumer that reads a recorded `info.env` for a begin-local
  binding after the block closed.
- NOT yet fixed: the fix is a central env-model change; deferred to a focused effort
  with std/yo-self/tests sweeps after each step (cf. the 151→15 regression a
  careless central ExprInfo change caused earlier this work).
