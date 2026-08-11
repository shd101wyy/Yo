# 2.3 blocker: the v0.2.0 seed binary mis-handles compiling current yo-self

**Status: OPEN** (2026-08-11). Found by PR #98's first seed-driven CI run
and reproduced locally.

- **Linux CI (hollow sweep)**: seed-built stage-1 completes but the produced
  compiler FAILS `tests/comptime.test.yo` + `tests/fn.test.yo` (RED) — both
  pass under a TS-built stage-1 of the same source.
- **macOS local**: the v0.2.0 binary compiling current `yo-self/main.yo`
  errors out with `mimalloc: mi_free: invalid pointer` (stage-1 never
  produced).

## Why this was expected eventually

A release binary IS a stage-2-class binary. The yo-self codegen still
carries known self-built-only debt — most prominently the async match
scrutinee-store family (`_store_temp_var_to_state_machine_if_needed` is a
documented no-op stub; the TS-side fixes from PR #92/#93 were never
ported), plus whatever new code shapes landed since v0.2.0 (TestSuite.
exclude, the #95 yo-self changes) that the seed never compiled before.
Compiling current source is the heaviest RC/async workload there is, so the
debt surfaces as invalid frees / subtle miscompiles.

## Path forward (ordered)

1. **Port the scrutinee-store family to yo-self codegen** (the standing
   "yo-self port pending" item) + rerun the fixpoint AND a seed-style
   self-build-of-self battery locally (a self-built binary building the
   source again — stage-2 building stage-1 — is the new pre-release gate).
2. Ship that as v0.2.2-class release; only then bump SEED_VERSION and land
   PR #98 (2.3). v0.2.1 (same codegen, current fixes) may improve things
   but carries the same stub debt — verify before trusting.
3. PR #98 stays open until a seed exists whose self-built stage-1 passes
   the full sweep. The 2.3 workflow changes themselves are correct.

## Repro

```bash
curl -fsSL https://github.com/shd101wyy/Yo/releases/download/v0.2.0/yo-v0.2.0-macos-arm64.tar.gz | tar -xz
YO_MAIN_STACK_MB=4096 ./yo-v0.2.0-macos-arm64/bin/yo compile yo-self/main.yo --release --allocator mimalloc -o /tmp/yo-seedstage1
# macOS: mi_free invalid-pointer errors; Linux: binary produced but
# tests/comptime.test.yo + tests/fn.test.yo RED under it.
```

## Progress (2026-08-11, evening)

The scrutinee-store port landed (`_store_temp_var_to_state_machine_if_needed`
is real in yo-self; s60 battery fully green incl. FIXPOINT_HOLDS with the
stores in the emitted C). The stage-2 gate moved but is not closed:

- stage-2-built binary: async_await 162/162 ✓ (was part of the crash class)
- `comptime.test.yo` / `fn.test.yo`: the binary now SEGVS (exit 11) while
  COMPILING the generated batch program (`--verbose` shows "batch compile
  failed (exit 11)"; non-verbose confusingly exits 0 — separate runner bug
  worth a look). Same family, next layer.

Next: rerun the failing batch with --keep-generated-files (if supported) or
regenerate it, compile it directly under /tmp/local_s2 vs /tmp/yo-s60 to
isolate evaluator-vs-codegen phase, then bisect the batch contents. The
remaining unported family pieces are the match.ts:279 + state-code-gen.ts:1644
scrutinee-store call-site mirrors and the binding-registration/dispose-skip
pair (yo-self match.yo has NO SM handling at all — 19 TS call sites total,
inventory pending).

## ROOT CAUSE ISOLATED (2026-08-11, late)

Minimal repro (`/tmp/v2.yo`, stage-2 rc=139, stage-1 rc=0):

```rust
main :: (fn() -> unit)({
  io :: __yo_builtin_io;
  begin(comptime_expect_error(comptime_assert(i32 == i32, "x")), ());
});
```

Probes: `comptime_expect_error(comptime_assert(false, "boom"))` OK, bare
`comptime_expect_error(i32 == i32)` OK, undefined-name OK — the throw must
happen INSIDE `evaluate_comptime_assert`'s ARG evaluation.

Function-body diff between the TS-emitted C (`/tmp/ts_stage1.c:502451`) and
the yo-self-emitted C (`/tmp/local_stage2.c:1044848`, `yo_id_369945`) of
`evaluate_comptime_assert` (yo-self/evaluator/builtins/comptime_assert.yo:38),
at the `__yo_effect_escaped` early-return after
`evaluate_expression(arg_expr, ...)`:

```c
// TS (correct):
fn_..___drop(msg_expr_opt);
fn_..___drop(arg_expr_opt);      // drops the OWNING Option locals

// yo-self (the bug):
__yo_decr_rc((void*)(arg_expr)); // drops the BORROWED match binding (.Some(arg_expr) =>)
switch (msg_expr_opt.tag) { case SOME: __yo_decr_rc(msg_expr_opt.data.Some.value); ... }
```

The borrowed `arg_expr` (bound by `.Some(arg_expr) =>` with no dup) gets a
raw decr — over-drop → the AST node dies → codegen later walks it
(`expr_contains_return_statement` reading `e->tag` at offset 0x40) → SEGV.
This is the escape-cleanup borrow-binding class: TS guards with
`resolveDropTargetInScope` (return.ts ~line 336: "match the drop target by
variable identity, not just name — a match-arm payload borrow must not
stand in for the outer variable"). Suspect either `_keep_pending_drop` /
the drop-target C-name resolution in `yo-self/codegen/exprs/return.yo`
resolving the pending drop (which TS resolves to `arg_expr_opt`) to the
inner binding, or the inline drop generator choosing the binding name.

NEXT: instrument/inspect `generate_pending_deferred_drops`'s target
resolution in return.yo for this shape; the extracted bodies are in
/tmp/fn_ts.c and /tmp/fn_s2.c; rebuild s61 + rerun /tmp/v2.yo emit under a
fresh stage-2 to verify any fix (then comptime/fn tests + sweep + fixpoint).

## Minimization status (handoff)

Two mini attempts (/tmp/mini.yo, /tmp/mini2.yo: ref-enum Option binding, arm
calls a throwing fn, single/double binding use) do NOT reproduce — both
codegens emit only temp drops in the arm's escape block, never the binding.
The real comptime_assert arm differs in: the binding is used in a LATER
nested exn.throw inside a TEMPLATE STRING (`${ast_expr_to_string(arg_expr)}`),
there are TWO fn-level Option locals (arg_expr_opt/msg_expr_opt) whose
fn-level deferred drops stack with the arm's, and the arm's begin holds
multiple := declarations. Next repro attempt should copy the arm shape
verbatim (nested match + conditional throw using the binding in a template).

Alternative (likely faster): compare the EVALUATOR-side drop sets directly —
run both compilers on yo-self/evaluator/builtins/comptime_assert.yo alone
(check/emit) with a temporary debug print of deferred_drop_expressions for
the `.Some(arg_expr)` arm's begin (TS: log in match.ts/begin.ts where
deferredDropExpressions is read; yo-self: eprintln in codegen/exprs/match.yo
generate_case_body where cur_drops is read), and diff the entry lists. If
the LISTS match, the bug is yo-self's codegen-side emission (drop-target
name resolution); if they differ, it is evaluator drop policy (the
RC_POLICY_MECHANISM_SPLIT policy-patch family).

Key artifacts: /tmp/v2.yo (6-line crash repro, stage-2 rc=139),
/tmp/fn_ts.c + /tmp/fn_s2.c (the diverging emitted bodies), /tmp/local_s2 +
/tmp/yo-s60 (binaries), /tmp/ts_stage1.c + /tmp/local_stage2.c (full C).

## Analysis trail (2026-08-11, night — for the instrumentation session)

- The buggy escape block (full view, /tmp/fn_s2_full.c lines 40-60) drops
  BOTH `arg_expr` (raw decr — ref-typed, so the entry genuinely targets the
  BINDING) AND `arg_expr_opt`'s payload (inline Option switch) — same node,
  twice. TS drops only the two Options. The delta is exactly ONE extra
  entry: drop(arg_expr). It recurs at ~10 escape points in the fn.
- Ruled out: yo-self's `_resolve_drop_target_in_scope` is a faithful port
  (identity-based); bindings are CREATED non-owning in both evaluators
  (match.ts:921/972 `isOwningTheRcValue: false`; match.yo:2100/2138 pass
  false); BOTH sides have the all-cases-own propagation (expr.ts:2223-2233,
  utils.yo:1592-1595) — so no obvious one-sided flip.
- Mini repros do NOT reproduce (mini/mini2/mini3 in /tmp — arm binding +
  throwing call + reuse + nested-match template throw all emit correct
  escape drops under BOTH codegens). The trigger is something else in
  comptime_assert.yo's arm (candidates: the `(x : Option(T)) = match(...)`
  TYPED fn-level declarations; is_comptime scrutinee flag; the arm being
  inside `if(validating || !executing)`; interaction with the all-cases-own
  merge across the arm's NESTED match).
- NEXT (do this first): instrument — in yo-self/codegen/exprs/return.yo's
  generate_pending_deferred_drops, before emission, eprintln each kept
  drop's `get_deferred_drop_target_atom_name` WHEN it equals "arg_expr",
  plus whether the entry came from pending vs expr-info; rebuild stage-1
  (TS-built, ~10 min), fixpoint stage-2 emit of yo-self, and observe which
  path emits it. Also instrument the all-cases-own flip (utils.yo:1593) to
  eprintln when it flips a var named "arg_expr" — if it fires during the
  stage-2 emit's EVALUATION of comptime_assert.yo, compare with a matching
  console.log in expr.ts:2223 under `./yo-cli check
yo-self/evaluator/builtins/comptime_assert.yo`. REVERT instrumentation
  after.

## FIXED (2026-08-11, night) — 13 lines in yo-self/codegen/exprs/return.yo

Final root cause (three probe rounds; instrumentation reverted): the
executing path's `arg_expr := match(arg_expr_opt, …)` — a LATER fn-level
owning local — has its pending scope drop evaluated at the VALIDATION arm's
`__yo_effect_escaped` cleanup points. That escape path deliberately runs
with `skip_env_check=true` (an earlier stage-2 leak fix) whose liveness
signal is the block-scope stack keyed by C NAME — and the arm's same-named
match binding `.Some(arg_expr)` makes the name look declared, so the later
variable's drop emitted a raw decr against the BORROWED binding.

Fix: the reduced (escape) filter in `_keep_pending_drop` now also applies
the positional guard the full env branch has — the drop's TARGET variable
(resolved by identity from the drop expr) initialized AFTER the cleanup
point is skipped. Mirrors TS's "declared after this cleanup point" skip.

Verified: FIXPOINT_HOLDS; the 6-line repro emits rc=0 under a stage-2
binary; a STAGE-2-BUILT compiler passes tests/comptime.test.yo 30/30,
tests/fn.test.yo 24/24, tests/async_await.test.yo 162/162 (the v0.2.0-seed
RED set); stage-1 suites + 27/27 corpus green. The seed-trust chain is
restored — SEED_VERSION bumps to the first release containing this fix.
