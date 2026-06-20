# yo-self codegen: intermittent SIGTRAP-in-malloc (live heap corruption)

## Status: FIXED (2026-06-21)

**Fix:** in `src/codegen/exprs/match.ts` (`generateMatchArmBody`, begin-block
branch), the begin block's `deferredDropExpressions` were re-emitted at arm
scope-close even when the arm's final expression exits via control flow
(`return`/`unwind`/`break`/`continue`). On that path the control-flow exit had
ALREADY flushed `pendingDeferredDrops` — which, per the concatenation a few lines
above, INCLUDES this begin block's drops — and dedup'd them. Re-emitting them
double-freed the borrowed clone-argument temp (the drops land BEFORE the
returned `finalExprCode`, so they execute live). Guard added: skip the
scope-close `generateDeferredDropExpressions(bodyExpr, …)` when the final
expression has control flow.

**Validation:** the 5 previously-flaky fixtures now compile 0/20 crashes (was
~33% each); corpus differential PASS 80/80, 0 SELF-FAIL deterministically (first
fully-clean serial run); full TS integration suite 2601/2601 (the fix touches
shared codegen — zero regressions). Regression test:
`tests/return_call_clone_arg_drop.test.yo`. Also landed a faithful
`is_join_handle_await_call` clone removal (below).

## (historical diagnosis below)

## Status: OPEN — P0 (blocks deterministic corpus validation)

## Symptom

`/tmp/yo-self-bin compile <fixture>` aborts `rc=133` (EXC_BREAKPOINT / SIGTRAP)
inside the system allocator freelist paths, at innocent allocation sites, long
after the corrupting write. The crash is **non-deterministic**: different
fixtures crash on different runs, and a corpus run under `--parallel 3` reports
SELF-FAIL on a *different* pair of fixtures each time. Standalone re-runs of a
"failed" fixture succeed most of the time.

This is the SAME class as the two already-fixed dossiers
(`issues/fixed/codegen-continue-in-while-heap-corruption.md`,
`issues/fixed/break-continue-skips-loop-body-drops.md`) — those fixed *specific*
triggers; this is a still-live instance.

## Measurement (2026-06-20)

Repeated standalone full compiles of one heavy fixture:

| binary | fixture | crashes |
|---|---|---|
| baseline (pre open-import fix) | `tests/codegen-bootstrap/match_arm_folded_fncall.yo` | 8/20 |
| current HEAD | same | 6/20 |

~30–40% per heavy fixture, and **independent of recent diffs** (the rate is the
same before/after the open-import-FuncVal change — so that change is not the
cause; this is pre-existing). `nullable_ptr_some.yo` and
`generic_impl_two_params.yo` also reproduce.

## Impact

Every corpus run is non-deterministically red, which destroys the validation
signal for ALL other codegen/evaluator work (a "did I regress?" check is 30–40%
noise). It would also make any self-host fixpoint unstable. This is why it is
P0 in `plans/BOOTSTRAPPING_CODEGEN.md`.

Interim mitigation: validate with `--parallel 1` and re-run any SELF-FAIL
standalone to confirm it is flaky (not a real diff). "Identical crash across
builds → suspect the compiler, not your diff."

## Suspect class

RC dup/drop placement in the emitted code or in the self-hosted compiler's own
RC layer — early-return over-release, consume-vs-transfer-site mismatch, or a
drop-on-scope-exit ordering bug. The corrupting write is a double-free / use of a
freed RC header that only trips the allocator's freelist invariants later.

## Method (proven workflow, from the fixed dossiers)

1. Pick the most reliable reproducer (highest crash rate); confirm flakiness with
   ~20 standalone runs.
2. Run under guard pages to turn the intermittent fault deterministic:
   `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib MallocStackLogging=full
   /tmp/yo-self-bin compile <fixture> -o /tmp/x` (use a small
   `YO_MAIN_STACK_MB=512` for a fast crash backtrace).
3. Post-crash lldb batch + `malloc_history <pid> <addr>` for the alloc / free /
   use-after-free stacks (template:
   `issues/fixed/yo-self-macro-dispatch-corruption.md`).
4. Map the offending alloc back to the emitter/RC site; fix; add a regression
   fixture; re-measure the crash rate to 0/20.

## ROOT CAUSE (found 2026-06-20)

It is a **deterministic double-free** of a borrowed clone-argument temporary on a
`return(f(x.clone()))` code path. Confirmed via an RC quarantine (see technique
below) — every reproducer fixture aborts `YO_RC_DOUBLE_FREE`, deterministically.

### Deterministic 14-line repro (compiled by the TS compiler)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
sink :: (fn(s : String) -> String)(String.from("r"));
f :: (fn(o : Option(String), indent : String) -> String)({
  local := String.from("L");
  match(o, .Some(mx) => return(sink(indent.clone())), .None => String.from("none"))
});
main :: (fn() -> unit)({ b := f(Option(String).Some(String.from("m")), String.from("  ")); () });
export(main);
```

The emitted C drops the `indent.clone()` temp (`_temp_NNN`) **twice** on the
non-escape early-return path:

```c
_tmp = indent.clone();
_ret = sink(_tmp);
if (__yo_effect_escaped) { ...drop(_tmp); drop(local); ...; return {0}; }
String___drop(_tmp);                 // DROP A  (return's deferredDropExpressions)
// Drop local variables before early return
String___drop(local);
String___drop(_tmp);                 // DROP B  <-- DOUBLE FREE
return _ret;
```

Key facts (verified by instrumenting the codegen):
- The plain tail form `match(o, .Some => sink(indent.clone()), ...)` (NO explicit
  `return`) drops the temp **once** — correct. The bug needs the explicit `return`.
- The return's own `deferredDropExpressions` = `[_tmp]` (DROP A — the correct,
  single post-call drop).
- `generatePendingDeferredDrops` for the return computes `dropsToEmit=[local]` —
  it CORRECTLY dedups `_tmp` (its `alreadyDroppedVars` contains `_tmp`). So DROP B
  is **not** emitted by that function.
- DROP B therefore comes from a *different* drop-emitter (begin-block scope-close
  in `exprs/begin.ts`, or a second generation pass). Instrumenting the four known
  emitters (`generateDeferredDropExpressions`, `generatePendingDeferredDrops`,
  `generateConsumedVarDropsForEscape`, the begin.ts loops) with C-comment markers
  showed **none** of them tag DROP B — and the `/*P2*/` drops that
  `generatePendingDeferredDrops` logged it emitting do NOT appear in the final
  `.c` at all. Strong evidence the function `f` is **generated twice** (one pass
  discarded), and the surviving pass uses a pending-drop flush whose
  `alreadyDroppedVars` dedup is not in effect. Pinpointing that second pass is the
  open work.

### Detection technique (REUSABLE — RC quarantine)

gmalloc does NOT reproduce this (it replaces the allocator; the corrupted
structure is the system freelist). Instead, instrument the emitted RC runtime in
`src/codegen/functions/generation.ts` (`__yo_decr_rc`, both the non-GC and GC
variants): on the last-ref branch, POISON the header instead of freeing
(`header->ref_count = 0xDEADBEEFDEADBEEFULL;` and drop the `__yo_free`), and at
the top assert `ref_count != sentinel` → `fprintf + abort()`. Rebuild yo-self-bin;
the next decrement of an already-freed header aborts deterministically with the
culprit backtrace. Map the abort PC to a C line by recompiling the emitted `.c`
with `clang -g -O0` and `atos -o <bin> <symbol+offset>` (nm the function symbol,
add the imageOffset from the crash `.ips`). This is how the
`generate_func_call` → `is_join_handle_await_call` clone chain and the
`return(_call_generate_expr(mx, indent.clone(), context))` site (the real yo-self
trigger, generation.yo's macro_expansion branch) were found.

### Already landed (faithful, corpus-safe)

`is_join_handle_await_call` (yo-self/evaluator/async/await_analysis.yo) was doing
`match(expr.clone(), ...)` — an unfaithful deep AST clone on every
`generate_func_call` (TS does a trivial 2-line check). Replaced with
`match(expr, ...)` (no clone). This removes a huge allocation source and lowered
the crash rate on `match_arm_folded_fncall` (33% → 0/30 standalone) but does NOT
fix the root double-free (other fixtures still trip it) — it is a correct
faithfulness+memory improvement kept on its own merits.

### Open: the fix

The double-free is a redundant scope-close/early-return drop of a temp that the
`return` expression's own deferred-drop already handles. The fix belongs in the
dup/drop optimizer (TS `src/evaluator/exprs/begin.ts` early-return drop
collection + `src/codegen/exprs/{return,begin}.ts` emission), and must be
verified with the RC-quarantine oracle (repro aborts → fixed = no abort) AND the
full corpus (this subsystem is regression-prone — see the two fixed dossiers).

## Exit criterion

The repro above does not double-free (quarantine clean); heavy fixtures compile
20/20 clean standalone; the corpus is deterministically green under `--parallel 1`.
