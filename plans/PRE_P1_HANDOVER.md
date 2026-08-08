# Pre-P1 handover — what to fix and do before implementing P1

**Written 2026-08-08.** Companion to
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md), which defines P1–P4.
This document covers only the question _"what should be true before we start
writing P1 code?"_ — plus the corrections P1's own plan needs, because three of
its stated premises are false.

Everything below is verified unless marked as a hypothesis.

---

## 0. TL;DR

**One hard blocker** remaining:

1. The **3 HOLLOW test files** — 60 tests reporting success while running nothing.
   Handed off; see [`issues/handover-yo-self-hollow-files.md`](../issues/handover-yo-self-hollow-files.md).

~~2. Branch protection is off~~ — **DONE 2026-08-08.** The `develop` ruleset is
`enforcement: active` with **15** required status checks, up from a disabled
ruleset naming 4 (one of them a `test` context that no longer existed). Every gate
below is now binding rather than advisory.

**One thing to decide consciously, not by default**: the `ctl` ABI issue. It is
no longer latent, and adjudicating it gets permanently harder once P2 retires the
TypeScript reference compiler.

**Three corrections to P1's plan** — `build` is hollow rather than unwired, `doc`
is ~3,800 lines short, and `module-manager.ts` has no counterpart at all.

---

## 1. Already done (2026-08-08) — do not redo

| PR  | What                                                                          |
| --- | ----------------------------------------------------------------------------- |
| #80 | Arrays of RC elements: constructor form, codegen dispatch, field tracer       |
| #81 | Made the CI gates binding; banked the differentials that expire with `src/`   |
| #82 | Both Linux-only RED files: test batching, and a dup/drop double free          |
| #83 | Comptime markers checked before the ExprInfo lookup; HOLLOW root cause traced |
| #84 | Handover brief for the HOLLOW files (docs)                                    |

Gates that now exist and pass:

- `gates_fast.sh` **GATE 4 — `check ./yo-self`** (~137 s). The only thing that
  type-checks `build_runner.yo` (952 lines) and `version_cache.yo` (640), which sit
  outside `main.yo`'s import closure and were checked by _nothing_.
- **`hollow-sweep` CI job** — all 188 language files through the self-hosted binary,
  scored honestly, gated as a **ratchet** against
  `scripts/bootstrap/known-failing.tsv`. Previously only 23 of 188 ran under
  yo-self; the other 165 were validated solely by the compiler P2 deletes.
- `scripts/diff-test.sh` now **fails** on SELF-FAIL/BOTH-FAIL. It used to exit 0
  when the self-hosted compiler could not compile the corpus at all.
- `release.yml` requires a green Test run for the released SHA. It previously
  published to npm and the Marketplace with **no test dependency whatsoever**.
- emsdk pinned to `6.0.6` (it was `latest`, which caused a real 403 outage).

---

## 2. Hard blockers

### 2.1 The 3 HOLLOW test files

`tests/index.test.yo` (49), `tests/safe_code_structural_gates.test.yo` (1),
`tests/variadic_comptime.test.yo` (10) exit 0 and report passing while executing
**no assertions**. `index.test.yo` matters most: **31 of its 49 arms are ordinary
runtime tests** lost as collateral.

Why this blocks P1 rather than riding along: after P2 the self-hosted binary's
"N passed" is the _only_ signal there is. A silent-success failure mode is the
worst thing to carry across that boundary, and P1 is the last phase where the TS
compiler can adjudicate it.

Root-caused to the evaluator (not codegen), with a 5-line reproducer and **four
ruled-out fix attempts**. Full brief:
[`issues/handover-yo-self-hollow-files.md`](../issues/handover-yo-self-hollow-files.md).

> **Two warnings, both learned the expensive way.** `hollow=0` is **not** proof of
> a fix — one attempt achieved it while the bodies still ran nothing, by moving the
> failure into a comment the detector does not grep for. And `check` passes on all
> of this, because it never forces the comptime evaluation a real compile does.
> Validate with an injected `assert(i32(1) == i32(2))`, nothing less.

**Done means** `scripts/bootstrap/known-failing.tsv` is empty, at which point the
gate demands a fully clean sweep on its own.

### 2.2 ~~Branch protection is disabled~~ — RESOLVED 2026-08-08

Previously `gh api repos/shd101wyy/Yo/rules/branches/develop` returned `[]`: the
ruleset existed but was `enforcement: "disabled"`, and its required-checks list
named only 4 of the jobs — one of them a `test` context that no longer exists. So
~55 minutes of green CI blocked nothing and a red PR could be merged by hand.

Now `enforcement: "active"` with **15** required status checks, and the branch
returns `["deletion","non_fast_forward","required_status_checks"]`.

Two notes for whoever maintains it:

- **The required list is not self-updating.** It is a literal list of job names.
  The first pass built it from a CI run that predated the `hollow-sweep` job, so
  the newest gate — the one that found both RED files — was running but not
  blocking until it was added explicitly. **Any new CI job must be added by hand**,
  or it silently does not gate. Check with:

  ```bash
  gh api repos/shd101wyy/Yo/rulesets/13548862 \
    --jq '[.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]' \
    | diff - <(gh api repos/shd101wyy/Yo/actions/runs/<recent-run-id>/jobs --paginate --jq '[.jobs[].name]|sort')
  ```

- `strict_required_status_checks_policy` is `true`, so a PR must be up to date
  with `develop` to merge. With ~55 min CI that means re-running when someone
  lands ahead of you; flip it to `false` if that becomes a tax.

Revert, if ever needed: `gh api -X PUT repos/shd101wyy/Yo/rulesets/13548862 --input /tmp/rs_before.json`
(or rebuild the payload with `enforcement: "disabled"`).

---

## 3. Decide consciously — the `ctl` ABI issue

[`issues/ctl-handler-void-signature-vs-sret-cast.md`](../issues/ctl-handler-void-signature-vs-sret-cast.md)

Filed as _latent_ on the premise that no reachable `ctl` has a `ResumeType` over
16 bytes. **Measurement refuted that premise**, in yo-self's own emitted C:

- Of 1064 `exn.throw` call sites, **95 cast to one of 7 distinct >16-byte structs**
  (widest: `FuncParamsResult`, 8 fields).
- All **29** handlers bound to `.throw` are emitted `void*` — register class.

So the caller builds a MEMORY-class call (hidden sret pointer in RDI, `err`
displaced to RSI) into a callee that reads `err` from RDI. On x86_64 — which is
what CI runs.

**Why nothing fails today is not what the doc said.** It is that most handlers
_discard_ `err` (their body opens with a bare `err;` no-op), so a garbage value is
harmless. But not all do — one dereferences `err.vtable->to_string(...)`, and that
handler is bound in `__yo_user_main`: the compiler's top-level "yo-self: error: …"
printer, which a throw reaches whenever no nearer handler catches it.

Today's green suite therefore rests on an **accidental pairing**, not on anything
the compiler enforces.

**Not a P1 blocker** — P1 is CLI parity. But it needs the TS referee, and P2
retires that. One cheap check remains: build x86_64 with `-fsanitize=function` and
run `check` over a deliberately broken file; that flags the mismatched call
directly, without needing a static argument about which handler wins.

---

## 4. Corrections to P1's plan — read before scoping

`SELF_HOSTING_COMPLETION.md` P1 says: _"The machinery for the rest is ALREADY
PORTED as libraries … the work is CLI wiring + flag parity + differential
validation."_ That is true for `init`, `fetch`, `install`, `cache`, `version`,
`lock_file`, `pkg_config`. It is **false** in three places:

| Subcommand              | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`build`**             | **Hollow, not unwired.** `_parse_registry_from_json` (`build_runner.yo:810-814`) returns an empty `BuildRegistry` regardless of input, and `evaluate_build_file` shells out to `yo-cli build --serialize-registry` — **a flag that does not exist in `src/`** (zero grep hits). `yo build` would build an empty DAG and exit 0. Upstream cause: yo-self's build builtins deliberately never populate the registry ("Registry population is deferred"), and there is no `get_build_registry`/`swap_build_registry` at all. |
| **`doc`**               | **~3,800 lines unported.** `src/doc/builder.ts` (1564), `render-html.ts` (1883), `render-json.ts` (25) and `doc-command.ts` (352) have no yo-self counterpart, so the default `--format html` path cannot work.                                                                                                                                                                                                                                                                                                           |
| **`module-manager.ts`** | **458 lines, no counterpart.** It is the shared "evaluate a `.yo` file and read its exports/registry" service that `build`, `fetch`, `install`, `doc`, `test-runner` and `codegen` all import. This is a prerequisite, not a subcommand.                                                                                                                                                                                                                                                                                  |

Two more scoping facts:

- **The `build` differential corpus cannot be "collected."** P1 says to gather
  `tests/build-projects/` from `build-system.test.ts` fixtures. That file is 2,075
  lines of pure **unit** tests whose only on-disk "projects" are one-line stubs;
  **no test invokes `yo build` end-to-end**. The corpus has to be _written_.
- **`test` is not at flag parity, and misparses silently.** yo-self honours only
  `--bail`, `--test-name-pattern`, `--exclude`; the arg loop's catch-all assigns
  any unrecognized token to `target_path`, so `yo test ./tests --profile` runs
  against a path literally named `--profile` and exits 0. CI passes exactly that
  flag. `std/cli/arg_parser.yo` (546 lines, tested) already exists and `main.yo`
  does not use it — adopting it fixes this and gets `--help`/`--version` for free.

---

## 5. Suggested order

1. **Fix the 3 HOLLOW files** (§2.1) — in flight with another agent.
2. ~~Enable branch protection~~ — **done**; the gates are binding.
3. **Start P1 with `init`.** It is genuinely ready (239 lines, complete
   `init_project`) and has **five observable divergences** a differential harness
   catches on day one — including one where **yo-self is right and TS is stale**
   (`test "it works", {…}` old statement syntax, never caught because CI runs
   `yo build run` and never `yo build test`). Small enough that harness bugs are
   obvious, real enough to prove the harness works.
4. Build `scripts/cli-diff-test.sh` alongside it. `scripts/diff-test.sh` supplies
   the verdict vocabulary and exit contract but compares only stdout+rc — useless
   for subcommands whose real output is a directory tree, a cache mutation, or an
   artifact set. Give it the corrected exit semantics from the start.
5. `cache` → `fetch`/`install` → **`module_manager`** → `build`.
6. **Defer `version`** to P3: today's version cache downloads from **npm**, and
   that channel dies with P2/P3. Porting it now means porting something about to be
   redesigned.
7. Fold in the `fmt` differential when `fmt` parity is done (§6).

---

## 6. Known debt — tracked, not blocking

- **`fmt` parity** — the self-hosted formatter disagrees with the reference on
  **315 files** (down from 417 after one bug fix). Two rule classes remain: a space
  before `)` and a space before `.`. This is P1-critical rather than cosmetic: at
  P2 the self-hosted formatter becomes canonical and `fmt --check` becomes
  self-referential, so the first `yo fmt` would silently restyle hundreds of files
  with nothing able to notice. **Caveat that shapes the fix**: the TS formatter
  _preserves_ existing line structure rather than canonicalizing, so a raw "would
  format" count conflates real spacing bugs with benign line-breaking differences.
  [`issues/yo-self-formatter-diverges-from-ts.md`](../issues/yo-self-formatter-diverges-from-ts.md)
- **Depth-8 RC cap** — `_type_contains_rc_inner` returns `false` past 8 levels
  where TS uses an unbounded visited set, so an object nested >8 aggregate levels
  deep is never torn down. **Blast radius on today's code is nil** (the marker fired
  0 times across `check ./std`, `check ./yo-self`, and a full self-emit). The twin
  cap in `_type_is_control_bound_inner` fired **181,325,397 times in one self-emit**
  — a _performance_ lever, not a correctness one.
  [`issues/yo-self-rc-depth-cap-skips-deep-teardown.md`](../issues/yo-self-rc-depth-cap-skips-deep-teardown.md)
- Coverage gaps worth knowing: yo-self is built and exercised on **ubuntu-x86_64
  only**; the stage-2 binary is never run against any test (byte-identity only);
  TSan covers 6 files; there is no UBSan job.

---

## 7. Method notes that saved real time

- **`YO_DEBUG_SWALLOW=1`** prints every def-time error yo-self swallows. Without it
  you chase symptoms — it is what turned the HOLLOW files from a weeks-scale
  mystery into a named line.
- **A green count can be hollow.** Probe with an injected `assert(false)` before
  believing any "N passed" from the self-hosted runner.
- **Before calling CI red "infra"**, check whether another job failed the _same
  test name_. A shared failure across unrelated platforms is code, not infra — an
  "emsdk 403" here was actually a regression.
- **Optimizer changes need an emit-diff.** Diff per-function dup/drop counts old vs
  new; counts must go **up or stay equal**. Fewer drops means a new cancellation,
  i.e. a potential use-after-free.
- **`MallocScribble` finds stale reads, not double frees.** A negative scribble
  result rules out one cause, not the class. "Passes on macOS, fails on Linux" has
  at least these two distinct explanations.
- Never run two heavy jobs at once on a 16 GB box; they swap and manufacture
  failures that do not reproduce in isolation.
