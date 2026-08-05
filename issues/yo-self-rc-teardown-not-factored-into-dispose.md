# yo-self emits 1.55x the C bytes of TS — RC teardown is inlined, never factored into `___dispose` functions (OPEN)

**Measured 2026-08-05** on the same input (`yo-self/main.yo`, `--release --emit-c`),
comparing the TS-emitted stage-1 C against the yo-self-emitted stage-2 C.

| artifact                       | bytes                 | lines     |
| ------------------------------ | --------------------- | --------- |
| stage-1 C (emitted by TS)      | 65,293,847 (62.3 MB)  | 839,492   |
| stage-2 C (emitted by yo-self) | 101,033,561 (96.4 MB) | 1,660,881 |
| ratio                          | **1.55x**             | **1.98x** |

Resulting binaries: **5.0 MB (TS-built) vs 5.6 MB (yo-self-built), +13%.**

## It is NOT extra specializations, and NOT extra temporaries

The obvious hypotheses are both wrong. Ruled out by counting:

| measure               | TS      | yo-self | ratio     |
| --------------------- | ------- | ------- | --------- |
| function definitions  | ~4,971  | 4,932   | **1.0x**  |
| `_temp_` occurrences  | 332,627 | 356,963 | **1.07x** |
| `__yo_malloc`         | 667     | 643     | 1.0x      |
| `memcpy`              | 41      | 41      | 1.0x      |
| `__yo_borrow`         | 410     | 397     | 1.0x      |
| blank + comment lines | 3.3%    | 1.3%    | —         |

Same functions, same temporaries, same allocation and borrow density. yo-self simply
spends **~332 code lines per function against TS's ~163**.

## The single cause

| measure        | TS        | yo-self     | ratio    |
| -------------- | --------- | ----------- | -------- |
| `__yo_decr_rc` | 1,540     | **273,648** | **178x** |
| `switch (`     | 10,270    | 167,208     | 16x      |
| `case __YO`    | 19,223    | 175,904     | 9x       |
| `___dispose`   | **2,281** | **9**       | 0.004x   |

TS FACTORS RC teardown into per-type dispose functions — **959 `___dispose` function
definitions, referenced 2,281 times** — and emits a call at each drop site.

yo-self emits **no dispose functions at all**. Its 9 `___dispose` matches are the
string literal `"___dispose"` in the compiler's own source (stage-2 C _is_ the
compiler), not emitted definitions. Instead it INLINES the whole teardown at every
drop site as a tag switch with a `__yo_decr_rc` per variant:

```c
switch ((_file____tmp__temp_5172).tag) {
  case __YO_T5_SOME: {
    __yo_decr_rc((void*)((_file____tmp__temp_5172).data.Some.value));
```

One inlined switch per drop site, per variant, explains all four rows at once — and
explains why function count and temp count are unchanged.

Note yo-self is not missing dispose synthesis entirely: it has a recursive
`___dispose` path used for narrow cases (see
`issues/fixed/yo-self-ref-enum-dispose-leak-fixed.md`, where a missing `ref(enum)`
`___dispose` caused a leak). What is missing is TS's use of dispose functions as the
GENERAL factoring for RC teardown.

## Why no gate caught it

By design, nothing compares emitted C between the two compilers:

- `scripts/diff-test.sh` states it outright — "Equivalence is judged by RUN BEHAVIOUR,
  never C-text equality". The 155-file corpus compares stdout + exit code.
- The **fixpoint** proves stage-2 C ≡ stage-3 C byte-identical. That is yo-self against
  ITSELF, and is completely insensitive to how far either differs from TS.
- The hollow gate only looks for `Failed to transpile` markers.
- `check ./std` never reaches codegen.

So this is invisible to every gate, and correctly so — C-text parity with TS was never
a goal. But it means emission SIZE has never been measured, and a 1.55x gap can persist
indefinitely without any gate noticing.

## Is it expected?

**Semantically, yes — this is not a correctness bug.** All gates are green with it:
battery 20/20 non-hollow, corpus PASS 155 DIFF 0, `check ./std` 153/153, stage-2 clang
clean, FIXPOINT_HOLDS. Inlined teardown and a called dispose function do the same work.

**As a port outcome, no.** TS's dispose factoring is a deliberate codegen strategy that
yo-self does not implement, so this reads as an unfinished part of the RC-emission port
rather than a chosen divergence. Consequences worth caring about:

- **clang time on every self-emit** — 1.66 M lines instead of 839 K to parse and
  optimise. This is a plausible and unmeasured contributor to the stage-2 emit + clang
  cost that the memory/perf campaign has been fighting
  (`plans/YO_SELF_ENV_SHARING.md`).
- **+13% binary** (5.6 vs 5.0 MB), and worse I-cache behaviour from teardown code
  duplicated at hundreds of thousands of sites.
- Any future "why is stage-2 slow to compile" investigation should start here.

## Next steps

1. Confirm the mechanism from the TS side: read `src/codegen/` for where the
   `___dispose` functions are synthesised and called, and find the corresponding
   yo-self emitter that inlines instead.
2. Quantify the prize before building anything: measure clang wall-time on stage-2 C as
   it is, since that is the payoff for factoring.
3. Only then port the factoring. It touches RC emission — the most regression-prone area
   in this compiler (see the drop-emission-order and double-free entries in
   `issues/fixed/`) — so it needs the full gate chain plus the `tests/internal`
   differential, not just a repro.

Do NOT treat this as a quick win: RC teardown correctness is load-bearing, and the
current inlined form is verified working.
