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
(those emit INSIDE the loop via generate_loop_body) NOR — I thought — the arm
scope-end. It comes from the pending-deferred-drops / loop-exit machinery OR the
arm scope-end. Confirmed below.

## DEFINITIVE PIN (3rd pass — injected `// [SED-SCOPE-END]` tag into generate_deferred_drop_expressions, reverted)

The after-loop `__yo_decr_rc((void*)(t))` is **immediately preceded by
`// [SED-SCOPE-END]`** → it is emitted by **`generate_deferred_drop_expressions`
(drop_dup.yo:542)** draining the **ARM begin block's `deferred_drop_expressions`**.
So `t` IS in the arm block's deferred_drops (i.e. the arm frame's
`_schedule_scope_end_drops` DID include `t` as e7-eligible — the earlier co-var
probe's "t not e7-eligible" reading was for a different `_schedule` invocation).
NOT the pending/loop-exit path (that would be comment-less too, but the tag
proves it's the scope-end path), NOT `generate_pending_deferred_drops` (that
emits its own "// Drop local variables before early return/completion" comment).

Why the existing skip doesn't catch it: `generate_deferred_drop_expressions` has
an `undeclared_temp` skip — but it is gated to TEMP names (`is_temp_variable_name`)
and checks `!declared_c_var_names.contains(cn)`. `t` is a USER var (not skipped),
AND `t` IS in `declared_c_var_names` at the arm-scope-end point (its declaration
emitted INSIDE the loop; `declared_c_var_names` is FUNCTION-scoped, grown-only,
never removed on block exit) — so it reads as "declared" even though its C block
`{}` closed. `declared_c_var_names` tracks DECLARATION, not scope EXIT.

## Fix options (RC-safety-critical, focused session)

(a) EVALUATOR (correct, matches TS): stop `t` (a while-body local) from ending up
in the ARM frame's `_schedule_scope_end_drops`; it should be dropped by the
WHILE-BODY frame INSIDE the loop (per-iteration). Requires finding which frame
`t := match(...)` binds into during `evaluate_while`'s body eval and why it is
attributed to the arm frame (instrument `add_variable_to_env` frame level for
`t`). This is the faithful fix.
(b) CODEGEN (pragmatic, but LEAKS `t`): make drop-emission scope-EXIT aware — e.g.
snapshot `declared_c_var_names` on loop-body entry and treat vars declared
only inside the (now-closed) loop `{}` as out-of-scope at the arm scope-end,
extending the `undeclared_temp` skip to user vars. Safe (no double-free) but
leaks `t` and does NOT match TS. Only acceptable if (a) proves too deep.

Validate corpus 103/103 (DIFF 0 = double-free oracle) + std 152/152 + ASan +
stage-2 (expect the 5 user-var + several temp undeclared errors to clear).
