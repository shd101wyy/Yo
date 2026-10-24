# VBD lookahead: the v0.2.70 and v0.2.71 work, PR by PR (2026-10-23)

> **Status:** Lookahead plan, 2026-10-23: implementation-ready breakdowns for v0.2.70 and v0.2.71;
> plans/VALUES_BY_DEFAULT.md stays authoritative. `VBD_RELEASE_SCHEDULE.md` stays the schedule.
> Where this doc recommends something that changes a schedule row or a decided pick, the
> recommendation is marked **amendment**. An amendment takes effect only once the maintainer
> adds a dated row to the schedule's §5.
>
> **Base:** develop `ef153b749`. `SEED_VERSION` is v0.2.68, and v0.2.69 has not been cut yet.
>
> **Method:** light only, with no heavy-lock slot. Counts come from `git grep` on develop.
> Probes were `yo check`, `yo fix --dry-run` and `yo compile` of single files under 30 lines, run
> with the installed v0.2.68 seed against develop's std (§8).
>
> **Sources:** four breakdowns (B4; B6+B7; B8–B11; v0.2.71) and a critic's review of them. Each
> critic claim was re-checked; §9 lists what held and what did not. Line numbers are develop's at
> `ef153b749` and go stale as the tree moves, so re-grep before editing.

## 0. Where things stand

**On develop (since the schedule's v0.2.69 row):**

- B3 (#1553) and B5 (#1551).
- `RefCell.take`/`replace`/`replace_with`/`into_inner` (#1554).
- The derive early-return S1 (#1557).
- W1 `--cycle-collector` (#1536) and W2 `Arc` without `Acyclic` (#1534).
- The explicit-copy migration fixes (#1537).
- The async aliased-argument S1 (#1538).

**On branches, not merged** (ahead-of-develop commit counts in parentheses):

| Branch | What it carries | State |
| --- | --- | --- |
| `feat/v2b-b1-regeneration-2` at `a2314fbad` | B1 step 1: `Token.input`/`module_path` share an `Rc` cell (`5a9f6071c`…`0445fcffb`; about 40 files in `src/evaluator`, `env.yo` and `lexer.yo`, about 260 lines). The regeneration `f08b97e7e` (632 `.clone()` insertions, none in the hot paths). The listing `plans/handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-23.md` (1,959 listed sites). | **GO**, no PR open |
| `perf/share-token-input` (14) | B1 step 1 on its own | folded into the B1 branch |
| `fix/compile-time-cond-borrowed-handle-dup` (9) | C1, the compile-time `cond` collapse S1 | PR body drafted |
| `fix/b8bug-rawview-generic` (3) | C2 | WIP |
| `fix/b8bug-newtype-pattern` (3) | C3 | WIP |
| `fix/b8bug-returning-arm` (2) | C4 | done, not opened |
| `feat/z11-debug-allocator` (7, 36 files) | Z11 `--allocator debug` and `yo test --allocator debug` | in progress |
| `feat/yo-cell-primitive-gen-a` (2, 12 files) | `__yo_cell`/`__yo_atomic_cell` Generation A | WIP |
| `probe/v2b-b8-flip-census` (11) | the B8 flip probe | never merged |

## 1. The recommended decisions in one table

The detail and the alternatives are in §7. "Amendment" means the maintainer must add a dated row to the schedule's §5 first.

| # | Question | Recommendation | Amendment? |
| --- | --- | --- | --- |
| D1 | How the 82 copies that B5's `with_mut` captures force are spelled | `RefCell.with_mut` takes `sink(body) : Impl(FnOnce(v : &mut T) -> R)`. The 82 sites list their captures (`{ k, v }(m) => m.insert(k, v)`). The explicit-copy tool learns that an `FnOnce` body moves a listed capture. Not `take`/`replace`. | No: it keeps §5 decision 3's `with`/`with_mut` spelling |
| D2 | Where decision 19's `take`/`replace`/`swap` live, and who owns them | A new module `std/mem.yo` (Rust's `std::mem`), not the prelude. ONE PR, B6-0, the first piece of B6. | New file: needs the maintainer's OK |
| D3 | The order of B1 and the tool fixes | Merge B1 as measured (GO at `a2314fbad`). Then land B4-0a (the S3 key fix) and B4-0b (D1). Never the other way round. | No |
| D4 | Where the B4 evaluator PRs start from | Stacked on B1's branch, with their dry runs taken on B1's head. Not on develop. | No |
| D5 | B4's granularity | 8 PRs: rest ×2, codegen ×1, evaluator ×5, each ≤ ~260 sites. | No (the plan caps a PR at ~250 sites) |
| D6 | The `.FnCall(_, _, a, _, _) => a` arms (about 290) | Read `a` inside the arm where it is only read. `.clone()` only where it is stored. Keep `fargs` shared in `AstExpr`'s `Clone` (`src/expr.yo:441`). | No |
| D7 | B7's read walk `for(&xs, …)` | Split it out as B7a and land it before the v0.2.69 cut, so that the v0.2.69 seed carries the rewrite. | **Yes** (the schedule has B7 after B6, all in v0.2.70) |
| D8 | Which compiler fixes must be in the v0.2.69 seed | MUST: C1, plus the two 2026-10-23 S1s if their shapes occur in std or src. SHOULD: C2, C3, C4, C7 and B7a. Any release: C6, which is downgraded (§9), C8 to C11. | No |
| D9 | Decision 47 locals Generation B | Pull the **std half only** into v0.2.70, before B8. src, docs and `markdown_yo` stay at v0.2.72. | **Yes** (§5 decision 2) |
| D10 | String interpolation after B8 | B8 itself appends a `String` part by borrow (`src/parser.yo` ~:545), as the plan says. Not a follow-up. | No (it restores the plan) |
| D11 | B9–B11 if the window is short | They may ride the v0.2.71 cut, so v0.2.70 is never held for them. B8 alone completes `String`/`ArrayList`. | **Yes** (a schedule row move) |
| D12 | The v0.2.71 Generation A halves (`__yo_cell`, B12, allocator v2) | Merge each once it is gated, even inside the v0.2.70 window. If v0.2.70 carries them, the v0.2.71 forced cut loses its risk. | No (schedule rule: "Independent Generation A pieces may share a release") |
| D13 | V2c and `Rc.clone` | In ONE PR: `Rc(T)`'s `Clone` becomes an unbounded handle copy, `Arc(T)` gains `Clone`, and the 8 hand-written handle-copy impls in `src/types/definitions.yo` go. V2c merges after B6 and B7, because it reuses `cloned-accessors` for counted handles. | No |
| D14 | The sized `free` for allocator-placed `Rc` cells | Store size and alignment in the owner prefix of allocator-placed blocks. Every cell free path is generic today. | **Yes** (the plan says 16 B per block) |
| D15 | The order of `Weak` (W3) and V2c | Keep the schedule: W3 after V2c. If V2c is not merged by the middle of the window, W3 may go first. | Only if taken |

## 2. Tier 1, as used in this doc

Each PR's gate below is the AGENTS.md Tier 1. It has these parts:

- `yo build --std-path ./std`, when `src/` changes.
- `yo check ./src` and `yo check ./std`, with the tree binary and `--std-path ./std`.
- The named test files, one per `yo test` call.
- At most 8 `tests/internal` files. More than 8 means one in-process run under `exclusive`.
- `scripts/cli-diff-test.sh`, when std, CLI output, diagnostics, skills or a `yo fix` mode changes. Read each GOLDEN-DIFF before `--record`.
- An emit-diff of `src/main.yo` C, base against head, when codegen changes.
- Tree-binary `fmt --check` and `scripts/check-issue-refs.sh`.

Anything else a PR asks for is labelled **extra**: the fixpoint, an ABBA timing, or a heavy dry run.

**"Seed: none"** means the seed builds stage 1 from the PR unchanged. **"Generation A"** means std and src may use the feature only once `SEED_VERSION` carries the PR.

## 3. Before the v0.2.69 cut: what the seed must carry

CI's stage 1 is the seed compiling the tree's std and src. B8–B11 run on the v0.2.69 seed, so any seed miscompile or false error that the flipped std or src hits must be fixed in v0.2.69. Each row below is one PR, and each can start now.

| # | Issue | Fix site | Branch | Verdict | Tier 1 |
| --- | --- | --- | --- | --- | --- |
| C1 | `issues/fixed/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md` (S1, use-after-free) | `src/codegen/exprs/cond.yo:630` `generate_cond_expression`: the `can_opt` collapse must apply the arm's deferred `___dup`s, as `_emit_value_arm` does | `fix/compile-time-cond-borrowed-handle-dup` | **MUST**. B6's natural `cond(Type.impls(T, Copy) => …)` accessor shape hits it. | build; check; the repro test; `tests/copy_trait.test.yo`; `tests/cond_return_in_string_literal.test.yo`; emit-diff plus an over-cancellation canary (dup/drop family) |
| S1a | `issues/fixed/2026-10-23-a-match-whose-other-arm-breaks-drops-the-moved-local-again-after-the-match.md` (double free) | codegen drop emission after a `match` with a `break` arm | none | **MUST if** a grep of std and src finds the shape: a by-value move in one arm of a `match` inside a loop whose other arm breaks. After B8, every `String` or list local becomes a candidate. | build; the issue's repro as a test; `tests/match_*.test.yo`; `tests/continue_rc_cleanup.test.yo`; emit-diff |
| S1b | `issues/fixed/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.md` (use-after-free) | evaluator: keep the auto-deref'd receiver's cell alive across the call (the issue doc's fix) | none | **MUST if** std or src calls a `&Self` method with a closure argument through an `Rc` auto-deref, and the closure can drop that `Rc`. `RefCell.replace_with` is the found instance. | build; check; repro; `tests/rc_cell.test.yo`; `tests/deref_auto.test.yo` |
| C2 | `issues/fixed/2026-10-22-the-raw-view-gate-rejects-a-generic-buffer-owning-value-parameter.md` | the evaluator's raw-view owner exemption | `fix/b8bug-rawview-generic` | SHOULD. Workaround: `pragma(Pragma.AllowUnsafe)` on `std/rand.yo`. | build; check; the new test; the raw-view tests |
| C3 | `issues/fixed/2026-10-22-a-struct-pattern-on-a-newtype-emits-a-field-access-the-c-type-does-not-have.md` | codegen pattern binding | `fix/b8bug-newtype-pattern` | SHOULD. Otherwise `String.into_bytes` clones, O(n) per call. | build; the branch tests; `tests/match_*.test.yo`; emit-diff |
| C4 | `issues/fixed/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.md` | evaluator move tracking | `fix/b8bug-returning-arm` | SHOULD. Without it, 9 false positives in std need `.clone()`. | build; check; `tests/move_only.test.yo`; `tests/match_*.test.yo` |
| C7 | `issues/fixed/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.md` (spurious runtime panic) | `function_param_mutation_mask` (`src/evaluator/effects/mutation_summary.yo:3455`): a by-value clone result is fresh storage | none | SHOULD. Fix the evaluator. **Do not** close the issue by rewriting its test to `for(&self.items, …)`, which hides the bug (§9). | build; `tests/for_macro_borrow*.test.yo` (3); internal `effect_analysis.test.yo` |
| B7a | §4.3 | `src/expr.yo`, `std/prelude.yo` | none | SHOULD (D7). Without it, std and src may not write `for(&xs, …)` until `SEED_VERSION` ≥ v0.2.70. | §4.3 |
| C6 | `issues/2026-10-23-a-ref-payload-in-another-variant-makes-a-move-only-match-binding-a-borrow.md` | match binding mode per variant | none | **Any release** (downgraded). src and std contain no `derive(…FromJson)` use, so stage 1 never meets it; the 3 uses are in `tests/encoding/json.test.yo:456/459/510`. | build; repro; `tests/encoding/json.test.yo`; `tests/derive*` |
| C8 | `issues/2026-10-22-a-whole-value-destructuring-binds-move-only-fields-as-borrows.md` | match evaluator, the curly-form unwrap | none | Preferred. Workaround: a `match` struct pattern, once C3 lands. | build; repro; `tests/match_*.test.yo` |
| C9 | `issues/2026-10-22-clone-of-an-anonymous-record-element-copies-the-element-first.md` | evaluator | none | Can slip. Workaround: a named struct in `std/fs/dir.yo`'s `read_dir`. | build; repro |
| C10, C11 | `issues/2026-10-22-a-move-in-one-cond-arm-is-reported-at-the-other-arm.md`, `issues/2026-10-22-a-swallowed-test-body-error-inside-a-while-loop-breaks-the-next-derive.md` (S3) | tree only | none | any release | their tests |

C5, the derive early return, landed as #1557.

Not seed-relevant: the verifier S1 `issues/fixed/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.md` (open when this was written) is fixed by `fix/s1-verifier-frame`, outside this window.

Z11 (`feat/z11-debug-allocator`) needs no seed and may also merge before the v0.2.69 cut. That is better, because W6a then has its oracle one release earlier.

## 4. v0.2.70, PR by PR

### 4.0 The order at a glance

```text
now ─┬─ C1..C9, S1a/S1b, B7a ............................ → v0.2.69 seed
     ├─ B6-0 std/mem ─┬─ B6-a ─┬─ B6-b ── B6-c(std,tests)
     │                │        ├─ B7b (stacked draft)
     │                │        └─ B7c (stacked draft)
     ├─ P1 channel move-out, P3 OrderedMap/TOML, P4 decision 28 (P6: LinkedList removed instead)
     ├─ P5 decision 47 std (if D9 is accepted)
     ├─ V3a/b/c drafts; Z11; v0.2.71 Generation A drafts (§5, D12)
B1 merges ── B4-0a ── B4-0b ── B4-1a/1b/2/3a..3e (3a..3e stacked on B1 now)
                                   └── last B4 ── B6-c(src half)
B4 + B6 + B7 merged, v0.2.69 seed released ── B8 ── B9 ── B10
                                               └──── B11
```

### 4.1 B4: the `src/` hand edits (1,959 sites listed, 1,111 of them in `src/evaluator`)

**The listing.** `plans/handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-23.md` is on `origin/feat/v2b-b1-regeneration-2` only. Its positions are from base `412258a2a`. Re-run the dry run on each PR's base before editing.

**Sites by reason**, measured from the listing. Most are a judgment call; about 25 % are mechanical.

| Reason (tool text) | Total | evaluator | codegen | rest (`env`+`lexer`) | Default edit |
| --- | ---: | ---: | ---: | ---: | --- |
| source written afterwards | 521 | 198 | 98 | 225 (17) | by sub-pattern, below |
| returned from a borrowed binding | 465 | 277 | 108 | 80 (6) | by shape, below |
| hot path: field-store | 247 | 236 | 0 | 11 (11) | borrow, share or move first; `.clone()` last |
| raw pointer taken | 216 | 74 | 4 | 138 (3) | 133 sit in files that take no pointer, a symptom of the S3 key collision (B4-0a). The real ones are `main.yo` argv (17), `verifier/z3.yo` and `diagnostics_registry`. |
| returned from a `&`/`&mut` param | 127 | 18 | 51 | 58 (4) | a `-> &T` projection if callers only read; `.clone()` if they keep the value |
| field of a dying temporary | 115 | 67 | 22 | 26 | 104 are `ast_expr_token(&e).value`: see D16 |
| hot path: return / param / binding / assign | 99 / 81 / 46 / 17 | 98 / 73 / 46 / 17 | 0 | 1 / 8 / 0 / 0 | 51 of the param sites are B5 captures (B4-0b) |
| copy written afterwards | 9 | 5 | 0 | 4 (4) | a `&mut` borrow of the chosen list (`env.yo` `target_list := if(...)`) |
| returned from a module-level binding | 7 | 2 | 0 | 5 | `.clone()` |
| source does not print back | 5 | 0 | 3 | 2 | spell `x.*.items.clone()` by hand |
| inside a `Clone` impl | 4 | 0 | 0 | 4 | `pattern.yo:103/112/113` take `.clone()`; `expr.yo:441` `fargs` stays shared (D6) |
| **Total** | **1,959** | **1,111** | **286** | **562** | |

**"Source written afterwards" splits into four sub-patterns:**

- **Parameter-rooted copies**, about 380 of the 521. This is where the S3 key collision lives. For example, `register_executable`/`register_static_library`/`register_shared_library` (`src/evaluator/builtins/build.yo:248/279/310`) have 18 sites each, and their `artifact : &BuildArtifact` is never written.
- **Save/restore snapshots**, `prev := context.x; …; context.x = prev`. src has 261 snapshot lines, of which only the non-Copy ones are listed. They use D2's `replace` (B6-0) or `.clone()`.
- **Push or insert of a local that is changed later.**
- **Genuine aliasing.** These become `&mut` or `Rc(RefCell(...))`.

**The functions with the most sites:**

| Function | Location | Sites |
| --- | --- | ---: |
| `_evaluate_function_call_unanchored` | `src/evaluator/calls/function.yo:7236` | 44 |
| `evaluate_property_access` | `src/evaluator/exprs/property_access.yo:434` | 34 |
| `evaluate_module_value` | `src/evaluator/values/impl.yo:4737` | 33 |
| `_synthesize_types_impl` | `src/evaluator/types/synthesizer.yo:902` | 32 |
| `create_specialized_function_inline` | `src/evaluator/calls/helper.yo:2878` | 26 |
| `try_to_call_function_with_arguments` | `src/evaluator/calls/helper.yo:6796` | 20 |
| `generate_other_function_call` | `src/codegen/exprs/other_fn_call.yo:1247` | 19 |

**Shapes in the return classes:**

- 221 listed `match(e, .FnCall(_, _, a, _, _) => a, …)` returns. src has about 290 arms of this form; greps give 288–293, depending on how the binder is matched. See D6.
- 111 `TypeValue` variant payloads, plus 34 `Rc(.Struct({ id : sid })) => sid` Strings.
- 92 `.Some(x) => x`. Of these, 41 match a `.get(…)` and 11 a `G.with(m => m.get(k))`; both groups are deferred to B6-c.

#### B4-0a: the S3 "every parameter of a module has one key" tool defect

- **Issue:** `issues/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.md`.
- **Files and functions:**
  - `src/evaluator/utils.yo`: `_ic_decl_key` :2698, `record_copy_write` :2745, `record_copy_pointer` :2778.
  - `src/evaluator/calls/function_type.yo`: `_build_def_time_body_env` :655. Its `synthetic_token(&pn, …)` at :981 gives every parameter offset 0.
  - `src/env.yo:508`: `synthetic_token`.
  - `src/main.yo`: `_copy_written_after` :2829 and `_decl_written_after` :2857.
- **Fix:** key a parameter by (fn literal id, parameter index), or by its real declaration token.
- **Test:** a new cli-case, `fix-migrate-explicit-copy-param-key`, built from `issues/repros/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.yo`. The issue then moves to `fixed/`.
- **Seed:** none.
- **Gate:**
  - build; check; the 13 `tests/cli-cases/fix-migrate-explicit-copy*` cases plus the new one.
  - **Extra:** one dry run, `yo fix ./src --migrate explicit-copy --dry-run --hot-path src/evaluator --hot-path src/lexer.yo --hot-path src/env.yo --std-path ./std` (7–11 min, 1.5 GB, one normal slot). Record the new counts. The raw-pointer and written-after counts outside the hot paths should fall by an estimated 250–300.
- **Order:** after B1 merges (D3).

#### B4-0b: D1 for the B5 capture copies

**The sites.** They are on develop now: 31 lines (37 `.clone()` tokens) that B1's regeneration inserts, plus 51 listed hot param sites.

- **Inserted:**
  - `src/expr_info.yo`: 1087, 1475, 1765, 1939, 2098, 2164, 2175, 3034, 3084, 3118, 3147, 3178, 3209, 3236, 3268, 3317.
  - `src/input_record.yo`: 111, 163, 264.
  - `src/types/`: `compatibility.yo:244`, `creators.yo:937`, `type_key.yo:101/491/946`, `utils.yo:947`.
  - `src/utils.yo:326/966`, `src/verifier/vc.yo:250/435`, `src/codegen/async/state_machine.yo:638`, `src/codegen/utils/index.yo:817`.
- **Listed:**
  - `src/evaluator/values/type_trait_methods.yo`: 240, 283, 382, 442×2, 675, 700, 766, 811×2.
  - `src/evaluator/types/function.yo`: 185, 363, 512, 585, 741, 748, 769, 776.
  - `src/evaluator/values/impl.yo`: 403, 490, 492, 2603, 6239.
  - `src/evaluator/context.yo`: 1313, 1490, 2460, 2473.
  - `src/evaluator/effects/mutation_summary.yo`: 3854, 3909, 3963×2.
  - `src/evaluator/trait_checking.yo`: 172, 1103, 1904.
  - `src/evaluator/module_loader.yo`: 75, 167, 219.
  - `src/evaluator/utils.yo`: 2239, 2288, 2686.
  - `src/evaluator/exprs/c_include.yo`: 85, 91.
  - `src/evaluator/values/anonymous_function.yo`: 456, 470.
  - `src/evaluator/builtins/derive.yo:71`, `src/evaluator/builtins/derive_rule.yo:156`, `src/evaluator/calls/function_type.yo:276`, `src/evaluator/utils/closure.yo:411`.
  - `src/env.yo:2913`×2, and the `g_synthetic_token_cache` insert.

**The change, three parts in one PR:**

1. `std/sync/refcell.yo:117`: `with_mut`'s `body : &Impl(Fn(v : &mut T) -> R)` becomes `sink(body) : Impl(FnOnce(v : &mut T) -> R)`. `with` stays `&Impl(Fn(...))`, since it only reads.
2. The explicit-copy tool: a capture named in a by-value capture list, and used at its last use in an `FnOnce` body, is a move, not a copy. Today the tool asks for `.clone()` there (probe P-B, §8).
3. The 82 sites list their captures:

   ```yo ignore
   _ := G.with_mut({ k, v }(m) => m.insert(k, v));
   ```

   The 1,096 other `with_mut` calls in src, std and tests pass lambda literals: none passes a named closure. They need no edit.

**Seed:** none. The v0.2.68 seed checks, compiles and runs an `FnOnce` `sink` parameter whose body moves a move-only capture (probe P-B).

**Gate:**

- build; check.
- Tests: `tests/rc_cell.test.yo`, `tests/global_lend.test.yo`, `tests/fn_once.test.yo`, `tests/closure*.test.yo`. The `refcell-*` cli-cases.
- Internal (8): `expr_info`, `input_record`, `type_key`, `types_utils`, `type_trait_methods`, `context`, `verifier`, `module_invalidation`.
- Emit-diff: `with_mut` callers now pass the closure by value. Expect only call-shape changes.
- **Extra:** ABBA `check src/main.yo` and `check std/rand.yo` against base, capped at 12 GB. Bar: RSS ≤ 1.02x, user time within noise.
- If the ABBA bar fails, fall back to `.clone()` per site, the tool's default. Never use the `take`/`replace` window (D1).

#### B4-0c (dropped)

The breakdown's prelude `take`/`replace`/`swap` is now B6-0 (§4.2, D2). It is one PR, not three.

#### The directory PRs

Each PR:

- re-runs the dry run restricted to its directory on its own base;
- applies `yo fix` where the tool inserts;
- hand-edits the listed sites;
- records each deferred site with its reason in the plan's "B4 as built", as B3 recorded its 30.

All of them are **Seed: none**. They use only `.clone()`, `&`, `&mut`, `-> &T` projections, `std/mem` and `RefCell` methods.

| PR | Scope | Sites | Starts | Internal files (≤ 8) |
| --- | --- | ---: | --- | --- |
| B4-1a, the CLI and build files | `src/*.yo`, except `env`, `lexer`, `expr_info`, `parser`, `expr`, `formatter` (`main` 61, `build_runner` 47, `error` 17, `module_manager` 12, `diagnostics_registry` 11, …) | ~290 before B4-0a | after B1 merges | `compile`, `build_runner`, `diagnostics_registry`, `diagnostics_registry_examples`, `error`, `install_command`, `check_watch`, `lsp_protocol` |
| B4-1b, the AST, types, verifier, doc and lsp files | `env.yo` 43 (hot), `lexer.yo` (hot), `expr_info.yo` 53, `pattern.yo`, `expr.yo` `Clone` (D6), `types/` 74, `verifier/` 50, `doc/` 29, `lsp/` 10. Also the V2a identity tests `env.yo:3052` and `expr_info.yo:1521`, and the `ArrayList` identity accessors `input_record.yo:267` (`env_reads`) and `expr_info.yo:2600` (`get_module_level_init_exprs`) | ~280 | after B1 merges | `env`, `env_lookup`, `expr_info`, `lexer`, `types_compound`, `type_key`, `verifier`, `doc_stability` |
| B4-2, codegen | `exprs` 198, `functions` 35, `utils` 27, `async` 23, other 3 | 286 | after B1 merges (B1 inserts 122 clones here) | `gc_runtime_atomics`, `match_binding_shadow`, `main_wrapper_console_cp`, `state_machine_naming`, `chunk_assembly`, `line_directives`, `compile`; **emit-diff** |
| B4-3a | `evaluator/calls` | 213 | now, stacked on B1 (D4) | `ast_reflection`, `macro_helpers`, `module_invalidation`, `quote_macro_eval` (`macro_expansion` was deleted 2026-10-24) |
| B4-3b | `evaluator/builtins`, `ctfe`, `async`, `shared` | 234 | now, stacked on B1 | `build_runner`, `verifier_strip`, `verifier_assumed`, `verifier_contract_splice`, `macro_helpers`, `await_analysis`, `suspension_analysis` |
| B4-3c | `evaluator/values`, `evaluator/utils` | 196 | now, stacked on B1 | `type_trait_methods`, `module_invalidation`, `check_watch`, `ast_reflection` |
| B4-3d | `evaluator/types`, `evaluator/effects`, and the `TypeValue.SomeT`/`TraitT` constraint lists written in place | 209 | now, stacked on B1 | `synthesizer`, `effect_analysis`, `effect_analysis_types`, `module_invalidation` (`macro_registry` was deleted 2026-10-24) |
| B4-3e | `evaluator/exprs` and `evaluator/*.yo`. This includes the unlisted V2a blockers: `copy_eval_context` (`context.yo:1869`) per D17, the comptime-place model, and `module_loader`'s cached arrays | 259 | now, stacked on B1 | `assignment`, `binding`, `initialization_assignment`, `identifier_and_operator`, `runtime`, `unwind`, `context`, `recursive_enum` |

`codegen_read_keys` (`expr_info.yo:1604`) returns a `HashSet` and belongs to B9, not B4 (§9 item 17).

**The gate shared by every B4 PR:**

- build; check src and std; fmt; refs.
- **Completeness:** the directory dry run lists only sites that are deferred with a reason.
- **Behaviour:** compile a fixed corpus to C with the base and head stage-1 binaries, under one pinned std, and require byte-identical C. The corpus is the copy-sensitive files below plus `src/main.yo --emit-c --skip-c-compiler`. This catches a `.clone()` that broke intended sharing, which `check` cannot see.
- **Copy-sensitive tests**, one per call: `rc`, `rc_binding_gives_way`, `rc_cell`, `tests/string/*`, `closure*`, `async_await`, `type_soundness`, `tests/collections/array_list.test.yo`, `tests/collections/hash_map.test.yo`, `global_lend`.
- **For the evaluator PRs and B4-1b:** ABBA `check src/main.yo` and `check std/rand.yo`. Bar: RSS ≤ 1.02x, user time ≤ 1.05x.
- **Extra:** the fixpoint, once, on the last evaluator PR. The plan's B4 says "fixpoint recommended for the evaluator PR"; Tier 1 does not require it.

**B4's exit check.** Re-run the B8 flip probe over `src/` on B4's tip. It last stopped at the B5 wall, so this run gives the first real `src/` frontier. B8's entry check is "no B4-class residual".

### 4.2 B6: decision 20's accessors

**Already there:**

- Caller attribution for an E0901 raised in std: `_reported_at_user_call` (`src/evaluator/calls/function.yo:6844`, called at :7009, note text at :6838). A probe confirms that `ArrayList(Box(String)).get(i)` reports at the caller.
- One limit: only the first caller of an instantiation is reported. Census tools must therefore record at the call site, not from E0901s.

**Measured:**

| Item | src | std | tests |
| --- | ---: | ---: | ---: |
| Accessor calls | 7,328 | 242 | 1,111 |
| of which `.get(` | 7,125 | 214 | 1,012 |
| `.unwrap()` | 308 | 234 | 1,811 |
| `.unwrap_or(` | 103 | 15 | 71 |
| `.unwrap_or(&` | 53 | 0 | 0 |
| `.extend(` | 9 | 4 | 4 |

The accessor calls are `.get(`, `.get_key_value(`, `.get_index(`, `.first()`, `.last()`, `.front()`, `.back()`, `.peek()`, `.first_entry()` and `.last_entry()`.

#### B6-0: `std/mem.yo`, decision 19's `take`, `replace` and `swap` (D2)

- **Can start:** now.
- **Seed:** none.
- **API:**

  ```yo ignore
  replace :: (fn(generic(T : Type), dst : &mut T, v : T) -> T)(...);  // __yo_ptr_read / __yo_ptr_write inside unsafe
  take :: (fn(generic(T : Type), where(T <: Default), dst : &mut T) -> T)(...);
  swap :: (fn(generic(T : Type), a : &mut T, b : &mut T) -> unit)(...);
  ```

  The seed already compiles the same shape in `RefCell._swap` (`std/sync/refcell.yo:187`).
- **Why not the prelude:** a probe shows that a module-level definition or a local that reuses a prelude export's name is an error ("variable shadowing is not allowed"). A prelude `take` would break `src/env.yo:2624` and `src/lsp/signature_help.yo:129` (locals named `take`), `tests/fn.test.yo:6`, `tests/safe_code_structural_gates.test.yo:85`, `tests/origins/model_corpus.test.yo:315` and two cli fixtures, as well as every user program that names something `take`.
- **First users:** `StringBuilder.to_string` (`std/string/string_builder.yo:187`), and B4's save/restore snapshots.
- **Tests:** the new cases go in `tests/move_only.test.yo`: a move-only `T`, `unit` (`refcell.yo` notes that `unit` has no C storage) and a `Box`.
- **Gate:** check std and src; `tests/move_only.test.yo`; `tests/string/string_builder.test.yo`; internal `compile.test.yo`.

#### B6-a: the std accessors

- **Can start:** now.
- **Seed:** none.
- **The 14 `<name>_cloned` siblings**, each with `where(T <: Clone)`, cloning through the slot:
  - ArrayList: `get` :447, `first` :665, `last` :669.
  - Deque: `front` :217, `back` :221, `get` :232.
  - HashMap: `get` :669, `get_key_value` :719.
  - OrderedMap: `get` :203, `get_index` :327.
  - BTreeMap: `get` :91, `first_entry` :169, `last_entry` :176.
  - PriorityQueue: `peek` :65.

  Use runtime `cond` only until C1 is in a seed.
- **Decision 20's non-copying access on the index-addressed lists** (`ArrayList`, `Deque`):
  - `with(i, body : &Impl(Fn(v : &mut T) -> R)) -> R`;
  - `take(i) where(T <: Default)`, which is `mem.take(&mut xs(i))`.

  `swap(i, j)` exists (`array_list.yo:686`). Deque gains it.
- **`get` keeps its body.** The copy is the check (plan decision 4).
- **The unwrap family consumes its receiver.** `Option`/`Result` `unwrap`, `expect`, `unwrap_or_else` and `unwrap_or` take `self : Self` (`std/prelude.yo:8265`, :8273, :8369, :8377, :9156, :9273, :9281, :9289). This fixes `mk().unwrap()` on a move-only payload, which is E0901 today (probed). `or_value : &T → T` waits for B6-c.
- **`extend` splits:** `extend(other : ArrayList(T))` moves, and `extend_cloned(other : &ArrayList(T)) where(T <: Clone)` copies. The 17 call sites are edited by hand.
- **std's own 9 accessor copies** that B3 left read in place or call `_cloned`.
- **Gate:**
  - check std and src with BOTH the seed and a develop-built binary; `yo build --std-path ./std` with the seed.
  - Tests: `tests/collections/*` (one per call), `option_result_combinators`, `comptime_option_result`, `copy_trait`, `move_only`, `move_only_collections`, `collection_clone_through_borrow`, `index`, `derive_clone_complex`.
  - Internal: `compile.test.yo`.
  - cli-diff; `yo verify ./std/collections --format json`; fmt; refs.

#### B6-b: the decision 20 text, N7, and `--migrate cloned-accessors`

- **Can start:** now, in parallel with B6-a. It merges after B6-a.
- **Seed:** none (tree compiler only).
- **The help text.** In `_reported_at_user_call` (`function.yo:6844`): when the re-anchored error is E0901 at a method call `r.m(args)` whose receiver type has an `m_cloned` sibling in the impl registry, the help says "read it in place with `r(i)`, copy it with `r.m_cloned(…)`, or write through it with `r.with(i, …)`". `with` appears only where the receiver has it. The names come from the registry; the compiler keeps no name list.
- **N7.** `g_audit_copying_accessor = debug_knob(\`YO_AUDIT_COPYING_ACCESSOR\`)`, beside `src/evaluator/utils.yo:2577`. It fires per call site in `evaluate_function_call`'s user branch (`function.yo:6976`ff) when the method has a `_cloned` sibling and the payload category satisfies `_ic_category_is_unique_buffer` (`utils.yo:3148`).
- **The migration** in `src/main.yo`:
  - the mode name (:3672), the usage text and the dispatch (near :3796/:3843);
  - `_run_migrate_cloned_accessors`, beside `_run_migrate_explicit_copy` (:2987), reusing its write, flow and tail tables;
  - `--hot-path` allowed for this mode (the guard at :3709).
- **The verifier:** `get_cloned` is modelled like `get` (`src/verifier/vc.yo:4656`).
- **C9:** fix it here, since `get_cloned` on an anonymous record hits it.
- **Gate:**
  - build; check; `yo compile src/main.yo --skip-c-compiler`.
  - New cli-cases: `fix-migrate-cloned-accessors` and `check-accessor-copy-names-get-cloned`.
  - Re-run `std-bound-error-is-reported-at-the-user-call` and `check-derive-clone-container-non-clone-elem`.
  - Internal: `error`, `diagnostics_registry`, `verifier_list_len`, `verifier_spec_collections`, `compile`.
  - `move_only_collections`.
  - **Extra:** one N7 run, `YO_AUDIT_COPYING_ACCESSOR=1 yo check ./src`, recorded in the plan.

#### B6-c: the regeneration (B1's playbook)

- **std and tests half:** after B6-a and B6-b.
- **src half:** after the LAST B4 PR, because a regenerable migration goes last.
- **Hot paths:** run with `--hot-path src/evaluator --hot-path src/lexer.yo --hot-path src/env.yo`. Before the flip, `get_cloned` deep-copies what `get` shares today, which is B1's 80x failure mode (D18).
- **Also here:**
  - `unwrap_or(or_value : T)` and its 53 src `&x` sites.
  - The 41 + 11 `get` sites that B4 deferred.
  - **The `unwrap` count after B8.** Once B8 flips, every `o.unwrap()` on a live `Option(String)` or `Option(ArrayList)` is E0901. That is up to 308/234/1,811 calls in src/std/tests. B6-c's dry run must count them by instantiated payload, and B8's probe must spell them.
- **Gate:**
  - build; check; tree fmt; each touched test file.
  - The internal importers, in-process under `exclusive`.
  - **N5 is required:** `check src/main.yo` max RSS and user time within ±10 % of develop. The v0.2.70 window must allow this timing run.

### 4.3 B7: iteration and entries

**Measured:**

| Item | src | std | tests |
| --- | ---: | ---: | ---: |
| `for(` (word-bounded) | 46 | 37 | 203 |
| `for(&mut` | 15 | 12 | 71 |
| Real `for(&xs, …)` read sites | 1 (`src/evaluator/builtins/comptime_expect_error.yo:287`) | 0 | 8 |
| Value-form loops | 5 (`lsp/server` ×3, `doc/builder`, `suspension_analysis`) | | about 115 |

#### B7a: the read walk `for(&xs, …)` (D7)

- **Can start:** now. Target: before the v0.2.69 cut.
- **`src/expr.yo`:**
  - The `for` clause of `_borrow_spelling_rewrite` (:1726–1738) drops the `&` today. It now rewrites the read form to `for(xs, __yo_imm(x) => …)` and the map form to `(k, __yo_imm(v))`.
  - Add `_bs_imm_for_handle`, mirroring `_bs_mut_for_handle` (:1542).
  - Update the comment table at :1326.
- **`std/prelude.yo`:**
  - `BorrowedWalk` (:10339) splits into a read trait (`WalkCursor`, `WalkElem`, `walk_start`, `walk_valid`, `walk_next`, and a new `walk_ref(self : &Self, cur) -> &Self.WalkElem`) and `BorrowedWalkMut` (`walk_elem` alone, `where(Self <: BorrowedWalk)`). A seed probe confirmed that a supertrait associated type in a method signature checks, compiles and runs.
  - Add the `is_imm_form` arm and a map read arm to `for` (:10621).
  - In both map arms, bind the key as `k := &entry.key`. Today it is the copy `k := entry.key` (:10752), which is E0901 for `String` keys after B8.
- **std:** add `walk_ref` to the 5 impls (`array_list.yo:1275`, `btree_map.yo:273`, `deque.yo:391`, `hash_map.yo:1234`, `ordered_map.yo:547`), plus read-only impls for `HashSet` and `PriorityQueue`. No impl for `String` or `Array` (D19).
- **The one src site** (`comptime_expect_error.yo:287`) becomes `for(saved_observed_msgs.indices(), i => …)`, which every seed accepts.
- **The verifier:** `_for_term` (`src/verifier/vc.yo:3252`) learns the `walk_ref` expansion. It uses the same index model.
- **Tests:**
  - `tests/internal/parser.test.yo:1044` (expected form); `tests/borrow_spelling.test.yo:212`.
  - New cases in `tests/for_macro_borrow.test.yo`:
    - the body reads `xs`;
    - a body write is E0911;
    - the map read form;
    - a `HashSet` walk;
    - `for(&mut set, …)` stays an error.
  - `tests/for_macro_borrow_user_collection.test.yo` (the user impl splits).
- **Docs:** `docs/{en-US,zh-CN}/DESIGN.md` (the `for` section), `MEMORY_SAFETY.md`, and the skills cheatsheets. The cheatsheets move 7 cli goldens.
- **Seed: Generation A for std and src.**
  - The v0.2.68/0.2.69 seeds parse `for(&xs…)` as the value form, which copies through `into_iter`. That is harmless before the flip, and wrong after it.
  - So std and src may write `for(&xs…)` only once `SEED_VERSION` carries B7a.
  - Tests may use it at once, except the files that a workflow runs with the seed. Grep `.github/workflows/` (#1440's lesson).
- **Gate:**
  - build; check.
  - Tests: `borrow_spelling`, `for_macro_borrow`, `for_macro_borrow_strict`, `for_macro_borrow_user_collection`, `global_lend`, `move_only`, `tests/collections/*` (9 files, one per call), `iterator_combinators`.
  - Internal: `parser`, `formatter`, `compile`, `macro_helpers`.
  - cli-diff; `yo verify ./tests/spec/fixtures/valid`; fmt; refs.
  - No emit-diff: codegen is unchanged.

#### B7b: consuming iteration

- **Can start:** now, as a draft stacked on B6-a. It merges after B6-a.
- **Seed:** none.
- **`IntoIterator.into_iter`** (`std/prelude.yo:10313`) takes `self : Self`. So does every impl:
  - `into_iter` on ArrayList :1185, BTreeMap :219, Deque :332, HashMap :1146, HashSet :418, OrderedMap :516, PriorityQueue :183, String :2293, `_ArrayIter` (`prelude.yo:10445`);
  - the 7 `SharedList` impls (`src/types/definitions.yo:91–211`).
- **`chars`/`bytes`/`char_indices`/`lines`/`keys`/`values`/`chunks`/`windows` consume their receiver** (D20).
- **The `*Ptr` `iter()`s** (ArrayList :1260, BTreeMap :263, Deque :375, HashMap :1203, HashSet :453, OrderedMap :536, PriorityQueue :228) hold a raw buffer pointer and a length, not the container. They stay under `pragma(Pragma.AllowUnsafe)`.
- **The iterators keep copying elements out until each container flips** (D21, an "as built" deviation from the plan's move-out).
- **Sweep:**
  - Tests: a value `for(xs, …)` whose source is used afterwards becomes `for(&xs, …)`. Teach the explicit-copy migration a `for`-source path that rewrites to `&`. First check that the dry run records those copies at all (`binding(macro)` is excluded today).
  - src: 5 value loops plus 3 `.iter()` users (`check_watch.yo:161`, `module_manager.yo:1708`, `suspension_analysis.yo:669`), edited by hand with seed-safe spellings.
- **Optional:** fold in `issues/blanket-into-iter-is-not-an-intoiterator-impl.md` if a probe shows that the real blanket impl now type-checks.
- **Gate:**
  - build; check.
  - Tests: `iterator_combinators`, `iter_filter_closure`, `for_macro_borrow*`, `tests/collections/*`, `tests/string/*` (8 files), `async_await`.
  - Internal: `compile`, `suspension_analysis`, `check_watch`, `module_invalidation`, `types_value`.
  - cli-diff. The seven `inout-*` panic cases keep their panic until B8.
  - `yo verify` on `tests/spec/fixtures/{valid,negative}/for_produced*.yo`; docs in both languages.
- **Closes:** `issues/collection-iterators-have-no-sound-post-v2b-shape.md`, together with B7a and B7c.

#### B7c: the `HashMapEntry` with-shape (D22)

- **Can start:** now, as a draft stacked on B6-a. It merges after B6-a.
- **Seed:** none.
- **The signature:** `entry(self : &mut Self, key : K, body : Impl(FnOnce(e : &mut HashMapEntry(K, V)) -> R)) -> R`.
- **The entry type:** it holds `_map : *HashMap(K, V)` (std `AllowUnsafe`) instead of the map (`hash_map.yo:1023`).
  - `or_insert` and `or_insert_with` return `&mut V`, and `and_modify` returns `unit`.
  - `get_or_insert*` and `update_with` (:941–951) go through the entry.
- **Call sites:** 3 in std, 18 in `tests/collections/hash_map.test.yo:744–837`, and 1 in `move_only_collections.test.yo:136`.
- **Gate:**
  - check std and src;
  - `hash_map`, `hash_set`, `ordered_map` and `move_only_collections`;
  - cli-diff.

### 4.4 The prerequisites the flips need (P-series; std or tree-only, no seed gate)

| PR | What | Files | Can start | Gate |
| --- | --- | --- | --- | --- |
| P1 | `Thread(T).join()` and `Channel(T)` accept a move-only `T`. Today `Thread(V).join()` with a move-only `V` is E0901 at `std/sync/channel.yo:318` (probed). After B8 the same happens for `Thread(String)`. File the S2 issue first. | `std/sync/channel.yo:237/263–265/291/317–319/376`: move out with `__yo_ptr_read`, store with `__yo_ptr_write`, drop with `drop_in_place` | now | check std; `tests/thread.test.yo` (the new move-only rows), `tests/send_sync.test.yo`, `tests/thread_safety.test.yo`; internal `async_thread_exit_release` |
| P3 | `OrderedMap`'s position index and TOML's `_Parser.cur` stop writing through a copy. `_index_add` (`std/collections/ordered_map.yo:154–165`) pushes onto a list that it got from `self._index.get(&h)`, which is lost once `ArrayList` flips at B8 even though `HashMap` is still `ref`. TOML's `cur : root` alias is at `std/encoding/toml.yo:425–466`. | `_index_add`/`_index_drop`/`_index_bump` write through a projection or remove-edit-insert; `_Parser.cur` becomes a path that is re-resolved from `root` | now | `tests/collections/ordered_map.test.yo`, `tests/encoding/toml.test.yo`; cli-case `inout-for-nested-storage-insert-panics`; internal `toml_edit`, `manifest` |
| P4 | Decision 28's value-root rule: a `&mut` argument that overlaps another argument rooted at the same value local is E0910 (`s.push_string(&s)`) | the tree evaluator; `tests/string/string.test.yo`'s self-push test becomes a `comptime_expect_error` | now | build; check (the tree must not contain the overlap); `tests/string/string.test.yo`, `tests/parameter_modes.test.yo`, `tests/local_borrows.test.yo`; cli-diff if a diagnostic moves |
| P5 | Decision 47 locals Generation B, **std only** (D9, amendment) | `yo fix ./std --migrate mut-bindings` with the tree binary. The census lists 1,067 bindings on develop, a lower bound, because pattern bindings are under-counted. Drop the std half of `is_global_mut_rule_exempt` (`src/evaluator/memory_safety.yo:250`) for locals. | once D9 is accepted | build; check std; `yo test ./std`; the collection and string tests; tree fmt |
| P6 | Replaced by the removal (#1583, D23 amendment): `std/collections/linked_list.yo` is deleted rather than given raw-pointer nodes. That removes std's only intrinsic `Rc` cycle (prev/next, patched by #1486) before W6a measures, at zero migration cost. | — | done | — |
| P7 | The `Send`/`Sync` opt-ins for raw-buffer collections, drafted on the probe: `impl(generic(T : Type), where(T <: Send), ArrayList(T), Send())` and `impl(generic(T : Type), where(T <: Sync), ArrayList(T), Sync())`, with a SAFETY comment, as `Box` does at `std/prelude.yo:10060–10061`. Without them, a value `ArrayList` is not `Send` (probed: a raw pointer is neither, `prelude.yo:6979–6983`), and Part A's replacement probe fails. They land INSIDE each flip PR, not before. | each flip's std file | now (on the probe) | the replacement probe (D25) |
| P8 | `_IC_COLLECTIONS` gains `StringBuilder` and `HeaderMap` (`src/evaluator/utils.yo:3194`), so the explicit-copy listing covers their copies | tree only | now | build; the `fix-migrate-explicit-copy*` goldens if the listing grows |

### 4.5 The flips (all std-only; the v0.2.69 seed is stage 1)

Before opening each flip, run its probe: a never-merged branch rebased on the tip and checked with the SEED binary. Run `yo check ./std --std-path ./std`, then `yo check ./src --std-path ./std`, then the named tests. Every count is a lower bound.

#### B8: `ArrayList` + `String`

**Needs:**

- B4, B6 and B7 merged.
- C1 to C4 and C7 in the released v0.2.69 seed (B7a too, if std/src write `for(&xs, …)`).
- B6-0, P1, P3, P4, and P5 if D9 is accepted.

**Std:**

- `std/collections/array_list.yo:46–54` drops `ref(...)`. `Drop`, `Clone` and `Trace` already exist. Add P7's `Send`/`Sync` impls.
- `std/string/string.yo:99–101` becomes `String :: newtype(_bytes : ArrayList(u8))`, with the 223 `_bytes` sites rewritten. `into_bytes` moves the buffer out (needs C3).
- **The plan's 11 sharing sites:**
  - `std/fmt/to_string.yo:345` (`String.to_string`) becomes a clone. Interpolation stops routing through it (next item).
  - json and toml input holding.
  - `regex/match.yo:40/56`: `_input` becomes `Rc(String)`.
  - `regex/vm.yo`'s Save step and its scratch buffers use `mem.replace`.
  - `fs/watch.yo` and `string_builder.yo:187` use `mem.replace`.

**src:**

- **Interpolation (D10).** The lowering near `src/parser.yo:545` appends a `String` part by borrow into one builder, instead of `part.to_string()` joined with `+`. This is a tree-only parser change, but it lands in B8 because B8 is what makes `to_string` clone.
- **The ArrayList identity accessors.** If B4-1b has not already converted them, convert them here.

**Tests:**

- The census §5 expectation edits: `tests/cycle_collector.test.yo:751`ff, `tests/copy_trait.test.yo:296`, `tests/collections/array_list_convenience.test.yo:242`, `tests/index.test.yo:1065`.
- About 54 `ref_count` asserts on lists or strings across about 30 files. Keep only the ones that are about an `Rc`.
- The 24 `tests/` handle globals that B5 left.
- `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md` moves to `fixed/`.
- **The replacement probe (D25),** in `tests/thread.test.yo`:
  - `String` and `ArrayList(String)` moved into `Thread(...).spawn` and back through `join()`;
  - the same through `Channel(String)`;
  - use after the move is E0901;
  - an `Rc(String)` capture stays E0602.

**Goldens:**

- `audit-implicit-copy-lists-copies-of-live-values` and `fix-migrate-explicit-copy*`.
- Five `inout-*-panics` cases: `alias-push`, `pop-under-borrow`, `store-fresh-into-self`, `interior-borrow-growth`, `self-method-under-borrow`. Read each diff: a static error replaces the panic.
- The 7 cheatsheet-hash cases, if the skills change.

**Docs, in both languages:** `STRINGS`, `MEMORY_SAFETY`, `THREAD_SAFETY`, `PARALLELISM`, the cheatsheets, and the status of `plans/STRING_VALUE_SEMANTICS.md`.

**Ratchet:**

- Lower `check_src_main_alloc_calls` (`scripts/bootstrap/memory-ratchet.tsv`, today 1,961,432,937), with a dated row.
- Re-measure `check_src_main_max_rss_kb` (1,159,212) and `compile_src_main_peak_kb` (3,317,216).
- The maintainer's 2026-10-23 OK to raise memory baselines applies.

**Companion:** a `markdown_yo` release, if v0.0.20 still fails once B6 projects (`src/inline/link.yo:841`).

**Tier 1:**

- `yo build --std-path ./std` with the seed (stage 1), then with the tree binary; check src and std.
- Tests, one per call: `tests/collections/array_list*.test.yo`, `tests/string/*` (8), `move_only`, `copy_trait`, `cycle_collector`, `for_macro_borrow*` (3), `index`, `rc`, `async_await`, `comptime`, `tests/encoding/*`, `thread`, `send_sync`.
- Internal: `lsp_protocol`, `recursive_enum`, `compile`, `gc_runtime_atomics`, `input_record`, `expr_info`, `toml_edit`, `manifest`.
- cli-diff; fmt; refs.
- The fixpoint, once under `exclusive`. The plan's B8 requires it.

**Surface:** `ArrayList` has 6,036/879/2,839 mentions in src/std/tests, `String` 13,991/1,352/6,893.

#### B9: `HashMap` + `HashSet`

- **Needs:** B8 merged.
- **Std:**
  - `std/collections/hash_map.yo:97` drops `ref` and gets P7's impls.
  - `std/collections/hash_set.yo:59–69` becomes a value wrapper of `HashMap(T, unit)` with a `where(T <: Clone)` derive of `Clone`.
- **src:** `codegen_read_keys` (`src/expr_info.yo:1604`).
- **Probe first.** Use the real accessor and iterator shapes from B6 and B7. Do not use the census's `__probe_dup`, which deep-clones `ref` maps. Also run `YO_AUDIT_INOUT_BORROW=1 yo check ./src`.
- **Tier 1:** B8's shape with:
  - `tests/collections/hash_*.test.yo` and `std/collections/hash_*.test.yo`;
  - `send_sync`, `async_await`, and `thread` (the probe extended with `HashMap(String, ArrayList(String))`);
  - internal `env`, `expr_info`, `effect_analysis`, `module_invalidation`;
  - the ratchet within ±5 %.
- **Surface:**
  - HashMap: 765/109/329 mentions in src/std/tests.
  - HashSet: 398/38/183.
  - Globals: 195 `RefCell(HashMap` and 44 `RefCell(HashSet` globals are already cells (B5).

#### B10: `Deque`, `BTreeMap`, `OrderedMap`, `PriorityQueue`

- **Needs:** B9 merged, because `OrderedMap` holds a `HashMap`.
- **Deque** (`deque.yo:42`) drops `ref`, gets a hand-written `Clone` where `T <: Clone`, and gets P7's impls.
- **The wrappers** (`btree_map.yo:43`, `ordered_map.yo:70`, `priority_queue.yo:40`) drop `ref` and derive `Clone` with `where` bounds.
- **Iterators that hold their source** must already have B7b's shapes.
- **Tier 1:**
  - `tests/collections/{deque,btree_map,ordered_map,priority_queue}.test.yo`;
  - cli-case `inout-for-nested-storage-insert-panics`;
  - the probe extended; check src.

#### B11: `StringBuilder`, `HeaderMap` and `HttpHeader`

- **Needs:** B8 merged. It can run in parallel with B9. (`LinkedList` left this step: it was removed, D23 amendment.)
- **StringBuilder** (`string_builder.yo:81`) becomes `struct(_buf : ArrayList(u8))` with `derive(Clone)`. It keeps `to_string(self : &mut Self)` as the O(1) detach over `mem.replace`, and gains `into_string(self : Self)` (D24).
- **`HeaderMap` and `HttpHeader`** (`std/http/http.yo:76/98`) become values with `derive(Clone)`. `entries()` (:185) returns `&ArrayList(HttpHeader)`.
- **Tier 1:**
  - build (only if P8 has not landed);
  - `tests/string/string_builder.test.yo`, `tests/http/*`;
  - internal `formatter` and `parser`.
- **Surface:**
  - `StringBuilder` has 75/32/88 mentions. src has 48 `:= StringBuilder` locals and no by-value parameter or field.
  - `HeaderMap` has 1/19/12, `HttpHeader` 0/13/3.

### 4.6 V3: the cell-free resources become move-only values

This step had no breakdown. Schedule §5 decision 4 places it at v0.2.70. Plan V3 "std": each resource becomes `struct(_cell : Box(_XState))`, whose state implements `Drop`. `Arena` stays as the §3.11 exception.

**The types and their mentions** (src/std/tests):

| Type | Location | src/std/tests |
| --- | --- | --- |
| `File` | `std/fs/file.yo:74` | 35/146/145 |
| `TempDir` | `std/fs/temp.yo:62` | 2/16/23 |
| `TempFile` | `std/fs/temp.yo:176` | 0/13/15 |
| `Watcher` | `std/fs/watch.yo:102` | 2/18/7 |
| `TcpStream` | `std/net/tcp.yo:128` | 3/54/50 |
| `TcpListener` | `std/net/tcp.yo:185` | 0/28/55 |
| `UdpSocket` | `std/net/udp.yo:67` | 0/15/28 |
| `UnixStream` | `std/net/unix.yo:43` | 0/16/14 |
| `UnixListener` | `std/net/unix.yo:50` | 0/7/10 |
| `TlsStream` | `std/crypto/tls.yo:127` | 1/21/4 |
| `HttpClient` | `std/http/client.yo:286` | 0/21/29 |
| `Child` | `std/process/command.yo:674` | 1/26/13 |
| `ChildStdin`/`ChildStdout`/`ChildStderr` | `std/process/command.yo:706/710/714` | 0/29/7 |
| `Thread` | `std/thread.yo:80` | |

**The PRs:**

| PR | Types | Needs | Tier 1 |
| --- | --- | --- | --- |
| V3a | `File`, `TempDir`, `TempFile`, `Watcher` | none found. The schedule orders it after the flips; let it merge first if B8 slips. | check src/std; `tests/fs/*` (7 files, one per call); `tests/move_only.test.yo` (rejected copies, `Drop` once); internal `build_runner` and `install_command` (they use `File`) |
| V3b | the sockets, `TlsStream`, `HttpClient` | the same | check; `tests/net/*` (6), `tests/http/*` (4), `tests/crypto/tls.test.yo`, `tests/crypto/tls_available_sync.test.yo`; `tests/move_only.test.yo` |
| V3c | `Child*`, `Thread` | P1, because `Thread` holds `_result : Channel(T)`, which stays `atomic` until V5 | check; `tests/process.test.yo`, `tests/process/command.test.yo`, `tests/thread.test.yo`, `tests/thread_pool.test.yo`, `tests/send_sync.test.yo`; internal `async_thread_exit_release` |

- **The migration:** a copy of a resource handle is E0901. The fix is `Arc(Mutex(T))`, `.clone()` where the type has `Clone`, or `&mut`, and the error says which.
- **Seed:** none. The v0.2.69 seed enforces move-only.
- **Can start:** all three now, as drafts.

### 4.7 Z11: `--allocator debug`

The branch `feat/z11-debug-allocator` has 7 commits and 36 files. It covers `tests/debug_allocator.test.yo` and the cli-cases `build-allocator-debug`, `test-allocator-debug-fails-a-leaking-test` and `test-allocator-debug-suite`.

**What it touches:**

- `src/main.yo`: the `--allocator` validation (:6996), the `--debug-heap` interplay (:7016), the lowering (:7837) and the `yo test` forwarding (:8848).
- `src/build_runner.yo:2013`.
- The runtime.

**Seed:** none.

**Gate:**

- build; check.
- `tests/debug_allocator.test.yo`, `tests/allocator.test.yo`, `tests/explicit_allocators.test.yo`.
- Internal `gc_runtime_atomics`.
- The three cli-cases; emit-diff, which should show no change under the default allocator.

The size-mismatch abort waits for allocator v2's sized `free` (§5 PR 2).

## 5. v0.2.71 (forced cut #1), PR by PR

**V2c is about two orders of magnitude larger than the plan's "63 sites in src".**

- **Emitted C.** The C of `src/main.yo` (on disk from 2026-10-23) has 5,252 count bumps on `Rc`/`Arc` handles after the pair optimizer.
  - `TypeValue` accounts for 3,308, in 984 functions.
  - The expr-info table handle accounts for 944.
  - `SharedList` cells account for about 695, and `VcTerm` for 196.
  - `AstExpr`'s 2,840 bumps belong to V4/V5: it is still a `ref` type.
- **Grep proxies:** 517 `ArrayList(TypeValue)`, 267 by-value `: TypeValue`, 152 `-> TypeValue`, and 1,038/14/819 `rc(` constructions in src/std/tests.
- **Estimate:** 2,500–5,000 `src/` sites. PR 3's dry run gives the real count.

**Order (D29):**

1. `__yo_cell`
2. B12
3. allocator v2
4. V2c
5. W3
6. W4

The owner prefix (PR 2) and the cell header (PR 4) are separate layout diffs, read one at a time. PRs 0, 1 and 2 are compiler-only Generation A halves. They can merge as soon as they are gated, even in the v0.2.70 window (D12).

### PR 0: `__yo_cell`/`__yo_atomic_cell`, Generation A

- **Branch:** `feat/yo-cell-primitive-gen-a` (2 WIP commits, 12 files, `tests/yo_cell.test.yo`).
- **Contracts with later PRs:**
  - The constructor lowers to `__yo_new_<C>(__yo_alloc_scope_t, V)` through `__yo_rc_alloc_scoped`, so PR 2 updates that path.
  - The layout is exactly `ref(struct((*) : V))`, so PR 4's header change applies unchanged.
  - The runtime helpers take `cell : &C`, generically.
- **Decision 49:** step 1 (the flagless `Cell` on this primitive, `issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`) is a separate PR after this one, and only if the maintainer accepts that question's recommendation.
- **Seed:** this IS the Generation A, for V5.
- **Gate:**
  - build; check; `tests/yo_cell.test.yo`;
  - internal `gc_runtime_atomics`;
  - emit-diff, which should show no `src/main.yo` change.

### PR 1: B12, `Dyn` Generation A

**Codegen:**

- **The vtable slot.** Add a `__yo_clone` slot to the vtable prefix: `src/codegen/types/generation.yo:1692–1694`, plus both runtime copies of `__yo_vtable_prefix_t`/`__yo_dyn_retain` (`src/codegen/functions/gc_runtime.yo:473–484` and `:696–707`).
- **Filling it.** `generate_dyn_vtables` (`src/codegen/functions/dyn.yo:745`, slot init :822–823) fills the slot with a per-impl `__yo_dyn_clone_<impl>`.
  - That function boxes `payload.clone()` in a fresh box placed by the source's owner (decision 12), through `generate_dyn_box_functions` (`dyn.yo:102`, allocation :147).
  - The slot is NULL when the impl is not `Clone`.
- **`__yo_retain`/`__yo_release` stay in Generation A.**

**Evaluator:**

- **`Clone` in a `Dyn`'s trait list** contributes the slot, not a wrapper method. The code is `_dyn_trait_slot_names` and `_reject_dyn_slot_name_clash` (`src/evaluator/types/dyn.yo:65/85`).
- **`Dyn` leaves two carve-outs:**
  - the one at `src/types/utils.yo:939`;
  - the move-only walk's `Dyn` stop (:807–813).
- **The new kinds:** `Dyn(T, Clone)` becomes explicit-copy, and any other `Dyn` becomes move-only. The error applies outside std and src, through `is_global_mut_rule_exempt` (`src/evaluator/memory_safety.yo:250`).
- **`.clone()` lowers to the slot.** The dup sites that need the clone/move path:
  - `src/codegen/exprs/drop_dup.yo:436–438/671`;
  - `src/codegen/exprs/async.yo:1050/1069`;
  - the upcast at `src/codegen/exprs/downcast.yo:311`.
- **The E0901 notes:** `_clone_hint` (`src/evaluator/utils.yo:617`) and `_explicit_copy_kind` (:948).

**Tests and docs:**

- Sweep the 8 copies in tests (§6 of the plan counted 9/6/8 in src/std/tests; tests have 411 `Dyn(` mentions).
- Docs: `docs/{en-US,zh-CN}/DYN_DESIGN.md`.

**Seed:** this IS the Generation A. B13 (v0.2.72) needs a seed carrying it.

**Gate:**

- build; check.
- Tests: `tests/dyn.test.yo`, `copy_trait`, `move_only`, `fn_once`, `closure`, `error_source_chain`, `send_sync`, `tests/async/sm_ownership.test.yo`, `tests/io/async_traits.test.yo`.
- Internal `gc_runtime_atomics`.
- Emit-diff: only the new slot line per vtable plus the clone functions.
- cli-diff: `check-dyn-unresolved-payload`, `check-test-bodies-auto-boxed-dyn`, `dyn-vtables-registering-futures-are-each-defined-once`.

### PR 2: allocator interface v2, Generation A

**The runtime**, in `src/codegen/types/generation.yo:1062–1158`:

- **The vtable.** `__yo_alloc_vtable_t` (:1074–1079) becomes `alloc(ctx, size, align)`, `realloc(ctx, ptr, old_size, new_size, align)` and `free(ctx, ptr, size, align)`.
- **Allocation.** `__yo_rc_alloc_scoped(s, size)` (:1130) gains `align`, and places the prefix in the `max(16, align)` bytes before the block.
- **Lookup and free.** `__yo_scope_of_object` (:1120) and `__yo_rc_free` (:1083) read the new prefix.
- **Call sites:** `__yo_rc_alloc_scoped`/`__yo_rc_free`/`__yo_scope_of_object` are named at 19 places in 6 files: `gc_runtime.yo` 8, `generation.yo` 5, `exprs/async.yo` 2, `constructors.yo` 2, `dyn.yo` 1, `async/state_machine.yo` 1.

**The sized free for cells (D14).**

- The 8 generic cell frees in `gc_runtime.yo` (:413, :461, :576, :643, :684, :1092, :1182, :1243) have no size.
- So an allocator-placed cell's prefix records `size` and `align` beside `{ctx, vtable}`: 32 bytes, or `max(32, align)`.
- Global-heap cells carry no prefix, so the common case pays nothing.

**The switch (D30).** Codegen picks the ABI from the shape of std's `AllocatorVTable` (the arity of its `alloc` field), so the contract and its switch cannot disagree. Generation B (v0.2.72) moves `std/allocator.yo` (`AllocatorVTable`, `_GLOBAL_VTABLE` :195, `_stamp` :207) and `std/arena.yo`. The v1 path is deleted once no supported seed needs it.

**Tests:**

- An over-aligned element in an `ArrayList`, through an aligned allocator.
- A header-free pool that frees by the size it is given.
- Every existing arena and counting-allocator test.

These go in `tests/explicit_allocators.test.yo` and `tests/arena.test.yo`, not in new files.

**Seed:** this IS the Generation A.

**Gate:**

- build; check.
- Tests: `tests/allocator.test.yo`, `tests/arena.test.yo`, `tests/explicit_allocators.test.yo`, `tests/rc.test.yo`, `tests/arc.test.yo`.
- Internal `gc_runtime_atomics`.
- The `--allocator fixed` cli-cases.
- Emit-diff: the runtime text and the call arity only.

### PR 3: V2c, decision 17, as ONE PR

**Needs:**

- B6 and B7 merged: `ArrayList(TypeValue).get(i)` copies an explicit-copy element after V2c, so the `cloned-accessors` category extends to counted handles.
- Part A (landed).

**The rule:**

- `type_requires_explicit_copy` (`src/types/utils.yo:964`) and `_explicit_copy_kind` (`src/evaluator/utils.yo:948`) report `Rc` and `Arc`, and a struct holding one.
- A6's `_check_bundle_fields_copy` (`src/evaluator/calls/function.yo:2480`) changes its help text. The plan says that the "keep shared state in an `Rc` field" help is wrong after V2c.

**The `Clone` impls (D13):**

- `std/prelude.yo:9807–9816` (`Rc(T)`'s `Clone`, a deep clone today, bound `T <: Clone`) becomes a handle copy with no bound.
- `Arc(T)` gains the same impl. Today it has none: `tests/unapplied_constructor_method.test.yo:158–160` asserts "No method clone on Arc(i32)", and that test flips.
- The 8 hand-written handle-copy impls would overlap and are deleted in the same commit: `src/types/definitions.yo:221/223/225/227/229` (`SharedList(...)`), :643 (`TypeValue`), :659/:661.
- `tests/copy_trait.test.yo:341` ("Rc.clone reaches the payload's clone") flips.
- `Frame` (`src/env.yo:637`) and `Token` (`src/token.yo:79`) keep their impls: they are `ref` types until V5.

**The migration:** `yo fix --migrate rc-clone` inserts `Rc.clone(x)`/`Arc.clone(x)`, and inside a closure a capture-list entry `{ h : Rc.clone(h) }`. It is a new mode beside `_run_migrate_explicit_copy` (`src/main.yo:2987`). It runs over std, src and tests in the same PR, followed by `--migrate cloned-accessors` with the extended category.

**Layout:** a generated commit, then hand edits, as B1 did. Review is by commit.

**Seed:** none. `Rc.clone(w)` is in every seed. The tree std redefines its meaning, and the seed builds that std.

**Gate:**

- build; check.
- Tests: `rc`, `arc`, `rc_cell`, `copy_trait`, `unapplied_constructor_method`, `deref_auto`, `closure_capture_rc_leak`, `async_await`, `send_sync`, `thread`.
- Internal: `type_key`, `types_compound`, `synthesizer`, `env`, `expr_info`, `verifier`, `gc_runtime_atomics`, `compile`.
- Emit-diff: report the change in `___dup` count. The plan says that rise is the cost to report, not a reason for a fallback.
- cli-diff: `fix-spells-a-wrapper-member-clash`, plus a new `fix-migrate-rc-clone`.
- **Extra:** ABBA `check src/main.yo`, and the fixpoint (the PR rewrites thousands of src lines).

### PR 4: W3, `Weak(T)`

- **The weak count** goes in the free 16-bit `borrow_count` of a plain `Rc` header (`src/codegen/types/generation.yo:998/1028/1056`). It saturates at 65535, and a saturated cell leaks rather than dangles.
- **Guard first:** `ref` objects still use `borrow_count` until V5 (`gc_runtime.yo:331–379`). Add an assertion, or prove from the code, that no path marks an `Rc` cell's `borrow_count` before reusing the bits.
- **The dead flag** is a new `gc_flags` bit beside `__YO_GC_TRACKED`/`__YO_GC_BUFFERED` (`generation.yo:598`).
- **Two free paths:** the last strong handle runs `dispose_fn` and frees only if `weak == 0`; the last `Weak` frees a dead cell.
- **`traverse_fn` skips `Weak` fields**, so `can_type_form_rc_cycle` (`src/types/utils.yo:1764`) reads a weak back edge as acyclic.
- **The surface:** the prelude beside `Rc` (`std/prelude.yo:9737`), as given in `WEAK_AND_UNCOLLECTED_RC.md` §3.1, with `derive(Weak(T), Clone)`.
- **Docs:** a `Weak` page beside `docs/*/ARC.md`, in both languages.
- **Seed:** this IS the Generation A. std uses `Weak` on the v0.2.71 seed.
- **Gate:** build; check; `tests/rc.test.yo` and `tests/cycle_collector.test.yo` get the W3 rows (WEAK §7); an ASan run of those rows; internal `gc_runtime_atomics`; emit-diff.

### PR 5: W4, `ArcWeak(T)`

- **What:** atomic weak counts and `Send`/`Sync` iff `T <: (Send, Sync)`. `ARC.md` and `DESIGN.md` gain the sentence that W2 deferred.
- **Gate:** the W3 rows across `Thread.spawn` in `tests/arc.test.yo`; a TSan run; internal `gc_runtime_atomics`.

## 6. Risks

- **v0.2.70 is overloaded:** B4 (8 PRs), B6 (4), B7 (3), B8–B11, V3 (3), Z11 and P1–P8. D11 lets B9–B11 ride the v0.2.71 cut; they are std-only and add no boundary. The only consumer that needs them is decision 47 locals Generation B at v0.2.72.
- **A missed seed fix costs a release.** If C1, S1a or S1b (where its shape exists) misses v0.2.69, B8 either carries a workaround or waits for v0.2.70 as its seed.
- **Population cost (B1's 80x lesson).** A `.clone()` at a hot evaluator site costs copy × frequency × retention. The ABBA bar on every evaluator PR and N5 on B6-c contain it.
- **Silent lost writes.** A copy that used to share a handle and is now written fails nowhere in src, which stays exempt from decision 47 until v0.2.72. The nets are the B4 behaviour corpus, the B8 probe over src and the fixpoint. In std, P5 (D9) closes it.
- **D1 changes the call shape of 1,096 `with_mut` calls.** The emit-diff and the ABBA bar decide it. The fallback is per-site `.clone()`, never the `take` window.
- **The take window, rejected.** `m := G.take(); …; G.replace(m)` leaves the cell unborrowed and empty. A re-entrant read in an evaluator cache then sees an empty map instead of panicking, and that is silent.
- **Seed codegen in a flip.** HashMap's probe and move paths may surface a new seed bug, as `Pattern` (#1438) and `IterPeekable` (#1437) did. Probe each flip with the seed before opening its PR.
- **The verifier models `get` and the value `for` by name.** Without the `vc.yo` edits in B6-b and B7a, migrated `Pragma.Verify` code silently falls outside the subset.
- **V2c's size.** 2,500–5,000 src sites in one PR (plan: "one PR, not two generations"). Its review is by commit. Budget the heavy dry run (1.5 GB, about 10 min) and the fixpoint.
- **Two layout changes in one window:** PR 2's prefix and PR 4's header. Serialize them, each with its own emit-diff.
- **Stale numbers.** The B1 listing's positions are from `412258a2a`, and the census ran on `e30c0d8ed`/`b14840077`. Re-run each dry run or probe on the PR's base.

## 7. Open design questions, with recommended answers

**D1. The B5 capture copies (82 sites).**

- (a) `take`/`replace` windows (#1554): they list nothing and run correctly (probe P-A). But the window turns a re-entrant panic into a silent empty read, allocates a `default()` handle per call until B8/B9, and reverses §5 decision 3's `with`/`with_mut`-only spelling.
- (b) A `with_mut_given(arg, (v, a) => …)` door: it fixes only single-value sites.
- (c) Wait for `get_mut()` in v0.2.73: the clones stay until after B8.
- (d) **Recommended:** an `FnOnce` `with_mut` with capture lists, plus the tool fix (B4-0b). Probe P-B shows the evaluator already accepts moving a move-only capture out of an `FnOnce` body. The current `&Impl(Fn)` door rejects it with E0913, whose help names exactly this shape. The tool asks for `.clone()` there today, which is an S3 over-insertion to file with B4-0b.

**D2. Where decision 19 lives.**

- **Recommended:** `std/mem.yo`, imported explicitly (Rust's `std::mem`), ONE PR as B6-0. The plan ties decision 19 to decision 20's non-copying access (plan, around line 1065), so B6 owns it. B4 and B8 consume it.
- The prelude is rejected, because a prelude export reserves the name in every module (probe P-C).
- A new `.yo` file needs the maintainer's OK. If it is refused, the fallback is free functions `mem_take`/`mem_replace`/`mem_swap` in the prelude.

**D3. B1 versus the tool fixes.** Land B1 as measured. Changing the tool (B4-0a) or the sites (B4-0b) first would make B1 regenerate a different commit and void its GO measurement, and B1 is v0.2.69's critical path.

**D4. Where the evaluator PRs start.** B1's branch carries step 1 (`Token.input`/`module_path` cells: 7 commits, about 40 files under `src/evaluator`, `env.yo` and `lexer.yo`, about 260 lines). A dry run on develop lists the `Token.input` field stores that caused the 80x regression, and hand-cloning them would recreate it. So stack B4-3a to 3e on B1 now, and rebase when B1 merges.

**D5. Granularity.** 8 PRs (§4.1). Their files are disjoint, so they merge in any order within the slot cap.

**D6. The AST call args.** Use the borrow restructure where the list is only read, and `.clone()` where it is stored. Escalate to `SharedList` args only if an evaluator PR fails its ABBA bar. That is V4's change pulled forward: 62 constructors and 1,206 `.FnCall(` patterns, measured on its own as #1532 was.

**D7. B7a in v0.2.69 (amendment).**

- Split the read walk out of B7. It needs no accessor, since `walk_ref` reads the slot.
- Land it before the cut, so that v0.2.70's flips may spell std and src read walks as `for(&xs, …)`.
- If it misses the cut, std and src use `indices()`/`xs(i)`, `for(&mut …)` (on a mutable place) or `.clone()` until `SEED_VERSION` ≥ v0.2.70. Today that affects 1 src site and 0 std sites, but the flips add more, the largest group being HashMap `keys()`/`values()` (94 src sites).

**D8. The seed triage.** As §3. C6 drops from SHOULD to "any release": src and std hold no `derive(…FromJson)`.

**D9. Decision 47 locals Generation B for std in v0.2.70 (amendment to §5 decision 2).**

- The census shows that the std exemption hides real lost writes after the flip (the OrderedMap index, the TOML cursor).
- std has 1,067 mechanical sites on a seed that has carried Generation A since v0.2.65.
- src, docs and `markdown_yo` stay at v0.2.72, to avoid a double pass over the 5,773 handle writes.
- B9–B11 each re-run the std migration for their own types.

**D10. Interpolation.** B8 makes the change, as the plan says (around line 7355: "B8 must also stop routing a `String` part through `to_string`"). It is not a follow-up.

**D11. B9–B11 may ride the v0.2.71 cut (amendment).** The boundary count is unchanged, and v0.2.70 is not held for them.

**D12. Pull v0.2.71's Generation A halves forward.** `__yo_cell`, B12 and allocator v2 are compiler-only and independent of the B-series. Merging each when it is gated, even in the v0.2.70 window, means the v0.2.71 forced cut no longer waits on them. If v0.2.70 carries them, B13, allocator v2's Generation B and V5's seed prerequisite are met a release early.

**D13. `Rc.clone`'s meaning.**

- §5 decision 1's premise, "`Rc.clone(w)` has been in every seed since #1241", is true of the spelling. It is not true of the meaning: today it is a deep clone.
- V2c redefines it as a handle copy with no bound, adds `Arc`'s impl, and deletes the 8 overlapping src impls, all in one commit.
- The visible change is to 24 `Rc.clone(` sites in tests (none in std code).

**D14. The sized free for cells (amendment).** Record size and align in the prefix of allocator-placed cells (32 B, or `max(32, align)`).

- Rejected: threading a per-type size through `dispose_fn`. That rewrites the collector's free pass, which W6b deletes in v0.2.74.
- Revisit at W6b: with the collector gone, the free can be per-type, and the prefix can go back to 16 B.

**D15. W3 after V2c.** Keep the order. `Weak` is explicit-copy whatever V2c does (it is move-only with `Clone`), so the dependency is soft. If V2c is not merged by the middle of the window, W3 may land first. Record that as an amendment.

**D16. `ast_expr_token(&e).value` (107 sites).**

- Use a projection, `ast_expr_text(e : &AstExpr) -> &String`, where the text is only read or compared, and `.clone()` where it is stored.
- First probe with the seed that a projection through a `ref` enum payload compiles, and avoids C1's collapse shape.

**D17. `copy_eval_context`'s collection fields** (`src/evaluator/context.yo:1869`), decided per field:

- a cache written through the copy on purpose (`comptime_fn_caches`) becomes `Rc(RefCell(...))`;
- a snapshot (`captured_variables`, the specializing stack) takes `.clone()`;
- a read-only field becomes an `Rc` share.

The two list-identity tests become an explicit flag or an `Option`.

**D18. The hot paths in B6-c.** Do not rewrite `.get(` inside `src/evaluator`, `lexer.yo` or `env.yo`. List those sites and hand-edit them to `xs(i)`.

**D19. `for(&s, …)` over a `String` or an `Array`.** Neither gets a read walk. The error names `s.chars()`, and the value form for `Array`. A `walk_ref` over `String` would project `&u8`, which silently changes the meaning.

**D20. `chars`/`keys`/`values`/`chunks`/`windows` consume their receiver** (B7b). Before the flip that is a count bump. After it, temporaries and last uses keep working. Decision 43 step 4 restores borrowing iterators.

**D21. Consuming `into_iter` keeps copying elements until each flip.** Before the flip, a `ref` container can be aliased at run time, so moving out of a shared buffer is a use-after-free. Each flip switches its own iterator to move-out. Record this as "as built".

**D22. `HashMapEntry`.** `m.entry(k, e => { e.and_modify(f); e.or_insert(d) })`. The entry holds a raw `*HashMap` and lives only as a closure parameter, so it cannot go stale across a rehash.

**D23. `LinkedList`.**

- `_Node(T) :: struct(value : T, next : ?*Self, prev : ?*Self)`, with the list as `struct(head, tail, length)` under `AllowUnsafe`.
- A hand-written `Drop` and `Clone`. The cursor is `?*_Node(T)`.
- The nodes land as P6, before B8.
- Rejected: an index slab (unstable capacity, and it deviates from the decided design), and `Weak` back edges (they need W3 and keep a counted cell per node).
- **Amendment (2026-10-24): superseded by removal.** LinkedList removed 2026-10-24 rather than migrated. Grounds: no consumer in src/std/deps; a surface Deque and ArrayList already provide; it was std's only intrinsic Rc cycle, so removal is P6's goal at zero cost and leaves nothing for W6b to leak. A future list, if a use case appears (O(1) unlink with stable handles, LRU), is a value type over raw `?*_Node(T)` with a cursor API or an arena list, designed after VBD; `Weak` back-edges remain rejected. Its `cycle_collector.test.yo` cases are deleted without replacement, since W6b deletes the collector.

**D24. `StringBuilder`.** A value `struct(_buf : ArrayList(u8))`, kept separate from `String`, because `write_byte` can build non-UTF-8 mid-way. Keep `to_string(&mut self)` (48 call sites) and add `into_string(self)`. A shared builder is spelled `Rc(RefCell(StringBuilder))`.

**D25. The replacement probe** goes in the existing `tests/thread.test.yo` (AGENTS.md: no new `.yo` files unasked). B9–B11 extend it.

**D26. `HttpHeader`.** A value struct, with a borrow getter for `entries()`. `HttpRequest` and `HttpResponse` stay `ref` until V5.

**D27. The order of the later flips.** B9 strictly before B10, because `OrderedMap` holds a `HashMap`. B11 depends only on B8, so it can run in parallel with B9.

**D28. Split V3 three ways** (§4.6). `Thread` goes last, after P1.

**D29. The v0.2.71 order:** `__yo_cell` → B12 → allocator v2 → V2c → W3 → W4. Each layout change is read on its own.

**D30. The allocator v2 switch.** Derive it from the shape of std's `AllocatorVTable`, not from a CLI flag or a second constant. The vtable's field types ARE the contract, so the switch cannot disagree with them. One stage-1 nuance: the tree compiler must accept both shapes until `SEED_VERSION` carries Generation B.

## 8. The probes behind this doc (seed v0.2.68, develop std, scratch files deleted)

- **P-A:** a `RefCell(HashMap(String, String))` global written with `m := G.take(); _ := m.insert(k, v); _ := G.replace(m);`. `yo fix --migrate explicit-copy --dry-run` lists nothing. It compiles and runs.
- **P-B, the `FnOnce` door.**
  - A local `with_once(h, sink(body) : Impl(FnOnce(v : &mut HashMap(i32, V)) -> R))` called as `with_once(h, { k, v }(m) => m.insert(k, v))`, where `V :: struct(b : Box(i32))` is move-only. Check passes, and the program compiles and runs.
  - The same call through today's `G.with_mut(m => m.insert(k, v))` is E0913, and its help is "list the capture and type the closure `FnOnce(...)`".
  - With an implicit `k` in a list that names only `v`, the list is exhaustive and the error asks for `k`.
  - The explicit-copy dry run on the `String` version of the `FnOnce` call still says "`k` would become `k.clone()`". That is the tool gap B4-0b fixes.
- **P-C, prelude names.**
  - A module-level `drop_in_place :: …` fails with "Variable "drop_in_place" is already defined here (variable shadowing is not allowed)", pointing at `std/prelude.yo:323`.
  - A local `drop_in_place := …` fails the same way.
- **Grep counts** were taken at `ef153b749` with `git grep` (word-bounded where noted). The emitted-C counts come from a `src/main.yo` C file dumped on 2026-10-23 (`~/Workspace/Yo-wt/vbd-logs/derive-drop-review/emit-dev.c`).

## 9. What the critic's review changed (each claim re-checked)

**Held, and integrated above:**

1. The prelude `take`/`replace`/`swap` appeared twice (B4-0c, P2). It is now ONE PR, B6-0, and lives in `std/mem` (D2, P-C).
2. C7 is fixed in the evaluator. Rewriting its test would hide the bug (§3).
3. B7a joins the v0.2.69 SHOULD list (§3, D7).
4. B6-c's src half runs after the last B4 PR (§4.2).
5. B1 merges as measured before B4-0a and B4-0b (D3).
6. The evaluator PRs stack on B1. B1 step 1 touches about 40 evaluator/env/lexer files and about 260 lines (`git show --stat`: 7+39+1+1+1+2+1 files).
7. The `take`/`replace` spelling is rejected. The critic's untested `FnOnce` alternative was probed and adopted, together with the tool fix it needs (D1, P-B).
8. Interpolation belongs in B8 (plan around line 7355).
9. The std-only decision 47 pull is an amendment for the maintainer (D9).
10. B7a's split is an amendment (D7).
11. `Rc.clone` is a deep clone today, and the 8 overlapping impls are at `src/types/definitions.yo:221/223/225/227/229/643/659/661` (D13).
12. V3 and Z11 now have breakdowns (§4.6, §4.7).
13. B6 gains decision 20's `with(i, body)` and `take(i)`, and its help text names `with` (B6-a, B6-b).
14. B4 gains the three unlisted V2a blockers: the `SomeT`/`TraitT` lists, the comptime-place model and `module_loader`'s arrays (B4-3d, B4-3e).
15. The two 2026-10-23 S1s are in §3. Both files exist and are marked S1.
16. P7's `Sync` impl is bounded by `where(T <: Sync)`, as `Box` is at `std/prelude.yo:10061`.
17. The identity accessors are split: the two `ArrayList` ones go to B4-1b, and `codegen_read_keys` (a `HashSet`) goes to B9.
- **Smaller points that held:**
  - The `unwrap(self : Self)` cost after B8 is counted in B6-c.
  - The W3 soft dependency is an amendment only if taken (D15).
  - The two off-by-one lines are fixed: `k := entry.key` is at `prelude.yo:10752`, and `_clone_hint` at `utils.yo:617`.
  - The counts are corrected: `Dyn(` in tests is 411, `for(&mut` in tests 71, word-bounded `for(` 46/37/203, `:= StringBuilder` in src 48.
  - C6 is downgraded: 0 `derive(…FromJson)` in src/std (§3).

**Did not hold:**

- **"Plan B4 does not ask for the fixpoint."** It does: "fixpoint recommended for the evaluator PR". This doc keeps one fixpoint, on the last evaluator PR, labelled as an extra beyond Tier 1.
- **The `.FnCall` arm count.** The critic's 288 and the breakdown's 293 are both grep-dependent. This doc says "about 290".
