# yo-self codegen: intermittent SIGTRAP-in-malloc (live heap corruption)

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

## Exit criterion

Heavy fixtures compile 20/20 clean standalone; the corpus is deterministically
green under `--parallel 1` (and ideally `--parallel 3`).
