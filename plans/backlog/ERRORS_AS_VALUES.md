# Errors as values: `ctl` and `unwind` are deleted

**Status: BACKLOG — adopted 2026-11-28.** Decided by VERDICTS-96 (Fable 5.2)
and adopted by the maintainer the same day: "Yes lets adopt the final verdict
for algebraic effect." The plan is VERDICTS-94's E-0a to E-5 with VERDICTS-96
§6's five amendments. It supersedes
[`CAPABILITIES_AND_HANDLERS`](../archive/CAPABILITIES_AND_HANDLERS.md)
(VERDICTS-95's "keep and make correct", adopted and superseded on the same
day). E-0a, the adoption PR that wrote this plan, is the only step done. The
verdicts and their probes are in the coordinator's directory
(`VERDICTS-94.md`, `VERDICTS-95.md`, `VERDICTS-96.md`; `v94-probes/`,
`v95-probes/`, `v96-probes/`); the fact base is `origin/develop` `06c6306f3`
and the released v0.2.80.

Related: [`STD_RUST_ALIGNMENT`](STD_RUST_ALIGNMENT.md) (L-1, `try(expr)`, is
E-1), [`ALLOCATION_FREE_ASYNC`](ALLOCATION_FREE_ASYNC.md) (AFA-3 ports no
unwind; AFA-7 waits for E-5),
[`IO_INTERFACE_AND_STD_RUNTIME`](IO_INTERFACE_AND_STD_RUNTIME.md) (`Io` as an
interface value; the effect row, E-6),
[`DEFAULT_ON_VERIFICATION`](DEFAULT_ON_VERIFICATION.md) (S5's exit paths are
E-1v), [`SELF_VERIFICATION`](SELF_VERIFICATION.md) (lever L2 withdrawn),
[`SPEC_AND_PROOF`](SPEC_AND_PROOF.md) (the false-proof rules F8 joins),
[`POST_VBD_PLAN`](POST_VBD_PLAN.md) (the release map).

## Why `ctl` and `unwind` are removed

The maintainer's three concerns (2026-11-28): the mechanism "introduces too
much complexity, might be hard for verification, and having two ways of
handling error/exception make our std inconsistent". Each has a measurement
behind it.

1. **What the mechanism is.** Capability parameters plus one checked non-local
   exit. A handler's `return(v)` is a C `return` from an ordinary function, and
   `unwind(v)` is a thread-local flag, a value buffer and a test after every
   call that may unwind. No continuation is ever captured, and a handler cannot
   hold state. The resuming half has no user in `std/` or `src/` (0 resuming
   handlers; `ResumableException` has 0 uses), and the largest Yo program
   outside the compiler, `markdown-yo`, uses none of it. What the compiler and
   std use is an exception mechanism: all 96 handlers in `src/` are bound to
   `Exception` (VERDICTS-94 §1, §2).
2. **Complexity.** About 7,100 effect-only lines, 2.2% of `src/`. About 2,600
   of them serve `unwind` alone: the flag protocol, drops on unwind paths,
   frame-bound escape checks, unwind through async state machines and the task
   abort registry. A hello-world emits 26 flag tests (VERDICTS-94 §3). About 60
   fixed issues name the mechanism and 9 are open, and probing found ten new
   defects in two days (VERDICTS-89's four, VERDICTS-94's F1–F4, VERDICTS-95's
   F5 and F6); VERDICTS-96's F8 is an eleventh. Keeping it sound takes 8
   PRs for the core and 13 in full, and keeps about 5,000 lines
   (VERDICTS-95 §3.1, §3.2). Every "keep" option keeps the exception half,
   which is where the cost is (VERDICTS-96 §2.1).
3. **Verification.** A contract describes the value the caller receives.
   `unwind` hands a value to a different function than the one that was
   called, so no contract sees it. In VERDICTS-96's probes `v02` and `v03` a
   `Pragma.Verify` caller proves an index and a divisor from the contract of a
   function whose handler unwinds a value that breaks it, and the proved check
   fails at run time. That is F8, a false proof
   (`issues/2026-11-28-a-run-time-ensures-is-skipped-by-an-early-return-or-an-unwind.md`).
   The `Result` twin (`v04`) puts the failure in the value the `ensures`
   already describes: a wrong recovery is refuted with the counter-example
   `Err(11)` and the right one proves. VERDICTS-94's pair `p09`/`p09b` shows
   the same: a `Result` contract proves and its negation is refuted, while the
   `exn : Exception` twin is outside the verifier's subset. Proving a
   function that takes a handler needs lever L2 (about 1,000 verifier lines)
   for the normal path only; its failure path and its installer stay outside
   (VERDICTS-96 §2.2).
4. **std consistency.** std has two error mechanisms: 236 signatures fail
   through a handler and about 195 through a `Result`, and 14 functions are
   exported twice to bridge them (`parse`/`parse_exn`, `decode`/`decode_exn`,
   `to_utf8`/`to_utf8_exn`, …). The rule that splits them, STD_API_AUDIT D1,
   sorts by where a function sits (the `io` path throws, a pure transform
   returns `Result`), not by how it fails, so the two meet wherever a program
   reads and then parses. The seam has needed rules of its own: a stream puts
   its failure in the item, `ASYNC_LINES_NEEDS_A_NONTHROWING_READ` exists
   because `Reader` throws, and an unwound task's error is lost at
   `JoinHandle.await` (VERDICTS-96 §2.3; VERDICTS-94 §5). After the deletion
   there is one way: a failure is `Result(T, TypedError)`, an absence is
   `Option(T)`.
5. **What was weighed and rejected** (VERDICTS-96 §4; VERDICTS-95 §5).
   - *Keep as is:* two open S1s and a claim ("algebraic effects") that is half
     true.
   - *(d) keep and make correct* (VERDICTS-95's rank 1): 8–13 PRs to buy a
     sound version of a mechanism whose only capability beyond `Result` plus a
     closure has 5 users, all in tests. Its value depended on (e), and errors
     would still move to `Result` in its own expected path.
   - *(e) real handlers on AFA frames:* a research project (H-0 to H-4, 10–12
     lane-weeks, 50% to land by v0.2.90) that reuses about 1,000 of today's
     7,100 lines and stays outside the verifier's subset. Its one clear gain,
     generators, needs frames and not `ctl`, and is a question of its own.
   - *(b2) exceptions only* (`ctl(...) -> never` plus `unwind`): keeps about
     4,700 lines, the drop class and the two-mechanism seam. It stays the
     fallback if the pilot reopens the decision (§4).
6. **What Yo keeps over Rust** (VERDICTS-96 §3). The verifier sees every
   failure path, because a failure is an arm of the result the contract
   describes. Capabilities stay explicit interface values (`io : Io`,
   allocators by argument, no ambient authority, `yo effects`); they never
   depended on `ctl`. Comptime, the toolchain written for models (coded
   diagnostics, `yo fix`, the pack), origins without lifetime annotations and
   allocation-free async without `Pin` are unchanged. Generators are a separate
   question after AFA-7
   (`issues/questions/2026-11-28-generators-on-frames.md`). Being like Rust in
   error handling costs nothing: `Result` and `?` are what models write most.
7. **What would reopen the decision** (VERDICTS-96, "what would change my
   mind"):
   - the pilot: after one repair round, stage-2 `check ./src` is still more
     than 10% slower or larger, or `-O0 check ./src` no longer fits the default
     stack. The candidate is then (b2);
   - a program the maintainer wants within ten releases that needs a handler
     which keeps its continuation, and that a generator or a closure cannot
     express. Neither audit found one;
   - handlers put back as the product's first differentiator, above the
     verifier;
   - L-1 showing that an early exit with live temporaries is as defect-prone as
     the unwind path was. `return` inside a `match` arm ships today, so this is
     not expected.

## 1. The target

After E-5 (VERDICTS-94 §4 (c)):

- **Failure:** `Result(T, E)`. std uses a real error enum (`IoError`,
  `NetError`, `TlsError`, `HttpError` and 22 more exist), `AnyError` where no
  one enum covers a function; `src/` uses `AnyError`. `try(expr)` propagates.
- **Absence:** `Option(T)`, unchanged.
- **Capabilities:** `io : Io` (an interface value since IO-1b), allocators by
  argument, a user capability as a closure or a record of functions. No `ctl`,
  no `unwind`, no control-bound types.
- **Async:** `Impl(Future(Result(T, E), Io))` and `try(io.await(f, io))`. An
  error survives a `spawn`: the `JoinHandle` yields the `Result`.
- **Divergence:** `panic` and `never`, unchanged.
- **`yo effects`** stays and reports `io`, the allocator and `fallible` (a
  `Result` result) from signatures.

A contract over a move-only `Result` matches through a borrow,
`ensures(match(&result, .Ok(q) => (q.* <= x), .Err(_) => true))`: a `match`
on `result` itself consumes it (decision 26, E0901; seen while filing F9).

## 2. The migration

The rewrite is type-directed, and the compiler already computes its condition
(`_call_may_unwind`). `yo fix --errors-as-values` does it and is retired after
E-4d (VERDICTS-94 §4 (c)).

| Today | After |
| --- | --- |
| a parameter `exn : Exception` | dropped; the result `T` becomes `Result(T, E)` |
| a tail value `e` | `.Ok(e)` |
| `exn.throw(x)` | `return(.Err(x))` |
| `f(a, exn)` | `try(f(a))` |
| `h := Exception(throw : (e -> unwind(V))); r := f(a, h)` | `r := match(f(a), .Ok(v) => v, .Err(e) => return(V))` |
| `-> Impl(Future(T, IoExn))`, `e.io.await(f, IoExn(io : e.io, exn : h))` | `-> Impl(Future(Result(T, E), Io))`, `try(io.await(f, io))` |

A catch site becomes a `match` that sees the locals, because a handler is
capture-free today (`src/build-runner.yo`'s `read_dir` site):

```yo ignore
// today: the handler sits in a wrapper block so that its unwind has a frame to end
swallow := Exception(throw : (_e -> unwind(ArrayList(DirEntry).new())));
e.io.await(read_dir(Path.new(owned_dir.clone()), e.io), IoExn(io : e.io, exn : swallow))

// after: the recovery is at the call
match(io.await(read_dir(Path.new(owned_dir.clone()), io), io), .Ok(entries) => entries, .Err(_) => ArrayList(DirEntry).new())
```

**No flag day.** The two styles interoperate today (VERDICTS-94 `p07`,
ASan-clean), so each directory converts alone and the fixpoint gates each step:

- top-down, a converted function keeps its body and adds one line,
  `exn := Exception(throw : (e -> unwind(.Err(e))));`;
- bottom-up, an unconverted caller writes
  `match(new_f(a), .Ok(v) => v, .Err(e) => exn.throw(e))`.

**The tool's three invariants** (VERDICTS-96 §5). The migration must not
create the shapes of F1, F5 and F8 while the mechanism still exists:

1. the adapter binds one handler first and passes only that one to a call, so
   no statement passes a local handler together with another handler (F1);
2. no adapter is emitted inside a `Drop` impl (F5);
3. no adapter is emitted in a function that carries a contract clause (F8).

E-4's gate re-runs VERDICTS-96's census on every PR (§4).

**Seed gating.** `try` lands in the compiler one release before `std/` and
`src/` use it (L-1's split). E-5 needs no seed: by then the tree no longer
names what it deletes.

## 3. The PRs

VERDICTS-94 §7's E-0a to E-5 stand, with VERDICTS-96 §6's five amendments:

1. **No mechanism fixes.** E-0b is not "fix F1–F4"; it is the contract fix
   for F8.
2. **The pilot measures; it no longer decides at 3%.** A miss leads to a
   repair round in the lowering; only a second miss above 10% reopens the
   decision.
3. **`try` ships provable.** The verifier work is a named PR, E-1v, so a
   contracted function that uses `try` is in the subset the day std uses it.
4. **AFA-3 carries no unwind into embedded frames.** An `io.async` body that
   names a handler type, in its row or in a literal, keeps today's cell
   lowering, the fallback AFA-3 already keeps for cycles. K-8 is not built;
   AFA-7 deletes the fallback after E-5. E-6 is answered before AFA-5 declares
   `BoxFuture(T, E)`.
5. **std takes typed errors at E-3** where one existing error enum covers a
   function, `AnyError` elsewhere. `src/` takes `AnyError`.

| PR | Release | Seed | Content | Size, lane | Gate beyond Tier 1 |
| --- | --- | --- | --- | --- | --- |
| **E-0a** | v0.2.81 | no | This plan, the edits of VERDICTS-96 §8, F8–F10 filed. Markdown and `issues/` only | S | refs check; fmt |
| PR A | v0.2.81 | no | VERDICTS-89 PR A (E0627) as it stands: the last mechanism fix | — | its own |
| PR B | v0.2.82, after the cut | no | VERDICTS-89 PR B as it stands, only if its Tier 1 is green; otherwise the branch is closed | — | its own |
| **E-0b** | v0.2.82 | no | A contracted body's `ensures` is asserted on every `return(...)`; an `ensures` on a function that installs an unwinding handler is an error. F8, F10 | S–M, lane E | VERDICTS-96 `v01`–`v03`, `v09`, `v11`, `v12` as fixtures |
| **E-0c** | v0.2.82 | no | Delete the dead effect code (about 1,200 lines: `effect-analysis.yo` and its types, `get_evidence_parameters`, `_module_type_contains_ctl_field`, three write-only context fields) | S | emit-diff identity |
| **E-1** | v0.2.83 | A | L-1, the `try(expr)` builtin, with VERDICTS-94 §6's additions: inside a closure or an `io.async` body it returns from that body; `try` on `Option`; the error conversion through `From` by value | M | L-1's |
| **E-1v** | v0.2.83–84 | no | Verifier: an early `return` (and so `try`) is an exit path that owes the `ensures`; F9; `dyn(Box.new(e))` at an `AnyError` slot is an opaque value | M, lane E | VERDICTS-96 `v04`–`v07` as `tests/spec` fixtures; a contracted function using `try` proves |
| **E-2** | v0.2.83, on a dev-built compiler | — | `yo fix --errors-as-values`. The pilot as prepared PRs: `std/fs`, `src/build-runner.yo`, `src/lsp/` (about 40% of the handler installs, with async). The measurement (§4). The evals: the same tasks written in both styles, as input to the pack | L | §4 |
| **E-6** | a question, answered by v0.2.84 | — | `issues/questions/2026-11-28-does-future-keep-an-effect-row.md`: with every row `Io`, does `Future(T, E)` keep a row? Recommended no; it deletes bucket B (about 2,100 lines) | — | decided with the AFA lane |
| **E-3** | v0.2.84 | B | std flips: no `exn` parameter, `Result(T, TypedError)`, `Future(Result(T, E), Io)`; `IoExn` and the 14 `*_exn` twins deleted; `Exception` stays exported while `src/` uses it. Tests, cli-cases, docs and the pack in the same series; `src/`'s std call sites adapted by the tool. It does not wait for a pilot miss's repair: std's cost is not the compiler's | L | develop's battery; cli-diff; `markdown-yo` rebuilt |
| **E-4a–d** | v0.2.84–85 | B | `src/` by directory: lsp, doc, formatter; build, manifest, resolver; codegen; evaluator. The top-down adapter first, then the tool removes `exn` beneath it. Directory sweeps in announced windows (154 of 273 files change) | L | fixpoint; a time and RSS row per PR; the census zeros (§4) |
| **E-5** | v0.2.86 (v0.2.85 if E-4d is early) | no | Delete `ctl`, `unwind`, `Exception`, `ResumableException`, the control-bound rules, the flag protocol, the value buffer, the unwind catch in state machines, the registry's unwind half and `tests/algebraic-effects.test.yo`. `ctl` and `unwind` become ordinary unbound names with no special help. The open mechanism docs move to `issues/retired/` | M | fixpoint; a C-size and stage-2-time table; a hello-world has no flag test |

*Judgment* (VERDICTS-96 §6): 7–8 lane-weeks in all, most of it gate time.

## 4. Gates

**The pilot (E-2).** Measured against the base, each on stage 2:

| Measure | Target |
| --- | --- |
| `check ./src` wall time | within +3% |
| `check ./src` RSS | within +3% |
| `yo.c` size | within +3% |
| `-O0` `check ./src` | fits the default stack |

- **A miss** (any row above +3%): one repair round in v0.2.84 on the lowering,
  first the temporaries of `try` at `-O0` and the return of a `Result` by
  value. E-3 proceeds meanwhile.
- **A second miss above +10%, or the `-O0` stack:** the decision reopens with
  (b2) as the candidate (reason 7 above). Between +3% and +10% after the repair
  round, the plan continues and the cost is recorded.

**The census (E-4a–d).** Each PR re-runs VERDICTS-96's census scripts
(`v96-probes/scripts/`) over the tree and expects, in `src/` and `std/`:

| Shape | Expected |
| --- | --- |
| statements that pass a local handler together with another handler (F1) | 0 |
| `Drop` impls that install a handler or unwind (F5) | 0 |
| definitions with a contract clause and an `unwind(` (F8; `tests/` too) | 0 |

The baseline on `06c6306f3`: 97 handler installs and 152 uses in `src/`, 1 and
1 in `std/`, and the three zeros. The installs fall to 0 as each directory
converts; E-5 starts when they are 0 in `src/` and `std/`.

## 5. Release placement

| Release | Errors as values | ALLOCATION_FREE_ASYNC | Verification |
| --- | --- | --- | --- |
| v0.2.81 | E-0a; PR A | AFA-0 | SPEC_AND_PROOF PR 1a, 1b; DEFAULT_ON_VERIFICATION S2 |
| v0.2.82 | PR B; E-0b; E-0c | — | E-0b is lane E's |
| v0.2.83 | E-1; E-2 | AFA-1, AFA-2 | E-1v; `logic` and `lemma` |
| v0.2.84 | E-3; E-4a, E-4b; E-6 answered | AFA-3 with no unwind in embedded frames; AFA-4 | S3 starts on modules E-3 has converted |
| v0.2.85 | E-4c, E-4d | AFA-5, AFA-6: std's async files change once more, after E-3 | — |
| v0.2.86 | E-5 | AFA-7, after E-5 | — |
| v0.2.88 or later | the generators question | — | — |

- **v0.2.81 does not slip:** E-0a is documents, and PR A is ready.
- **Against AFA.** If E-5 slips past AFA-7, AFA-7 waits for it. If the AFA
  lane finds the cell fallback costs more than porting today's catch as it is,
  it ports; either way nothing new is designed for `unwind` in the embedded
  protocol. *Judgment:* 65% that the fallback is the cheaper one.
- **Against the verifier.** S3 proves std bodies after SPEC_AND_PROOF PR 4,
  which is E-3's release, so a std contract is written once, against a `Result`
  signature, and S3 writes no contract on an `exn`-taking function.
  DEFAULT_ON_VERIFICATION S5's "exceptions as exit paths" is "early return as
  an exit path", E-1v. SELF_VERIFICATION's lever L2 is withdrawn; the 13.7% of
  `src/` signatures that take `Exception` are served by E-4.

## 6. In-flight work and the open records

| Item | Decision (VERDICTS-96 §5) |
| --- | --- |
| VERDICTS-89 PR A (E0627) | Merged in v0.2.81. It closes an S1 in shipped compilers by rejecting programs, is evaluator-only and emit-identical, and files the `-> never` issues and the parked question. It moves `issues/2026-11-25-a-generic-ctl-handler-that-resumes-with-its-resume-value-loses-it-at-a-non-scalar-resume-type.md` to `issues/fixed/` |
| VERDICTS-89 PR B (no fall-through) | Merged after the v0.2.81 cut only if its Tier 1 is green as it stands; otherwise the branch is closed. No further work goes into it |
| F1–F7 | Not fixed. Each doc says so and moves to `issues/retired/` with E-5. A census finds no statement in `src/` or `std/` that can reach F1, F4 or F5; F2, F3 and F6 need a program that moves a handler out of its frame. A user program on v0.2.81–85 can still meet F1 or F5, and the roadmap withholds the soundness claim while an S1 is open |
| F8 | Fixed in v0.2.82 as a contract fix (E-0b) |
| F9 | Fixed by E-1v |
| F10 | Fixed by E-0b, which rewrites the same wrapper |
| The other open mechanism issues | Documented only; retired with E-5: the Windows heap corruption (S2), the unwinding closure's temp (S2), the unwound task's locals (S2), the conditional-unwind leak (S3), the shared-cell diagnostic (S3). The two bundle issues retire with E-6. E-3 removes the throwing `fs` path the Windows issue needs |
| `issues/2026-10-24-a-construction-passed-to-an-unknown-effect-callee-escapes-the-borrow-assert.md` (S1) | Not a mechanism issue: "effect" there is the mutation summary. Fixed by lane A |
| VERDICTS-89 findings 2 and 3 (`-> never`) | General bugs, fixed on their own as filler: finding 2 reproduces with a plain `fn(code : i32) -> never` value in statement position (VERDICTS-96 `v08`). Their docs arrive with PR A; the doc of finding 2 records that it is not `ctl`-only |
| The parked question "a non-resuming operation is `ctl` returning `never`" | Answered "not adopted: the operation is deleted". It arrives with PR A and moves to `issues/retired/` once PR A has merged |
| `issues/questions/`: operation contracts, by-value rows with `ctl` handlers, a test whose unwind escaped | Retired in E-0a, each with its answer |
| `issues/questions/with-lock-and-with-permit-cannot-see-an-unwind.md` | Answered in E-0a (with errors as values `with_lock` sees `f`'s `Result`); it moves to `issues/retired/` with E-3, because `std/sync/semaphore.yo` and `tests/sync/semaphore.test.yo` cite its path and E-0a edits no code |

Filed with this plan:

- F8 (S1): `issues/2026-11-28-a-run-time-ensures-is-skipped-by-an-early-return-or-an-unwind.md`;
- F9 (S2): `issues/2026-11-28-a-verified-function-that-passes-on-a-callees-result-with-a-user-error-enum-gets-a-solver-error.md`;
- F10 (S2): `issues/2026-11-28-a-bare-variant-at-a-block-tail-is-not-inferred-when-the-function-has-an-ensures.md`;
- E-6: `issues/questions/2026-11-28-does-future-keep-an-effect-row.md`;
- generators: `issues/questions/2026-11-28-generators-on-frames.md`.

## 7. Docs and naming

Two rules, both the maintainer's: never "algebraic effects", and docs describe
only the current language (VERDICTS-96 §7).

- **E-0a.** README: "Explicit capabilities and async/await". ROADMAP
  positioning: "adds explicit capabilities, comptime and a built-in verifier".
  `ALGEBRAIC_EFFECTS.md` keeps its file name until E-5 (a rename now is two
  renames in four releases); its title becomes "Handlers: `ctl` and `unwind`"
  and its first paragraph says what is true. The docs describe `ctl` and
  `unwind` accurately and say nothing about removal. The pack is unchanged:
  std's `io` path takes `exn` until E-3, and `try` does not exist before E-1.
  Agents are steered by `yo-design.instructions.md` (no new `exn` parameter or
  `ctl` type) and `AGENTS.md`.
- **E-3.** `ERROR_HANDLING.md` is rewritten around `Result`, `try`, the `Error`
  trait, `From` and `AnyError`; the pack's error and async sections follow; the
  handlers page shrinks to the language feature.
- **E-5.** The handlers page is deleted in both languages, with no history
  section. `CAPABILITIES.md` holds what is still true: a signature is its
  capability list, a callee cannot use what it was not handed, and `yo effects`
  reads it without bodies. README: "Explicit capabilities: I/O, allocation and
  failure are in every signature (`io : Io`, an allocator argument, a
  `Result`), and `yo effects` reports them." `ctl` and `unwind` get no E0401
  help (a help line for a removed feature is history), unless the evals show
  models writing `unwind`.
