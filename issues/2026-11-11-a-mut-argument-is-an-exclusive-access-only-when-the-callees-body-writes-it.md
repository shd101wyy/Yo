# A `&mut` argument is an exclusive access only when the callee's body writes it

**Severity:** S1. Whether `f(&mut xs)` conflicts with a live `&` loan of `xs` is decided from a summary of `f`'s
BODY. A callee that only returns or stores the lend — `(&mut xs).into_iter()`, a cursor or holder constructor —
counts as a read, so the caller ends up holding a `&mut` path beside live `&` loans. Since #1876 lowers
`for(&mut xs, …)` to `(&mut xs).into_iter()`, every write walk is affected: accepted, heap-use-after-free. The
write-walk forms are a regression since v0.2.76 (the seed rejects them with E0911); the holder form predates it.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A6). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-mut-argument-is-an-exclusive-access-only-when-the-callees-body-writes-it.yo`
(negative, expects E0911; v0.2.76: E0911 "Cannot borrow with `&mut` `xs` here"):

```yo
main :: (fn() -> unit)({
  mut(inner) := ArrayList(String).new();
  inner.push(String.from("hello-world-hello-world-hello-world"));
  mut(xs) := ArrayList(ArrayList(String)).new();
  xs.push(inner);
  r := xs.index(usize(0)).index(usize(0));
  for(&mut xs, x => {
    x.* = ArrayList(String).new();
  });
  println(`OUT: ${r.*}`);
  ()
});
```

```text
$ yo check repro.yo        # develop: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-callee-walk.yo` (negative, E0911; v0.2.76 rejects): a read-walk element is stored in an outer slot, then
  `overwrite(&mut xs)` runs, whose body is `for(&mut b.*, x => { x.* = …; })`, then the slot is read. The same through
  a `&mut self` method.
- `…-holder.yo` (negative, E0911; accepted by v0.2.76 too): no `for` at all —
  `handle :: (fn(b : &mut Bag) -> Handle(b))(Handle(b)(bag : b));`, then `h := handle(&mut b); h.bag.items.clear();`
  while `r`, a `&` into `b.items`, is live.
- `…-pos.yo` (positive control): the `&` loan's last use is before the walk.

- `…-fn-value.yo` (negative, expects E0911): `f := clear; f(&mut x)` inside a `match(&x, .Some(p) => …)` arm that
  reads `p` afterwards. Accepted; ASan SEGV reading through the cleared `Option`.
- `…-dyn-trait.yo` (negative, expects E0911): the same through `d.wipe(&mut x)` on a `Dyn(Wiper)`.

## The family (develop `64f33c710`)

| Shape | Verdict |
| --- | --- |
| `for(&mut xs, …)` while a `&` into `xs` is live; `HashMap` and `Deque` write walks | accepted, UAF |
| an explicit `&mut` cursor `it := (&mut xs).into_iter()` beside a live `&`; a `&` cursor live across a later `&mut` cursor | accepted |
| a write walk nested inside a read walk of the same list | accepted |
| a callee or `&mut self` method whose body is a write walk | accepted, UAF |
| a callee returning `Option(&mut …)` or a holder of its `&mut` parameter | accepted, UAF |
| two callees that differ only in their BODY: `f(&mut xs)` with an empty or read-only body vs one that writes, each called while `r := &xs…` is live | accepted vs E0911 |
| a callee with NO body to summarize, its real body a direct write (`o.* = .None`): a function value (`f := clear; f(&mut x)`), a function-pointer parameter, an `Impl(Fn(...))` parameter, a `Dyn(Fn(...))`, a `Dyn(Trait)` method — each called while a `&` loan of `x` is live (added with VERDICTS-57's probe (a); v0.2.76 accepts all five too) | accepted, ASan SEGV |
| the same callee called directly by name, or as a trait method of a `where`-bound generic parameter | E0911 |
| a `&mut` callee whose body writes the parameter directly (field write, `push`, `clear`, `.* =`) | E0911 |
| two `&mut` cursors over one list; a read walk while a `&mut` BINDING is live; a read walk nested in a write walk | E0911 |

## Root cause

`d3_check_pending` (`src/evaluator/exprs/assignment.yo`) turns a `&mut` argument into a `Write` access against the
live loans only when `param_mutation_mask_hits(function_param_mutation_mask(…))`; otherwise the argument is judged
a `Read`, which a live `&` loan allows. The mask (`src/evaluator/effects/mutation_summary.yo`) records writes the
callee's body performs through the parameter itself. It does not follow references DERIVED from the parameter: a
cursor or holder the callee returns, or a write through a cursor item inside the callee. `into_iter` writes
nothing, so the lend `for(&mut xs, …)` lowers to is a read.

This is a rule the design rejects in so many words. `REFERENCES_AND_ORIGINS.md` O2: elision is "a default the
checker verifies, never inference it trusts"; §6 rejects "inferring a callee's borrow behaviour from its body — the
contract would live in the body; an edit inside one function silently changes what callers may do"; O3 step 2 and
decision 28 make a `&mut` lend an exclusive access of its place. The mutation summary was built for D3 (the
"`&mut` never written" diagnostic) and the runtime asserts, and leaked into exclusivity.

A callee with no body is the same rule's other end. `d3_check_pending_unresolved_callee` (same file) handles a
`Dyn(Fn)` value or a function pointer and says so: "Only the borrowed-value entries are judged; the D3 atomic and
local-borrow entries keep needing a body." With no body there is no mask, the local-borrow entry of the `&mut`
argument is never judged, and the lend is not an access at all. The `for(&mut …)` form is new since v0.2.76 (#1876
moved the walk onto `into_iter`); the bodyless form is not.

## Expected

A `&mut` argument, the receiver included, is an exclusive access of its place at the call's activation point
whatever the callee's body does (E0911 against any live loan of an overlapping place; E0910 against another
argument). The mutation mask feeds only D3 and the runtime asserts.

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`for-mut-walk-while-shared` (E0911) and `mut-lend-readonly-callee-while-shared` (E0911); `tests/for_macro_borrow*.test.yo`
gains the write-walk-under-a-live-`&` case.
