# A closure's `&mut` capture-list entry is not checked against the loans of the call's other arguments

**Severity:** S1 — use-after-free in safe code: `peek(&ws(usize(0)), &mut ({ &mut ws }() => { ws.clear(); }))` is accepted, and the callee reads the element the closure freed (ASan heap-use-after-free).

- Filed: 2026-11-21 by the VERDICTS-70 row 5 lane (the guard-off knob), from the guard-off probe file `tests/origins/guard/` (`scripts/guard-off-probes.sh`).
- Reproduces on develop `50928986a` (a stage 1 built from it with `YO_DEBUG_GUARD_OFF` unset, whose emitted C for `src/main.yo` is byte-identical to develop's).
- **Status: OPEN.** It is a claim (S) hole (VERDICTS-58 decision 7(b)) and, in its `Rc` form, the evidence VERDICTS-70 row 11 needs: the borrowed-argument guard masks it, so deleting the guard first would turn an accepted, clean program into a dirty one.

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

## Cause (not yet confirmed)

Decision 28's argument exclusivity at a call checks each later argument for an access to a place an earlier argument lends: `_check_call_lent_place_moves` for the lends written as arguments and receivers, and the value-loan walk beside `_reject_value_loan_access` (`src/evaluator/calls/function.yo`) for the loans argument values carry. Both look for accesses by name: a move, a `&mut place`, a `&place`, an assignment, a method receiver. A capture-list entry `{ &mut ws }` is a `&mut` lend taken when the closure is built, while the call's other loans are live, and neither check records it. The implicit capture is caught only because it is a move.

## Fix direction

Treat each capture-list entry of a closure literal argument as the access it is: `{ &mut p }` lends `p` `&mut` and `{ &p }` lends it `&`, at the closure's construction. Check them against the call's other loans exactly as a `&mut p` / `&p` argument is checked, which makes all five rows above E0910. The fix's test is the repro above (in `tests/origins/unsound/`, `// expect: E0910`, with a `-pos` twin that clears a different list), and re-recording the four probe-file headers to `E0910`.
