# plans/ — design and planning documents

One markdown file per feature design, migration plan, or campaign roadmap.
Always create new design/plan documents here (see `AGENTS.md` workflow rules).

## Layout

| Location       | Meaning                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `./*.md`       | **Active** — plans and handovers actively driving work right now. Nothing else lives here.                                                        |
| `reference/`   | **Landed designs & decision records** — shipped-subsystem designs and policy decisions kept as the authoritative reference (still true, nothing pending). |
| `backlog/`     | **Backlog** — designs and ideas for future work: written but not started, or explicitly parked/deferred.                                          |
| `archive/`     | **Closed** — completed campaigns, refuted/rejected proposals, superseded roadmaps, one-off audits; each carries a banner stating its outcome.      |

Every doc states its status in its first lines: active docs carry a live
Status header; archived docs carry a closing banner (outcome + the commit/run
that proved it). Historical numbers inside archived docs are frozen at their
writing dates — the banner is the authoritative summary.

## Current entry points

Active work (root) — **plans and handovers driving work right now, and nothing else lives here**:

- [`ROADMAP.md`](ROADMAP.md) — overall language/product roadmap.
- [`INCREMENTAL_COMPILATION_ZIG_LESSONS.md`](INCREMENTAL_COMPILATION_ZIG_LESSONS.md) —
  edit-compile-run latency: what Yo takes from Zig's incremental design
  (per-definition hashing + dependency edges, stable symbol identity, a
  resident evaluator, per-module TUs) and what it does not (native
  backend, in-place patching). Phase 0 = instrumentation; nothing started.
- [`MATCH_PATTERN_MATCHING.md`](MATCH_PATTERN_MATCHING.md) —
  ACTIVE 2026-09-13: the `match` audit (value matching exists only on the
  primitive path; three silent wrong answers and three check-green/C-red
  shapes measured) and the design for real pattern matching: patterns stay
  expressions, one compiled `Pattern` IR shared by the evaluator and both C
  emitters, usefulness-based exhaustiveness, `switch` kept where it is
  switch-shaped plus a test-chain lowering for nested/literal/or/guard/range/
  string/tuple/struct patterns. P0 absorbs PR #661 and closes the
  exhaustiveness hole it leaves.

The formal-verification campaign's live state lives in its plan, not in a
handover: [`backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md)
carries the per-slice banners (V1–V5 complete; V6 task 5 slice 2, task 6,
task 3 slice 2 and task 2's abstract half landed as #713/#726/#727/#745) and
the open PR (#753, task 3 slice 3) is the frontier. Its two dated handovers
([`HANDOVER_2026-09-14_FV_V6_TASK1.md`](archive/HANDOVER_2026-09-14_FV_V6_TASK1.md),
[`HANDOVER_2026-09-15_FV_V6_REMAINING.md`](archive/HANDOVER_2026-09-15_FV_V6_REMAINING.md))
closed 2026-09-17 once everything they handed over had landed.

The **LLM-friendly toolchain campaign** closed 2026-09-17:
[`archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md`](archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md)
— every item implemented across #718/#720/#724/#733. What stays authoritative
is the §4 brace DECISION (a brace group is a record unless it has a `;`, in
every position, including destructuring and match arms; `{ x }` gets a
diagnostic rather than a grammar change) and the REJECTION of
`struct(generic(T), …)`. Shipped: a non-`unit` `main` is rejected, a failed
test batch says `0 of N tests ran`, `yo check --test-bodies`, `yo fix` with
structured `Repair`s carried by `--error-format json` and applied for both
parse and evaluator errors, and the generic "failed to evaluate" messages
fixed once at the swallow. Read its OUTCOME notes on §1.3 and §2 before
reviving anything: two of the document's own proposals were measured WRONG,
and so was the root cause in the issue it filed.

Closed campaigns (`archive/`) — self-hosting is **finished**. The compiler has
been self-hosting since 2026-08-03, the TypeScript compiler was retired
2026-08-20 (tag `src-attic-final`), distribution and LSP shipped. Start from
[`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md) (the bootstrap campaign,
GOAL ACHIEVED) and
[`archive/SELF_HOSTING_COMPLETION.md`](archive/SELF_HOSTING_COMPLETION.md)
(the P1–P4 umbrella); the per-phase records (`P1_CLI_PARITY.md`,
`P2_RETIRE_SRC.md`, `P2_5_RETIRE_EXECUTION.md`, `P3_DISTRIBUTION.md`,
`P4_LSP.md`) sit alongside them.

The **build & dependency campaign** closed 2026-09-13 with every phase
delivered:
[`archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`](archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md)
— the `yo.toml` manifest, the Cargo-style resolver and `yo.lock` v2, the
content-addressed store, `build.manifest` / `build.env` / `comptime_read_file`
/ `comptime_json_parse`, parallel DAG levels and workspaces; its closing
banner lists the six deliberate deferrals (on-demand fetch for `check`,
`build.fetch`, workspace inheritance, two coexisting majors, `[patch]`, and
P4's registry + `yo publish`). The dogfooding milestone that ended it —
`vendor/markdown_yo` un-vendored, the compiler resolving its own dependency —
was driven by
[`archive/HANDOVER_UNVENDOR_MARKDOWN_2026-09-13.md`](archive/HANDOVER_UNVENDOR_MARKDOWN_2026-09-13.md),
archived alongside it.

The **std API campaign** closed 2026-09-13 with the second half too:
[`archive/STD_API_STABILIZATION.md`](archive/STD_API_STABILIZATION.md)
(COMPLETE 2026-09-13 — all eleven §2 decisions D9–D19 landed, §4's P1
batteries are in, §5's three maintainer decisions are made AND implemented;
`spawn_blocking` was the last open item, exported once the four-layer
compiler defect behind it was fixed), with raw per-module findings
[`archive/STD_API_STABILIZATION_FINDINGS.md`](archive/STD_API_STABILIZATION_FINDINGS.md)
archived alongside. Its 2026-09-07 handover — the PR stack, the verified
merge order, and the rules that bit the session — is
[`archive/HANDOVER_STD_AUDIT_2026-09-07.md`](archive/HANDOVER_STD_AUDIT_2026-09-07.md),
closed with the campaign. The first half:
[`archive/STD_API_AUDIT.md`](archive/STD_API_AUDIT.md) (the 2026-08-22 audit —
S0–S5 complete, superseded by `archive/STD_API_STABILIZATION.md`), with its sub-plan
[`archive/STD_API_AUDIT_D4_PLAN.md`](archive/STD_API_AUDIT_D4_PLAN.md)
(byte-indexed strings) and method notes
[`archive/STD_API_AUDIT_HANDOVER.md`](archive/STD_API_AUDIT_HANDOVER.md).
Its superseded handovers (`HANDOVER_2026_08_28.md`,
`HANDOVER_STD_AUDIT_NEXT.md`, and the dated 08-30 / 09-01 / 09-02 / 09-05 /
09-06 files) are archived alongside, as is
[`archive/HANDOVER_STD_CAMPAIGN_2026-09-10.md`](archive/HANDOVER_STD_CAMPAIGN_2026-09-10.md)
— the 09-10 evening handover, closed 2026-09-11 once everything it handed over
had landed, and worth reading for its §4 (three "Yo has no X" comments that
were false, each having already produced a workaround);
[`archive/D6_TLS_PLAN.md`](archive/D6_TLS_PLAN.md) closed with Windows
Schannel TLS in v0.2.26.

Two more campaign records closed 2026-09-17 after their last phase landed:

- [`archive/THREAD_SAFETY.md`](archive/THREAD_SAFETY.md) — all 14 phases
  implemented; Phase P (field visibility) landed as #716 (2026-09-16), the
  compiler-enforced `_` prefix recorded in
  [`reference/MEMBER_VISIBILITY.md`](reference/MEMBER_VISIBILITY.md).
- [`archive/WAKER_BASED_SCHEDULING.md`](archive/WAKER_BASED_SCHEDULING.md) —
  the async scheduling campaign (Waker + `park`, `yield`, `Mutex`, `Channel`,
  the combinators' cancellation, cross-thread wake, `spawn_blocking`),
  COMPLETE 2026-09-13.

One-off plans closed 2026-09-17, each with a banner stating what landed:

- [`archive/CI_RUNTIME_REDUCTION.md`](archive/CI_RUNTIME_REDUCTION.md) — the
  118-minute test.yml critical path; change 1 (shard the long non-required
  legs, `yo test --shard i/n`) landed widened in #707, change 2 (the Linux
  legs consuming the shared stage-2 binary) did not.
- [`archive/INOUT_LOCAL_BINDINGS_AUDIT.md`](archive/INOUT_LOCAL_BINDINGS_AUDIT.md)
  — implemented (#473 Phase A; #476 Phases B–C + the borrowed `for`); its
  deliberately-open follow-ups live in the banner.
- [`archive/PERF_BORROW_ELISION.md`](archive/PERF_BORROW_ELISION.md) — the
  RC-traffic perf plan, moot in its written form since the TS compiler was
  retired; kept for its measurement method, remaining levers in
  `issues/yo-self-compile-performance-rc-string-eq.md`.
- [`archive/RELEASE_NOTES_v0.2.31_DRAFT.md`](archive/RELEASE_NOTES_v0.2.31_DRAFT.md)
  — shipped as v0.2.31 (2026-09-12).

Landed designs & decisions (`reference/`) — done but still true. Subsystem
designs: [`reference/BUILD_SYSTEM.md`](reference/BUILD_SYSTEM.md),
[`reference/DEPENDENCY_MANAGEMENT.md`](reference/DEPENDENCY_MANAGEMENT.md),
[`reference/VERSION_MANAGEMENT.md`](reference/VERSION_MANAGEMENT.md),
[`reference/ERROR_DIAGNOSTICS_OVERHAUL.md`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md),
[`reference/PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md),
[`reference/ASYNC_ITERATION_STREAM.md`](reference/ASYNC_ITERATION_STREAM.md)
(the `Stream` trait — async iteration, LANDED 2026-09-11 with `for_await` and
`BufReader.lines` parked in `backlog/`),
…. Policy decisions:
[`reference/MACRO_POLICY.md`](reference/MACRO_POLICY.md),
[`reference/TARGET_TRIPLES.md`](reference/TARGET_TRIPLES.md),
[`reference/FUNCTION_OVERLOADING_POLICY.md`](reference/FUNCTION_OVERLOADING_POLICY.md),
[`reference/LAZY_TOPLEVEL_BINDINGS.md`](reference/LAZY_TOPLEVEL_BINDINGS.md)
(order-independent definitions, LANDED 2026-09-05),
[`reference/OPERATOR_SET_AND_PRECEDENCE.md`](reference/OPERATOR_SET_AND_PRECEDENCE.md),
[`reference/WINDOWS_ALLOCATOR_DECISION.md`](reference/WINDOWS_ALLOCATOR_DECISION.md),
[`reference/MATCHING_LOGIC_RESEARCH.md`](reference/MATCHING_LOGIC_RESEARCH.md)
(matching logic / K assessed and declined as the verifier foundation, 2026-09-09),
[`reference/REMOVE_OPEN_BUILTIN.md`](reference/REMOVE_OPEN_BUILTIN.md)
(the `open(...)` builtin removed 2026-09-10 — glob imports are
`{ ... } :: import(...)`, and the migration rules there are how to read an
`open(...)` in an older doc),
[`reference/MEMBER_VISIBILITY.md`](reference/MEMBER_VISIBILITY.md)
(member visibility landed 2026-09-16 as the compiler-ENFORCED `_` prefix —
private to the declaring module and its same-directory siblings, error
E0405; the `priv` marker the doc recommended was rejected as seed-gated
syntax),
[`reference/C_INCLUDE_EXTERN_MODULE_VALUE.md`](reference/C_INCLUDE_EXTERN_MODULE_VALUE.md)
(`c_include(...)`/`extern(...)` evaluate to module values, LANDED #698
2026-09-15 — the bare statement form is parse-time sugar for the glob, the
destructurer enforces no-shadowing, and `label : c_type("…")` spells a
non-identifier C symbol),
….

Backlog (`backlog/`) — written, not started. Recent additions:
[`backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md`](backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md)
(unsafety is FILE-scoped in Yo, which is what makes the D14 pointer `iter()`
expensive — with probes and a Rust/Swift comparison),
[`backlog/FUNCVAL_ENV_SHARING.md`](backlog/FUNCVAL_ENV_SHARING.md) (the
mechanism was built and rejected twice; kept because the failure modes
generalize) and
[`backlog/ZEROLANG_AGENT_FIRST_LESSONS.md`](backlog/ZEROLANG_AGENT_FIRST_LESSONS.md)
(a keep/reject audit, explicitly not a commitment) and its sibling
[`backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md)
(PROPOSED 2026-09-18: what Yo takes from Bend 2 — `law(...)` claims outside
the code, lemmas as contracted `ghost_fn`s proved by induction, a
`yo verify --strict` gate that fails on `assumed()`, `yo guide`/`yo std`, an
evals corpus — with implementation phases B0–B6 another agent can pick up),
and [`backlog/SELF_VERIFICATION.md`](backlog/SELF_VERIFICATION.md)
(PROPOSED 2026-09-18: can the compiler be verified by itself? Measured
baseline `yo verify ./src`: 4,049 fns, 57 `ok`, 2 with any obligation, 90%
blocked at the parameter-type gate; semantic preservation is a non-goal, the
plan is S0 measure/ratchet → S1 subset growth driven by the compiler's own
blockers → S2 the semantic kernel (comptime arithmetic vs the bitvector model,
struct layout) → S3 a verification fixpoint → S4 pipeline invariants). Three landed 2026-09-11
alongside `reference/ASYNC_ITERATION_STREAM.md`, each parking a piece of it
with the blocker measured:
[`backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`](backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md)
(an `io.await` inside a macro expansion compiles to a BLOCKING await, so an
awaiting macro deadlocks in a task),
[`backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`](backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md)
(an async `BufReader.lines` needs a `Reader` that returns its failure instead
of throwing it),
[`backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`](backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md)
(`where(T <: Trait(Assoc := A))` binds nothing when `A` is a generic — true of
`Iterator` too), and
[`backlog/ASYNC_DEADLINE_COMBINATOR.md`](backlog/ASYNC_DEADLINE_COMBINATOR.md)
(why `std/async`'s `timeout` cannot be used from inside a task, and the HTTP
server keep-alive that blocks on it).

**Language features the std campaign was blocked on** (added 2026-09-10, each
written from the std row that needed it, with the blocked call sites named).
As of 2026-09-17, three of the four have landed:

- [`reference/THREAD_LOCAL_STORAGE.md`](reference/THREAD_LOCAL_STORAGE.md) —
  LANDED 2026-09-17: `thread_local` in #741 (v0.2.36), adopted by
  `std/rand.yo` in #748 as Rust's `thread_rng`.
- [`archive/WAKER_BASED_SCHEDULING.md`](archive/WAKER_BASED_SCHEDULING.md) —
  LANDED 2026-09-13 (the largest one): everything that waits on a peer used
  to poll a **1 ms timer**, putting a millisecond floor under every hand-off
  and making `spawn_blocking` inexpressible. The Waker + `park` primitive,
  `yield`, the async `Mutex` and `Channel`, the combinator cancellation and
  cross-thread wake + `spawn_blocking` all shipped.
- [`backlog/ASYNC_ITERATION_STREAM.md`](backlog/ASYNC_ITERATION_STREAM.md) —
  superseded by the landed
  [`reference/ASYNC_ITERATION_STREAM.md`](reference/ASYNC_ITERATION_STREAM.md)
  (the `Stream` trait, 2026-09-11).
- [`backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`](backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md)
  — the one still open: an associated constant in a TYPE position
  (`Array(u8, T.BYTES)`) silently resolves to **0**. Blocks collapsing the
  ten per-type byte conversions, and `usize`/`isize` having them at all.

Two things measured while writing these, both of which turned out to be
features Yo already HAS despite comments in the tree saying otherwise:
associated **types** (`Item : Type`, `Self.Item`, used as a return type and as
a constructor) and associated **constants** in a value position (`T.BITS`).
Probe before working around.

## Conventions

- When a plan completes (or is refuted/superseded), add a closing banner at
  the top stating the outcome and the commit/run that proved it, then
  `git mv` it into `archive/` — or into `reference/` if it is a landed
  design/decision that stays authoritative — and update references
  (`grep -rn "plans/<NAME>.md"`).
- A doc that is written but not started goes to `backlog/`; promote it to the
  root when work starts. When a root doc lands, graduate it to `reference/`.
- Historical status numbers inside archived docs are frozen at their writing
  dates — do not update them; the banner is the authoritative summary.
