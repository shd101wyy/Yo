# After VALUES_BY_DEFAULT: the plan from v0.2.80

**Status: BACKLOG — proposed 2026-11-08 by the coordinator, at the maintainer's
request ("design a concrete plan for what you'd suggest us to do after the VBD
campaign").** It starts the release after VBD completes. VBD completes in
v0.2.79 per `plans/handover/VBD_RELEASE_SCHEDULE.md` §1, or later if decision
49 S3 slips.

This plan orders the work and names the owning doc for each item. The owning
doc stays authoritative for the design. The input was a 63-document audit of
`plans/` on 2026-11-07, in which every backlog doc's remaining work, value and
dependencies were checked against the tree. Every item below cites its owning
doc.

**The maintainer decides the order.** The design positions inside the items
are already decided in their docs (VERDICTS-29 to -33 and earlier).

## 0. Where Yo stands when VBD ends (v0.2.79)

- **Ownership.** Values by default with unique ownership. `Rc`/`Arc` handle
  sharing, `Weak`/`ArcWeak` handle back edges, and there is no collector
  (decision 48, landed #1763).
- **References.** `&T`/`&mut T` carry origins (decision 43). The checker is
  sound on what it accepts (the claim (S), asserted by the release-candidate
  tests of VERDICTS-58 decision 7; `BORROW_CHECKER_COMPLETENESS.md`).
  Rust-parity expressiveness (decision 50) is a target, not a v0.2.79 fact:
  it is claimed when `DIVERGENCES.tsv` has no row "rejected pending a parity
  item". Until lane A's first items land, the container/cell wall (E0909,
  N2c–N2f), second-class closures (P4), `Rc(&T)` (P5), scoped threads (P6)
  and lending iterators through a trait (P7) are walls, listed as such in
  the v0.2.79 notes.
- **Unsized types:** `?Sized`, `str`, `[T]` (`Slice(T)`) and `Dyn`, with fat
  pointers (decision 49).
- **Allocators** are placed by argument. Kebab-case module names are in.
  Macros and the isolated-transfer type are deleted, and every `yo fix`
  migration is retired.
- **Brace groups are final:** `.{ … }` builds a record, a bare expression
  brace is a block (`BRACE_BLOCKS.md`).

**What VBD deliberately deferred** (`VBD_RELEASE_SCHEDULE.md` §7):
- evaluator performance steps 1–2;
- the issue-date rename;
- PARALLEL_COMPILATION P4 step 2 and `YO_TEST_FORK` sizing;
- allocator placement step C (the root `global_allocator`).

Every RSS and wall-time number grew during VBD and was never re-baselined:
- `check src/main.yo`: 1.72 GB (the plans said 970 MB);
- `compile`: a 4.59 GB cgroup peak (the plans said about 2.5 GB);

per the ratchet, #1742.

## 1. Ordering rules

1. **Close VBD before starting anything new.** A slipped VBD item (decision
   49 S3, `Box` layout L3, the parity close-out) takes the first post-VBD
   release ahead of every lane below.
2. **Soundness before speed.**
   - An S1/S2 soundness item outranks a performance item.
   - A latent wrong answer (an `issues/` doc at S3 that hides a soundness
     rule) is fixed in the first phase that touches its area.
3. **Measure before optimising.** No performance PR starts until P-PERF-0
   has re-baselined the numbers on the post-VBD tree.
4. **Decided designs before new designs.**
   - Lanes start with work whose design is already settled: the `Io`
     interface, the pool, allocator step C, NO_LIBC.
   - Catalogue docs (the F\*/Lean/Goose/K/Rust/Zig candidate lists) are
     pull-only: an item moves into a lane when something needs it.
5. **At most four concurrent agents** (the standing cap). That is one agent
   per lane, with lanes A–D running and lane E starting when one of them
   drains.
6. **Seed-gated pairs are staggered.** A Generation A item lands one release
   before its Generation B. While waiting on a seed, that lane takes its next
   ungated item, so no lane idles on a seed.

## 2. The lanes

| Lane | Theme | Owning docs |
| --- | --- | --- |
| **A** | Soundness and language completion | `TYPE_SYSTEM_SOUNDNESS.md`, `BORROW_CHECKER_COMPLETENESS.md` (the G-D generator, totality), `COMPTIME_METAPROGRAMMING_AUDIT.md`, `REFERENCES_AND_ORIGINS.md` (move to `reference/`) |
| **B** | Runtime and platform | `IO_INTERFACE_AND_STD_RUNTIME.md`, `THREAD_POOL_OWNED_WORKERS_AND_SHARED_QUEUE.md`, `ALLOCATOR_PLACEMENT.md` step C, `ZIG_STYLE_ALLOCATORS.md`, `NO_LIBC_BY_DEFAULT.md` |
| **C** | Performance | P-PERF (§3.3): `EVALUATOR_MEMORY_REDUCTION.md`, `CODEGEN_MEMORY_REDUCTION.md`, `PARALLEL_COMPILATION.md`, `CODEGEN_PERFORMANCE.md` |
| **D** | Docs and the agent loop | `AGENT_KNOWLEDGE_CONSOLIDATION.md` (K2–K7), `OWNERSHIP_AND_BORROWING_DOC_DRAFT.md`, `RUST_REFERENCE_PATTERNS.md` (the porting guide), `BEND_LAWS_AND_AGENT_LOOP_LESSONS.md` (B4 evals, B5, `yo gate`) |
| **E** | Verification | `SAFE_MODE.md`, `SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`, `SELF_VERIFICATION.md`, `FORMAL_VERIFICATION.md` (open tail), `THEOREM_PROVING_DIRECTION.md` (ranking), `ADA_SPARK_LESSONS.md` |
| **F** | std features and ecosystem | `ASYNC_DEADLINE_COMBINATOR.md`, `ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`, `RAW_AND_FENCED_STRING_LITERALS.md`, `MODULE_PREFIX_STUTTER_REMAINDER.md`, `LANGUAGE_FEATURE_CANDIDATES.md`, `PACKAGE_MANAGER_DISTRIBUTION.md`, `SEED_VERSION_AUTOMATION.md` (ledger) |

Lane F is the filler lane: an agent whose own lane is waiting on a seed or a
battery takes the next lane-F item.

## 3. Phases

### Phase 0 — close VBD and take the baselines (v0.2.80)

- **VBD slips,** if any:
  - decision 49 S3;
  - `Box` L3;
  - brace groups Generation B and the `record-literal` retirement, if the
    schedule's §5f decision 38 fallback was taken;
  - VERDICTS-31's parity close-out, if its remaining part (G-C, the
    completeness close-out) slipped. P6, P7 and the G-D generator are not
    slips: VERDICTS-58 (schedule §5g) moved G-D to the start of v0.2.78 and
    P6 and P7 to lane A below.
- **Lane A, first items (v0.2.80–v0.2.81; VERDICTS-58 decision 9):** the
  walls the campaign dropped, in this order.
  1. **N2c–N2f, P4 and P5.** N2c–N2f never landed (the container/cell wall,
     E0909), and P4 and P5 depend on N2d. They wait for the retype to finish
     because each multiplies the positions of the audit's clusters, and
     v0.2.79's evaluator is reserved for the three-tree retype.
  2. **A41 and A42,** the D1 thread reach walk
     (`issues/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.md`,
     `issues/2026-11-11-the-d1-thread-reach-walk-trusts-every-std-body-including-the-user-impls-a-std-generic-calls.md`).
  3. **P6** (scoped threads, Generation A compiler marker then Generation B
     std), behind A41/A42 because it widens thread surface over that walk.
  4. **P7** (lending iterators through a trait), unless its Generation A
     landed in v0.2.78 (decision 11).
- **P-PERF-0 (lane C, no code):** re-baseline on the v0.2.79 tree.
  - Measure `check`/`compile`/`build` RSS and wall time on the 64 GB Linux
    box (stage-2, mimalloc verified).
  - Measure the language suite's wall time and the paired codegen suite.
  - Write one table that replaces every pre-VBD number in the four
    performance docs. **Gate:** the table is in this plan's §6.
- **IO-1a and TP-1 (lane B):** as decided in `IO_INTERFACE_AND_STD_RUNTIME.md`
  §6 and the pool plan §4. IO-1a is the compiler's Generation A, and the
  seed must carry it. TP-1 is not seed-gated and fixes the open S2
  `issues/2026-11-07-a-pool-task-that-awaits-blocks-every-task-queued-behind-it-on-its-worker.md`.
- **Lane D:**
  - Promote the ownership guide. Re-sync it against decisions 46–50 and N1/N2
    as built, then publish it to `docs/` in both languages.
  - The issue-date rename (VBD §7). It is mechanical, and it should run
    before the post-VBD issue stream grows.
  - Fix the K7 grep list first: `mut(x) :=` is current syntax, and only the
    parameter form `mut(x) : T` is gone.

### Phase 1 — foundations (v0.2.81–v0.2.83)

- **Lane A:**
  - **TYPE_SYSTEM_SOUNDNESS:** redo Phase 6 step 4/4.2 on develop (branch
    `tss/phase6-step4` is a month stale), then Phase 3 step 9 (`ArrayLen`;
    re-check it against decisions 43/49), then the kept-swallow kinds.
  - **The `Comptime` storage exclusion**
    (`issues/2026-11-08-value-collections-that-own-heap-memory-derive-comptime.md`),
    plus COMPTIME_METAPROGRAMMING_AUDIT's C5 (bigint `comptime_int`) and C6
    (`source_location`).
  - Move `REFERENCES_AND_ORIGINS.md` to `reference/` once G3 has landed.
  - Brace groups ([`BRACE_BLOCKS.md`](BRACE_BLOCKS.md)) return here
    (Generation A v0.2.81, Generation B v0.2.82, ahead of K7) only if both
    in-campaign attempts missed (the schedule's §5f decision 38).
- **Lane B:**
  - IO-1b, the std Generation B (`Io` becomes `{ctx, vtable}`).
  - IO-1c.
  - ALLOCATOR_PLACEMENT step C: Generation A reads `global_allocator`, then
    Generation B adds the std catalogue's first modules.
  - NO_LIBC's std-only **P3** (owned float print/parse, which closes two S2s)
    and **P7** (an async DNS resolver, which closes two S2s). Both run in
    libc mode too.
- **Lane D:**
  - AGENT_KNOWLEDGE K2–K7, ending with K7's bilingual docs sweep and K5's
    gate that type-checks every ` ```yo ` block. After that the docs teach
    only the finished language.
  - K4 deletes the skills and `yo skills install`, which also removes the
    reason CLI goldens moved on every skill edit.
  - BEND B4, the evals corpus. It is the only measurement of the
    LLM-authoring claim, and it starts here so that every later phase is
    measured against it.
- **Lane E (the honesty quick wins):**
  - BEND Z2: pin Z3 by sha256.
  - Z1: close the machine-load unknown flip.
  - File ADA §7's two `issues/questions/` entries.

  Each is S-sized.

### Phase 2 — performance (v0.2.84–about v0.2.88)

- **Lane C, P-PERF.** One compiler-performance plan absorbs
  `EVALUATOR_MEMORY_REDUCTION.md` §8.3 and `CODEGEN_MEMORY_REDUCTION.md` §6.1
  "Open", from P-PERF-0's baseline. Its first PR merges the two docs. Then,
  in order:
  1. VBD-deferred evaluator steps 1–2.
  2. PARALLEL_COMPILATION P2/P3 and P4 step 2.
  3. `YO_TEST_FORK` sizing.
  4. CODEGEN_PERFORMANCE CP0 (the paired suite and event counters), then
     CP2f (a range pass that discharges overflow traps; integer reductions
     run at 5.7–7× today), then CP2g (erase std's proved contracts).

  CP2c/CP2e are void (no collector, `Rc` is read-only). CP2b retargets to
  G2's cursors.

  **Gates:** the memory ratchet (`scripts/bootstrap/memory-ratchet.tsv`)
  only goes down, and each PR states its measured before and after.
- **Lane B:** NO_LIBC P0 (the `__yo_os` seam) → P0b (crt0, TLS) → P1
  (mimalloc over the seam) → P2 (console and panic output), in that order.
  IO-1b and TP-1 have landed by now, so P0b constructs `Io.native()` in its
  final shape.
- **Lane A:**
  - BORROW_CHECKER_COMPLETENESS's standing gates (G-A–G-E) stay green.
  - Its generator (G-D, running since v0.2.78) runs on a schedule.
  - New holes found by G-C/G-D are fixed here.
- **Lane F, as filler:**
  - HTTP server keep-alive over `timeout`;
  - `Reader.try_read` plus `BufReader.lines()`;
  - raw and fenced string literals.

### Phase 3 — no libc, and the allocator catalogue (about v0.2.89–v0.2.95)

- **Lane B:**
  - NO_LIBC P4 (the syscall swap) and P4b (std off `std/libc`), then P5/P6
    (clone/futex threads, porting TP-1's pool handles), then P8 (vendored
    libm, the UTC offset), then **P9, the flip** (Linux defaults to
    `--libc auto`).
  - ZIG_STYLE_ALLOCATORS' `std/heap` catalogue (A1–A5) goes beside it,
    because D2's default allocator under no-libc is mimalloc over the seam.

  **Gate:** NO_LIBC §5, the byte-identical no-libc battery leg.
- **Lanes C/A** continue their queues. **Lane E** starts in earnest (phase 4)
  once lane C drains.

### Phase 4 — verification as the flagship (overlaps phase 3)

There is one shared bottleneck, and it is attacked first: **std bodies that
the verifier walks instead of `assumed()`.** SAFE_MODE 5b Phase 3, SAFE_MODE
Phase 6 (strict mode), THEOREM_PROVING T1 (the std lemma library) and
SELF_VERIFICATION M1 all wait on it.

The order is the one THEOREM_PROVING_DIRECTION §4 ranks:
1. Verified std bodies.
2. 5b Phase 3.
3. SELF_VERIFICATION M1, the semantic kernel. Re-record its census and
   baseline first, because V5 part B made the evaluator's context a value.
4. Strict mode.
5. FORMAL_VERIFICATION's open tail: vacuity probes, `paranoid`, the mutation
   gate, `--blame`.
6. ADA's refinements and type invariants (L).

### Phase 5 — reach (continuous from phase 2, lane F)

- The package registry and `yo publish` (`PACKAGE_MANAGER_DISTRIBUTION.md`).
- The SEED_VERSION ledger's actionable follow-ups.
- MODULE_PREFIX_STUTTER (after kebab Part C).
- LANGUAGE_FEATURE_CANDIDATES' live four (SIMD, rest/prefix patterns, V6
  sequencing, `Soa`).
- The idiomatic example corpus for pretraining (ROADMAP "Publish for
  pretraining").

## 4. Release map (the first eight post-VBD releases)

| Release | Lane A | Lane B | Lane C | Lane D / E / F |
| --- | --- | --- | --- | --- |
| v0.2.80 | VBD slips; N2c–N2f + P4 + P5 (Gen A) first | IO-1a, TP-1 | P-PERF-0 baselines | Ownership guide promoted; issue-date rename; K7 list fixed |
| v0.2.81 | N2c–N2f + P4 + P5 (Gen B); A41/A42; then TSS Phase 6 step 4 | IO-1b (Gen B on v0.2.80) | merge the memory plans | K2–K4 (skills deleted); B4 evals corpus |
| v0.2.82 | `Comptime` exclusion; C5 | IO-1c; ALLOCATOR step C Gen A | evaluator step 1 | K5 gate; Z2 sha pin; Z1 |
| v0.2.83 | TSS Phase 3 step 9 | step C Gen B; NO_LIBC P3 | evaluator step 2 | K6–K7 docs sweep |
| v0.2.84 | REFERENCES_AND_ORIGINS → `reference/` | NO_LIBC P7; P0 | PARALLEL_COMPILATION P2 | keep-alive |
| v0.2.85 | TSS kept-swallow kinds | NO_LIBC P0b | P3; P4 step 2 | `try_read`/`lines()` |
| v0.2.86 | C6 `source_location` | NO_LIBC P1 | CODEGEN_PERFORMANCE CP0 | raw strings |
| v0.2.87 | G-C/G-D findings | NO_LIBC P2 | CP2f | registry design refresh |

Lane A's order from 2026-11-13 is N2c–N2f + P4 + P5, A41/A42, P6, P7 (§3,
Phase 0); every later Lane A cell above slides right by the releases those
items occupy.

Cadence stays patch releases, as in VBD: a release cuts when develop's battery
is green on the tip. A row is a target, not a gate. An item that is not ready
slides to the next row, and nothing waits for it.

## 5. Decisions the maintainer may want to make (with recommendations)

1. **A `v0.3.0` milestone.**
   - Recommendation: cut **v0.3.0** when IO-1c and K7 have landed (about
     v0.2.83). At that point the language surface the docs teach is the
     final one: values, origins, unsized types, `Io` as a value, no skills.
   - Under the no-compatibility rule it is a label, not a promise. Its
     purpose is to tell readers and models that "pre-0.3 Yo" is a different
     language.
2. **Lane E's start.**
   - Recommendation: phase 4 overlaps phase 3, and is not after it.
     Verification is the positioning claim (ROADMAP), and the verified-std
     bottleneck is independent of NO_LIBC.
   - The alternative is to finish NO_LIBC first, which is the faster route
     to a Zig-style hello-world.
3. **Registry before or after NO_LIBC.**
   - Recommendation: after P9. A registry is distribution and adoption work.
     NO_LIBC changes what every published binary links, and doing it first
     avoids publishing packages whose build expectations change one phase
     later.

## 6. Measurements (filled by P-PERF-0)

*(Empty until v0.2.80.)*

## 7. Not planned

These are deliberately parked, with their trigger recorded in the owning doc:
- **A `Send`-gated migrating executor** (`ThreadPool.spawn_async`). Deferred
  until after NO_LIBC P9, and only on a measured workload
  (`IO_INTERFACE_AND_STD_RUNTIME.md` §7, VERDICTS-33).
- **Porting the async runtime to Yo.** One epoll backend, as an experiment,
  after NO_LIBC P9 (same plan, §5).
- **The candidate catalogues**
  (`FSTAR_`/`LEAN_`/`GOOSE_`/`K_FRAMEWORK_`/`RUST_`/`ZIG_ADOPTION_CANDIDATES`).
  These are pull-only, as in rule 4.
- **Polonius-only borrow cases.** A recorded divergence
  (`BORROW_CHECKER_COMPLETENESS.md` P16).
- **Windows CRT-less builds and a freestanding profile** (NO_LIBC P10).
  Decided by measurement after P9.
