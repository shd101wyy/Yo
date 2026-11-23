# Test 7 (d): the second adversarial pass, a brief for ten probing agents

**Status: READY TO LAUNCH on the v0.2.80 release candidate (written 2026-11-19 by the test 7 lane).** This is leg
(d) of test 7, the test that asserts the soundness claim (S) (VERDICTS-58 decision 7(d); the procedure and pass
criteria are `VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Legs (a)–(c) are `scripts/test7.sh`. This leg is agents:
ten probing agents, one area each, one working day, on the candidate binary, after the parser drop (R7). It passes
when it finds **zero new S1 in clusters 1–8, or each one walled**.

The coordinator fills the four `<…>` values in §1, then gives each agent §§1–7 plus its area section of §8. The
first audit's brief (`~/Workspace/Yo-wt/audit-boo/tmp/probes/BRIEF.md`, 2026-11-11) is the model; this pass must be
**independent** of it, so agents are not shown the first pass's probes or ledger. They may read the audit document,
since it is what they must not re-report.

## 1. Setup (the coordinator fills this in)

- Candidate SHA: `<sha>`; candidate binary (a stage 1 built from it with `--std-path ./std`): `<path>/yo`.
- Read-only candidate worktree: `<~/Workspace/Yo-wt/v0280-t7d>`, a detached checkout of the candidate. Agents read
  it and never write it.
- Each agent's probe directory, the only place it writes: `<worktree>/tmp/t7d/<area>/`.
- Collection: each agent's `FINDINGS.md` in its directory, and the same text as its final message.

```bash
Y=<path>/yo; S=<worktree>/std
$Y check p.yo --std-path $S > p.check.log 2>&1; echo rc=$?    # rc 0 = accepted
# accepted => compile under ASan and run (clang on PATH; on the shared Linux box, inside `nix develop <worktree>`):
$Y compile p.yo --std-path $S --optimize 1 --sanitize address --allocator system --cc clang -o ./p.bin > p.compile.log 2>&1
ASAN_OPTIONS=detect_stack_use_after_return=1:detect_leaks=1 ./p.bin > p.run.log 2>&1; echo rc=$?
grep -E 'ERROR: AddressSanitizer|ERROR: LeakSanitizer|SUMMARY|OUT' p.run.log
$Y explain E0911
```

A `yo check` of a small file takes 5–15 s on the loaded box; the ASan compile about as long. Both are light steps.

## 2. Hard rules

- Never run `yo build`, `yo check ./src`, `yo check ./std`, `yo compile src/main.yo`, `yo test` on a directory, or
  any `tests/internal` file. Single small files only; at most three compiler processes per agent at a time.
- Write only inside your probe directory. No git command that changes anything; no other worktree; no messages to
  other sessions; no sub-agents.
- Every program has `main` and `export(main);`, so it can be compiled and run.
- Keep the scope: clusters 1–8 of the audit (§3 below). A thread race (A41/A42's D1 reach walk), a crash of the
  compiler, invalid C and a wrong rejection are recorded, but they are not this pass's verdict (§5).

## 3. What you are attacking

Yo's checker for ownership, moves, drops, references, origins and captures: decisions 18–50 of
`plans/VALUES_BY_DEFAULT.md`, O1–O10 of `plans/backlog/REFERENCES_AND_ORIGINS.md`, and the per-node rules and
lowerings of `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§2 invariants, §3 rules, §5 lowerings, §7 the parity
table: what is designed to be accepted, and what is a scheduled wall). The 2026-11-11 audit,
`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md`, found 52 S1 holes with three gates green; its §9 groups them
into nine root-cause clusters. Clusters 1–8 are this pass's scope:

1. an argument's value is not a loan (two-phase activation against other arguments' values);
2. an access reaches the loan table weaker than its mode (a `&mut` lend judged a read, a capture, `consume`);
3. a value position computes no origin (block and arm values, composite call results, sub-patterns, scrutinees);
4. a flow join keeps one branch (every-arm assignment, the loop back edge, a store through a `&mut`);
5. a signature is trusted without its check (`static`, an impl against its trait, a function value at a slot, a
   holder's elided origin, invariance under a by-value wrapper, a method's `lend_through`);
6. rooting through an owning handle (`Box`/`Rc`/`Arc` `.*`), and the reborrow union;
7. captures (a captured reference parameter, a by-value entry holding a reference, a future's maker);
8. ownership in control positions and in codegen (moves in a guard or loop condition, `x = x`, tuple targets, a
   copied `&mut` field, shadowed C names, temporaries across an early exit or an `await`).

Most of those rows are fixed or walled now. Every fix closed the shape someone wrote down. **Your job is the
neighbour nobody wrote down**: the same root cause through another wrapper, position, callee form or join.
Vary systematically:

- **wrapper**: a bare `&T`, `Option(&T)`, a struct holder `H(p)`, a tuple, an enum payload, `Box`, a closure
  capture, a future;
- **creation site**: a lend, a constructor field, an arm or block tail, a call or method result, a projection, a
  `for` element, a match binding, a closure call result;
- **argument position** beside a `&mut` or moved argument: a by-name lend, a bare named reference, a holder, a
  nested call result, an inline constructor;
- **callee form**: direct, method, UFCS, a function value, a function-pointer parameter, `Impl(Fn)`, `Dyn(Fn)`,
  `Dyn(Trait)`, a generic bound, an effect operation;
- **sink**: `:=`, a typed declaration, `=`, a field write, a `&mut` slot a callee writes, a capture, `return`, a
  push into a container;
- **invalidating event**: a write, a reassignment, a move, a drop, scope end, growth, `clear`, a handle
  reassignment;
- **path between**: a generic function, a trait method, `Dyn` dispatch, a closure, an async body, a loop back
  edge, an early return or `unwind`.

The heap payload makes ASan the judge: a `String` longer than the small-string buffer, an `Rc(X)`, an `ArrayList`
grown a thousand times, so that a dangling read is a `heap-use-after-free`, and an `OUT:` print of the value read.

## 4. Learn the surface language first (fifteen minutes, then probe)

The syntax is unusual: no operator precedence, `name :: (fn(params) -> T)(body)`, `x := v`, `mut(x) := v`,
`cond(...)`, `match(...)`, `while(c, { … })`, `.{ … }` for a record, calls for everything. The release removed
`ref(...)`/`atomic(...)` (E0009) and made `str` unsized (`&str` is the fat reference). Read, in this order:

1. `pack/context.md` (the language pack; `yo context --list` and `yo context <module>` index the API);
2. `tests/origins/unsound/*.yo`: about 390 small complete programs, each a known hole's shape (now rejected) or
   its positive control, with a `// expect:` header. **They are your template style**, not your targets;
3. `tests/origins/corpus/*.yo` with `tests/origins/corpus.tsv`, the design's corpus with expected verdicts;
4. `docs/en-US/MEMORY_SAFETY.md`, then the design documents of §3 for the rules you attack, and `yo explain E09xx`
   for each code you meet.

When a spelling does not parse or type-check, find a working one in `tests/` or `std/` (`grep -rn`) and move on.

## 5. What counts

- **A new S1 in scope (the verdict of this pass).** `yo check` accepts a program in safe Yo (no
  `Pragma.AllowUnsafe`, no raw pointer, no `extern`, nothing spelled `__yo_*`), its root cause is in clusters 1–8
  (or is A40's or A43's kind), and the program, compiled as in §1, is a use-after-free, double free, out-of-bounds
  access, read of a moved or dropped value, or a miscompile that changes what the program prints. It is **new**
  unless an issue under `issues/` (open, not `fixed/`) already describes that exact root cause, or it is the
  reproducer of a row of the audit's §3 that is still open. A shape whose issue is in `issues/fixed/` and that
  reproduces is a **regression**, and counts as new.
- **Not this pass's verdict, recorded anyway** (one line each in FINDINGS.md): a thread race (A41/A42, needs
  TSan); a leak with no unsafety; a compiler crash or invalid C (B class, loud); a wrong rejection or a wrong
  diagnostic (C class); a rejection by a documented wall (`Cannot re-point`, "carries an origin inside a container
  or a cell", E0922's `static` wall, P4–P7, P10, P11, P15, N2c–N2f) — "wall confirmed".
- **Ambiguous cluster.** If you cannot say which cluster a hole belongs to, report it as in scope. The coordinator
  decides; an S1 that might be in scope is never dropped by an agent.

## 6. Dedupe before writing a finding up

- `grep -rln "<keyword>" issues/*.md issues/fixed/` and `tests/origins/unsound/` (a must-reject program of your
  shape that is rejected means the shape is pinned).
- The audit's §3 table (`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md`): an OPEN row's shape is known.
- `tests/origins/gen-known.tsv`: patterns G-D already knows.
- Cite the document instead of re-reporting; a FIXED document whose shape reproduces is a regression.

## 7. Deliverable

`<worktree>/tmp/t7d/<area>/FINDINGS.md`, returned as your final message:

```text
# Findings: <area>
## Summary
N probes; in-scope new S1: n; regressions: n; other: A-out-of-scope n, B n, C n, walls confirmed n.

## F1 — <one sentence stating the defect, issue-title style>
- Class: in-scope S1 | regression | out-of-scope A | B | C      Cluster (1-8, or "unsure"):
- Repro: tmp/t7d/<area>/<file>.yo  (minimal, complete; first line `// expect: E09xx` naming the code that SHOULD
  reject it), and its positive twin `<file>-pos.yo` (`// expect: accept`, the same shape with the invalidating
  event after the last use), which must run clean
- Observed: check verdict; the ASan ERROR/SUMMARY line or the wrong OUT line
- Rule: the design rule it violates (O3 step 2, decision 28, BCC R-CALL, …) and the correct verdict
- Why: one or two sentences; name the src/evaluator function if you read it
- Neighbours tried: variants that also reproduce, and the ones rejected (with codes)
- Dedupe: the grep terms you used and what you found

## Coverage map
| shape | verdict (code) | file |   (every shape handled correctly; terse)

## Walls confirmed / known issues hit
One line each.
```

Quality bar: every S1 has a program a maintainer runs in one command and sees the ASan report. A dozen distinct
real findings beat fifty near-duplicates. Probe broadly across the area before going deep. Budget: 80–150 probes.

## 8. The ten areas

One agent each, the same ten areas as the first audit, so coverage is comparable:

| # | Area | Probe hardest at (clusters) | Tests to read for spellings |
| --- | --- | --- | --- |
| 1 | calls: arguments, two-phase, receivers, callee forms | 1, 2, 5 | `tests/local_borrows*.test.yo`, `tests/origins/corpus/call-*` |
| 2 | patterns and control flow: `match`, `cond`, loops, joins, early exit | 3, 4, 8 | `tests/match*.test.yo`, `tests/origins/unsound/a1[12589]*` |
| 3 | generics and traits: origin parameters, impls against traits, `Dyn(Trait)`, `static` | 5 | `tests/origins/impl_origin_result.test.yo`, `tests/generic*.test.yo` |
| 4 | ownership and moves: partial moves, guards, loop conditions, `x = x`, drops, codegen names | 8 | `tests/move_only*.test.yo`, `tests/*drop*.test.yo`, `tests/origins/unsound/c8*` |
| 5 | iteration and collections: borrowed cursors, adapters, `for`, element lends, growth | 3, 4 | `tests/iter*.test.yo`, `std/collections/*.test.yo` |
| 6 | holders: structs and enums over references, elided origins, `&mut` fields, re-pointing | 3, 4, 5, 6 | `tests/origins/corpus/holder-*`, `tests/origins/unsound/a2[5-9]*` |
| 7 | cells and handles: `Box`, `Rc`, `Arc`, `Weak`, `RefCell`, `Dyn`, `.*` rooting, `Deref` | 6 | `tests/rc*.test.yo`, `tests/box*.test.yo`, `tests/fixtures/cell_handles.yo` |
| 8 | closures: capture lists, implicit captures, `Fn`/`FnMut`/`FnOnce`, closures returning references | 2, 7 | `tests/closure*.test.yo`, `tests/origins/unsound/c2-*capture*`, `tests/origins/unsound/c7*` |
| 9 | async and effects: futures over borrows, `io.async` captures, `await` across temporaries, handlers, `unwind` | 7, 8 | `tests/async*.test.yo`, `tests/algebraic_effects.test.yo`, `tests/origins/unsound/async-*` |
| 10 | the boundary: module-level bindings, globals, `MaybeUninit`, the unsafe gate, threads (A40/A43 kinds in scope; races out) | 9's A40, A43 | `tests/thread*.test.yo`, `tests/origins/unsound/global*`, `tests/origins/unsound/maybe*` |

The file globs are starting points; the agent finds the rest.

## 9. After the pass (the coordinator)

1. Collect the ten FINDINGS.md files; re-run every in-scope S1 and regression on the candidate binary yourself
   (one command each), and dedupe across areas by root cause.
2. Each new in-scope S1 gets an `issues/YYYY-MM-DD-<name>.md` (severity S1, the cluster named) with its
   reproducer pair under `issues/repros/`, and is either fixed, or **walled**: a rejection with an error code at
   exactly the positions the rule does not yet cover, its negative program moved into `tests/origins/unsound/`
   (G-B pins the wall), and the positive twin recorded as a limitation in the issue (status line "WALLED in
   v0.2.80"). An S1 that is neither fixed nor walled at the cut fails leg (d), and the notes say "(S) pending".
3. Out-of-scope findings are filed as ordinary issues with their class (B, C, A41/A42 family); they join §3.5's
   known-issue list, they do not fail the leg.
4. The release notes' slot: "a second adversarial pass of ten agents after the parser drop found [new in-scope
   S1] new S1 in clusters 1–8 ([walled] walled, each listed below)". The issue documents are the record; the
   notes also give the total probe count, summed from the ten summary lines.
5. The probes are the next pass's seed: add them to the frozen corpus (`scripts/test7/audit-corpus.tar.gz`) in a
   follow-up PR, so leg (b) of the next run replays them.
