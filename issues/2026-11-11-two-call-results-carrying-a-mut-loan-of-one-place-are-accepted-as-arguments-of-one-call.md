# Two call results that each carry a `&mut` loan of one place are accepted as arguments of one call

**Severity:** S1. Safe code hands a callee two live `&mut` to one place: `both(idm(&mut x), idm(&mut x))` passes
`yo check`, and the callee frees the payload through one reference and reads it through the other (ASan: SEGV
through the freed cell). Present in the released v0.2.76 as well as on develop.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A2).

## Reproducer

`issues/repros/2026-11-11-two-call-results-carrying-a-mut-loan-of-one-place-are-accepted-as-arguments-of-one-call.yo`:

```yo
idm :: (fn(r : &mut Option(Rc(X))) -> &mut Option(Rc(X)))(&mut r.*);
both :: (fn(a : &mut Option(Rc(X)), b : &mut Option(Rc(X))) -> usize)(
  match(
    a,
    .Some(p) => {
      b.* = .None;
      p.*.s.len()
    },
    .None => usize(0)
  )
);
main :: (fn() -> unit)({
  mut(x) := mk();
  n := both(idm(&mut x), idm(&mut x));
  println(`OUT: ${n.to_string()}`);
  ()
});
```

```text
$ yo check repro.yo                      # v0.2.76, develop cd99fc50c and 64f33c710: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000010
```

## The family

| Call | v0.2.76 | develop | Correct |
| --- | --- | --- | --- |
| `both(idm(&mut x), idm(&mut x))` | accepted | accepted | E0910 |
| `both(idm(&mut x), &mut x)` (the call result first, the by-name lend second) | accepted | accepted | E0910 |
| `clr_read(idr(&x), &mut x)` (a `&` call result first, then `&mut x`) | accepted | accepted | E0910 |
| `both(&mut x, idm(&mut x))` (the by-name lend first) | E0910 | E0910 | E0910 |
| `clr_read(&x, idm(&mut x))` | E0910 | E0910 | E0910 |
| `a := idm(&mut x); b := idm(&mut x);` | E0911 | E0911 | E0911 |
| `a := idm(&mut x); both(a, idm(&mut x))` | E0911 | E0911 | E0911 |
| `P(x)(a : &mut x, b : &mut x)`, `P(p)(a : &mut r.*, b : &mut r.*)` (constructor fields) | — | E0910 | E0910 |

## Root cause

Decision 28's argument check is by NAME: it records the places an argument lends when the argument is written as
`&place`/`&mut place` (or is a borrowed receiver) and tests later arguments against those. E0911 tests accesses
against loans held by BINDINGS. An argument that is a call RESULT is neither: it lends nothing by name at the outer
call, and no binding holds the loan its value carries. So after `idm(&mut x)` returns a `&mut(…, x)`, nothing
remembers that `x` is exclusively lent while the remaining arguments are evaluated and while `both` runs.

`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §2 already defines a loan's holder as "a binding or a hidden statement
temporary", and §3's R-CALL gives the result of `idm(&mut x)` the origin `{(x, &mut)}`. The missing piece is that an
origin-carrying argument VALUE is such a temporary: a loan the call holds from the moment the argument is evaluated
until the call returns. Every access a later argument performs (here the second `&mut x`), and the activation of
every `&mut` or moved argument, must be checked against it. The reference model (`tests/origins/model.yo`,
`eval_call`) rejects the first row, but by comparing the two arguments' reference types pairwise, which is the rule
`REFERENCES_AND_ORIGINS.md` O3 step 2 says must not exist (it would also reject `swap(a, b)` over `get2_mut`'s pair);
the audit document states the rule that covers both.

The regression of 2026-11-09 (P9, the two-phase rule for named loans; no separate doc is filed here because the
fix lane `fix/p9-holder-arg` owns it) is the same missing rule seen from the other side: there the argument value is
a named reference or holder whose "last use" is the argument.

## Expected

E0910 at the argument whose evaluation accesses a place an earlier argument's value has borrowed, naming the earlier
argument. `swap(a, b)` over two `&mut(T, xs)` bindings obtained from one `get2_mut` call stays accepted: neither
argument's evaluation accesses `xs`.

## Test

With the fix: this program as a `tests/origins/unsound/` pair (negative: E0910; positive control: the two results
used in two separate calls), and a corpus row beside `call-arg-overlap`.
