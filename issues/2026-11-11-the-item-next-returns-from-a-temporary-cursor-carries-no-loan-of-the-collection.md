# The item `next()` returns from a temporary cursor carries no loan of the collection

**Severity:** S1. `a := (&xs).into_iter().next()` passes `yo check` with `a` carrying no loan of `xs`: the list is
then grown (reallocated) and `a`'s `&String` is read (ASan: heap-use-after-free). The same with a user cursor
built through `impl(&(Bag, p), IntoIterator)`, through the `skip`/`take` adapters, and through an identity
function. A BOUND cursor (`it := (&xs).into_iter(); a := it.next()`) is rejected with E0911. The std form is
not expressible on v0.2.76 (its `ArrayList.into_iter` takes the list by value: E0901); the user-cursor form is
accepted by v0.2.76 too, so the defect predates the new `impl(&C, IntoIterator)` API.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A14). Confirmed on develop `64f33c710`. Lane o6
("call-result origin naming + method-lend", branch in `Yo-wt/o6-m`) was checked on 2026-11-11 and does not cover it:
its binary accepts all five programs the ledger lists as accepted (the std form, the user cursor, `skip`, `take`
and the identity-function form).

## Reproducers

`issues/repros/2026-11-11-the-item-next-returns-from-a-temporary-cursor-carries-no-loan-of-the-collection.yo`
(negative, expects E0911):

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("hello-world-hello-world-hello-world"));
  a := (&xs).into_iter().next();
  mut(i) := usize(0);
  while(i < usize(1000), i = (i + usize(1)), {
    xs.push(String.from("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
  });
  match(a, .Some(s) => println(`OUT: ${s.*}`), .None => ());
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  lane o6 (2026-11-11): accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-user-cursor.yo` (negative, E0911): the same with `BagCursor(p)` and `impl(&(Bag, p), IntoIterator)`;
  heap-use-after-free; v0.2.76 accepts it. The same cursor made by a free function, `cur(&b).next()`, is E0911.
- `…-pos.yo` (positive control): the item's last use is before the list grows. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `a := (&xs).into_iter().next()`, then `xs.push` ×1000, `a` read | accepted, UAF | E0911 |
| the same with a user `BagCursor(p)` from `(&b).into_iter()` | accepted, UAF | E0911 |
| `(&xs).into_iter().skip(usize(1)).next()`, `.take(usize(1)).next()` | accepted, UAF (ledger) | E0911 |
| `keep((&xs).into_iter().next())` through `keep :: (fn(o : Option(&String)) -> Option(&String))(o)` | accepted (ledger) | E0911 |
| `cur(&b).next()`, `cur :: (fn(b : &Bag) -> BagCursor(b))` | E0911 | — |
| `mut(it) := (&xs).into_iter(); a := it.next()` | E0911 | — |
| bound adapter `mut(it) := (&xs).into_iter().skip(…)`; `c := …; mut(it) := c.skip(…)`; `mut(d) := c` | E0911 (ledger) | — |
| `a := (&xs).index(usize(0))` | E0911 (ledger) | — |


## Root cause

Hypothesis, partly verified by reading the source. `next(self : &mut Self) -> Option(&(String, p))` spells its
result's origin `p` through the receiver's POINTEE (`Self = ArrayListIter(p)` / `BagCursor(p)`), so
`projection_call_root_args` (`src/evaluator/utils.yo`) does not list the receiver as a root, by design ("A receiver
whose POINTEE carries them … is no root: the result points where the receiver's references point (the holder
walk …)"). That holder walk is `_origin_carrying_roots_shallow`'s receiver branch (mode 2 of `_call_origin_mode`),
which reads `_holder_roots_into` only when the receiver is an ATOM, i.e. a bound cursor whose `bind` registered
`xs`. A temporary receiver contributes nothing there, and nothing computes `origin_of` of the receiver EXPRESSION
`(&xs).into_iter()` instead. That accounts for the bound-vs-temporary split. Why `cur(&b).next()` is still rejected
(its receiver is a temporary too) is not established; the difference is that `cur`'s result names a parameter
(`BagCursor(b)`), while `into_iter(self : Self) -> BagCursor(p)` binds an impl origin parameter from the receiver
lend's type.

## Expected

E0911 at `xs.push(…)`: `a` borrows `xs`. R-CALL (BCC §3) gives `next`'s result the receiver's origin
substituted for `p`; for a receiver that is itself a call, that origin is the call's own R-CALL result, `{(xs, &)}`
here, exactly as for a bound cursor ("the element binding `bind` with the cursor's origin (R-CALL over `next`)",
BCC's `for` row). A pointee-carrying receiver that is not an atom must contribute `origin_of(receiver)`.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
beside `for-element-stored` in `tests/origins/corpus.tsv` for the temporary-cursor item, and the adapter forms in
`tests/for_macro_borrow.test.yo`.
