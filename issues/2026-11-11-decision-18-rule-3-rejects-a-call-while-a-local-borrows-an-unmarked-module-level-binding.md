# Decision 18 rule 3 rejects a call while a local borrows an unmarked module-level binding

**Severity:** S2. ``H := String.from("…")`` at module level, then ``y := &H; println(`${y.*}`);`` in `main`, is rejected with E0911 "Cannot
call `("".to_string)` while `y` is live: `y` borrows `H`, a module-level place, …", and so is any call in a
`match(&G, .Some(s) => …)` arm or a `for(&G, x => …)` body over an unmarked `G`. Decision 47 made an unmarked module-level binding immutable so
that it "may be lent freely, to a call or across an `await`"; the argument form `f(&H)` is accepted, the binding form
is not. A valid program wrongly rejected; the workaround is to copy the value out or pass `&H` directly. Pre-existing:
v0.2.76 rejects both forms with the same E0911.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C4). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-decision-18-rule-3-rejects-a-call-while-a-local-borrows-an-unmarked-module-level-binding.yo`
(wrongly rejected, expects accept):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
H := String.from("0123456789abcdefghijklmnopqrstuvwxyz");
main :: (fn() -> unit)({
  y := &H;
  println(`OUT: ${y.*}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76
error[E0911]: Cannot call `("".to_string)` while `y` is live: `y` borrows `H`, a module-level place, which has no
run-time borrow flag, and a callee can reach a module-level place by name.
```

- `…-match.yo` (expects accept; E0911 today and on v0.2.76): ``match(&G, .Some(s) => println(`OUT: ${s}`), …)`` over
  an unmarked `G := Option(String).Some(…)`.
- `…-arg.yo` (accepted today, stays accepted): `_len(&H)`, the argument form of the same lend. Runs clean, `OUT: 36`.
- `…-for.yo` (expects accept; E0911 today and on v0.2.76): a borrowed `for` over an unmarked
  `H := ArrayList(String).from(…)` whose body calls `println`; the element binding `x` borrows `H`.
- `…-mut.yo` (E0911 today, must stay E0911): the main program with `mut(H)`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `y := &H` (unmarked), then any runtime call while `y` is live | E0911 | accept |
| `match(&G, .Some(s) => <call>)`, `G` unmarked | E0911 | accept |
| `f(&H)`, `H` unmarked | accepted | accept |
| ``for(&H, x => println(`${x.*}`))``, `H` unmarked: the cursor's lend is exempt, the element binding `x` is not | E0911 at the call in the body | accept |
| `y := &H` with `mut(H)`, then a call | E0911 | E0911 |

## Root cause

Confirmed by reading the source. `local_borrow_note_call` (`src/evaluator/utils.yo`) raises E0911 for every live
borrow with `info.module_root` set (`module_root : root.is_module_level()`, whatever the binding's marker), guarded only
by `_lb_for_iterator_lends_mut_global`. That helper already applies decision 47, but only to a desugared `for`'s
hidden cursor: it checks `is_mut_global(…)` for the borrow's root when the borrow comes from a `for` desugar site and
returns `true` (judge it) for every other borrow. The amendment was implemented for the loop's cursor and for the
argument lend (E0916 fires only for `mut(G)`), not for a named local borrow, a `match(&G, …)` arm binding, or the
element binding of the very `for` whose cursor it exempts.

## Expected

Accepted. Decision 18 rule 3 (`plans/VALUES_BY_DEFAULT.md`), as amended by decision 47: "an unmarked module-level
binding is immutable (Zig's container-level `const`, Rust's `static`), so it may be lent freely; a `mut(G)` binding may
not be lent to a call (E0916) or across an `await` (E0909)". R-GLOBAL (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`):
a lend of an unmarked module-level binding has origin ∅; only a `mut(G)` lend carries `{(G, mode)}` "with decision 18
rule 3 at the access". So rule 3 belongs to `mut(G)` roots only, for every lend form. Interior mutability inside an
unmarked global (a `RefCell` payload) stays governed by the cell's own run-time flag, as for any shared reference.

## Test

With the fix: the main, `-match` and `-for` programs become positive rows in `tests/origins/corpus.tsv`
(`global-unmarked-local-borrow-call`, `global-unmarked-match-arm-call`, `global-unmarked-for-element-call`, `pos`);
`tests/global_lend.test.yo` keeps the `mut(H)` program at E0911 as the negative twin, and the `-arg` program as the
existing positive.
