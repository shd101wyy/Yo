# Emitted C flipped between modes ONCE under extreme load — unexplained (Z3 ruled out)

**Severity:** S3 — emitted C differed byte-wise once in ~8 runs under extreme load — reproducibility unproven, mechanism unexplained

> Found 2026-09-10 while gating the fixed-region allocator PR locally on
> Windows. **OPEN — the mechanism is not identified.** The original Z3 theory
> was DISPROVEN while investigating; the corrected evidence is below so the
> next person does not chase it again.

## Observed

`yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler` (no
`--no-verify`), SAME binary and source, produced THREE distinct outputs
across sessions:

| mode | observed | when |
| --- | --- | --- |
| A (`3a26a39…`) | 7+ runs | idle machine, and most loaded runs |
| B (`772397b…`) | 1 run | while a concurrent `clang -O2` of a 163 MB C file (an ASan compiler build) hammered the same 16 GB box |
| C (`ec067cb9…`) | deterministic | any run given an ABSOLUTE input path instead of the relative `src/main.yo` |

Mode C is NOT a bug of this class: the input file's path spelling feeds
eval-minted temp-variable prefixes and module ids, so relative-vs-absolute
input changes emitted C deterministically. Every gate and golden uses one
spelling consistently by construction. Mode B is the open question: a single
1-of-~8 deviation, byte-different from both A and C, correlated with extreme
memory/CPU pressure, never reproduced on an idle machine (7 consecutive
identical runs), and the churn shape is the same `__yo_tN` renumbering as
the std-path spelling issue (one type-id registration shifts, everything
downstream renumbers).

## What was ruled out

- **Z3 / the verify pass.** The box has NO Z3 installed (`discover_z3()`
  finds nothing), and `src/main.yo` registers zero verify tasks, so
  `_run_contract_verification` returns before touching anything. The
  `--no-verify` runs being stable was coincidence, not evidence.
- **Std-path spelling** — that is real but a different, deterministic issue
  (`issues/fixed/fixpoint-gate-std-path-spelling-changes-type-keys.md`).
- **Output-path length** (`-o` name) — tested, no effect.
- **Run-to-run cache coupling** — outputs alternate, they are not sticky.
- **Module-load async ordering** — the loader reads files synchronously
  (`_read_file_sync`, "synchronous on purpose").

## A candidate carried over from a retired doc (2026-09-14)

`issues/retired/emitted-c-include-order-differs-ts-vs-self.md` was retired
because its TS-vs-self framing died with the TypeScript compiler, but it
observed something still true: `c_includes` is a `HashSet(String)` and
`emit_c_includes` emits by iterating it, so the `#include` block's order comes
from hash iteration rather than insertion.

That is NOT this bug — the churn observed here is `__yo_tN` renumbering, not
include order — but it is the right SHAPE of suspect, and it establishes that
at least one emitted artefact's order is decided by a hash container. Any other
such container in the emission path is worth auditing for the same reason.
Determinism currently rests on the hashing being fixed-key rather than on an
ordering guarantee.

## Leading suspicion

A resource-pressure-sensitive branch somewhere in evaluation/collection that
changes ONE type registration's timing — e.g. a silently swallowed
allocation failure (`match(.None => ())`) that skips an interning step, or an
address-dependent comparison. The compile peaks at ~14 GB; the concurrent
clang build pushes the box into swap.

## Reproduction sketch (Windows, 16 GB box)

Start a `clang -std=c11 -O2` of a ~163 MB generated C file, then in parallel:

```bash
for i in 1 2 3 4; do
  yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/f$i
done
md5sum /tmp/f*.c   # occasionally one file differs (1-in-~8)
```

## Fix direction

Instrument or bisect under memory pressure: run the loaded experiment against
compiler builds with subsets of a `match(.None => ())`-guarded allocation
converted to panics, or add a debug counter of interned types printed at
exit and diff the counter across modes to find WHICH registration moves. CI
is unaffected today (the fixpoint legs run on idle, isolated runners).

## 2026-11-19 — reproduced repeatedly under load (derive-fix lane)

Two `--emit-c --optimize 2 --skip-c-compiler` runs of `src/main.yo` with the SAME develop stage-1 (`d8f0d89fa`), on the
same tree and std, differed from a third binary's output by 281,506 and 155,324 diff lines respectively. The byte sizes
were identical, and the differences are numeric id suffixes only (0 diff lines once digits are normalized). So run to
run, the develop binary's id allocation order was not stable. The box was at load average ~80 (a dozen concurrent
compiles; WSL2, 32 threads). In the same window the fixpoint's stage-2 vs stage-3 comparison stayed byte-identical
(`FIXPOINT_HOLDS` on four rider branches), so the instability shows only across separate processes under load. That
fits a timing-dependent ordering source (a deadline/timeout path, or anything keyed on wall clock or scheduling) more
than a hash-seed one. Logs: the derive-fix lane's `~/Workspace/Yo-wt/v0279-derivefix/tmp/log/emit_diff.txt` (raw diff
head) and the PR body of `v0279/derive-later-clone`. Still S3: no behavioral difference was observed, but it makes
"zero emit-diff" gates unusable as stated under load. Normalize digits before comparing until the source is found.
