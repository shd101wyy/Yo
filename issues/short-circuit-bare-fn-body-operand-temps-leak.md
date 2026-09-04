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
4. **gated tail flush** (emitted-once guard + `require_scope_stack`
   block-scope gate) — **verdict: INCONCLUSIVE, not disproven**. Its CI run
   failed (wasm32-wasi SHA-1 abort; stage-3 byte-identity fail) and the
   branch-built binary aborts even on eval-only `yo check` of hello world —
   but a probe build with emission prints showed ZERO emissions firing
   before the abort: the corruption is the **seed-build lottery**
   (v0.2.23's latent self-miscompiles — the class documented in
   `issues/fixed/seed-built-stage1-miscompiles-current-source.md`), which
   lands on a tree's exact eval shapes and can strike ANY branch that
   shifts them. A control binary from the identical tree minus the flush
   compiles cleanly. The flush itself was never actually invalidated.

## Next direction

**Precondition: a seed that carries the #403/#405 fixes** (the emitted-once
guard closed the seed's own double-emission class). After the next release
bumps SEED_VERSION past v0.2.23, re-land attempt 4 verbatim and let the
self-hosted CI chain judge it — the corruption noise that masked the
verdict is the old seed's, not the change's. If it still corrupts, pinpoint
with the YO_DEBUG_TAIL_FLUSH probe (read the env IN-FUNCTION — module-level
reads fire before std/env is populated) and design a consumption gate
mirroring `_keep_pending_drop`'s `consumed_at_token` check.
