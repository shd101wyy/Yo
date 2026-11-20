# A closure's `&mut` capture-list entry is not checked against the loans of the call's other arguments

**Severity:** S1 — use-after-free in safe code: `peek(&ws(usize(0)), &mut ({ &mut ws }() => { ws.clear(); }))` is accepted, and the callee reads the element the closure freed (ASan heap-use-after-free).

- Filed: 2026-11-21 by the VERDICTS-70 row 5 lane (the guard-off knob), from the guard-off probe file `tests/origins/guard/` (`scripts/guard-off-probes.sh`).
- Reproduces on develop `50928986a` (a stage 1 built from it with `YO_DEBUG_GUARD_OFF` unset, whose emitted C for `src/main.yo` is byte-identical to develop's).
- **Status: FIXED** on `v0280/capture-list-loans` (see "Fixed" below). It was a claim (S) hole (VERDICTS-58 decision 7(b)) and, in its `Rc` form, the evidence VERDICTS-70 row 11 needs: the borrowed-argument guard masked it, so deleting the guard first would have turned an accepted, clean program into a dirty one.

## Reproducer

`issues/repros/2026-11-21-a-closures-mut-capture-list-entry-is-not-checked-against-the-loans-of-the-calls-other-arguments.yo`:

```yo
// expect: E0910
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array-list");
{ println } :: import("std/fmt");
W :: struct(s : String);
peek :: (fn(w : &W, act : &mut Impl(FnMut() -> unit)) -> unit)({
  act();
  println(`OUT: ${w.s.clone()}`);
});
main :: (fn() -> unit)({
  mut(ws) := ArrayList(W).new();
  ws.push(W(s : String.from("hello, a string long enough to live on the heap")));
  peek(
    &ws(usize(0)),
    &mut ({ &mut ws }() => {
      ws.clear();
    })
  );
});
export(main);
```

```bash
yo check issues/repros/2026-11-21-a-closures-mut-capture-list-entry-is-not-checked-against-the-loans-of-the-calls-other-arguments.yo --std-path ./std   # rc 0: accepted
yo compile issues/repros/2026-11-21-a-closures-mut-capture-list-entry-is-not-checked-against-the-loans-of-the-calls-other-arguments.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
```

```text
ERROR: AddressSanitizer: heap-use-after-free
```

## The shapes, measured (stage 1 of develop `50928986a`, ASan, `--optimize 1`)

| Program | Guard on (shipped) | `YO_DEBUG_GUARD_OFF=1` |
| --- | --- | --- |
| `peek(&ws(usize(0)), &mut ({ &mut ws }() => { ws.clear(); }))`, `ws : ArrayList(W)` | accepted, heap-use-after-free | the same |
| `ws(usize(0)).peek(&mut ({ &mut ws }() => { ws.clear(); }))` (a receiver) | accepted, heap-use-after-free | the same |
| `hs(usize(0)).peek(&mut ({ &mut hs }() => { hs.clear(); }))`, `hs : ArrayList(Rc(W))` | accepted, **clean** | accepted, heap-use-after-free |
| `w.head().peek(&mut ({ &mut w }() => { w.items.clear(); }))`, a generic wrapper's `head : (fn(self : &Self) -> &T)` over `Rc(W)` elements | accepted, **clean** | accepted, heap-use-after-free |
| `first(&hs).peek(&mut ({ &mut hs }() => { hs.clear(); }))`, `first : (fn(xs : &ArrayList(Rc(W))) -> &Rc(W))` | accepted, heap-use-after-free | the same |

The probe file carries the last four as `tests/origins/guard/capture-list-mut-element-argument.yo`, `capture-list-mut-rc-element-receiver.yo`, `generic-wrapper-receiver-clears-list.yo` and `returned-reference-receiver-clears-list.yo`, with these verdicts recorded.

- With an `Rc` element the guard's caller-owned +1 on the handle keeps the payload alive, so the hole is invisible on the shipped compiler. The free-function form (`first(&hs)`) gets no +1 because the guard's place walk stops at a call result (`_place_root_is_runtime_variable`, `src/evaluator/utils.yo`).
- Without an `Rc` there is nothing for the guard to hold, so the program is dirty either way.

## Neighbours

- **E0910:** the same calls with an implicit capture, `peek(&ws(usize(0)), &mut (() => { ws.clear(); }))`. The capture moves `ws`, and the move is checked against the element's lend ("This argument moves `ws`, which an earlier argument of the same call lends to it").
- **E0910:** `clob(&mut ws, firstw(&ws))`, a `&mut` argument against an argument value's loan.
- **Rejected (no code):** `poke(&mut ws(usize(0)), &mut ({ &ws }() => …))`, the shared capture against a `&mut` element argument ("argument 2 of the same call could hold a handle to `ws` and grow it").
- **E0911:** `r := first(&hs); r.peek(&mut ({ &mut hs }() => …))`, the loan held by a binding.

## Cause

Decision 28's argument exclusivity at a call checks each later argument for an access to a place an earlier argument lends: `_check_call_lent_place_moves` for the lends written as arguments and receivers, and the value-loan walk beside `_reject_value_loan_access` (`src/evaluator/calls/function.yo`) for the loans argument values carry. Both look for accesses by name: a move, a `&mut place`, a `&place`, an assignment, a method receiver. A capture-list entry `{ &mut ws }` is a `&mut` lend taken when the closure is built, while the call's other loans are live, and neither check records it: the parser rewrites the pun `&mut ws` to the mode head `__yo_mut(ws)` (`__yo_imm(ws)` for `&ws`), which no walk reads as a lend. The implicit capture is caught only because it is a move. The labeled spelling `{ q : &mut ws }` keeps its `&mut ws` initializer, so the walks caught it after an earlier lend; but in the other order, with the closure first (`poke(&mut ({ q : &mut ws }() => …), &ws(usize(0)))`), neither spelling was a lend of the call at all, since `_call_lends` collected only `&p` / `&mut p` arguments, receivers and bare borrows. That order is dirty too (ASan heap-use-after-free on the shipped compiler).

## Fix direction

Treat each capture-list entry of a closure literal argument as the access it is: `{ &mut p }` lends `p` `&mut` and `{ &p }` lends it `&`, at the closure's construction. Check them against the call's other loans exactly as a `&mut p` / `&p` argument is checked, which makes all five rows above E0910. The fix's test is the repro above (in `tests/origins/unsound/`, `// expect: E0910`, with a `-pos` twin that clears a different list), and re-recording the four probe-file headers to `E0910`.

## Fixed

`_closure_capture_lends` (`src/evaluator/calls/function.yo`) reads a closure literal's capture list as the lends it takes: a pun
`&p` / `&mut p` lends `p` (its place a fresh atom of the name, resolved in the call's scope, because the pun's own atom declares the
capture binding), and a labeled entry `q : &p` / `q : &mut p` lends its initializer's place. Decision 28's checks use it in both
directions:

- A closure literal anywhere in a LATER argument takes its capture-list lends while the earlier arguments' loans are live:
  `_find_lent_place_access` reports a `&mut` entry against an earlier lend, and `_find_value_loan_access` reports a `&mut` entry
  against an earlier argument value's loan (a receiver `hs(usize(0))`, `w.head()`, `first(&hs)`), and a `&` entry against a `&mut`
  one. This covers the call-result root: `first(&hs)`'s value carries its loan of `hs` (`origin_of`), which the value-loan walk
  checks.
- A closure literal that IS an argument's value (`f(&mut ({ &mut p }() => …))`, `f(dyn(&mut …))`, `f(closure)`) holds its capture
  lends for the whole call: `_call_lends` records each as a `_CallLend` (tag `capture-mut` / `capture-imm`), so the value-root
  overlap check, the value-loan check and the two-phase check judge it against the other arguments in either order, exactly as a
  `&mut p` / `&p` argument.

Every shape in the table above is E0910, as are the closure-first orders in both spellings and a `&` entry against a `&mut`
argument. Rust's rule is the same: a closure capturing `&mut ws` is a mutable borrow from its construction to its last use.

Tests (`tests/origins/unsound/`, each negative `// expect: E0910` with an ASan-clean `-pos` twin where one applies):
`capture-list-mut-element-argument`, `capture-list-mut-element-receiver`, `capture-list-mut-rc-element-receiver`,
`capture-list-mut-generic-wrapper-receiver`, `capture-list-mut-returned-reference-receiver`,
`capture-list-mut-closure-before-element-argument`, `capture-list-labeled-mut-closure-before-element-argument`,
`capture-list-mut-closure-before-call-result-argument`, `capture-list-imm-against-mut-argument`, and the positive
`capture-list-imm-against-imm-argument-pos` (two `&` loans of one list pass). Before the fix every negative except `capture-list-imm-against-mut-argument` was accepted (that one was already rejected, see
"Neighbours"), and all of them except `capture-list-mut-rc-element-receiver` and
`capture-list-mut-generic-wrapper-receiver` (held alive by the guard's +1 on the element's handle) were dirty under ASan.
