# VALUES_BY_DEFAULT release schedule

> **Status: LIVING schedule** (simplified 2026-11-22). `plans/VALUES_BY_DEFAULT.md` stays authoritative for the
> design; this file only says what ships when. Update a row when its release ships.
>
> **History.** The full schedule (per-release rows for v0.2.68–v0.2.79, the forced-boundary analysis, the count
> revisions and the dated decision records §5–§5l, decisions 1–59) is the revision at develop `e55faf6c8`:
> `git show e55faf6c8:plans/handover/VBD_RELEASE_SCHEDULE.md`. Section and decision numbers cited by other plans and
> issues refer to that revision. The design verdicts since 2026-11-20 are VERDICTS-70 to VERDICTS-76.

## 1. Shape of the campaign

VBD runs **v0.2.68 → v0.2.82**, 15 releases:

- **v0.2.80 makes the two claims**: (L) the language migration is complete, and (S) `yo check` accepts only sound
  programs (test 7).
- **v0.2.81 and v0.2.82 finish removing implicit dup/drop** (VERDICTS-70, adopted 2026-11-20). Those rows need a
  seed that carries the previous release, so they cannot fold into v0.2.80.
- A third claim, Rust-parity expressiveness, comes after VBD (§6).

A **forced** release is one a later Generation B needs as its seed; a **cadence** release is cut for size. Every
release is cut on the first develop battery that is green on the exact tip.

## 2. Shipped

| Release | Date | Headline |
| --- | --- | --- |
| v0.2.68 | 2026-10-22 | Shared-handle prerequisites (`module_path`, environments, `TypeValue` lists); explicit-copy guards; macro Part A (`Iso` removed) |
| v0.2.69 | 2026-10-24 | Explicit-copy migration fixes; W1/W2 (cycle collector off, `Arc` without `Acyclic`); `drop_in_place`; B5 collection globals |
| v0.2.70 | 2026-10-24 | The flip seed: C2/C3/C7, the `__yo_cell` primitive, P1/P3, B7a |
| v0.2.71 | 2026-10-27 | B12 (`Dyn` Generation A), allocator v2 Generation A, B4 complete |
| v0.2.72 | 2026-10-28 | Decision 43 step 1 (`&(T, p)` references and the `Origin` kind); static-argument inference Generation A |
| v0.2.73 | 2026-10-30 | V2c, B13 (errors by value), the B6-c `src/` half |
| v0.2.74 | 2026-11-04 | Decision 43 N1a–N2b; macro B1; the B8–B11 flips |
| v0.2.75 | 2026-11-05 | Cadence cut: V5 cells Generation B, B2b, W6b, N1e/N1f pieces |
| v0.2.76 | 2026-11-08 | Last-migrations release: N1e-2b, N1f-2, G1 (`FnMut` slots), `deref` Generation A |
| v0.2.77 | 2026-11-13 | Migrations retired except `deref`; decision 49 S1 |
| v0.2.78 | 2026-11-16 | `deref` Generation B; brace groups Generation B; decision 49 S2/G3 |
| v0.2.79 | 2026-11-20 | Parser drop (`ref`/`atomic` are E0009); `str` unsized; kebab-case std modules |

## 3. v0.2.80 — the claim release (in progress)

**Forecast: around 2026-11-28 to 12-02** (best case ~11-26). The walls stay: P12 READY 12-04 12:00, Deref F1+F2
READY 12-08 12:00, cut no later than 12-11 (latest 12-19).

**Landed** (#2018–#2053): the borrow-checker cluster fixes (#2018); the six test-7 soundness bugs (#2020, #2038);
capture-list loans (#2028); the dup/drop pair optimizer deleted (#2023, VERDICTS-70 row 1); side-effecting
builtins kept (#2024); `std/sync` as move-only values shared through `Arc` (#2025, row 4); IO-1a (#2026); the
guard-off knob (#2027, row 5); the `__yo_` namespace, E0407 (#2029); partial application over generic binders
(#2032); the `Hash(&T)`/`ToString(&T)` blankets (#2036); E0909/E0602/E0927 coded (#2037); the combinators
future-origin fix (#2039); `ArrayList` `Deref`/`DerefMut` (#2040); the schedule simplified (#2042); the generic
`GKind(T)` S2 filed (#2043); test 7 as one procedure, `scripts/test7.sh`, with legs (a)–(c) first green and the
corpus respelled (#2044, #2045); S3b-`str` PR A (#2046); `yo fix --migrate` deleted (#2047); the receiver riders
r1–r4 (#2048); TP-1, `ThreadPool` owns its workers (#2049); VERDICTS-76 Q1, `a := m` moves a `&mut` (#2050); five
test-7 S1s (#2051); an unwind releases a `_temp_`-named local (#2052); `slot.replace(&x)` accepted as a lend (#2053); docs: the ownership guide, current-language docs, the pack rewrite, the README.

**To land before the cut:**

| Item | What | Gates claim |
| --- | --- | --- |
| Evaluator-work ratchet | Reclaim #2020's +27% allocation regression without changing a verdict (release blocker) | — |
| P12 | `static` is a checked origin; E0922 deleted (VERDICTS-74) | (L) |
| S3b-`str` PR B | The value-`str` alias deleted; stacked on P12 | (L) |
| S3b-`str` PR E | `String : Deref(Target : str)` and the non-static `&str` producers; behind P12 | — |
| Deref F1 → F2 | The explicit `.*` sweep, then member forwarding deleted (E0623, VERDICTS-73) | — |
| E0926 for reference values | After F1/F2 (VERDICTS-75 §8; tests only); also covers a bare `&T` field read (VERDICTS-76 row 14) | — |
| Test 7 | Legs (a)–(c) green on the release tip | (S) |
| S1 rider | A `mut` name destructured from a call result is released twice | (S) |
| Riders | The box-self enum S2 fix; borrow-mark runtime (row 3); allocator v1 ABI retirement | — |
| Census | VERDICTS-70 row 2, the instrumented census (no PR) | — |

A rider that is late moves to v0.2.81 rather than holding the cut. Claim (L) is written in the release notes once
S3b-`str` PR B lands; claim (S) once test 7 passes on the tip.

## 4. v0.2.81 — implicit dup deleted

Needs the v0.2.80 seed.

- **VERDICTS-70 rows 7–14**:
  - row 7: a generic value's copy is judged at the instantiation;
  - row 8: the `Dyn` kind moves into the predicates;
  - row 9: one predicate (drop glue means not implicitly copyable); its PR first routes the two capture dup sites
    (`utils/closure.yo`, `values/anonymous-function.yo`) through `set_expr_as_needs_to_call_dup`, so the assertion has
    one site, and rewrites the raw-cell copies in `tests/yo-cell.test.yo` and `tests/cell-handles.test.yo`;
  - row 10: implicit dup insertion deleted;
  - row 11: the guard, Stage 1 and the call-scoped share marks deleted;
  - row 12: `Rc.clone`/`Arc.clone` through the retain extern; `___dup` and all dup glue deleted, with the two explicit
    uses (`calls/function.yo`, `tests/fixtures/cell-handles.yo`);
  - row 13: the prelude's borrow-mark externs deleted;
  - row 14: `drop_in_place` Generation A.
- `Rc`/`Arc.strong_count` replaces `ref_count` (row 6; parked behind the guard deletion).
- VERDICTS-76 Q2: an owned destructuring `{ a, b } := x` consumes `x` (with the Fable review's amendments).
- VERDICTS-76 rows 10, 12 and 20 and the row-6 help: a `&mut` re-point `a = m`, a `&mut` field reborrow into a
  local, a `{ m }` capture-list `&mut` move, and the `&m.*` help. Here because v0.2.80 claims (S) and adds no accept
  surface.
- VERDICTS-78 (`~/Workspace/Yo-wt/v0273/fable/VERDICTS-78.md`):
  - PR 0: the S2 generic `&T` binder at `T := Box(Dyn(S))`, which emits invalid C;
  - Q1: the reference-field store `h.r = &y` admitted;
  - Q3 PR 1: the `ToString` → `Display`/`Debug` rename (`ToString` removed; `append_to` and `Format` kept for the seed);
  - Q3 PR 2: `${x:spec}`, `${x:?}`, spec-aware `fmt`;
  - Q2: `Display`/`Debug` for `Box`/`Rc`/`Arc`; `Arc` gains `Eq`/`Hash`, all three gain `Ord`.
- A free generic function's unbound binder slot with `&x`: infer-first (Rust) as a candidate, with the open S2
  `issues/2026-11-23-a-lend-to-a-by-value-reference-parameter-in-a-static-method-call-is-e0601.md`.
- VERDICTS-72 rule (b): no user binder in the `__yo_` namespace.
- The `std/sync` channel payload back to `_ChannelState(T)`; the prelude's four `Deref` arms in
  `derive(Clone)`/`derive(Hash)`.
- IO-1b (std Generation B of the `Io` interface).
- VERDICTS-77: a substituted recursive type's self-reference denotes the substituted type (`substitute` and the
  finals registries; `type_key` renders the recursion cut by declaration and arguments), two stacked PRs after
  the evalwork memo — fixes the generic `GKind(T)` impl-member S2 and its struct twin.

## 5. v0.2.82 — implicit drop deleted; VBD closes

Needs the v0.2.81 seed.

- **VERDICTS-70 row 15**, `drop_in_place` Generation B: the prelude's `drop_in_place` on the intrinsic, `Drop`
  impls for `Rc`/`Arc`, and `___drop`, `__yo_rc_own` and the builtin decrement arm deleted.
- VERDICTS-78 Q3 PR 3: `append_to` and `Format` deleted.
- The last seed-gated renames.
- IO-1c.

## 6. After VBD

Not counted above:

- the Rust-parity claim (made when `DIVERGENCES.tsv` has no row "rejected pending a parity item"), with
  N2c–N2f, P4, P5, P6 and P7;
- evaluator performance steps 1–2;
- the issue-date rename;
- PARALLEL_COMPILATION P4 step 2;
- sizing `YO_TEST_FORK`;
- allocator placement step C (`plans/backlog/ZIG_STYLE_ALLOCATORS.md` §7.1, formerly `ALLOCATOR_PLACEMENT.md` §6 C): the root module's
  `global_allocator`, the `std/heap` catalog, and the deletion of `--allocator` on compile and build,
  `--heap-size`, `--debug-heap`, `build.allocator` and `AllocatorKind` (`yo test --allocator debug` stays).
