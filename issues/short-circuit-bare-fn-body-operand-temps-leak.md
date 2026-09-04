# A short-circuit `||`/`&&` that IS a whole fn body leaks its operand temps (the pending channel is empty there)

**Status: OPEN** (carved out of
`issues/fixed/parser-multibyte-spec-tests-leak-under-linux-asan.md`, whose
real-world shape — the tokenizer's reserved-word check inside begin blocks —
IS fixed; this is the narrow residual).

## Reproducer

```rust
is_res :: (fn(id : String) -> bool)(
  (id == `forall`) || (id == `∀`)
);
```

100 calls leak 400 allocations under `--sanitize address --allocator system`
(the two `String.from(...)` temps the `==` promotions create for the str
literals — and under the bare-body shape, BOTH operands' temps leak: the
closing-loop's in-branch emission also reads the pending channel).

## Mechanism

A single-expression fn body takes generation.yo's NON-BEGIN path: no codegen
begin opens, so `context.pending_deferred_drops` is EMPTY — the operand
temps' scope drops ride the shared body node's own ExprInfo list (the
evaluator's begin concat). The body-level flush-first gate-skips them (their
C declarations do not exist yet), the expression-internal flushes only see
their own call nodes, and the implicit-return tail flushes param-targeted
drops only. No emission point exists. (With begins open around the `||` —
every real-world occurrence surveyed — the pending-side operand-0 emission
in `generate_op_and`/`generate_op_or` covers it; that fix landed and is
verified.)

## Four failed attempts at the body-level flush (do not repeat blind)

1. **scopes-gated tail flush** (attempt 2 of the original leak work):
   double emission across emitters that do not remove-on-emit —
   "mimalloc: corrupted free list entry".
2. **unfiltered bare-tail second chance + removal-on-emit** (attempt 3):
   registered-but-never-emitted temps (`use of undeclared identifier`) —
   and removal-on-emit inverts the pending path's `already` contract.
3. **broad ||-node list flush** (this branch, first try): same undeclared
   class plus a bool-target drop expr (`.tag` on bool) from inner-node lists.
4. **gated tail flush** (this branch, second try — emitted-once guard +
   `require_scope_stack` block-scope gate): the branch-built compiler
   ABORTS with `mimalloc: corrupted free list entry` compiling even
   trivial files — the wrongly-emitted drop is somewhere in the compiler's
   own bare-tail fns, and the wasm32-wasi leg failed the same way
   (tests/crypto SHA-1, exit 34304). Conclusion: the scheduler-produced
   body list contains drops whose release is accounted for ANALYTICALLY
   elsewhere (the `_optimize_dup_drop_pairs` cancellation family) — none of
   the four gates (emitted-once, undeclared-temp, scope-stack,
   closure/short-circuit) covers that class.

## Next direction

Pinpoint the wrongly-emitted drop FIRST, then design the gate around the
actual failure: build the compiler from a tail-flush branch with
`--sanitize address` (an ASan compiler build points at the exact over-
release), or add a debug env-gated print of every tail-flushed
drop's target and module path, compile the tree, and read the first drop
whose target is analytically cancelled. The likely missing gate is a
consumption/cancellation check mirroring `_keep_pending_drop`'s
`consumed_at_token` logic (return.yo) for the node-list channel.
