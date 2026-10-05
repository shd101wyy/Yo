# Safe mode: handover

> **CLOSED 2026-10-02: every item this handover made actionable for an agent
> is done.** It stays here as the record of the 2026-09-28 → 10-02 stretch.
>
> - **§3.1 `set_len` S1:** landed with #1075.
> - **§3.2 the pointer-free unsafe-API audit:** landed with #1108 (`String.ptr()`,
>   the `MaybeUninit.assume_init` witness, the `refine.unchecked*` witness).
> - **§3.3 the capacity-overflow guard tests:** landed with #1101.
> - **§3.7 the loop-variant signedness S2:** landed with #1114. The
>   contracted-generic issue was already fixed by #1075.
>
> What is NOT done was never an agent's to finish here. Each item lives in its
> authoritative plan:
>
> - **§3.4 5b Phase 3:** blocked on std bodies the verifier walks and on an
>   ArrayList bounds-check elision hook. See the Phase 3 status note in
>   [`SAFE_MODE_5B_VERIFIED_GUARD_ELISION`](../backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md).
> - **§3.5 the known gaps:** deliberate, and recorded in the same plan.
> - **§3.6 strict mode:** deferred until a user asks for it ([`SAFE_MODE.md`](../SAFE_MODE.md) §9).
> - **§3.8 required check:** making "Verified guard elision oracle (pinned Z3)"
>   a required check is a ruleset setting only the user can change.
>
> The §4 gating notes (the heavy lock, the local battery, the elision oracle,
> the wrap-discovery and perf A/B techniques) still apply to the next
> safe-mode change.

**Status:** written 2026-10-01 by the session that landed 5b Phases 0–2 and the
`usize` overflow guard, handing over to an agent on another machine. **§3.1–§3.3 are DONE** (2026-10-02 update: §3.1 with #1075, §3.2 and §3.3 by the takeover session — see §3.0 for the branches); what remains is §3.4 (blocked), §3.5, §3.6 (deferred), §3.7 and §3.8. The plan is
[`SAFE_MODE.md`](../SAFE_MODE.md) and the 5b design is
[`backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](../backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md);
both stay authoritative for what each phase means. This doc says where the work
stands and what to do next. Move it to `archive/` with a banner once §3 is empty.

## 1. Where the plan stands

| Phase | State |
| --- | --- |
| 0a/0b/0c, 1, 2, 3a/3b/3c, 4 | Landed (`SAFE_MODE.md` §12). 3a gained the 64-bit `usize` trap in #1024. |
| 5a local elision | Closed as a documented non-change. |
| 5b verifier-driven elision | Phases 0–2 landed (#983, #987, #998, #1009). **Phase 3 open, blocked** (§3.4). |
| 6 strict mode | Deferred sketch, gated on 5b (§3.6). |
| §14 audit list R1–R8 | Done (2026-09-28). |

Promise A ("no UB in safe code") has one **known open S1 hole**: `ArrayList.set_len`
(§3.1).

## 2. Landed in this stretch (2026-09-28 → 2026-10-01)

- **#969:** §14 R6–R8. Callback function types, the standing UBSan workflow
  (`.github/workflows/ubsan.yml`), the class-1 governance cross-check, and the 5b design.
- **#976:** the union read gate and the consume memcpy fix. **#978:** the AGENTS.md
  cancel-sweep exemption for `ubsan.yml` / `fixpoint-arm64.yml` runs.
- **#983:** in verify mode a runtime-checkable `requires` keeps its entry assert
  (closing the open-world hole: a caller the verifier never walks could violate
  it). The missing-solver rule is mode-aware: only `verify` needs proofs, while
  `verify+` compiles without Z3. A dangling `YO_Z3_PATH` is now an error.
- **#987 (5b Phase 0):**
  - each obligation records the guard it discharges (`GuardSite`: node id, module, row, column, class), and JSON prints a `site` object;
  - obligation names are unique;
  - `usize`/`isize` widths follow the target;
  - the verify cache is keyed by the run's config and carries an epoch.
- **#998 (5b Phase 1):**
  - **Elision:** proved fixed-array index, unsigned `/` `%` and shift guards are emitted as the bare operation.
  - **Filter:** a guard is elided only when its function's outcome is `ok`, no unenforced assumption is on its path (a ghost-fn `requires`, a `refine` premise, any callee `ensures`), and the target is 64-bit.
  - **Opt-out:** `--no-guard-elision`.
  - **Report line:** `verify: N guard(s) elided`.
  - **Oracle:** the C-diff script `scripts/check-guard-elision.py`, plus the CI job "Verified guard elision oracle (pinned Z3)".
- **#1009 (5b Phase 2):** elision-only obligations `div-no-overflow`, `no-overflow`,
  `neg-no-overflow`. They never fail a run, and they are generated only when
  asked for: by `yo compile` when it records sites, and by `yo verify --elision`.
  That is because they add +62% queries on the straight-line battery and +127%
  on the valid fixtures. Fixed on the way: the verifier's literal folder used
  checked `u64` math and aborted `yo verify` on a zero subtrahend.
- **#1024:** safe mode never trapped a 64-bit `usize` `+ - *`. It now traps
  like `u64`. Two other changes made that possible:
  - 158 wrap-reliant `X.get(X.len() - 1)` sites in `src/` and `std/` became `X.last()`;
  - the overflow helpers share one out-of-line `_Noreturn` cold trap `__yo_ovf_trap`. Without it the guards cost 19% of self-compile time; with it, 0%.

## 3. Open work, in order

### 3.0 The branches (2026-10-02 update)

- `safe-mode-audit` — the §3.2 audit's PR #1108 (three gated APIs, the two
  filed findings, the per-API design lesson).
- `hash-capacity-guard-test` — the §3.3 regression tests (#1101).
- This handover. Everything else from the original session is merged.

### 3.1 S1: safe code reaches freed memory through `ArrayList.set_len` — RESOLVED

Landed with #1075 (merged 2026-10-01): `ArrayList.set_len` is deleted,
growth over unwritten memory takes the `spare_capacity()`/`assume_init(n,
spare)` token pair, and the issue lives in `issues/fixed/`. NOTE: #1076
showed "MERGED" on GitHub without reaching develop — its commits were
pushed into sibling stack branches, which auto-closed it; the fix actually
travelled in #1075. Watch for that pattern when reading the PR log.

### 3.2 Audit std for pointer-free APIs — DONE (2026-10-02, #1108)

Every pattern in the handover's method list swept, by grep plus empirical
probes (each candidate compiled from a pragma-less file with the installed
yo). Three hits, all gated:

- **S1 `String.raw_bytes() -> RawSlice(u8)`** — a struct wrapping a public
  `*(u8)` handed to safe code; `random_bytes(rs)` after a reallocation is a
  heap-use-after-free WRITE (proven under ASan). Fix is PER-API:
  `raw_bytes` deleted, `String.ptr() -> ?*u8` in `ArrayList.ptr()`'s shape.
  Two attempts at a class fix (see through structs with public pointer
  fields) were measured and REVERTED: `HashMap`'s `ctrl` is public BY
  ACCIDENT (broke 238 src files), `Allocator` is a public fn-pointer table
  (broke 58 suite runs). Public-pointer-field does not decide safety; the
  gate stays shallow and std hands out storage as the pointer.
  `issues/fixed/safe-code-holds-a-use-after-free-through-rawslice.md`.
- **S1 `MaybeUninit.assume_init`** — a pointer-free uninitialized read.
  Now `assume_init(written : *(BaseType))` — the `as_ptr()` result, #1076's
  token pattern. The extern declaration ALSO carries the witness (a direct
  body call hits the alias-only emitter and emits `return (__yo_t_…)` —
  invalid C under the seed). `issues/fixed/safe-code-reads-uninitialized-memory-through-maybeuninit-assume-init.md`.
- **S2 `std/spec/refine.unchecked*`** — trusted casts whose doc said "pair
  with AllowUnsafe", unenforced. Each takes `witness : *(T)` (`&(x)` at
  privileged call sites); the module declares AllowUnsafe.
  `issues/fixed/safe-code-forges-refinement-proofs-through-unchecked-casts.md`.

Cleared by probe/list: `__yo_*` runtime externs (Rule D6), `rc()` (read-only),
`unsafe.drop` (move checker), `unsafe.cast` (`__yo_as`, Rule D6),
`String.from_bytes` (invalid UTF-8 is mojibake/panic — std hands back
unvalidated bytes by design), json `advance` (checked indexing + trapping
usize arithmetic), container `_`-fields (E0405), `str.from_raw_parts` /
`extend_from_ptr` / the `ptr()` family (pointer-typed signatures), `iov`
(pointer-typed). `public-safe-report` learned the witness/written/spare
token exemption.

Filed on the way: `issues/fixed/prelude-methods-have-no-visibility-owner.md` (S3 —
prelude-registered methods carry owner `""`, so a `_` method there would be
public everywhere; none exists today) and
`issues/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md` (every
fast-suite leak failure is a LeakSanitizer verdict CI cannot see; all
reproduce with the seed).

### 3.3 S3: the HashMap/HashSet capacity-overflow guard has no test — DONE (#1101)

The guard is pinned by sibling tests beside the containers
(`std/collections/hash_map.test.yo` new, `hash_set.test.yo` extended):
the wrap capacity is `.Err(.CapacityOverflow)` and an ordinary capacity is
`.Ok`, RED-verified by disabling the guard. The 2026-09-04 issue's
`tests/collections/` plan no longer compiled — `_alloc_with_capacity`
became module-private with member visibility (2026-09-16) — siblings are
the sanctioned shape. `issues/fixed/hash-container-capacity-overflow-guard-has-no-regression-test.md`.

### 3.4 5b Phase 3 (imported verified modules): blocked, measured

Measured 2026-10-01 after #1048/#1057: `yo verify ./std/collections` gives 9
`assumed`, 3 outside-subset and 1 vacuous `ok`, with **0 sited obligations**.
Phase 3 would elide nothing today. Two prerequisites:
1. std bodies that the verifier walks rather than `assumed()`.
2. An elision hook for ArrayList's own bounds check. An ArrayList `xs(i)` traps
   inside std, not through `__yo_idx_chk`, so today's emitters never see it.

Do not start Phase 3 before both exist. The plan's Phase 3 status note has the
detail.

### 3.5 Known gaps in what landed (deliberate, recorded in the 5b plan)

- **Callee `ensures`:** every callee `ensures` counts as unenforced, even one
  proved in the same compile. That is conservative. Lifting it needs the callee's
  proof status at the call site.
- **Rule 2 coverage:** the `unproven` case of rule 2 has no fixture, because only a
  solver timeout reaches it (`verify+` turns a refutation into a compile error).
  `record_elidable_guard_sites`'s `outcome == "ok"` check is its gate.
- **Index, division and shift traps:** these still inline their
  `fprintf` + `__yo_abort()`. Outlining them was measured and dropped: a
  guard-bound microbenchmark ran 0.44 s both ways, and there are only ~765
  sites in the compiler. Do not redo it without a new workload that shows a
  cost.

### 3.6 Phase 6 strict mode

`SAFE_MODE.md` §9: an opt-in where an unprovable trapping site is a compile error.
It is Phase 5b plus a flag that turns "guard emitted" into "error reported". Deferred;
build it only on a user request, and never as the default.

### 3.7 Adjacent (not safe mode, but the verifier 5b depends on) — DONE

- `issues/fixed/verifier-loop-variant-obligations-are-signed-for-unsigned-measures.md`
  (S2), fixed by #1114: a sound program with an unsigned loop `decreases`
  was falsely refuted, and a u64 measure growing across the high bit
  verified. All three sites now use the measure's own order.
- `issues/fixed/verifier-contracted-generic-fn-is-silently-unverified.md`: fixed by #1075
  (abstract generic bodies). A generic body elides nothing today (5b rule 5), and
  `tests/spec/fixtures/elision/div_generic_kept.yo` pins that; #1108's
  guard-elision oracle run (70/70) re-checked it after #1075.

### 3.8 One setting only the user can change

The CI job **"Verified guard elision oracle (pinned Z3)"** is not a required check
in the develop ruleset yet. Until it is, a PR can merge with the soundness oracle
red.

## 4. How to gate (read before merging anything)

- **The repo rule (AGENTS.md, #1026):** merge to develop only on a green CI
  battery on the PR's final head, never `--admin`. This session had an explicit
  user override ("admin merge your PRs if the local gates pass"). That override
  was for this session; ask before assuming it carries over.
- **The heavy lock:** before any build, check, suite, gate or fixpoint, take
  `mkdir ~/Workspace/Yo-wt/.heavy-lock`. Write your name, the job and the start
  time to `.heavy-lock/owner`. `rm -rf` it on exit (use a `trap`). Two
  self-builds at once thrash a 16 GB machine.
- **Local battery** (what every PR here passed):
  - `yo build`;
  - `S1=<binary outside the repo> P=<prefix> bash scripts/bootstrap/gates_fast.sh` (corpus + CLI goldens);
  - `fixpoint_only.sh` (`FIXPOINT_HOLDS`);
  - `yo test ./tests --exclude tests/internal --exclude tests/cli-cases`. Check that the count of `^tests/.*\.test\.yo$` lines in its output equals the number of test files on disk: a seed-built compiler once silently ran 173 of 292 files with rc 0;
  - `tests/internal/verifier*.test.yo` one file at a time with `YO_TEST_Z3=1`.
- **Elision changes:** run
  `python3 scripts/check-guard-elision.py --bin <tree-built yo>`. It must say
  `N/N passed`. Each `tests/spec/fixtures/elision/*.yo` header
  `// expect-elided: N` is enforced. A fixture with that header that fails to
  compile is a failure, not a skip. The oracle parses helper calls with
  balanced parentheses, because guards nest (a guarded `usize` index inside an
  index guard).
- **Byte-identity for runtime code:** `yo compile src/main.yo --emit-c
  --skip-c-compiler` with and without `--no-guard-elision` must give the same
  sha256. `src/` has no verify pragma.
- **Finding wrap-reliant code (the #1024 technique):** emit stage 2 with the
  guard on, then patch the three `__yo_*_chk_u64` helpers in the emitted C to
  log instead of `abort()`. Compile it with clang, keeping the OpenSSL
  pkg-config/brew fallback from `fixpoint_only.sh`. Run it over the
  self-compile and the fast suite, then
  `grep "overflow (at" | sort | uniq -c`. One pass lists every site that
  actually runs.
- **Performance A/B (the #1024 technique):** clang the same stage-2 C twice,
  once per helper variant, and time `compile src/main.yo --emit-c` with each.
  Patched helpers that drop `abort()` are not a fair comparison: without the
  `noreturn` call the failure path stops being cold.
- **Tooling traps on this machine:**
  - the Bash tool is zsh, so `$VAR` does not word-split (use `${=VAR}`) and `--include=*.md` globs (quote it);
  - `sed` is GNU sed, so use `sed -i`, not `sed -i ''`;
  - `yo fmt` reflows code, so re-read a block before a scripted replace anchored on it;
  - a tree binary resolves std from its own worktree (pass `YO_STD` to compare binaries on one std).
