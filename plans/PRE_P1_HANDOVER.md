# Pre-P1 handover — what to fix and do before implementing P1

**Written 2026-08-08.** Companion to
[`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md), which defines P1–P4.
This document covers only the question _"what should be true before we start
writing P1 code?"_ — plus the corrections P1's own plan needs, because three of
its stated premises are false.

Everything below is verified unless marked as a hypothesis.

---

## 0. TL;DR

**No hard blockers remain.**

~~1. The 3 HOLLOW test files~~ — **DONE 2026-08-08.** All three run their
assertions, and `scripts/bootstrap/known-failing.tsv` is **empty**, so the
full-corpus sweep now demands a clean run on its own. Five distinct bugs, not
three; see [`issues/fixed/handover-yo-self-hollow-files.md`](../issues/fixed/handover-yo-self-hollow-files.md).

~~2. Branch protection is off~~ — **DONE 2026-08-08.** The `develop` ruleset is
`enforcement: active` with **15** required status checks, up from a disabled
ruleset naming 4 (one of them a `test` context that no longer existed). Every gate
below is now binding rather than advisory.

~~3. One thing to decide consciously: the `ctl` ABI issue~~ — **DONE 2026-08-09.**
Resolved rather than decided: the check §3 proposed was run, it downgraded the bug
from urgent to schedulable, and it was then fixed in BOTH compilers with the

> 16-byte reproducer the issue had called "not yet built". Follow-up left open on
> purpose: enable `-fsanitize=function` as the standing guard.

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
| #85 | This document                                                                 |
| #86 | Recorded the repository-admin bypass on the `develop` ruleset                 |
| #87 | **All 3 HOLLOW files fixed** — five bugs; allowlist now empty                 |
| #88 | **`ctl` ABI fixed** in both compilers, with the >16-byte reproducer built     |

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

## 2. Hard blockers — none left

### 2.1 ~~The 3 HOLLOW test files~~ — RESOLVED 2026-08-08

`tests/index.test.yo` (49), `tests/safe_code_structural_gates.test.yo` (1) and
`tests/variadic_comptime.test.yo` (10) exited 0 and reported passing while
executing **no assertions**. All three now run them, `known-failing.tsv` is
**empty**, and the sweep demands a clean corpus on its own.

They were **five** bugs, not three, each hidden behind the next because one
swallowed error erases a batch's entire `__yo_user_main` dispatch:

| file                         | bugs                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variadic_comptime`          | a comptime variadic parameter was never bound into the CALLEE env — the `quote` sibling was, the comptime one had no branch at all                                                                                      |
| `index`                      | the `slice_copy` rewrite fired on comptime receivers (TS guards it) · the range-type test matched a struct NAME that is always empty · `Range`/`RangeInclusive` are structurally identical, so every `..` read as `..=` |
| `safe_code_structural_gates` | `comptime_expect_error` restored the frame DEPTH but not the frames, losing the MODULE frame outright · a rejected module-level binding leaked its name into the codegen module-global registry                         |

**The method note worth keeping** — the previous four attempts all failed
because the brief's step 1 was wrong, and it was wrong in a way that looked
certain: the error's token pointed at the function's DEFINITION line, so the
def-time body eval was blamed. The token points there only because that is where
the body is. Compiling the definition **alone** (clean) versus definition + one
call (fails) settles it in one compile, and is cheaper than either the four
speculative fixes or the instrumented build that followed them. Full write-up:
[`issues/fixed/handover-yo-self-hollow-files.md`](../issues/fixed/handover-yo-self-hollow-files.md).

> **Two warnings, both learned the expensive way, and still binding for the next
> change in this area.** `hollow=0` is **not** proof of a fix — one attempt
> achieved it while the bodies still ran nothing, by moving the failure into a
> comment the detector does not grep for. And `check` passes on all of this,
> because it never forces the comptime evaluation a real compile does. Validate
> with an injected `assert(i32(1) == i32(2))`, nothing less. That is what was
> used here: it now FAILS in all three files, where before it reported a clean
> pass.

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
    --jq '[.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]|sort|.[]' \
    | diff - <(gh api repos/shd101wyy/Yo/actions/runs/<recent-run-id>/jobs --paginate --jq '[.jobs[].name]|sort|.[]')
  ```

  **Re-run 2026-08-09 against PR #87's run: 15 required, 15 jobs, IN SYNC.**
  (Note the `|.[]` — without it `diff` compares two single JSON blobs and reports
  a difference for any ordering change, which reads as a false alarm.)

- `strict_required_status_checks_policy` is `true`, so a PR must be up to date
  with `develop` to merge. With ~55 min CI that means re-running when someone
  lands ahead of you; flip it to `false` if that becomes a tax.

- **Stacked PRs get NO CI** (learned 2026-08-09 on #88). `test.yml` triggers on
  `pull_request: branches: [develop]`, so a PR based on another feature branch
  runs nothing — and the green checkmark you are not seeing is not a failure, it
  is an absence. When the parent merges, GitHub retargets the child to `develop`
  but that fires `edited`, **not** `synchronize`, so still no run: you must push
  the branch (a rebase onto `develop` does both — it triggers CI and clears the
  `BEHIND` state that `strict` requires). Widening the trigger to `branches: ['**']`
  would fix it at the cost of the full ~55 min matrix on every stacked PR.

- **Repository admins can bypass** (`bypass_actors: [{RepositoryRole 5, always}]`),
  added deliberately the same day. It was `[]` at first, which meant _nobody_ —
  including the owner — could merge without all 15 checks green, so a broken
  `develop` or an urgent revert had no path in except waiting out the full matrix.
  `always` rather than `pull_request` so it also covers a direct push in that case.

  The checks still run and still block by default; this only permits a deliberate
  override. Which makes the gate exactly as strong as the discipline not to reach
  for `--admin` — **if you find yourself using it routinely, that is the signal
  the required set is wrong, not that the bypass is useful.** Recorded here rather
  than left as a quiet loophole. Revert:
  `gh api -X PUT repos/shd101wyy/Yo/rulesets/13548862 --input /tmp/rs_pre_bypass.json`

Revert, if ever needed: `gh api -X PUT repos/shd101wyy/Yo/rulesets/13548862 --input /tmp/rs_before.json`
(or rebuild the payload with `enforcement: "disabled"`).

---

## 3. ~~Decide consciously — the `ctl` ABI issue~~ — FIXED 2026-08-09

[`issues/fixed/ctl-handler-void-signature-vs-sret-cast.md`](../issues/fixed/ctl-handler-void-signature-vs-sret-cast.md)

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

**Resolved rather than decided.** The cheap check was run (`-fsanitize=function`,
which works on arm64 — only the consequences are x86_64-specific) and answered the
open question: the `err`-reading top-level handler IS reached through a mismatched
call, but every EXECUTED by-value throw cast was <= 16 bytes, so the exercised paths
sat in the register class. That downgraded it from urgent to schedulable — and it was
then fixed rather than scheduled, in both compilers, with the >16-byte reproducer the
issue had called "not yet built". All `exn.throw` casts now use the callee's real
return type. Remaining follow-up: enable `-fsanitize=function` on test binaries as the
standing guard, deliberately left as its own change.

---

## 4. Corrections to P1's plan — read before scoping

`SELF_HOSTING_COMPLETION.md` P1 says: _"The machinery for the rest is ALREADY
PORTED as libraries … the work is CLI wiring + flag parity + differential
validation."_ That is true for `init`, `fetch`, `install`, `cache`, `version`,
`lock_file`, `pkg_config`. It is **false** in three places:

| Subcommand              | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`build`**             | **Hollow, not unwired.** `_parse_registry_from_json` (`build_runner.yo:810-814`) returns an empty `BuildRegistry` regardless of input, and `evaluate_build_file` shells out to `yo-cli build --serialize-registry` — **a flag that does not exist in `src/`** (zero grep hits). `yo build` would build an empty DAG and exit 0. Upstream cause: yo-self's build builtins deliberately never populate the registry ("Registry population is deferred"), and there is no `get_build_registry`/`swap_build_registry` at all.                                                                                                                                                        |
| **`doc`**               | **~3,800 lines unported — but the extraction half IS ported** (re-verified 2026-08-09; the original wording read as if `doc` were untouched). `yo-self/doc/` exists with 1,773 lines: `extractor.yo` (587), `render_markdown.yo` (800), `model.yo` (201), `sections.yo` (185). What is missing is the RENDER/DRIVE half — `src/doc/builder.ts` (1564), `render-html.ts` (1883), `render-json.ts` (25) and `doc-command.ts` (352) = 3,824 lines, none with a counterpart — so the default `--format html` path cannot work and the CLI is unwired (`doc` appears once in `main.yo`). Scope it as "port builder + html/json renderers + wire the CLI", not as a from-scratch port. |
| **`module-manager.ts`** | **458 lines, no counterpart.** It is the shared "evaluate a `.yo` file and read its exports/registry" service that `build`, `fetch`, `install`, `doc`, `test-runner` and `codegen` all import. This is a prerequisite, not a subcommand.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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

1. ~~Fix the 3 HOLLOW files~~ (§2.1) — **done**; the allowlist is empty.
2. ~~Enable branch protection~~ — **done**; the gates are binding.
3. ~~**Start P1 with `init`.**~~ — **done**, and it did its job on day one.
   "Genuinely ready (239 lines, complete `init_project`)" was true of the code
   and false of the reality: `init_project` was wired to **no subcommand**, so
   it had never been executed once. Wiring it up produced `rc=139` against the
   reference compiler's `rc=0`, and the root cause was not in `init.yo` at all
   — the async state machine silently miscompiled `await` under an `if`,
   emitting a C _comment_ and then dereferencing a NULL future. See
   `issues/fixed/yo-self-init-segfaults-on-first-run.md`.

   **Carry this forward:** in this codebase "ported" can mean "type-checks and
   is unreachable", and `check` cannot tell those apart. Every ported
   subcommand needs an execution differential before it is called ready. That
   is now `gates_fast.sh` **GATE 5**, which runs `init` and asserts the seven
   artifacts — deliberately not just `rc=0`, because the original bug created
   the directories and _then_ died.

   The predicted divergence where **yo-self is right and TS is stale** was
   confirmed: `src/init.ts` still scaffolds `test "it works", {…}` and
   `import "./deps.yo"`, pre-call syntax the language moved away from. Still
   open — CI runs `yo build run`, never `yo build test`.

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

- **`fmt` parity** — **re-measured 2026-08-09: 339 of 808 files diverge** (the
  earlier "315, two rule classes remain" was both stale and too optimistic).
  Method, reproducible in ~25 min — format a copy of every `std`/`tests`/`yo-self`
  file with BOTH formatters and `cmp` the outputs:

  ```bash
  for f in $(find std tests yo-self -name '*.yo'); do
    cp "$f" /tmp/a.yo; cp "$f" /tmp/b.yo
    ./yo-cli fmt /tmp/a.yo >/dev/null; "$S1" fmt /tmp/b.yo >/dev/null
    cmp -s /tmp/a.yo /tmp/b.yo || echo "$f"
  done | wc -l
  ```

  **Status 2026-08-09: 339 → 17 of 808 files, and both root causes are fixed.**

  1. ~~The Dot case ate the space the Comma/operator handler had just set~~ —
     fixed in both formatters (339 → 253).
  2. ~~The self-hosted formatter DESTROYED any file with a multi-byte character
     plus a backtick string~~ — fixed (253 → 17). It was a character index used
     as a byte offset (`formatter.yo:1460` → `read_raw_template_string`); ASCII
     hid it, so no existing test could catch it, and `fmt` exited 0 with output
     that did not parse. 23 of 40 sampled `std/` files were being destroyed.
     [`issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md`](../issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md)

  **What remains is ONE class, 17 files**: a stray space before `)` after an
  operator token in a MULTILINE paren frame — `(==)`, `(..)`, `(..=)`,
  `quote(=>)`, and the C-variadic `...`. It does NOT reproduce on a minimal
  single-line case, so the multiline frame is part of the trigger. This is the
  last thing between here and wiring the `fmt` differential gate.

  Historical note on what this class used to look like:

  **The dominant remaining class was not spacing — it was SOURCE DESTRUCTION.**
  `yo-self fmt` rewrites any file containing a multi-byte character plus a
  backtick string into something that **does not parse**, and exits 0. **23 of 40**
  sampled `std/` files with a backtick are destroyed this way; 774 of 922 captured
  differing lines involve a backtick. Root cause is one line —
  `formatter.yo:1460` passes `Token.character` (a CHARACTER index) into
  `read_raw_template_string`, whose parameter is documented and used as a BYTE
  offset. ASCII-only input hides it, which is why every existing test misses it.
  4-line reproducer and full analysis:
  [`issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md`](../issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md).

  This **must be fixed before the `fmt` differential gate can be wired at all** —
  the gate would otherwise be measuring corruption rather than style. It is also
  the sharpest possible instance of why §6 is P1-critical: after P2 makes the
  self-hosted formatter canonical, the first `yo fmt` silently destroys the
  standard library.

  Two further corrections that change how this should be scoped:

  1. **It is NOT two rule classes.** On a 250-file sample, 50 files diverge and only
     **12 (24%) become identical once dot-spacing is normalized** — so roughly
     three quarters of the diverging files carry at least one other difference.
     Budget accordingly; "fix two spacing rules" will not close the gate.
  2. **The dot class is a bug in BOTH formatters, and they must change together.**
     Root cause is the Dot case calling `trimTrailingHorizontalWhitespace()`
     unconditionally, eating the space the preceding Comma/operator case just
     established with `ensureSpace()` — so `, .Some` collapses to `,.Some`, and
     likewise `=.Some`, `=>.Err`, `:.Some`. The fix is to trim only for MEMBER
     ACCESS (`needsSpaceBeforeAtom(previous)`, which is exactly "the dot has a left
     operand"). See [`plans/PREFIX_OPERATOR_OPERAND_RULE.md`](PREFIX_OPERATOR_OPERAND_RULE.md),
     which diagnosed this independently and correctly.

     > **Retraction (2026-08-09).** An earlier revision of this section claimed
     > "yo-self already emits the spaced form; TS is the one with the accidental
     > trim." **That was wrong**, and the error is worth recording because it is
     > easy to repeat: it came from reading adjacent `<` / `>` lines out of a
     > diff file that CONCATENATED many files' diffs, so the two lines were not a
     > matched pair at all. The decisive test is per-file and per-direction — feed
     > BOTH formatters BOTH spellings and see what each normalizes to:
     >
     > | input              | TS                  | yo-self  |
     > | ------------------ | ------------------- | -------- |
     > | `=.Some` (tight)   | `= .Some` after fix | `=.Some` |
     > | `= .Some` (spaced) | `= .Some` after fix | `=.Some` |
     >
     > Both normalized to TIGHT before the fix. Never read a cross-file diff dump
     > as if its `<`/`>` lines were paired.

  Still P1-critical rather than cosmetic: at P2 the self-hosted formatter becomes
  canonical and `fmt --check` becomes self-referential, so the first `yo fmt` would
  silently restyle hundreds of files with nothing able to notice. **Caveat that
  shapes the fix**: the TS formatter _preserves_ existing line structure rather than
  canonicalizing, so a raw "would format" count conflates real spacing bugs with
  benign line-breaking differences — which is why the measurement above compares
  BOTH formatters' output on the same input instead of counting `--check` hits.
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
- **An error token inside a function body says nothing about WHO evaluated that
  body.** It points there because that is where the body is; a CALL that executes
  it reports the identical location. Split the reproducer — definition ALONE vs
  definition + one call — before instrumenting. One compile each, and it decides
  def-time vs call-time outright. This is what four failed attempts on the HOLLOW
  files missed (§2.1).
- **One swallowed error hides a STACK of bugs.** A hollow file's failing arm
  erases the whole batch dispatch, so the next bug only surfaces once the previous
  one is fixed — `index.test.yo` took three rounds. "Still fails after a correct
  fix" is the expected intermediate state, not evidence the fix was wrong. Read
  WHICH arm the new last swallowed error names; a different arm means progress.
- **`-fsanitize=function` adjudicates ABI mismatches on arm64.** Only the
  _consequences_ of a mismatched call are x86*64-specific — the cast types live in
  the emitted C, so a local run answers "is this call really mismatched, and with
  what return type?" without an x86_64 host. Pair it with
  `_Static_assert(sizeof(T) <= 16, ...)` appended to the emitted C to size the
  return decisively, and `clang --target=x86_64-... -S` on an 8-line freestanding
  repro to \_show* the register displacement rather than argue it (§3).
