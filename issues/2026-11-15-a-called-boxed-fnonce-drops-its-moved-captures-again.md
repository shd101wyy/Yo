# A called `Box(Dyn(FnOnce(...)))` drops the captures its call already moved

**Severity:** S1 (a double drop from safe code: every capture a boxed `FnOnce` closure's body moves out
is dropped a second time when the box is released after the call — a double free for a heap-owning
capture)

## Symptom

```yo
u := _Tok(n : i32(6));
(d : Box(Dyn(FnOnce(go : bool) -> i32))) = dyn(Box.new({ u }(go : bool) => _once_take(u)));
_call(d, true);   // _call :: (fn(d : Box(Dyn(FnOnce(go : bool) -> i32)), go : bool) -> i32)(d(go))
```

With a `Drop` counter on `_Tok`, three closures (one bare, two boxed) report 5 drops instead of 3
(`tmp/p/p17b.yo`).

## Root cause

An `FnOnce` call consumes its callee and records a post-call release (`_record_fnonce_callee_release`,
`src/evaluator/calls/function.yo`) unless the callee "releases itself". Before the flip a `Dyn` callee
did: its call-once wrapper released the legacy box and cleared the dispose when the payload's body owned
its captures. Under the flip the callee is a `Box(Dyn(FnOnce))`, not a `Dyn`, so the release recorded
was the full `___drop(d)`: the box's drop ran the payload's `drop_in_place` over captures the body had
moved.

## Fix

- A `Box(Dyn)` callee's post-call release is `d._free_consumed()` — a new prelude `Box` member that
  frees the cell without dropping the payload and zeroes the box (the `into_inner` pattern).
- The payload-convention call-once wrapper (`src/codegen/functions/dyn.yo`) drops the payload after the
  call when it is an `Fn` closure called through the `FnOnce` slot (its body only borrowed its
  captures); a capture-list `FnOnce` body took them already.

## Test

`tests/fn_once.test.yo` (its boxed rows count drops: "captures the body does not move drop when the call
ends", "a captured String moves out without a clone", …), probe `tmp/p/p17.yo`. Fails before, passes
after.
