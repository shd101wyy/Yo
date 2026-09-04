# A short-circuit `||`/`&&` that IS a whole fn body leaks its operand temps (the pending channel is empty there)

**Status: FIXED for the two-operand family; CHAINED operands partially
covered** (attempt 5, PR #409 — a chain's INNER nested operand still leaks;
see Remaining work). Root cause unchanged from the
filing: a single-expression fn body takes generation.yo's NON-BEGIN path —
no codegen begin opens, so `context.pending_deferred_drops` is EMPTY, and
the operand temps' scope drops ride the shared body node's own ExprInfo
list with no emission point (the flush-first gate-skips them as
not-yet-declared; the implicit-return tail flushes param drops only; the
expression-internal flushes only see their own call nodes).

```rust
is_res :: (fn(id : String) -> bool)(
  (id == `forall`) || (id == `∀`)
);
```

leaked 4 allocations per call under `--sanitize address --allocator system`.

## The fix (attempt 5 — the one that landed)

`_emit_drops_for_conditional_branch` (src/codegen/exprs/and_or.yo) gained a
second drop source: the SHORT-CIRCUIT ROOT NODE'S OWN deferred-drop list,
filtered to the same operand var_names and emitted at the existing points —
operands 1..n IN-BRANCH (inside their own still-open blocks; the emitter's
block-scope stack pops at the closing brace, so an in-branch point is the
only place their C declarations are in scope) and operand 0 at the
fall-through (function scope). Four gates, each closing a documented
failure class:

1. the NAME-KEYED HANDLED SET — cross-channel dedup: on begin-opened shapes
   the same TARGET reaches the pending source with a DIFFERENT drop-expr
   identity (the pending copy and the shared-id node list are distinct
   exprs), which the expr-id guard cannot see — the first cut of this fix
   double-dropped exactly there (mbleak UAF, diffed C: 2 baseline drops → 3);
2. the expr-id emitted-once guard (`emitted_deferred_drop_ids`, PR #403);
3. the closure-capture skip;
4. the block-scope stack — the target's C declaration must have been
   EMITTED and still be IN SCOPE (the registered-but-never-emitted
   divergence class can never pass; out-of-scope targets are left for their
   own scope's machinery).

CHAINS (`a || b || c`, which parses as NESTED binaries `(a||b)||c`) are
PARTIALLY covered: the outermost node's closing loop and fall-through
reach the outer operands' drops through the node source (a chain's leak
drops from 4 to 2 allocations per call under the ASan repro), but the
INNER `||`'s own list is empty (its operand temps' drops are scheduled
onto the outermost/body node's list), so the inner operand's temps still
leak. See Remaining work.

Built and validated locally with a cleanly-built (post-#403) compiler,
sidestepping the v0.2.23 seed-build lottery (`issues/
v0.2.23-seed-build-lottery-corrupts-shifted-trees.md`) that had masked
attempt 4's verdict (the v0.2.24 seed has since landed — the lottery is
over). Regression net: `tests/internal/short_circuit_drops.test.yo` —
whole-body `||`, whole-body `&&`, and the statement-position parity shape;
under the develop-codegen control binary the two whole-body tests
leak-abort and the statement-position one passes (the exact pre-fix
split); all three pass with the fix.

## Remaining work: the chain's inner operand

`(a || b) || c` as a whole fn body still leaks operand `b`'s temps (2
allocations per call). The designed continuation — threading the
OUTERMOST short-circuit node (e.g. a `short_circuit_root_node` context
field set when unset, restored on exit) so the inner `||`'s emission
points read the root's list — was implemented and locally built twice,
and both builds double-dropped operand `a`'s temp at the two fall-through
points: the same drop EXPR was considered twice with BOTH dedup signals
(emitted-once guard, name-keyed handled set) reading empty at the second
consideration, despite a control print proving the guard insert works in
a sibling emitter. Emissions also appeared in the C from paths none of
the three instrumented emitters (helper pending source, helper node
source, drop_dup's guarded emitter) reported — an uninstrumented fourth
emitter places drops at the fall-through positions. The next session
should instrument the remaining direct `_call_generate_expr(drop_expr)`
sites (return.yo:376/468/522, atom.yo:53/388/554, while_loop.yo:214,
begin.yo:153) — a ready-made patch exists in the session record — before
re-landing the root threading.

## The earlier attempts (kept for the record)

1. scopes-gated tail flush — double emission across emitters that do not
   remove-on-emit ("mimalloc: corrupted free list entry").
2. unfiltered bare-tail second chance + removal-on-emit —
   registered-but-never-emitted temps (`use of undeclared identifier`);
   removal-on-emit also inverts the pending path's `already` contract.
3. broad ||-node list flush — the same undeclared class plus a bool-target
   drop expr (`.tag` on bool).
4. gated tail flush in return.yo/generation.yo — verdict was INCONCLUSIVE
   (its CI failure was the seed-build corruption lottery: the branch-built
   binary aborted on eval-only `check` with zero flush emissions firing;
   a control binary from the identical tree minus the flush was clean).
