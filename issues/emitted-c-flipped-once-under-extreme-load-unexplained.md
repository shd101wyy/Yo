# Emitted C flipped between modes ONCE under extreme load — unexplained (Z3 ruled out)

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
