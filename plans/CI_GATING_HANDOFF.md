# Handoff — finish gating `compiler-internal-tests`

**Written 2026-08-06.** Branch `feat/bootstrap-codegen`, HEAD `5cf47795a`.

Goal of this workstream: **every CI job gates PRs. That is now DONE —
`continue-on-error` has been removed everywhere.**

**So `compiler-internal-tests` is RED and blocking merges right now, on purpose.** The flag
was dropped deliberately with one known failure outstanding (§2) so the bug cannot be merged
past. **Your job is §2.** Until it is fixed, expect that job to fail on every PR; the other
nine are green.

Everything in §3 is optional follow-up.

Read `plans/YO_SELF_STAGE2_HANDOFF.md` for the bootstrap campaign as a whole; this doc is
only the CI-gating tail.

---

## 1. Where things stand (verified, not assumed)

CI run `31051936217` (commit `13de0e3c1`) — **9 of 10 jobs green**:

| job                                          | state                               |
| -------------------------------------------- | ----------------------------------- |
| `test` ubuntu / macos / windows              | green, gating                       |
| `test-wasm32_wasi`, `test-wasm32_emscripten` | green, gating                       |
| `Bootstrap fixpoint (yo-self self-compile)`  | green, gating                       |
| `Bootstrap fixpoint stage-3 (byte-identity)` | green, gating                       |
| `ThreadSanitizer`                            | green, gating                       |
| `Self-hosted test subcommand (tier-1 gates)` | green, gating                       |
| `Compiler internal tests`                    | **gating, and currently RED on §2** |

`compiler-internal-tests` scorecard on that run:

- TS arm (ground truth): **824 / 826** — the 2 failures are both §2.
- self-hosted arm (differential): **826 / 826**.

### Fixed earlier in this session — do NOT re-investigate

| what                                                                             | commit      | evidence                                                                                                     |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| 2 Linux-x86_64 parser SEGVs (escape path dropped the unwound call's result temp) | `c82e4ec8e` | `issues/fixed/escape-path-drops-unwound-call-result-temp.md`; 16→0 bad drops of 515 sites; CI-confirmed gone |
| node-heap OOM that killed the TS arm at ~file 40 of 58                           | `c82e4ec8e` | one node process per file; measured 1.30 GB (4 files, one process) vs 1.166 GB (heaviest alone)              |
| `phase6*` test files renamed to say what they cover                              | `bfb233bf7` | `tests/internal/macro_helpers.test.yo` 3/3 after the rename; old→new table in `AGENTS.md`                    |

**Two retractions recorded in those docs — do not rebuild on the retracted claims:**

1. The garbage stack address in the SEGV was **not** an sret destination pointer left in
   RAX. `String` (`Option(ArrayList(u8))`) and `ParseResult` are **both exactly 16 bytes**,
   returned in `RAX:RDX` with no hidden pointer. What the register held was never pinned
   down, and the fix does not depend on it.
2. "The self-hosted arm passes, the TS arm crashes" was **not** evidence about TS's x86_64
   emission. The self-hosted test runner adds **no sanitizer** (`yo-self/main.yo`,
   `sanitize = ""`), so the two arms were never comparable on leak/UB questions.

---

## 2. THE BLOCKER — a conditionally-moved local is never released

> **FIXED 2026-08-06 — see the RESOLUTION section of
> `issues/fixed/where-constraints-arraylist-96b-leak.md`.** The sharp question below had a
> third answer nobody predicted: case 3 cannot fire because **there is no consumption at
> merge time at all**. The evaluator defers a `___dup` for a named local passed to a
> struct literal (copy semantics); the "move" in the C is manufactured later by the
> dup/drop pair optimizer in `begin.ts`, whose dup collector was branch-blind for macro
> calls — `if` keeps its macro head in the AST, so the collector recursed into the raw
> args and cancelled the arm's dup as if unconditional. Fix: the collector walks
> `$.macroExpansion` instead of raw macro args (same shape as `exprTreeContainsReturn`),
> so arm dups hit the existing branch-aware handler and the pair is preserved. Mirrored
> in `yo-self/evaluator/exprs/begin.yo` (`_search_dup_calls` +
> `_remove_dup_calls_from_tree`). Regression test: `tests/rc.test.yo` "Conditional move
> into a struct field balances both paths".
>
> The corpus differential then caught a follow-up bug in the first fix version: exposing
> macro arms to the branch handler also exposed them to its `__isEarlyReturnDup` fast
> path, which cancelled dups that FEED a return value — `drop(x); return x;` in yo-self's
> `compute_overlapping_slots` (stage-1 SIGSEGV on both `io_async_fsm_*` corpus tests).
> The fast path was removed in both compilers: return-arms now join the same
> all-arms-must-dup coverage calculus as fallthrough arms. See the issue doc's follow-up
> section. All §4 gates re-run green locally; the remaining step is the CI round trip
> (LeakSanitizer is Linux-only).

`issues/fixed/where-constraints-arraylist-96b-leak.md` is the full record. Summary, and what is
genuinely still unknown.

### Symptom

`tests/internal/macro_helpers.test.yo` (was `phase6f_macro_helpers`), tests 0 and 1 (test 2
is clean): LeakSanitizer reports **80 bytes on Linux** (96 on macOS — RC header/allocator
padding differs), allocated by `ArrayList(WhereConstraintEntry).new()` inside
`get_func_where_constraints` ← `try_to_implement_function_by_function_type`.

Pre-existing, not a regression: verified by stashing every `src/` change back to `8fb6aa0c6`
and re-running. It only surfaced in CI once the OOM was fixed, because the job had never
reached that file.

### The shape, in yo-self

`yo-self/evaluator/calls/function_type.yo`:

- `:880` — `def_where_entries := match(...)`, a local bound from a call that returns a FRESH
  RC value on the `.None` arm.
- `:970` — `if(has_fwd_comptime_fn_cap, {`
- `:978` — `where_entries : def_where_entries` — the move into `PendingDefEval`, **inside
  that `if`**.

(The issue doc says `:977` for the move; the correct line is **`:978`**.)

### Minimal reproducer — deterministic, macOS, no sanitizer

The ingredient five earlier attempts missed is that **the move is conditional**. Gate on
`rc()`, not on `leaks` (macOS `leaks` reports 0 for real leaks at `-O2`) :

```rust
Holder :: struct(items : ArrayList(i32));
g_seen := ArrayList(ArrayList(i32)).new();   // keeps an outside reference

make_fresh :: (fn() -> ArrayList(i32))({     // mirrors get_func_where_constraints
  l := ArrayList(i32).new();
  g_seen.push(l);
  l
});

work :: (fn(flag : bool) -> unit)({          // mirrors try_to_implement_…
  entries := make_fresh();
  if(flag, {
    h := Holder(items : entries);            // CONDITIONAL move
    println(`held ${h.items.len()}`);
  });
});
```

Call `work(true)` then `work(false)`, then compare `rc()` of the two lists `g_seen` still
holds → **`taken_rc=2 skipped_rc=3`**. One reference retained whenever the branch containing
the move is not taken.

A **parameter**-based variant (`consume_maybe(flag, l)` with `l` a parameter) does NOT
reproduce. Parameters are handled; a local bound from a call is not.

### Emitted C, so there is no ambiguity about what is wrong

```c
ArrayList* entries = _temp_40729;              // owned, rc 1
if (flag) {
  Holder _temp = { .items = entries };         // MOVE, no dup
  ...
  drop(h);                                     // releases entries
}
else {
}                                              // <- nothing releases entries
```

### THREE approaches ELIMINATED by measurement — do not repeat these

1. **Position-based drops on early exits** (what the issue doc originally proposed: on an
   exit whose position precedes `consumedAtToken`, drop the variable). **Cannot work.** The
   fall-through past the `if` is positioned _after_ the move token, so it still reads as
   consumed. This also refutes the doc's original claim that "the normal path is correctly
   balanced" — it is balanced only when the condition is true.
2. **Per-arm drops in the `cond` codegen** (`src/codegen/exprs/cond.ts`): at the end of each
   arm, release what a _different_ arm consumed. Built it, probed the variable there:
   ```
   PROBE arm=0 name=entries consumed=false init=true owning=true rc=true module=false
   PROBE arm=1 name=entries consumed=false init=true owning=true rc=true module=false
   ```
   **`consumed=false`** — the `cond`'s own `$.env` never records the consumption, so the arm
   emitter cannot see what to release. Reverted; nothing left in the tree.
3. **`mergeAndCheckEnvs` "case 1"** (`src/expr.ts`, the single-case branch). A probe that
   threw on every single-case consumption never fired, because **`if` is a prelude macro**
   (`std/prelude.yo:7655`) expanding to
   ```rust
   cond(unquote(condition) => unquote(then), true => unquote(else))   // else defaults to ()
   ```
   so there are always **two** arms, never one.

### THE SHARP QUESTION TO START FROM

> `mergeAndCheckEnvs` **"case 3"** — `src/expr.ts:2177`, `// case 3: Some cases consume, some don't`
> — is written to **reject exactly this program**, and it does not fire. Find out why.

Given `if` expands to a two-arm `cond` where arm 1 consumes and arm 2 (`()`) does not,
`consumedAtTokens` should be `[token, undefined]` and case 3 should throw
`Variable "…" is consumed in some cases but not in other cases`. It doesn't. Candidate
reasons worth checking in order: the `()` arm body may have no `$` and be dropped by the
`bodies.filter(...)` at the `mergeAndCheckEnvs` call site (`src/evaluator/exprs/cond.ts:447`,
which filters out `return`/`unwind` bodies); the variable may live in a frame index the
matrix does not line up; or the merge may not run at all for this shape.

The answer decides the fix:

- **If case 3 can be made to fire** → the compiler rejects conditional moves outright. Sound
  with no drop flags, and it forces the `yo-self` source at `:978` to clone or restructure.
  Cheapest correct option. Measure the blast radius: `./yo-cli check ./std` plus the fast
  suite will show how much existing code relies on conditional moves.
- **If conditional moves must keep compiling** → convert the move into a **dup** at the
  consumption site, leaving the variable unconsumed so the ordinary scope-end drop balances
  both paths. Correct with no runtime flag; costs one refcount increment on the taken path.
  `setExprAsNeedsToCallDup` (`src/expr.ts:2451`) already exists, but it needs the consuming
  _expression_ — `Variable` currently records only `consumedAtToken`, so it would gain a
  `consumedAtExpr`.
- **Drop flags** (what Rust does: `bool moved = false;` … `if (!moved) drop(x);`) are the
  general answer and correct under any control flow, including loops. Largest change; only
  reach for it if the two above are ruled out.

Note `getVariablesNeedingDrop` (`src/env.ts:2279`) returns nothing for a variable with
`consumedAtToken`, so **no drop expression exists to filter** — any fix must _create_ one, or
prevent the consumption from being recorded.

### Risk, and the gate

Dropping on a path where the move DID happen is a **double free** — far worse than 80 bytes
on an error path. Before believing any fix:

1. the `rc()` reproducer above (seconds);
2. `tests/rc.test.yo` — 18 RC-ownership regression tests, including the three prior
   early-return/consumed-var fixes this is adjacent to
   (`issues/fixed/early-return-reassigned-rc-variable-leak.md`,
   `issues/fixed/early-return-missing-local-variable-drops.md`,
   `issues/fixed/pending-drop-consumed-var-nested-return.md`);
3. the real batch: `./yo-cli test ./tests/internal/macro_helpers.test.yo --parallel 1`
   (~3 min, 168 s measured);
4. §4 gates in full.

**LeakSanitizer is Linux-only.** No macOS run — including the 2657-test fast suite — can
detect a leak regression. Only `compiler-internal-tests` on Linux can. Plan on a CI round
trip to confirm.

### When it is fixed

Nothing to do in the workflow — `continue-on-error` is already gone and the job already
gates. Just confirm the job goes green, and drop the "EXPECTED TO BE RED" paragraph from the
comment above `compiler-internal-tests:` in `.github/workflows/test.yml` (and the matching
warning at the top of this doc) so the next reader is not told to expect a failure that no
longer happens.

---

## 3. Other open work, ranked

Nothing below blocks CI gating.

| #     | item                                                                                                                                                            | notes                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 49    | Remaining async RC-lifetime divergences (D2–D7)                                                                                                                 | **ORDERING HAZARD: dups before drops.** The missing drop currently masks a missing dup into a mere leak; restoring a drop first turns a balanced single-await into an over-release. D4 needs a semantics decision — yo-self's unwind answer looks _more_ correct than TS's.                                                                                                                                         |
| —     | `issues/ctl-handler-void-signature-vs-sret-cast.md`                                                                                                             | Latent ABI break: `ctl` handlers are emitted `void` while each call site casts to the surrounding expression's type. Harmless at ≤16-byte returns (the whole current corpus; `ParseResult` sits exactly on the boundary), argument-shifting above it. **Confirmed by `-fsanitize=function` on macOS arm64.** Fix the signatures, then enable that check as the guard — enabling it first fails the suite wholesale. |
| 40    | Re-express the four macro/reflection tests as cheap tests in `./tests`                                                                                          | They are the memory hogs: `macro_expansion` alone peaks ~6.5 GB.                                                                                                                                                                                                                                                                                                                                                    |
| 42    | `is_creating_closure` divergence, then wire the 3rd CTFE site                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 34–37 | Memory levers (RC header slimming, caller-frame sharing, `g_frame_indexes` diet, GC probe)                                                                      | Parked at user direction. `plans/YO_SELF_ENV_SHARING.md` has the ranked list.                                                                                                                                                                                                                                                                                                                                       |
| —     | `issues/module-global-c-names-are-not-namespaced.md`                                                                                                            | Soundness hole: module globals get UNMANGLED C names, so same-named globals in different modules alias. Audited clean today (std 0, yo-self 181/181 distinct, tests 2/2) but nothing prevents the next collision.                                                                                                                                                                                                   |
| —     | `issues/yo-self-tail-expression-arg-temp-drop-missing.md`, `issues/ctfe-elided-unit-call-arg-temp-leak.md`, `issues/fieldless-ref-enum-simple-enum-collapse.md` | Filed, unfixed, not CI-blocking.                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 4. Gates — exact commands and measured timings

Run in this order. Everything below was run on this branch today unless noted.

```bash
# 0. ALWAYS build first
bun run build

# 1. Fast language suite — 2657 tests, 306 s (the ~30 min in AGENTS.md is stale)
./yo-cli test ./tests --exclude tests/internal
#    baseline: 2657 passed / 0 failed

# 2. Stage-1, then tier-1 gates: 20-file battery + hollow detection + corpus + check ./std
node --expose-gc --max-old-space-size=8192 ./out/cjs/yo-cli.cjs \
     compile yo-self/main.yo --release -o /tmp/yo-stage1
S1=/tmp/yo-stage1 P=hand bash scripts/bootstrap/gates_fast.sh
#    baseline: every battery file rc=0 hollow=0; corpus PASS 155 DIFF 0 SELF-FAIL 0
#              TS-FAIL 0 BOTH-FAIL 0; STD 153/153; failures=0

# 3. Fixpoint (stage-2 emit + clang + stage-3 emit + byte compare), ~20 min
S1=/tmp/yo-stage1 P=hand bash scripts/bootstrap/fixpoint_only.sh
#    baseline: STAGE2_RC=0, stage2 hollow=0, CLANG_RC=0, STAGE3_RC=0, FIXPOINT_HOLDS

# 4. Evaluator type-check of the port
./yo-cli check ./yo-self     # baseline 237/237   (238 before control_fn_registry.yo was deleted)
./yo-cli check ./std         # baseline 153/153

# 5. The self-hosted differential over all 58 internal tests, ~40 min
YO_MAIN_STACK_MB=4096 /tmp/yo-stage1 test ./tests/internal --parallel 1
#    baseline: 826 passed / 826 total
```

**One file and one compiler at a time** for `tests/internal`. `macro_expansion` alone needs
~6.5 GB, so two concurrent children on a 16 GB machine swap, and the swapping trips the
runner's own 600 s evaluator deadline — manufacturing failures that do not reproduce in
isolation.

---

## 5. Traps specific to this area

- **`rc(x)` is the leak gate, not sanitizers.** macOS has no LeakSanitizer, and `leaks
--atExit` reports 0 for real leaks at `-O2` because LLVM deletes a malloc whose result is
  discarded. Two probes were nearly built on false negatives this session.
- **Always confirm a leaked allocation's stack matches the bug you are chasing.** A 48-byte
  "reproduction" turned out to be allocated in `__yo_user_main` — a different leak entirely
  (a handler's `unwind(())` exiting `main` without dropping its locals).
- **`___drop`/`___dispose` are `always_inline`.** A bad drop names the _enclosing_ function
  in a stack trace with no drop frame. Absence of a drop frame is not evidence that no drop
  was involved.
- **Do arithmetic on ASan's `pc`/`sp` across runs before reaching for sanitizers.** Constant
  low bits of `pc` across different ASLR bases plus a constant `pc - sp` means a _specific
  stack slot's address is being called_ — far narrower than "wild jump".
- **`tests/internal/parser.test.yo` rebuilds in 11 s** (it imports only
  lexer/token/parser/expr, not the evaluator). Fast loop for parser/codegen work.
- **Emitted-C invariant checks make a deterministic, platform-independent gate** where a
  `.yo` test cannot fail locally. Script the invariant, report before/after counts.
- **`gh run download <id> -n bootstrap-self-test-logs`** names a failing tier-1 test in one
  command. `gh api repos/<o>/<r>/actions/jobs/<id>/logs` works per-job once that JOB
  finishes; `gh run view --log-failed` needs the whole RUN complete.
- **A green `check` is not a passing test.** `check` never evaluates function bodies deeply,
  which is why a probe placed in `mergeAndCheckEnvs` looked inert under `check` and had to be
  re-run under a real `compile`.
- **`status` is read-only in some shells** — the CI loop uses `rc_all`.
