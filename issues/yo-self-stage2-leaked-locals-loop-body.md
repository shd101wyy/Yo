# Stage-2: leaked-locals — loop-body owning local dropped AFTER the loop (out of C scope)

## Symptom (part of the 12 "use of undeclared identifier" @ stage-2 = 56)

`extract_future_trait_from_type` (trait_checking.yo:1397) emits (stage-2 C, fn yo_id_246492):

```c
while (true) {
  ...
  __yo_t6* t = _file____User_temp_144157;   // t declared INSIDE the while body
  switch (_144158->tag) {
    case __YO_T6_FUTURETRAITT: { incr_rc(t); ...; return .Some(t); }   // early return (moves t)
    default: break;
  }
  i = i + 1;
}
loop_yo_id_406841:;
__yo_decr_rc((void*)(t));   // ← t dropped here, but t is C-scoped to the while {} → "undeclared identifier 't'"
__yo_decr_rc((void*)(_file____User_temp_144158));
_file____User_temp_144167 = (__yo_t22){ .tag = __YO_T22_NONE };
break;   // exits the match-arm switch
```

Same shape for `t`(×2), `t_expr`, `get_info`, `frame`, `arg_expr`, and 7
`_file____User_temp_*` — all loop-body owning locals whose scope-end drop lands
at the enclosing (match-arm) scope-end, past the C `}` that scopes them.

## Source

```rust
extract_future_trait_from_type :: (fn(ty) -> Option(TypeValue))(match(ty,
  .DynT(required_trait_types, ...) => {
    while(i < n, {
      t := match(required_trait_types.get(i), .Some(v) => v, .None => { i += 1; continue; });
      match(t.clone(), .FutureTraitT(...) => { return(Option.Some(t)); }, _ => ());
      i = i + 1;
    });
    Option.None
  }, ...))
```

`t` is a while-body local. `.None => continue` and `return .Some(t)` put CONTROL
FLOW in the body.

## TS behavior (correct — the target)

TS's analogous loop (`type_implements_future` in /tmp/yo-self-9.c ~149060) drops
the loop-body local INSIDE the loop, at the iteration end:

```c
while (true) {
  ...
  __yo_..._id_28* t = _235528;
  switch (t->tag) { case FUTURETRAITT: {...} default: break; }
  i = i + 1;
  fn_..._id_43___drop((...)(t));                 // <-- t dropped per-iteration, INSIDE the loop
  fn_..._id_56163___drop((...)(_235524));         // <-- temp dropped inside too
}
loop_...:;
result = found;
```

TS emits the fall-through (iteration-end) scope-end drops for the loop body AND
separately drops what's live before each continue/break/return — coordinated so
nothing double-drops.

## Root cause (yo-self)

The while body IS evaluated via `evaluate_begin_expression` (while.yo:310), which
pushes a frame, so `t` lives in the while-body frame. BUT
`_schedule_scope_end_drops` (begin.yo:227) SKIPS a begin block that contains
`return`/`unwind`/`break`/`continue`. The `extract_future` body has both
(`.None => continue`, `return .Some(t)`), so the while-body begin block schedules
NO scope-end drops → `t` is never dropped at the iteration end. The enclosing
match-arm begin block then drops `t` at ITS scope-end (after the loop), where `t`
is out of C block scope → "undeclared identifier".

The skip-on-control-flow rule is correct for a NON-loop begin block (an early
return drops its locals on the return path, and the fall-through is unreachable).
It is WRONG for a LOOP body: the fall-through (normal iteration completion) IS
reached every non-exiting iteration, so the loop-body's fall-through scope-end
drops ARE needed — exactly what TS emits.

## Fix direction (RC-safety-critical — focused session)

Make `_schedule_scope_end_drops` (or the loop-body codegen) emit the fall-through
iteration-end drops for a LOOP-body begin block even when it contains control
flow, coordinated with the existing continue/break drop path
(`_emit_loop_body_drops_before_exit`, atom.yo, commit 47237f3cb) and early-return
drops so NO var is double-dropped:

- The signal that a begin block is a loop body is `ctx.is_evaluating_loop_body`
  (set in while.yo:309 before the body eval).
- For `t` specifically it is safe (continue fires before `t` is bound; `return`
  MOVES `t` into `.Some`, so neither exit path drops it — only the fall-through
  should). But a local bound BEFORE a `continue`/`break` is dropped by
  `_emit_loop_body_drops_before_exit`; the fall-through must NOT also drop it →
  the two paths must be mutually exclusive per-var (TS achieves this).
- Also ensure the ENCLOSING (match-arm) scope-end does NOT claim while-body
  locals — its frame should only carry its own locals (n, i), not the nested
  while-body frame's (t). Investigate why the arm's `_schedule_scope_end_drops`
  includes `t` (it may be that skipping the loop body re-attributes its
  undropped vars upward).

Validate corpus 103/103 (DIFF 0 = double-free oracle) + std 152/152 + an ASan
run on a representative corpus binary + stage-2 (expect the 5 user-var + several
temp undeclared errors to clear). A wrong drop point double-frees or leaks.

## Verified facts

- Source = extract_future_trait_from_type (trait_checking.yo:1397), fn yo_id_246492.
- TS drops loop-body locals at the iteration end (inside the loop); yo-self at the
  enclosing scope-end (after the loop) → out of C scope.
- Trigger = control flow in the loop body (continue/return).

## REFINED (2nd attempt — instrumented `_schedule_scope_end_drops`, all reverted)

Two findings that CORRECT the initial hypothesis:

1. The skip-on-control-flow rule checks only DIRECT statements of the begin block
   for `return`/`break`/`continue`. In `extract_future` the control flow is NESTED
   inside `match(t, .FutureTraitT => return(...))` / `match(get(i), .None => {i++;
continue})` — NOT direct statements — so the while-body begin block does NOT
   skip. "The skip skips the loop body" was WRONG.
2. **Confirmed evaluator FRAME LEAK** (co-var probe): `t` and `i` appear TOGETHER
   in ONE NON-loop (arm) frame. Normally `i` is in the arm frame and `t` in the
   while-body frame — separate. Their co-occurrence proves the while-body local
   `t` LEAKED UP into the enclosing arm frame (via `evaluate_while` env threading
   around the body eval, while.yo:310). BUT in that arm frame `t` is NOT
   e7-eligible (the e7 probe did not fire) — so the arm's
   `_schedule_scope_end_drops` does NOT emit `___drop(t)`.

So the after-loop `__yo_decr_rc(t)` is emitted by NEITHER the while-body scope-end
(those emit INSIDE the loop via generate_loop_body) NOR the arm scope-end (t not
e7-eligible). It comes from a THIRD path — the pending-deferred-drops / loop-exit
machinery: `context.pending_deferred_drops` + `loop_body_drops_baseline_count`
(while_loop.yo:218-219), drained by `_emit_loop_body_drops_before_exit`
(atom.yo:32, before continue/break) and `generate_pending_deferred_drops`
(return.yo:219, before return). NEXT: instrument that path to find where `t`
enters pending_deferred_drops and why the drop lands at/after the loop label
rather than inside the body — then either (a) fix the evaluator frame leak so `t`
stays a while-body local dropped inside the loop (TS behavior), or (b) gate the
pending/loop-exit drop by C-scope liveness (like the `declared_c_var_names` gate,
commit 47237f3cb, but tracking scope EXIT). RC-safety-critical.
