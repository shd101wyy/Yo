# A body may store a reference to its own by-value capture through a `&mut` capture

**Severity:** S1. `io.async({ s : &mut slot, owned }(io : Io) => { s.* = .Some(&owned); })` passes `yo check`: the
caller's `slot` ends up holding a reference into the future's state machine, which drops `owned` when it completes,
and the caller reads `slot` after the await (ASan: heap-use-after-free). The closure twin dies with its capture
record (stack-use-after-scope). Pre-existing: v0.2.76 accepts both.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A50). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-body-may-store-a-reference-to-its-own-by-value-capture-through-a-mut-capture.yo`
(negative, expects E0912):

```yo
main :: (fn(io : Io) -> unit)({
  mut(slot) := Option(&String).None;
  owned := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  fut := io.async({ s : &mut slot, owned }(io : Io) => {
    s.* = .Some(&owned);
  });
  io.await(fut, io);
  match(slot, .Some(r) => println(`OUT: ${r.*}`), .None => println("none"));
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-closure.yo` (negative, E0912): an `Impl(FnMut() -> unit)` closure `{ s : &mut slot, owned }` stores `&owned`
  through a generic `store(&mut s.*, &owned)`; the closure dies at the end of its block, `slot` is read after:
  stack-use-after-scope.
- `…-pos.yo` (positive control): the body stores `o` from the BORROW entry `o : &owned`; that joins `slot`'s
  holder at the literal, and the program runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `io.async` body: `s.* = .Some(&owned)`, `owned` a by-value capture | accepted, heap-use-after-free | E0912 |
| `io.async` body: `store(&mut s.*, &owned)` (probe `r07`) | accepted, heap-use-after-free (ledger) | E0912 |
| `FnMut` closure body, the same store; the closure dies first | accepted, stack-use-after-scope | E0912 |
| a body LOCAL `y := …; s.* = .Some(&y)` (probe `r01`) | E0912 | E0912 |
| a body local made after an await, stored by `store` (probe `r10`) | E0912 | E0912 |
| an element of a body-local list stored from a `for` (probe `r09`) | E0912 | E0912 |
| a borrow capture `o : &owned` stored | accepted, runs clean | accept |

## Root cause

`_capture_store` (`src/evaluator/utils.yo`, VERDICTS-37 Q2/Q3) judges each ground root of a value stored through a
`&mut` capture: a literal parameter is E0923, a module-level or compile-time binding passes, a borrow capture joins
its outer place, and every other binding is "a local of this literal's body" (E0912) — except one exemption:

```yo ignore
.None => if(!is_capture_list_value_binding(rv.id()), {
  raise_flow_violation(… E_LOCAL_BORROW_ESCAPES …);
})
```

A by-value capture-list entry (`is_capture_list_value_binding`, `src/env.yo`) is neither rejected nor joined: the
store is dropped from the analysis. The entry's binding is the capture record's field, storage owned by the closure
or the state machine, which dies with it, exactly as a body local does.

## Expected

E0912 at the store. `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` O-3: "a store through a `&mut` capture is E0923
when rooted at a per-call parameter, E0912 at a body local, and otherwise joins the outer holder's flow set at the
literal". A by-value capture is storage of the literal, so for this rule it is a body-local root: the
exemption must go (or turn into the body-local branch). A borrow capture (`o : &owned`) keeps joining the outer place.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
`async-body-own-capture-into-capture` (E0912) beside `async-body-local-into-capture`, and the closure case in
`tests/closure_capture_list.test.yo`.
