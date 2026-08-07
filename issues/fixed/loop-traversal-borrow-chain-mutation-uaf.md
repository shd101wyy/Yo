# Loop-traversal borrow-chain optimization: use-after-free when the loop mutates the structure

**Found 2026-08-06** while auditing `docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`
for soundness. **Fixed the same day** (mutation/escape guard in
`optimizeLoopTraversalBorrowChain`, `src/evaluator/exprs/begin.ts`).

## Symptom

`optimizeLoopTraversalBorrowChain` removes ALL RC operations from the
`(x : Option(Node)) = param.field; while(runtime(true), match(x, …, x = binding.field))`
traversal pattern. Its safety argument — every node the traversal variable borrows stays
alive through the parameter's ownership of the structure — was never checked against
**mutation**: nothing in its criteria inspected what else the loop body does.

Deterministic reproducer (macOS, `--release`, no sanitizer): sever the chain inside the
loop while the un-dup'd traversal variable still points at the severed sublist.

```rust
Node :: ref(struct(value : i32, next : Option(Self)));

walk :: (fn(head : Node) -> unit)({
  (current_opt : Option(Node)) = head.next;   // detector requires `(x : T) =` form
  (first : bool) = true;
  while(runtime(true), {
    match(
      current_opt,
      .None => return(()),
      .Some(current) => {
        if(first, {
          first = false;
          head.next = Option(Node).None;      // severs: frees node2 and node3
        });
        println(`visit ${current.value}`);    // reads freed memory
        current_opt = current.next;           // walks freed memory
      }
    );
  });
});
```

With `head → n2 → n3` built inline (chain is the sole owner), the optimized build printed
`visit 0` / `done` instead of `visit 2` / `visit 3` — the traversal read freed, scribbled
memory and silently terminated early. The same program with `current_opt := head.next`
(`:=` init, which the pattern detector does not match) kept its dups and printed correctly,
isolating the optimizer as the cause.

## Fix

`traversalLoopHasUnsafeUse` (begin.ts) — a conservative scan of the while body run before
the optimization fires. It rejects the optimization when the body contains:

1. an assignment through a projection or index (`node.next = …`, `arr(i) = …`) — severing
   a link drops the borrowed sublist mid-walk;
2. a call (including `return`/`unwind` and constructors) receiving one of the traversal
   names (`current_opt`, the match binding, the init-source root such as `self`) as a
   bare-atom argument or method receiver, or any argument/receiver whose evaluated type is
   compatible with a traversal type — the callee could sever the chain through it or keep
   a node alive past the loop.

Pattern-binding positions (`=>` arm patterns) are skipped; operators, projections, and
cond/match/begin structure are recursed through without triggering the argument check, so
the read-only traversals the optimization was built for (e.g. the `LinkedList` `Index`
impl, `std/collections/linked_list.yo`) still optimize to zero RC operations — verified in
the emitted C.

## Known residual holes (accepted, documented)

- Mutation through a **global alias** inside a callee that never receives the structure.
- Node access through intermediate values whose static type does not mention the traversal
  types.

Closing these needs real borrow/alias inference (what Lobster does) or runtime exclusivity
enforcement (what Swift does); tracked as part of
`issues/borrowed-arg-invalidated-by-aliased-container-mutation.md`.

## Verification

- Reproducer above: `visit 2` / `visit 3` / `done` after the fix (guard rejects; 3 dups
  present in the emitted C).
- Read-only `sum` traversal: still 0 RC operations in the emitted C (optimization fires).
- Regression test: `tests/rc.test.yo` "Loop traversal keeps ownership when the loop
  mutates the structure" (asserts the severed traversal still visits nodes 2 and 3).
- `tests/collections/linked_list.test.yo`: 69/69.
- yo-self: not affected — the port's `optimizeLoopTraversalBorrowChain` is a documented
  no-op (`yo-self/evaluator/exprs/begin.yo` header).
