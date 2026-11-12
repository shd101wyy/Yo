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

## Re-measured on develop `4f8f975b3` (2026-11-12, after P9's fix #1910)

#1910 fixed the P9 two-phase rows of the wider family below; it does not reach this document's own rows, which
stay accepted on the v0.2.77 tip (`yo check`, audit probes under `tmp/probes/`):

| Probe | Call | v0.2.76 | develop `4f8f975b3` |
| --- | --- | --- | --- |
| `a/q2a` | `both(idm(&mut x), idm(&mut x))` (row 1 above) | accepted (spelled `q2a_seed`) | accepted |
| `a/q2c` | `both(idm(&mut x), &mut x)` (row 2 above) | accepted (spelled `q2c_seed`) | accepted |
| `calls/c59`-shape | an inline lend in a constructor argument, `f(&mut xs, Option(&i32).Some(&xs(usize(0))))` | not expressible | accepted |
| `iteration/w01` | a `for(&mut xs, …)` element stored through a helper into a `&mut`-lent holder slot, the list grown after | accepted | E0911 (fixed) |
| `iteration/w02` | a read-walk element of `c.items` stored into the sibling field `c.last`, `c.items` grown after | E0901 (not expressible) | E0911 (correct) |

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

## Wider family: any origin-carrying argument value (added with the calls and iteration probes)

The two-call-result shape is one case of a wider rule: an argument whose VALUE carries a loan (a call result, a
constructor or payload built inline, a named reference or holder) is a loan the call holds, and nothing compares it
with the call's other arguments. Verdicts are `yo check` on v0.2.76 and on develop `64f33c710`, measured 2026-11-12
(probes in the audit's `tmp/probes/calls/` and `tmp/probes/iteration/`); "UAF" is an ASan heap-use-after-free at
`--optimize 1`, from this session's or the ledger's run:

| Probe | Call | v0.2.76 | develop | Owner |
| --- | --- | --- | --- | --- |
| c10 | `f(&mut xs, first(&xs))`, the loan made inside a later argument | accepted | accepted, UAF | this doc |
| c36 | the same over a `&mut` parameter, `f(xs, first(xs))` | accepted | accepted | this doc |
| c48 | the receiver form, `xs.eat(first(&xs))` (`self : &mut Self`) | accepted | accepted | this doc |
| c52 | `f(first(&xs), xs)`: a move of `xs` beside the loan | accepted | accepted | this doc (E0911) |
| c23 | the mirror, `f(g(&mut w), &w.l)` (`g` returns `&mut w.l`) | accepted | accepted | this doc |
| p04 | a field, `f(&mut w.l, first(&w.l))` | accepted | accepted | this doc |
| c58 | an inline holder, `f(&mut xs, H(xs)(r : &xs(usize(0))))` | not expressible (E0601 on `&xs(i)`) | accepted | this doc |
| c59 | an inline payload, `f(&mut xs, Option(&String).Some(&xs(usize(0))))` | not expressible (E0601) | accepted | this doc |
| s16, s11 | `clear_then_read(&mut xs, xs.index(usize(0)))` | accepted | accepted, UAF (s16) | this doc |
| s17, s12 | the `&` argument first, `clr(xs.index(usize(0)), &mut xs)` | accepted | accepted | this doc |
| s08 | std, `xs.fill(xs.index(usize(0)))` | accepted | accepted, UAF | this doc |
| s15 | a user method, `xs.clr_then(xs.index(usize(1)))` | accepted | accepted | this doc |
| c09 | `q := &xs; f(&mut xs, first(q))` | E0911 | accepted | P9, `fix/p9-holder-arg` |
| s18 | `r := xs.index(usize(0)); clear_then_read(&mut xs, r)` | E0911 | accepted, UAF | P9, `fix/p9-holder-arg` |
| s14 | a named `Option(&String)` holder after a `&mut self` receiver, `xs.eat_then(o)` | E0911 | accepted | P9, `fix/p9-holder-arg` |
| c13 | `r := &xs; f(r, &mut xs)` (the named reference FIRST) | E0911 | accepted, UAF | P9, `fix/p9-holder-arg` |
| c05 | `h := H(xs)(r : xs.index(usize(0))); f(h, &mut xs)` (a holder FIRST) | E0911 | accepted, UAF | P9, `fix/p9-holder-arg` |

The first twelve rows are pre-existing and are this document's subject. The last five are the P9 two-phase
regression (a loan-carrying NAMED value beside a by-name `&mut x`, in either order): v0.2.76 rejects them because the
binding is live across the whole call (E0911 "`r` borrows `xs` … and is still live"), develop ends that loan at the
argument. They are not this document's subject; lane `fix/p9-holder-arg` owns them. The audit ledger listed c05 and
c13 as a pre-existing "gap 2" that needs no two-phase rule; measured, v0.2.76 rejects both with E0911, so on the seed
they are caught by the binding's liveness, not by decision 28.

Reproducers added with this section:

- `issues/repros/2026-11-11-two-call-results-carrying-a-mut-loan-of-one-place-are-accepted-as-arguments-of-one-call-nested-lend.yo`
  (c10; negative, E0910; v0.2.76 and develop accept; heap-use-after-free).
- `…-std-fill.yo` (s08; negative, E0910; v0.2.76 and develop accept; heap-use-after-free inside `fill`).
- `…-holder-first.yo` (c05; negative, E0911; v0.2.76 rejects it, develop accepts it; heap-use-after-free). It shows
  the P9 regression and the decision-28 gap below together and stays red until both are fixed.

Why decision 28 sees none of these (`src/evaluator/calls/function.yo`): `_call_lends` collects only TOP-LEVEL
arguments, and only three kinds: a `&place` / `&mut place` marker (`_lent_argument_place`), an operand its operator
borrows, and a borrow binding passed bare to a reference slot (`_bare_borrow_argument_lend`). The two checks that
consume that list, `_check_call_lent_place_moves` (a later argument may not move, overwrite or `&mut`-lend a place an
earlier argument lends; "a read, or a `&` relend, passes") and `_check_call_value_root_overlap` (pairwise among the
recorded lends), therefore miss:

- a loan made inside a nested argument (`first(&xs)`, `xs.index(usize(0))`, `H(xs)(r : &xs(usize(0)))`): it is no
  top-level lend, and as a later argument's `&` relend of the `&mut` argument's place it passes the two-phase rule,
  which treats the relend as ending inside the nested call although the argument's value carries it into the callee;
- a by-value holder (`h : H(p)`, `o : Option(&T)`): `_bare_borrow_argument_lend` returns `.None` for a slot that is
  not a borrow (`!t_slot_is_borrow(&slot)`), so no lend is recorded at all;
- a named reference passed bare: it is recorded with `place : lent`, the argument as written (`r`), not the place
  `r` borrows; c13 is E0910 on neither binary.

The fix is the one stated above: take `origin_of` of each argument value and treat each of its entries as a loan the
call holds from that argument's evaluation until the call returns.

## Expected

E0910 at the argument whose evaluation accesses a place an earlier argument's value has borrowed, naming the earlier
argument. `swap(a, b)` over two `&mut(T, xs)` bindings obtained from one `get2_mut` call stays accepted: neither
argument's evaluation accesses `xs`.

## Test

With the fix: this program as a `tests/origins/unsound/` pair (negative: E0910; positive control: the two results
used in two separate calls), and a corpus row beside `call-arg-overlap`.
