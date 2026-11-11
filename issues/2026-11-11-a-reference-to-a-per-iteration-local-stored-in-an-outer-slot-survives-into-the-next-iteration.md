# A reference to a per-iteration local stored in an outer slot survives into the next iteration

**Severity:** S1. `while(…, { match(slot, .Some(r) => use(r), …); b := Box.new(…); slot = .Some(&b.*); })` passes
`yo check`: the slot declared outside the loop is given a reference to a local of the loop body at the end of one
iteration and read at the top of the next, after the local was dropped (ASan: heap-use-after-free for a Box payload,
stack-use-after-scope for the local itself). Pre-existing: v0.2.76 accepts every form.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A19, part a). Confirmed on develop `64f33c710`. The second
back-edge defect, a write that precedes a lend in the body's text, is
`issues/2026-11-11-a-write-that-precedes-a-lend-in-a-loop-body-is-not-checked-against-the-loan-the-back-edge-carries.md`
(A19b): a different check misses it, so it is filed apart.

## Reproducers

`issues/repros/2026-11-11-a-reference-to-a-per-iteration-local-stored-in-an-outer-slot-survives-into-the-next-iteration.yo`
(negative, expects E0911):

```yo
L :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
main :: (fn() -> unit)({
  mut(slot) := Option(&String).None;
  mut(i) := 0;
  while(i < 3, {
    match(slot, .Some(r) => println(`OUT: ${r.*}`), .None => ());
    b := Box.new(L());
    slot = .Some(&b.*);
    i = (i + 1);
  });
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-stack.yo` (negative, E0911): `b := L(); slot = .Some(&b);` — the String itself is the body's local:
  stack-use-after-scope.
- `…-for.yo` (negative, E0911): a struct holder `h = H(r : &y.*, n : i)` re-pointed at a `for` body's local and read at
  the top of the next iteration: heap-use-after-free.
- `…-pos.yo` (positive control): the slot is read in the iteration that stored it and overwritten before any later
  read, so no dead local is reached over the back edge.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `Option(&String)` slot, `slot = .Some(&b.*)` over a body-local Box, read at the next iteration's top | accepted, heap-use-after-free | E0911 |
| the same with `b` a body-local `String` (ledger l08b; `if(i > 0, …)`-guarded read, l08e) | accepted, stack-use-after-scope | E0911 |
| the lend through a borrowed match, `match(&b, Box(s) => { slot = .Some(s); })` (ledger l07) | accepted, heap-use-after-free | E0911 |
| a struct holder over a body-local Box in a `while` (holders j06b) or a `for` body (j12); a typed `Option(&Rc(X))` slot (j08) | accepted, UAF / stack-use-after-scope | E0911 |
| the slot read AFTER the loop instead (holders j05, j13) | E0911 "`y`'s scope ends with its block, while `h` is live to its last use" | E0911 |
| the slot read only inside the storing iteration (`…-pos.yo`) | accepted | accept |

## Root cause

The store is judged by the §7 scope check in `bind_join_roots_for` (`src/evaluator/utils.yo`): a ground root whose
binding's scope ends before the holder's live range ends is E0911. Both ends are TEXT positions. The holder's range
comes from `local_borrow_range_of` over the holder's own `:=` statement: its last mention is the `while` statement,
and `_lb_region_end` treats a loop as "live to its end", which is the last token of the loop body — the same token
that ends `b`'s block (`_lb_binding_site_of(&root_v).scope_end`). `_lb_tok_after(&root_live_to, &root_site.scope_end)`
is a strict comparison, so the store passes (`YO_DEBUG_N2B=1`: `join-register slot: … ground=[b(imm)]`, no error).
Nothing models that the slot is live AROUND the back edge: it is read at the top of the body before any reassignment,
so at `b`'s scope end the slot is still live, and the loop body is evaluated once (`evaluate_while` in
`src/evaluator/exprs/while.yo`; `check_loop_flow` in `src/evaluator/utils.yo` joins move states only, never loans).
The read after the loop is caught because it lies textually after `b`'s block.

## Expected

E0911 at `slot = .Some(&b.*)`: a holder that is live at the loop head — read in the body or the condition before
it is reassigned on every path from the head — is live at the end of the body, so a store of a body-local's
reference into it outlives that local. `BORROW_CHECKER_COMPLETENESS.md` §3: "a holder's loans are the join over
reaching definitions (loops to a fixpoint)", and the `bind` row: "the holder's set becomes the join over reaching
definitions, including the loop back edge"; `REFERENCES_AND_ORIGINS.md` §4 states the per-body analysis is "joined
at control-flow merges and iterated to a fixpoint over loops". The reference checker (`tests/origins/model.yo`) has
that fixpoint; the compiler does not.

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`loop-store-body-local-read-next` (neg, E0911) and `loop-store-body-local-read-same` (pos) in
`tests/origins/corpus.tsv`, beside `flow-slot-lent-mut-loop`.
