# A SELF-BUILT compiler has a use-after-free in the report and build paths — 8 cli-cases abort

**Status: OPEN, and it BLOCKS P2.3** (found 2026-08-11 by the first CI run in
which stage-1 is built by the previous release instead of by TypeScript). This is
the bug class the 2.3 migration exists to expose: every CI arm until now tested a
**TS-built** stage-1, so a defect in what the SELF-HOSTED codegen emits for the
compiler's own sources was invisible.

## Symptom

`YO_SELF_BIN=<seed-built stage-1> scripts/cli-diff-test.sh` scores
**PASS 15/16, DIFF 3, SELF-FAIL 5, BOTH-FAIL 3-4** where a TS-built stage-1 from
the same sources scores **27/27**. Eight cases abort with rc=134; three doc cases
differ in stdout.

Two distinct manifestations, both memory corruption:

```
$ cd <unsafe-pragma-ok fixture> && <seed-built stage-1> build run
yo-self: error: Error: Build DAG stalled — possible undetected cycle.
mimalloc: error: corrupted free list entry of size 96b at 0x020004935280: value 0x2014493A680
```

```
$ cd <public-safe-report fixture> && <seed-built stage-1> public-safe-report . --json
  "totals": { "filesScanned": 16131858542891098079,
              "publicDeclsScanned": 16131858542891098079,
              "findings": 16131858542891098079 }
```

`16131858542891098079` is `0xDFDFDFDFDFDFDFDF` — **mimalloc's freed-block fill
pattern.** The totals are read out of memory that has already been freed. The
"Build DAG stalled" error is a downstream symptom: the DAG's own state is
clobbered, so the scheduler finds no runnable step.

## What is and is not affected — measured

Same fixture, same `YO_STD`, four binaries:

| binary                                | built by        | rc  | filesScanned | findings |
| ------------------------------------- | --------------- | --- | ------------ | -------- |
| stage-1 built by the v0.2.2 seed      | **self-hosted** | 134 | —            | —        |
| `local_s2` (a stage-2 from 2026-08-11)| **self-hosted** | 0   | **0** ✗      | **16** ✗ |
| stage-1 built by the TS compiler      | TypeScript      | 0   | 1 ✓          | 2 ✓      |
| the shipped v0.2.2 release binary     | TypeScript      | 0   | 1 ✓          | 2 ✓      |

**Every self-built compiler is wrong; every TS-built compiler is right.** So this
is NOT a v0.2.2-specific miscompile (the released binary behaves correctly — it
was TS-built) and NOT a regression from today's work: `local_s2` predates it and
is already wrong, silently reporting 0 files / 16 findings instead of 1 / 2.

It is a **`yo-self` codegen defect**: when the self-hosted compiler compiles the
compiler's own sources, it emits a premature drop (or a missing dup) in these
paths. Whoever built the compiler determines whether the resulting binary is
correct.

Reproduces identically on macOS-arm64 (locally) and linux-x64 (CI), so it is not
platform-specific.

## Why nothing caught it

- **Every CI arm builds stage-1 with TypeScript** (until PR #98). GATE 7 therefore
  compared TS against a TS-BUILT self-hosted binary — a binary compiled by the
  correct codegen.
- **The fixpoint cannot see it.** stage-2 ≡ stage-3 compares emitted C *text* for
  stability, not behavior; both stages are equally affected, so the byte-diff is
  clean. This is the "a stage-2-only bug is invisible to every stage-1 arm" note
  in AGENTS.md, now with a concrete instance in the OTHER direction: a
  self-BUILT-only bug is invisible to every TS-built arm.
- **`local_s2`'s wrong numbers do not crash.** With counters read from freed
  memory, `public-safe-report` exits 0 and prints plausible-looking JSON. Only
  the mimalloc build turns it into an abort. A silent wrong answer is the
  dangerous half.

## Family

Same class as `issues/fixed/seed-built-stage1-miscompiles-current-source.md`
(the escape-path pending-drop filter freeing a borrowed match binding, fixed in
#100) — a drop emitted for something still live. #100's fix was verified against
the RED set it was found from; this is a sibling site it did not cover.

## Next step (the technique that solved #100)

No new builds are needed to see the defect: a TS-built stage-1 IS yo-self's
codegen, so

1. emit C for `yo-self/public_safe_report.yo`'s totals path with the TS compiler
   (`node out/cjs/yo-cli.cjs … --emit-c`) and with a self-hosted binary,
2. diff the two emissions of the same function, and look for a `___drop`/
   `__yo_decr_rc` that the self emission places before the last use.

The `public-safe-report` path is the better reproducer of the two: it is a
self-contained text scanner (no build system, no child processes), its wrong
output is deterministic, and the corrupted value is self-identifying (`0xDF`
fill).

## Consequence for P2

**2.3 cannot go green until this is fixed** — the whole point of the item is that
the seed builds stage-1, and a seed-built stage-1 fails 8 of 27 cli-cases. Do not
allowlist GATE 7: a permanently-red gate is the failure mode this repo has
repeatedly paid for. The rest of the migration is proven — 15 of 16 jobs green,
including seed → stage-1 → stage-2 ≡ stage-3 byte-identical, the internal-tests
differential, and the 188-file hollow sweep.

## Minimal-reproducer attempts — what does NOT trigger it (2026-08-11)

Three shapes were tried against both codegens (TS-compiled vs compiled by a
self-hosted binary, the latter with `--allocator mimalloc` so a UAF is reported).
**All three produced identical, correct output under both compilers**, so none of
them is the trigger:

1. **Sync** `ref(struct)` built from locals mutated in a `while`, stored into a
   second `ref(struct)`'s field, read after the builder returns.
2. The same, but the builder is an **async closure** (`io.async((e : IoExn) => …)`
   returning `Impl(Future(Report, IoExn))`) with one `await` **before** the loop.
3. The same with an additional `await` **inside** the loop body (so the
   accumulating locals round-trip through state-machine slots every iteration).
4. The same with the counter mutations AND the `await` moved **inside an `if`
   body** within the loop — the shape the real site has, and the family of
   `issues/fixed/ts-bare-if-await-early-return-silently-skipped.md`.
5. The same as (4) but awaiting **real** `fs_file.read_string` on real files, so
   the state machine genuinely SUSPENDS and resumes (shapes 2-4 awaited an
   `io.async` closure that returns without suspending, which may never exercise
   slot round-tripping at all).

So "ref-struct built from slot-resident locals in an async tail expression" is
NOT sufficient. What the real site has that these lack: real filesystem awaits
(`fs_file.read_string`) nested two async frames deep, an `ArrayList` of
`ref(struct)` findings passed BY REFERENCE into a helper that appends to it
(`_scan_file(file, src, findings)`), a `collected.sort()`, and `String` clones
across the awaits.

Next probe, in order of expected yield:

1. **Function-body C diff on the real site** (the technique that solved #100):
   emit `yo-self` C with `node out/cjs/yo-cli.cjs … --emit-c --skip-c-compiler`
   and with a self-hosted binary, then compare the two emissions of
   `generate_public_safe_report` — mind that mangled names and emission order
   differ between the compilers, so map the function first rather than diffing
   whole files.
2. **Source-level bisection by neutralization** on the real function (drop the
   `_scan_file` call, then the inner awaits, then the sort) until the wrong
   counters turn correct; python delta-debugging over arm bodies worked for the
   batch bisection before.
3. Check the sibling: `unsafe_report.yo` has the same shape and its cli-case
   PASSES, so diffing the two files' totals paths may isolate the difference
   directly. Measured difference so far: `unsafe_report`'s counter-mutating loops
   contain NO awaits and its totals fields are mostly `.len()` calls, whereas
   `public_safe_report` mutates `(files_scanned : usize) = …` locals inside an
   `if` body that also holds the `await`. Shape (4) above tried exactly that and
   came out clean, so the differentiator is something narrower still.
4. **Look at the CALL SITE, not only the callee.** `main.yo:1892` does
   `report := io.await(generate_public_safe_report(…), IoExn(…))` and then passes
   `report` to a formatter. `issues/async-abort-dispose-double-drops-moved-enum-payload.md`
   is an OPEN bug of exactly this family — an async result dropped prematurely at
   the call site, worked around there with a `.clone()` band-aid in `version.yo`.
   The cheapest decisive test is to add that band-aid at main.yo:1892 and see
   whether a self-built compiler then reports the right totals; if it does, the
   root is the async-result drop, not anything in `public_safe_report.yo`.
