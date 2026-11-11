# An `Fn` closure that writes a capture releases the old value twice also through a `&mut self` method

**Severity:** S1. `run(&(() => { s.push_str(…); }))`, an `Fn` closure literal that grows its implicit capture of a
`String` through a `&mut self` method, passes `yo check`. The growth reallocates through the closure's copy of `s` and
frees the buffer the outer `s` still owns: reading `s` afterwards is a heap-use-after-free, and a callee that calls the
closure twice ends in a double free. Pre-existing: v0.2.76 accepts both.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A46). Confirmed on develop `64f33c710`. A sibling of the
open `issues/2026-10-23-an-fn-closure-that-reassigns-a-capture-releases-the-old-value-twice.md` (the assignment
form, with an `Rc`), whose B8 note already records that a method write through a by-value capture is LOST; this
doc records that with an owned heap value it is also memory-unsafe, and what a fix of that doc must add.

## Reproducers

`issues/repros/2026-11-11-an-fn-closure-that-writes-a-capture-releases-the-old-value-twice-also-through-a-mut-self-method.yo`
(negative, expects E0913):

```yo
run :: (fn(f : &Impl(Fn() -> unit)) -> unit)(f());
main :: (fn() -> unit)({
  mut(s) := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  run(
    &(
      () => {
        s.push_str("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
      }
    )
  );
  println(`OUT: ${s.len().to_string()} ${s}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

The emitted C (abridged): the borrowed literal's record holds a bitwise copy of `s`, and the record is passed by value:

```c
__yo_v_s = <String "0123…">;
Cap cap = (Cap){ .__yo_v_s = __yo_v_s };   // no dup, no move: an unowned alias of s's buffer
run(cap);                                   // push_str on the callee's copy reallocates, freeing s's buffer
… yo_len(__yo_v_s) …                        // use after free; s's scope-end drop frees it again
```

- `…-twice.yo` (negative, E0913): `twice :: (fn(f : &Impl(Fn() -> usize)) -> usize)(f() + f());` around the same body.
  Accepted, ASan "attempting double-free".
- `…-pos.yo` (positive control): `run(&mut ({ &mut s }() => { s.push_str(…); }))` with an `FnMut` slot. Accepted,
  `OUT: 180`, runs clean.

## The family (develop `64f33c710`)

| Shape (an `Fn` closure body writing its implicit capture) | Verdict | Correct |
| --- | --- | --- |
| `s.push_str(…)`, literal lent to `&Impl(Fn() -> unit)`, `s` read after | accepted, UAF | E0913 |
| the same, the callee calls it twice | accepted, double free | E0913 |
| a named `(f : Impl(Fn() -> usize)) = (() => { s.push_str(…); s.len() })` called twice | accepted; `OUT: 180 288`, the `Fn` closure's own copy grows (ledger) | E0913 |
| `n = (n + i32(1))` on an `i32`, lent to `&Impl(Fn)` | accepted; the write is lost, `OUT: 0` (ledger) | E0913 |
| the open doc's `r = rc(…)` reassignment | accepted, UAF (open doc) | E0913 |
| `{ &mut s }` capture at an `FnMut` slot | accepted, `OUT: 180` | accept |

## Root cause

The same as the open doc's: an `Fn` body is allowed to write a by-value capture, which is a copy of the outer value
held in a record the call only borrows. Here the copy is not even counted: for a borrowed literal
(`closure_literal_is_borrowed`), `generate_captured_variable_dup_expressions` (`src/evaluator/utils/closure.yo`) emits
no dup and no move (decision 22: the literal "borrows ALL its captures"), so the record's `s` aliases the outer buffer
without owning it; the borrow is a read-only one in the design, and a bitwise copy in the C. A `&mut self` call on it is then
judged as a write to the OUTER binding: `s` resolves to the enclosing `mut(s)`, which is owning and writable, so
`require_no_inout_write_through_borrow` (`src/evaluator/exprs/assignment.yo`) and `binding_require_mut` pass. The
evaluator knows the binding is an implicit capture (`_is_implicit_closure_capture`, `src/evaluator/utils.yo`) and
consults it for moves out of a capture (`_throw_implicit_capture_move`), `FnOnce` calls
(`consume_called_fnonce_closure`, E0913) and `match` scrutinees, but not for assignments or `&mut` lends.

## Expected

E0913 at the write: a body that writes a capture makes the closure `FnMut`, which an `Fn(...)` slot does not admit
(`plans/VALUES_BY_DEFAULT.md` decision 37; "Under `Fn` or `FnOnce` an entry write stays E0917, whose help now names
`FnMut`" for capture-list entries; E0913 is `E_CLOSURE_TRAIT_TOO_WEAK`). A fix of the open doc must additionally cover:

1. every write form, not only `=`: a `&mut self` receiver call, a `&mut` argument, `for(&mut s, …)`,
   `match(&mut s, …)` and a nested literal's `{ m : &mut s }` entry on an implicit capture inside an `Fn` body;
2. owned non-counted values (`String`, `ArrayList`), whose borrowed-literal capture is an unowned alias. The open doc's
   fix direction 2 (pass a borrowed `&Impl(Fn)` record by pointer) does not repair this form: the record's alias would
   still reallocate the buffer the outer `s` owns. Only direction 1, generalized, does.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/` next to the open
doc's repro; `tests/closure_capture_rc_leak.test.yo` or `tests/fn_mut.test.yo` gains the `push_str`, `&mut`-argument
and `i32` assignment forms as E0913 cases.
