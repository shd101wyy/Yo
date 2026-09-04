# A ref-typed named local passed by value to a call misses its scope-end drop — the whole RC group leaks

**Status: FIXED** (the begin-epilogue shared-id drop clobber + the emitted-once
flush guard). Root cause, fully characterized from the emitted C and a shape
bisect: Aliasing Stage-0 gives an RC-typed **field projection** passed to a
borrowing parameter a caller-side `___dup` whose temp is marked CONSUMED, so
its ONLY balancing release is the synthesized `___drop(<dup temp>)` the
evaluator attaches to the **call node** ("single post-call emission"). But a
call that is the sole expression of a begin block shares the AST node id with
that begin, and the begin epilogue —
`src/evaluator/exprs/begin.yo` `out_info.deferred_drop_expressions =
scope_end_drops` (RC layer Phase B original) — **clobbers** that list,
discarding the balancing drop while the dup itself survives
(`deferred_dup_expressions` is carried by the shared-id clone). +1 with no -1:
the whole group leaks. Reproduced at fn-body bare tails (trait-impl method
`YoError.to_string` = `render_diagnostics_human(self.diagnostics)`, plain
top-level fns) and bare `match`-arm bodies; mid-block call positions keep a
separate call node and were always correct.

(surfaced 2026-09-03 by the P2 error-diagnostics work; verified
**pre-existing** — reproduces identically on the P1 commit's code and on a
stage-1 built from pristine `origin/develop`.)

## Reproducer

`issues/repros/ref-local-scope-drop-leak3.yo` (looped) /
`issues/repros/ref-local-scope-drop-leak6.yo` (single-shot):

```rust
diags := ArrayList(Diagnostic).new();
diags.push(Diagnostic(code : Option(String).None, /* … */));
err := YoError(diagnostics : diags);   // ref-struct ctor takes the list by value
s := err.to_string();
```

```bash
nix-shell shell.nix --run '~/.local/bin/yo compile issues/repros/ref-local-scope-drop-leak6.yo --sanitize address --allocator system -o /tmp/leak6bin'
/tmp/leak6bin
# SUMMARY: AddressSanitizer: 674 byte(s) leaked in 8 allocation(s).
```

Per construction, exactly 8 allocations leak: the `ArrayList` header (the one
DIRECT root), its element buffer, the `Diagnostic`'s three `String`s (header +
data each) — i.e. **the entire `diags` group**. Looping ×100 leaks exactly ×100.

## Mechanism (read off the emitted C)

The emitted `to_string` is:

```c
__yo_t0* t1 = (*self)->diagnostics;          // projection
__yo_t0* t2 = __yo_incr_rc(t1);              // Stage-0 caller-side dup (+1)
__yo_effect_escaped = 0;
__yo_t4 t3 = render_diagnostics_human(t2);   // the call
if (__yo_effect_escaped) { return …; }
return t3;                                   // ← NO __yo_decr_rc(t2)
```

`__yo_user_main` is CORRECT (the ctor pass legitimately transfers the local's
ownership — the dup/drop pair optimizer cancels that dup against the scope-end
drop); the missing decr is the call's own balancing drop, so the group's
refcount never reaches 0.

The same shape leaks in `suggest_code` in `src/diagnostics_registry.yo`
(`entries := registry_entries(); … entries.get(i)`), which is why
`tests/internal/diagnostics_registry.test.yo`'s suggestion test reported a
leak, and why several `tests/internal/error.test.yo` golden tests reported
leaks under LeakSanitizer: the error-construction chain
(`ArrayList(Diagnostic)` → ref-struct `YoError` → `to_string`) is this pattern
exactly. Read-only callees are NOT affected — Aliasing Stage 1 elides their
dups entirely (verified: a `diags.len()` callee leaks nothing).

## Evidence it is pre-existing

- Built against the **P1 commit's** `src/diagnostics.yo`/`src/error.yo`
  (`git show d2be247cb:…` into a scratch module dir): same 8-allocation leak.
- Compiled by a **stage-1 built from this tree**: same leak — the codegen
  carries it, not just the v0.2.23 seed.
- The two `tests/internal/parser.test.yo` multibyte failures
  (issues/parser-multibyte-spec-tests-leak-under-linux-asan.md) are likely
  the same mechanism (small leaked groups in a spec-peel path).

## The fix (third attempt — this one landed)

1. **Stop the clobber** (`src/evaluator/exprs/begin.yo`, begin epilogue): on a
   `shared_with_tail` node, CONCAT the tail's own `deferred_drop_expressions`
   after the begin's `scope_end_drops` instead of replacing them — the
   faithful port of TS, where the inner expr is a separate node that keeps its
   own drops (begin.ts clones it; the shared-id port had collapsed the two and
   the drop side lost).
2. **Emitted-once guard** (`FunctionGenerationContext.emitted_deferred_drop_ids`,
   a per-function `HashSet(usize)` of emitted drop-expr ids; checked in
   `drop_dup.yo generate_deferred_drop_expressions` and codegen
   `begin.yo _emit_deferred_drops`): a shared node is now legitimately
   flushed from several points (the call emitter's post-call flush, then the
   enclosing arm/body-level flush — e.g. match.yo's arm flush), and the
   emitters must not re-emit. The guard is keyed by expr IDENTITY (not target
   name — same-named locals in sibling scopes are distinct drops) and is
   deliberately NOT removal-on-emit: node-list membership is the pending
   path's "the node's own flush handles it" signal
   (`generate_pending_deferred_drops`'s `already` set), which removal would
   invert into double emission through the pending path.

Why the two earlier codegen-side attempts failed (both reverted):
- scopes-gated tail flush → "mimalloc: corrupted free list entry" (double
  emission across emitters that do not remove-on-emit);
- idempotent drop flush + unfiltered bare-tail second chance → stage-2
  "use of undeclared identifier `_temp_NNN`" (the flush emitted drops whose
  temps were registered but never emitted as C declarations) plus corpus
  rc=134s. This fix adds NO new flush point and NO unfiltered flush: the
  preserved drops ride the call emitter's existing post-call flush — the same
  channel the mid-block position always used.

Validation: local rebuilds of the tree are killed by this environment's
~600 s CPU reaper, so CI is the validator — the internal-test shards (which
build the test binaries under LeakSanitizer and caught this leak), the tier-1
corpus (the rc=134 trio of the second attempt), and the fixpoint battery.

## Test coverage

The five variants suspended while the leak was open are restored
(`tests/internal/error.test.yo` ×3, `tests/internal/parser.test.yo` ×1,
`tests/internal/diagnostics_registry.test.yo` ×1), plus a new golden pinning
the trait-dispatch tail itself (`YoError.to_string renders through the trait
tail`) — under the shard's LeakSanitizer build it is the leak's permanent
regression net.

Restoring them surfaced that the suspension had ALSO been masking two
unrelated staleness bugs in the variants themselves (both pre-existing on
develop, verified under the seed compiler; fixed in the same PR):

- The renderer goldens predated P2's classifier coverage and explain tail:
  classified messages now render `error[EXXXX]:` headers and every coded
  diagnostic gains a `help: run \`yo explain EXXXX\` …` tail line, so the
  multi-line/lexer/coded/make_parse_error pins were updated to the current
  contract (E0601 / E0005 / E0308 / E0001).
- `suggest_code`'s test had chosen a target that IS a registered code (E0402
  — suggest_name deliberately returns None when the target exists) and a
  "far miss" the later E09xx registry family brought within the distance-3
  threshold (E9999). Re-picked: E1404 → E0404 (unique nearest, no
  first-listed-wins tie) and E99999 (unreachably far).
