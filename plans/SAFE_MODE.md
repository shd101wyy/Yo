# Safe mode — no undefined behavior, and every runtime failure proven, typed, or trapped

**Status: ACTIVE — designed 2026-09-21 from a measured codegen survey; amended
2026-09-22 (D7 adopted: the class-1 panic ban, Phase 0c); audited 2026-09-23
(§14, which is the authoritative open-work list).** Landed: 0a (#828; the
post-`main` belt re-landed with the install-frame classification fix, #858),
0b (#829), 0c (#831), 1 (#833), 2 (#835), 3a/3b/3c with the `wrapping_*`
escape hatch (#837; two missed wrap-by-design sites, #841), 4 (#836); 5a
measured and closed as a documented non-change. Open (§14): the std unwrap
ratchet (closing), the comptime-panic diagnostic that the "comptime carve-out"
reduces to, the per-phase docs and
instruction updates, the missing trap/OOM oracles, the UBSan acceptance run,
the governance cross-check, 5b (its FV gate is LIFTED, V1–V7 landed; design not
started), and 6 (gated on 5b).**
Ground-truth anchors were verified on `develop` at `a1df43578`; line numbers
drift, so each phase names the symbol to grep for, not just the line.

**Maintainer rulings 2026-09-22: D1–D7 all adopt the plan's recommendations**
(trap on signed+unsigned overflow at every `-O`; saturating float→int casts;
abort-with-message for the escaped unwind; checks are semantics, not debug aids;
document the slice clamp; UBSan CI leg optional; the class-1 panic ban).
**Phase 0a LANDED as designed-plus-corrections:** implementation found that H9's
flag-escape mechanism is unreachable (every unwind is caught at a task boundary
or install site and the boundaries clear the flag) — the real observable defect
was the silent task abort, now diagnosed at the unwind-side -2 writers, with the
post-`__yo_user_main` check kept as the belt. See
`issues/fixed/effect-unwind-escaping-a-task-or-main-is-silent.md` and
`issues/fixed/main-effect-parameters-other-than-io-segfault.md` (the latter
surfaced by the repro: `main` with a non-`Io` effect parameter segfaulted at
first use; the entry-point signature check now rejects it).

Companion documents that bound this design:

- [`plans/backlog/DEPENDENT_TYPES_POSITION.md`](backlog/DEPENDENT_TYPES_POSITION.md) — Layer 2
  (SMT refinements on runtime values) is the proof tier this plan builds its top rung on.
- [`plans/backlog/FORMAL_VERIFICATION.md`](backlog/FORMAL_VERIFICATION.md) — owns the verifier
  this plan's Phase 5b depends on; do not couple codegen to it before that campaign lands.
- [`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`](reference/OPERATOR_SET_AND_PRECEDENCE.md)
  — the affirmed "mistakes are loud, not silent" rationale for LLM authorship. This plan
  is that principle extended from parsing to runtime semantics.
- `docs/en-US/MEMORY_SAFETY.md` — already *claims* the indexing half of Phase 1
  ("All indexing is bounds-checked", line ~100). Phase 1 closes a doc-vs-code gap; it
  does not invent a new promise.
- `plans/archive/STD_API_AUDIT.md` D1 — the three blessed fallibility styles
  (effects / `Result` / `Option`). This plan adds a fourth tier — the deterministic
  trap — but does not disturb the three.

## 0. The two promises and the failure ladder

Split the slogan "no runtime exception and no undefined behavior by default under safe
mode" into two promises of different strength:

**Promise A (no UB):** *safe Yo code cannot execute C-level undefined behavior.*
This is a compiler obligation over emitted C. Yo emits 100% of the C a safe program
runs, so the obligation is mechanically checkable: every C UB source reachable from
safe constructs gets either a proof or a defined dynamic check. This promise is fully
deliverable by Phases 0–4 of this plan.

**Promise B (no untyped/unhandleable/silent failure):** *every runtime failure in safe
code is (1) proven impossible, (2) typed in the signature so the caller must handle it,
or (3) a deterministic trap with file/line that is defined behavior.* Promise B is the
correct reading of "no runtime exception" for Yo. A trap (`__yo_panic`-style message +
`abort()`) is not an exception — it is the language's tier-3 escape, the same thing
`assert`, `Option.unwrap`, and ArrayList indexing already do today. Eliminating traps
entirely would mean banning `assert`, `unwrap`, and every container accessor, breaking
std's closed API window (S2: std is additive-only), and burying LLM authors in
`get(i)`-then-match boilerplate. A trap-free *strict* mode remains possible later as an
opt-in (Phase 6), built on the proof tier. One slice of that strictness is pulled forward
into Phase 0: **D7 bans the optimistic-extraction vocabulary (`unwrap` & co.) in safe
files immediately** — it needs no verifier, because the failure information it discards
is already in the type (§3, Phase 0c).

The ladder, per hazard safe mode picks the highest affordable tier and never falls
below tier 3:

| Tier | Mechanism | Cost | Exists in Yo today? |
| --- | --- | --- | --- |
| 1. Prove | verifier contract (`requires(rhs != i32(0))`, `requires(i < self.len())`) discharges the check | zero | Layer 2 of the dependent-types position; verifier campaign V1–V6 underway |
| 2. Type | `Result` / `Option` / effect handler — caller handles, compiler enforces | explicit handling | the three D1-blessed styles; `ArrayList.get`, `try_push` |
| 3. Trap | deterministic `__yo_panic` with file:line, then `abort()` (rc 134) | one branch | ArrayList/Deque/Vec/String indexing, `unwrap`, `assert`, `__yo_rc_alloc` OOM |

Phase 5 (elision) is what moves sites from tier 3 to tier 1 over time.

### Why this is the right shape for an LLM-authored language

The LLM workflow is a compile–run–fix loop; its value is the quality of the failure
signal. Ranked by signal quality: UB is noise (symptoms far from cause, `-O0`/`-O2`
divergent, platform divergent — this repository's own `issues/fixed/` history is full
of multi-day UB-shaped campaigns that a trap with a file:line would have closed in one
turn); typed fallibility is best (moves "forgot the edge case" from runtime to compile
time, where LLMs are strongest); a deterministic trap is a one-turn fix. Silent
wrongness (defining `x/0 == 0`, unsigned wrap-around) is the only option strictly worse
than UB for this audience and is rejected throughout.

## 1. Ground truth: the hazard inventory (surveyed 2026-09-21)

What the code actually emits today, with evidence:

| # | Hazard | Today | Evidence | Target | Phase |
| --- | --- | --- | --- | --- | --- |
| H1 | Fixed `Array(T,N)` index read/write | **unchecked** — inlines to `&recv->data[idx]` | `src/codegen/exprs/generation.yo:486`, `src/codegen/exprs/inline_fns.yo:410-417`, `src/codegen/exprs/ptr_fns.yo` (address-of path), `src/codegen/exprs/rc_fns.yo:223-225` (dup helper reads `.data[idx]`) | tier 3 → tier 1 | 1 |
| H2 | `str.bytes(i)` | **unchecked**, documented "bounds are the caller's responsibility" | `std/prelude.yo:7184-7188`, inline at `src/codegen/exprs/inline_fns.yo:328-335` | tier 3 | 1 |
| H3 | Slice element index (`__yo_slice_index` family) | unchecked, same inline shape | the builtin arms beside H1 (audit list in Appendix A) | tier 3 | 1 |
| H4 | Int `/` and `%` by zero | **raw C** — UB | `src/codegen/exprs/inline_fns.yo:222-223` (`__yo_op_div` → `_binop(args, "/")`; `_mod_op` int arm) | tier 3 → tier 1 | 2 |
| H5 | `INT_MIN / -1` (and `INT_MIN % -1`) | raw C — UB/SIGFPE | same sites as H4; nothing anywhere handles it | tier 3 | 2 |
| H6 | Signed int `+ - *` overflow | raw C — UB | `src/codegen/exprs/inline_fns.yo:219-221` | tier 3 (D1) | 3 |
| H7 | Shift count ≥ width | raw C — UB | `inline_fns.yo:236-237` | tier 3 | 3 |
| H8 | Float→int cast out of range | raw C cast — UB | `__yo_as`, `inline_fns.yo:289-306` | saturate or trap (D2) | 3 |
| H9 | Escaped effect unwind past `main` | **silent rc=0** (mechanism corrected on implementation: the flag itself cannot reach top level — task boundaries clear it; the observable defect is the silent task abort, see §3 0a) | `src/codegen/functions/generation.yo` checked the flag after module init only; the -2 writers at `src/codegen/exprs/async_completion.yo` (`emit_async_future_escape`) and the sync_fut resume block in `src/codegen/exprs/async.yo` printed nothing | loud diagnostic + belt | 0 (landed) |
| H10 | Allocation failure | mostly handled — `__yo_rc_alloc` panics via `__yo_alloc_fail` (c-codegen instructions §OOM) | policy documented; coverage unaudited | audited tier 3 | 4 |
| H11 | `--sanitize undefined` | advertised but rejected | help `src/main.yo:7632` (en) / `:7682` (zh); validation `:3397` accepts only `address\|leak\|thread` | works | 0 |
| H12 | Optimistic panic vocabulary callable in safe files | `Option.unwrap`/`Option.expect`, `Result.unwrap`/`Result.unwrap_err` trap on the failure case (`std/prelude.yo:7937-7943`, `:8049-8055`, `:8797-8811`); measured use 2026-09-22: 163 sites / 18 files in `src/`, 2,497 in `tests/`, 234 in `std/`, 0 in `vendor/` and `scripts/` | compile error (D7, class 1) | 0c |

**Status (audit 2026-09-23):** H1, H2, H4, H5, H7, H8, H9, H10, H11 and H12
are closed. H6 closed as a semantics change rather than a UB closure: `-fwrapv` meant
signed overflow was never UB (§6). H3 was retired because the Slice builtins
were deleted before Phase 1 landed. The raw-subscript residue was audited and
is unreachable from user indices (§14 R3).

Already solid (no work): container-impl indexing (ArrayList `std/collections/array_list.yo:857-877`,
Deque, `imm.Vec`, String — all panic on OOB); the Law-of-Exclusivity borrow counter
(`src/codegen/functions/gc_runtime.yo:206-237`); `Send`/`Acyclic` at spawn boundaries
with atomic Arc/Iso refcounts and thread-local heaps; comptime arithmetic and comptime
indexing (already checked: "Division by zero in comptime integer operation",
`src/evaluator/builtins/comptime_numeric_fns.yo:684`; `check_int_overflow` `:160-237`);
float `/` and `%` (IEEE-total — inf/nan/fmod are *defined*, H4/H5 are integer-only problems).

## 2. Scope boundary and non-goals

Safe mode's promises cover **Yo-emitted C in files that do not carry
`pragma(Pragma.AllowUnsafe)`**. Explicitly outside the guarantee:

- `extern`/`c_include` FFI, inline `asm`, raw pointer types, `&` address-of,
  `unsafe(...)` — gated behind the pragma today (`src/evaluator/memory_safety.yo`),
  audited by `yo unsafe-report` / `public_safe_report`.
- The C compiler and libc themselves (miscompiles, libc bugs).
- Stack exhaustion on unbounded recursion — best-effort forever (1 GiB worker stack +
  `YO_MAIN_STACK_MB`); even Rust does not promise this away.
- Data races inside `AllowUnsafe` files. Safe parallelism is already designed
  (`Send`/`Acyclic`); this plan does not touch it.

Non-goals of the *plan* itself:

- **No ambient throw.** `/` does not become an effect. Yo's handlers are explicit
  parameters (evidence passing); making `/` effectful requires threading a handler
  through every dividing function — the ambient-exception design Yo rejected. A
  resumable division, if ever wanted, is an additive `checked_div`-style `Result` API
  (D1 style rules).
- **No std API break.** All checks land in *codegen builtins*, not in std signatures.
  Behavior changes that convert UB into a trap are "bug fixes that make behaviour
  match the documentation" under the S2 additive-only rule — `MEMORY_SAFETY.md` is the
  documentation.
- **No ban on `arr(i)` / `arr(i) = va`.** The hazard is the unchecked builtin, not the
  Index trait and not the assignment syntax: a user Index impl in a safe file cannot
  do pointer arithmetic (pragma-gated), ArrayList's trait impl is already checked, the
  interior-reference concern is owned by the borrow counter + FLOWABILITY, and banning
  familiar syntax makes every LLM prior wrong (the operator-set doc's own argument).
  Syntax stays; semantics become defined.
- No new required CI job without a branch-protection update (manual list — workflow rule).

## 3. Phase 0 — immediate landings: two defect fixes and the D7 policy gate

0a and 0b are standalone defects: per the workflow rules each gets an `issues/` entry
with a fails-before/pass-after test **before** the fix lands. Checked 2026-09-21: neither
has an existing entry (the `__yo_effect_escaped` hits in `issues/` are all about
flag cleanup during propagation, not the missing post-`main` check). 0c is a policy
gate plus a migration, decided as D7 on 2026-09-22.

### 0a — an escaped unwind must be loud (closes H9) — LANDED, mechanism corrected

**As implemented** (the survey's flag-escape story was a prediction and the
repro corrected it — recorded in
`issues/fixed/effect-unwind-escaping-a-task-or-main-is-silent.md`):

1. **Unwind-side task aborts are loud.** The two unwind-side -2 writers —
   `emit_async_future_escape` (`src/codegen/exprs/async_completion.yo`) and the
   sync_fut resume escape block (`src/codegen/exprs/async.yo`) — emit
   `fprintf(stderr, "unhandled effect unwind aborted an async task\n")`.
   `__yo_task_abort` (`src/codegen/async/runtime_core.yo`), the
   `JoinHandle.abort()` path race/timeout use, writes the same state WITHOUT an
   unwind and is deliberately not touched — a cancelled loser must stay
   silent. `JoinHandle.await` continues to return `.None` as the typed channel.
   **Revised after v0.2.40:** printing at abort time fired even when the handle
   was awaited, so a plain `yo build` printed the line 18 times. An abort is now
   *registered*, and any read of the Aborted state observes it silently. A task
   nobody observed prints `unhandled effect unwind aborted an async task that
   was never awaited`, once, when its last reference is released or when the
   program body returns
   (`issues/fixed/an-awaited-task-abort-is-reported-as-unhandled.md`, branch
   `fix/post-release-goldens`).
2. **The post-`__yo_user_main` flag belt: RE-LANDED (2026-09-23).** The
   original belt fired on four legitimate `algebraic_effects` tests: an
   install-frame unwind exit (`(raise : Raise) = handler; raise(...)`, the
   batch/test shape) left the flag SET after correctly exiting the frame —
   flag hygiene, not a swallowed error
   (`issues/fixed/effect-install-frame-exit-leaves-the-escaped-flag-dirty.md`,
   fixed the same day: rule 1 of `_call_is_handler_installation` admits a
   valueless ctl-typed callee via the Func-meta `is_control` flag and a
   callee-name binding search; a test-batch main is a boundary of last
   resort and clears the flag, while real programs abort on it — the
   deliberate escape-to-top idiom exists only in test batches).

**Validated** by patching the seed's emitted C for the fire-and-forget repro
with the exact emitted snippets and running (diagnostic line appears, rc
stays 0), plus the cli-cases `task-effect-unwind-diagnostic` and
`main-non-io-effect-param-rejected` (recorded by hand — the recording binary
must carry the fix).

~~**Tests.**~~ (superseded by the as-built validation above; the original
cli-case shape assumed the abort fires at top level, which the corrected
mechanism ruled out.)

### 0b — make `--sanitize undefined` real (closes H11)

**Change.** `src/main.yo:3397` validation adds `"undefined"`; the consumption `cond`
at `:4015-4035` gains an arm emitting `-fsanitize=undefined
-fno-sanitize-recover=all -fno-omit-frame-pointer`. Use
`-fno-sanitize-recover=all` so UB aborts instead of printing-and-continuing — a
recovering UBSan run is not a gate. The `emcc` reset at `:4012` already covers the
wasm case. Help text is already correct in both languages.

**Purpose.** UBSan is this campaign's measurement instrument: run the self-built
compiler and the test suite under it *before* Phases 1–3 to enumerate the latent
div/shift/overflow/OOB sites, and *after* to validate that the guards themselves are
clean. Whether it becomes a standing CI leg is D6; it does not need to for the
campaign to use it.

### 0c — ban the class-1 panic vocabulary in safe files (D7, closes H12)

**The selection criterion — where does the failure information live?** Classify every
panicking std surface by this one question, and the ban list falls out mechanically:

| Class | Definition | Examples | Ruling |
| --- | --- | --- | --- |
| **1. Failure is in the TYPE; the call erases it** | The argument's type already says "might fail" (`Option(T)`, `Result(T,E)`) and the callee returns the payload while trapping the failure case — the caller held the information and threw it away | `Option.unwrap`, `Option.expect`, `Result.unwrap`, `Result.unwrap_err` | **compile error in safe files, now** |
| **2. Failure is a VALUE-level precondition** | A fact about values the type does not carry | `list(i)` needs `i < len`; `/` needs `rhs != 0`; `substring` needs a rune boundary | tier-3 trap (phases 1–3); banning is Phase 6, where proofs replace checks. Typed alternatives (`get`, `try_substring`, future `checked_*`) coexist |
| **Deliberate abort** | The author's own loud statement | `panic(msg)`, `assert(cond, msg)` | never banned — and `assert` is the test infrastructure |
| **Environment failure, no typed alternative at this abstraction** | Runtime conditions outside the value world | allocation failure (`__yo_rc_alloc`), borrow-exclusivity aborts | keep, documented |

The one-sentence test to apply to any candidate: ***would this call ignore failure
information the type already gave the caller?*** If yes, class 1.

Why this line and not "anything that can panic": banning class 1 requires no verifier
(the discarded information is static), forks no operator types, and changes no std API
(it is a call-site gate — the functions remain for `AllowUnsafe` files, test files, and
comptime). Banning class 2 *today* would force tier 2 onto operators (`a / b :
Result(...)`) — a different language — which is exactly why class 2 waits for Phase 5b/6.
Note `String.substring` stays legal despite panicking on intra-rune offsets: its
precondition is value-level (class 2), and classification is by the criterion, not by
whether a `try_*` alternative happens to exist.

**The comptime carve-out — RE-MEASURED 2026-09-23: nothing to exempt; the
real defect is a lost comptime panic.** The 2026-09-22 probe (`o :=
Option(i32).None; o.unwrap();` panics at runtime) measured a *runtime*
binding, not a comptime context. Two measurements on v0.2.39 retire the
carve-out's premise:

1. `unwrap` is not comptime-evaluable at all. `Z :: Option(i32).Some(i32(7)).unwrap();`
   fails with `Expected compile-time value for "Z"`, so no comptime `unwrap`
   call exists for an exemption to cover.
2. The comptime spelling already exists and is legal in safe files:
   `comptime_unwrap` / `comptime_unwrap_err` (`comptime(self)` methods in the
   prelude). They are outside the class-1 name list by construction.

So D7's "comptime `unwrap` stays legal" already holds for the spelling that
exists. What does not hold is "decidable ⇒ checked at compile time":
`Z :: Option(i32).None.comptime_unwrap();` passes `yo check` (rc 0). When `Z`
is used, compilation fails only in clang (`use of undeclared identifier 'Z'`),
and a free comptime fn that reaches `__yo_panic` reports `Function body is not
evaluated correctly…` with the panic's message lost. The fix belongs in
`evaluate_panic`, not in the class-1 predicates: a `__yo_panic` reached while a
comptime function body is *executing* becomes a compile error that carries
its message (§14 R2). The Phase 5b `requires(is_some)` upgrade is unaffected.

**Mechanism (as built).** Evaluator-only, three gate sites over the shared
predicates in `src/evaluator/memory_safety.yo`
(`is_class1_panic_method_name` / `is_class1_panic_receiver_type` /
`is_class1_panic_exempt_file` — nominal `EnumT` name match on
Option/Result, the same rule the io-builtin classification uses):

1. property_access.yo, metadata gate — the receiver's ExprInfo names the
   type without re-evaluating anything (variable receivers, the 99% form);
2. property_access.yo, TypeVal arm — `Option(i32).unwrap` as an EXTRACTION
   (the bypass form);
3. calls/function.yo, dispatch gate beside `_reject_private_method_call` —
   the receiver type comes from the RESOLVED method's own first parameter,
   so it catches fresh call-result receivers the metadata gate cannot see
   (`make(flag).unwrap()`).

Exemptions (each a documented rule, not a hole): `*.test.yo` (2,497
in-tree sites stay — a failed unwrap fails the test loudly, the test doing
its job), `pragma(Pragma.AllowUnsafe)` files, and compiler-synthesized
`auto-generated://` code. `std/` was a fourth, temporary exemption and the
ratchet closed it on 2026-09-23. Of std's 233 sites, 207 sit in `AllowUnsafe`
files and are exempt by the pragma, exactly as a user's would be. 17 are doc
comments. The remaining 9 calls, in two safe files (`std/http/http.yo` and
`std/encoding/html_entities.yo`), were migrated. The blanket std branch of
`is_class1_panic_exempt_file` is gone, so a new unwrap in a safe std file now
fails like one in user code. New diagnostic via
`format_error_message_with_help` (the pointer-gate precedent — the
E0xxx/`yo fix` registry entry is deferred until the first diagnostic sweep
of this campaign's gates). A declaration-site `panics` marker that
generalizes the registry to user libraries is the documented future
extension — build it when a second library needs it, not before.

**Governance — how the list stays honest.** (1) `src/public_safe_report.yo`
grows a class-1 section cross-checking the predicates against reality, so a
renamed or newly added class-1 function is a report diff, not a silent
hole. (2) std policy, extending the D1 three-styles rule: **no NEW class-1
APIs** — a new accessor whose failure is in the type must force handling;
`unwrap`-style helpers exist only as the escape vocabulary. (3) The
accepted loophole: user code can hand-write `fn unwrap2(o : Option(T)) ->
T` with a `match` + `panic` body — visible, greppable, carrying its
invariant in source. That is the ban working (converting invisible
optimism into a statement), not a hole to close.

**Migration (as measured, corrected 2026-09-22).** The raw count overstated
the work: 155 of the 163 `src/` sites already sit in
`pragma(Pragma.AllowUnsafe)` files (exempt). The migration was **19 sites
in 5 files**, each with a real decision: provably-Some sites (guards
checked immediately before) carry visible `__yo_panic("invariant")` arms;
the genuinely fallible version parsers in resolver.yo now return
`Result.Err` naming the input instead of aborting (behavior-compatible for
every valid input, and `parse_version_req` exists to report exactly this);
the two post-`throw` unreachable fillers use `__yo_panic` directly.
`vendor/` and `scripts/` were clean (0 uses). The gate and the migration
land together in one PR (`yo check ./src` is the first gate — it fails
otherwise).

**Tests.** cli-cases `safe-mode-unwrap-rejected` (call form),
`safe-mode-unwrap-extraction-rejected` (extraction form),
`safe-mode-unwrap-allowed-with-pragma` (the AllowUnsafe exemption, rc 0) —
goldens recorded by hand, the recording binary must carry the gate; the
exempt `*.test.yo` and `std/` corpora ARE the positive tests (2,497 +
234 sites compile and run through every battery); the migrated `src/` tree
under the standard battery is the large regression.

## 4. Phase 1 — bounds-checked indexing builtins (closes H1, H2, H3)

**Design.** One runtime helper, one shared emitter, four splice sites.

Runtime (C11, `static inline`, emitted in the runtime preamble beside the
`__yo_panic`/flags family — follow the declare-before-use rule, c-codegen
instructions §"A new runtime function must be DECLARED before anything that calls
it"; the declaration buffer flushes first):

```c
static inline size_t __yo_idx_chk(size_t i, size_t n, const char* f, int r, int c) {
    if (i >= n) {
        fprintf(stderr, "index out of bounds: %zu not in [0, %zu) (at %s:%d:%d)\n",
                i, n, f, r, c);
        abort();
    }
    return i;
}
```

Emitter: a single helper, e.g. `_checked_index_expr(recv, idx, len_expr, tok,
context)` in `src/codegen/utils/index.yo`, returning the idx sub-expression to splice.
Every site that today writes `&recv->data[idx]` or `s.ptr[idx]` becomes
`&recv->data[__yo_idx_chk((size_t)(idx), (size_t)(LEN), "file", row, col)]` — the
helper returns the index, so lvalue-ness, the `&(…)` address-of shape, and the
auto-deref path are all untouched. `LEN` is the comptime `N` for fixed arrays, the
slice's runtime length field, and `.len` for `str`. File/row/col come from
`ast_expr_token(expr)` (the `BF_YO_MAYBE_UNINIT_NEW` arm at `inline_fns.yo:384` is the
precedent for deriving stable source positions there).

Sites to convert (grep gate below is the acceptance proof — Appendix A has the full
list with the strings to grep):

1. `_generate_index_trait_call` fixed-array arm — `src/codegen/exprs/generation.yo:486`
2. `BF_YO_ARRAY_INDEX` arm — `src/codegen/exprs/inline_fns.yo:410-417`
3. the `is_index_trait_address_of` address-of path — `src/codegen/exprs/ptr_fns.yo`
4. `__yo_dup_array_element`'s `.data[idx]` read — `src/codegen/exprs/rc_fns.yo:197-262`
5. `BF_YO_STR_BYTE` — `src/codegen/exprs/inline_fns.yo:328-335` (LEN = `(_a(args,0)).len`)
6. the `__yo_slice_index` builtin arm(s) beside (2)

Literal fold: when the emitted idx string is a bare decimal literal and LEN is a
comptime literal (fixed arrays), compare at emission time and emit the raw index —
five lines, keeps comptime-shaped code byte-identical. Conservative regex
(`^[0-9]+$`), nothing else folds.

Update `std/prelude.yo:7184`'s `bytes` doc comment ("bounds are the caller's
responsibility" → "panics on out-of-range"). Comment-only prelude edits shift emitted
counters (the byte-identity lesson in testing.instructions) — fixpoint compares
stage-2 vs stage-3 of the *same* generation, so the gates stay valid.

**Tests** (`tests/`, plus wasm32 legs — `usize` is 32-bit there, the width lesson):
runtime-idx OOB read, `arr(i) = va` store, `&(arr(i))` address-of, RC-element
consumption (Array of `String` — exercises the dup-helper site), `str.bytes` OOB,
slice OOB, boundary `i == len`, every width. Trap-message and rc assertions live in a
cli-case (a batch test cannot assert on its own abort), mirroring 0a. Comptime
indexing behavior is unchanged and already tested.

**Gates.** Standard battery plus the grep acceptance:
`rg -n -- '->data\[|\.ptr\[' src/codegen --glob '*.yo'` must return only hits inside
the shared helper. Then fixpoint (`S1=/tmp/yo-s1` copy, never the in-repo stage-1) and
`hollow_sweep69.sh` — **expect new reds**: latent compiler OOBs becoming traps is this
phase working, and each one gets an `issues/` entry and a fix per the workflow rules.
Budget for that explicitly.

**Perf protocol** (every phase, same recipe): median of 3 × wall time for `yo check
./src` and a full `yo build` on the same machine, before/after, recorded in the PR.
The guard is a `static inline` compare that clang/gcc fold at `-O1+`; at `-O0` it is a
call per index. If the self-compile regression exceeds ~5%, pull Phase 5a forward
rather than weakening the check.

## 5. Phase 2 — checked integer division and remainder (closes H4, H5)

**Design.** Mirror `_mod_op`'s shape (`src/codegen/exprs/inline_fns.yo:122-129`): a
`_div_op(args, expr, context)` arm replaces `BF_YO_OP_DIV => _binop(args, "/")`, and
`_mod_op`'s integer arm gains the same guard. `ei_ty(expr, context)` already tells the
emitter the result type (that is how `_mod_op` picks `fmodf`/`fmod`), and every
prelude int `Div`/`Mod` impl routes through these two builtins
(`std/prelude.yo:1905-1916` and the i8–usize parallels), so two arms cover the whole
language.

- `f32`/`f64`: unchanged — IEEE division/fmod are total. No guard, no message, ever.
- Unsigned ints: guard the divisor only.
- Signed ints: guard divisor-zero **and** `MIN / -1` (`MIN % -1` traps identically on
  x86 and is UB in C). The MIN constant is spliced per width from a width→literal
  table in the emitter (spell `(-9223372036854775807LL - 1)` for 64; never
  `1 << 63`).

Expression form — a comma-expression, parenthesized exactly like `_binop`'s output so
every consumer position stays legal:

```c
(__yo_div_guard((long long)(a), (long long)(b), <MIN-literal>, "f", r, c), ((a) / (b)))
(__yo_div_guard_u((unsigned long long)(b), "f", r, c), ((a) / (b)))
```

```c
static inline void __yo_div_guard(long long a, long long b, long long tmin,
                                  const char* f, int r, int c) {
    if (b == 0 || (a == tmin && b == -1)) {
        fprintf(stderr, "integer division/remainder by zero%s (at %s:%d:%d)\n",
                (b == 0) ? "" : " (or INT_MIN by -1)", f, r, c);
        abort();
    }
}
static inline void __yo_div_guard_u(unsigned long long b, const char* f, int r, int c) {
    if (b == 0) { fprintf(stderr, "integer division/remainder by zero (at %s:%d:%d)\n", f, r, c); abort(); }
}
```

Copy `_binop`'s degraded-render guard (the `// Failed to transpile` prefix check) into
the new arms. Comptime division already errors at compile time
(`comptime_numeric_fns.yo:684`); after this phase runtime matches comptime — worth
stating in DESIGN.md as the consistency argument.

**Tests.** `/` and `%` by zero on i8/i16/i32/i64/u8/u16/u32/u64/isize/usize (derive
boundary values from `sizeof * 8`, never hardcode 61/63 — the wasm lesson);
`MIN / -1` and `MIN % -1` per signed width; valid divisions unchanged; `cond((y !=
i32(0)) => (x / y), …)` still fine; float `/` by zero still yields `inf` (assert it —
that is now a *documented guarantee*, not an accident). Trap oracles in a cli-case
like Phase 1. Wasm legs: wasm traps div-by-zero natively, but the guard must fire
first with the message.

**Gates.** Standard battery; grep acceptance: the only `"/"` / `"%"` literals in
`generate_yo_inline_function_call` are inside `_div_op`/`_mod_op`. Same
latent-bug expectation and perf protocol as Phase 1 (the compiler itself divides
constantly — hashing, alignment, capacity math).

## 6. Phase 3 — arithmetic semantics: overflow, neg, shifts, casts (closes H6–H8)

Landed as three separately-measured PRs: 3a overflow + neg, 3b shifts, 3c casts.

### 3a Overflow and negation — LANDED (#837; follow-ups #841)

**Discovery that re-framed H6:** the survey missed that Yo passes **`-fwrapv`**
unconditionally (`src/main.yo`), so signed overflow was already DEFINED as
two's-complement wrap, and unsigned overflow is defined modular arithmetic.
H6 was therefore never a UB closure. It is a semantics change from
defined-but-silently-wrong to a trap, with a hard prerequisite: in-tree code
wraps on purpose. SipHash's mixing adds and FNV-1a's multiply ARE the
algorithm, and trapping them breaks every HashMap/HashSet.

That prerequisite is why the escape hatch shipped in the same PR as the traps
(#837):

1. **3a-i: wrapping builtins.** `wrapping_add` / `wrapping_sub` /
   `wrapping_mul` on all ten integer widths. One generic prelude impl over
   `where(T <: Integer)` sits on three `__yo_op_*_wrap` builtins whose codegen
   arm is the raw op. These are the only way to wrap in safe code.
2. **3a-ii: intentional-wrap sites migrated.** `std/hash.yo`, `std/rand.yo`,
   and `std/crypto/{sha256,sha512,sha1,md5}.yo` in #837. Two sites the
   inventory missed were caught by CI and migrated in #841:
   `std/collections/hash_map.yo`'s `mix_u64` (murmur3 fmix64) and
   `std/sync/atomic.yo`'s CAS-loop `fetch_add`/`fetch_sub`. Length and buffer
   counters are not wrap-by-design and stay plain. The `tests/crypto/`
   RFC/FIPS vectors are the bit-exactness oracle.
3. **3a-iii: the traps.** `integer {addition,subtraction,multiplication,negation}
   overflow (at file:r:c)` at every `--optimize` level.

Original policy (D1, still the ruling): trap on overflow for signed AND
unsigned `+ - *` and on
`-MIN`** in safe files, at every `--optimize` level (D4). Rationale: comptime already
*errors* on overflow (`check_int_overflow`) — trapping is the runtime match; unsigned
wrap is C-defined but silently wrong, the one failure mode this campaign exists to
eliminate; `-O`-dependent semantics (Rust's debug/release split) sends LLM loops
chasing bugs that reproduce only in release. Escape hatches arrive later as additive
std API (`Int.checked_add -> Option`, `wrapping_add`) if hot paths need them, and as
Phase 5 elision for provable cases. Alternatives considered and rejected are recorded
in §13-D1 so the ruling is reversible with its tradeoffs visible.

**Implementation.** Replace `_binop(args, "+")`/`"-"`/`"*"` for integer result types
with value-returning checked helpers — the `_callop2("fmod")` precedent of a function
call in expression position:

```c
(__yo_add_i64((a), (b), "f", r, c))   // static inline, returns the checked sum
```

**No GNU builtins** (`__builtin_add_overflow` is out — C11-only, the MSVC target
rules it out, c-codegen instructions §"Stick with C11 standard"). Portable scheme:

- widths ≤ 32 bits: widen to `long long` / `unsigned long long`, add, range-check
  against the target width's MIN/MAX, narrow on success. Trivially correct.
- 64-bit widths: same-width unsigned arithmetic + the standard overflow identities —
  add: `((a ^ r) & (b ^ r)) < 0`; sub: `((a ^ b) & (a ^ r)) < 0`; mul: `b != 0 && (r
  / b) != a` (plus sign shortcut). Encode once per helper.
- `-x` (the `_unop_narrowed` neg arm): trap on `x == MIN` for the operand width —
  note `-(int8_t)-128` promotes to `int` 128 today and only the narrowing cast makes
  it UB, so the guard belongs before the cast.

### 3b Shifts (closes H7)

Guard `sh < bits` for both `<<` and `>>` (`__yo_sh_guard(sh, bits, f, r, c)` comma-form
like Phase 2 — the shifted *value* is unchanged, only the count is validated). Sign of
`>>` on negatives is implementation-defined in C but uniform (arithmetic) across every
compiler Yo targets — document it as Yo semantics rather than guarding. Same width
derivation discipline (wasm!).

### 3c Float→int casts (closes H8, needs ruling D2)

**Recommended policy (D2): Rust-style saturating cast** (`NaN → 0`, out-of-range →
MIN/MAX of the target type) in `__yo_as`'s float→int arm. Rationale: it is the
mainstream prior every LLM carries, and `i32(x)` on `inf` saturating is benign in a
way `arr(garbage_index)` never is. The alternative — trap — is more consistent with
the ladder and is the right choice if the maintainer weighs strictness over priors.
Int→int narrowing stays truncation (implementation-defined in C, uniform in practice —
document it).

**Tests.** Boundary arithmetic per width (`127+1`, `255+1`, `MIN - 1`, `MIN * -1`,
`MIN / -1` already Phase 2), derived boundaries for `usize`/`isize`, shift by
`bits`/`bits-1`/`0`, `float→int` on `inf/-inf/nan/3.9e9/-3.9e9`, `--optimize 0` and
`2` both (D4 says results must be identical). A UBSan pass over the self-built
compiler (`yo check ./src` under 0b) must report zero arithmetic UB after 3c.

## 7. Phase 4 — allocation-failure coverage audit (closes H10) — LANDED (audit)

**As built (2026-09-22):** audited every runtime allocation in
`src/codegen/**` against the NULL-check/propagation policy. Result: the
policy holds everywhere EXCEPT one site — the cycle collector's scratch-array
growth (`__yo_gc_gather_white` in `src/codegen/functions/gc_runtime.yo`)
overwrote `gc->gc_white` with realloc's NULL on failure and NULL-derefered on
the immediate store. Fixed per the house OOM policy (cannot-propagate sites
abort via `__yo_alloc_fail`). The checked sites (wasm/Windows I/O runtime
`-ENOMEM` paths, TLS credential/connection allocations, the TLS buffer-grow
helper) were verified clean. The regression oracle remains the fixed
allocator (`--allocator fixed --heap-size 64K` makes OOM deterministic); the
existing `compile-allocator-fixed-oom` cli-case pins the `__yo_alloc_fail`
message path end-to-end.

**Open (§14 R5):** only one of the five tiny-heap oracles below exists.
`compile-allocator-fixed-oom` covers RC construction. Async task spawn,
thread spawn, and a deep `String` build have no case yet.

The policy already exists (`__yo_rc_alloc` panics via `__yo_alloc_fail`; the OOM
section of c-codegen.instructions) and `ArrayList.push` already traps on allocation
failure while `try_push` returns `Result`. This phase is an audit, not a design:
grep every runtime allocation in `src/codegen/**` (`__yo_malloc`, `realloc`, `calloc`,
TLSF paths in `src/codegen/c/allocator_fixed.yo`, the async/parallelism runtimes) for
a result used without a NULL check and no `if (!p) return -E…` path — each becomes
`__yo_rc_alloc` or an explicit failure return.

The regression oracle is the fixed allocator: `yo compile --allocator fixed
--heap-size 64K` makes OOM deterministic and cheap to force. Add cli-cases (tiny
heap → rc 134 + the `__yo_alloc_fail` message, never a segfault) for: RC object
construction, async task spawn, thread spawn, a deep `String` build.

## 8. Phase 5 — check elision: local first, verifier later

### 5a Local elision (pure codegen, no Z3) — RESOLVED as a documented non-change

**Measurement (2026-09-22, CI `test (ubuntu-latest)` durations on consecutive
stack branches, one full battery each — all six legs PASSED):**

| Branch | Content | Ubuntu duration |
| --- | --- | --- |
| safe-mode-0a | Phase 0 only (baseline with belt removed) | 78m16s |
| safe-mode-0b | + UBSan flag (CLI only, no runtime cost) | 76m33s |
| safe-mode-0c | + D7 evaluator gates (evaluator-only) | 63m56s |
| safe-mode-1 | + `__yo_idx_chk` indexing guards | 79m19s |
| safe-mode-2 | + div/rem guards | 78m47s |
| safe-mode-4 | + gc scratch-realloc fix | 81m20s |

**Decision: no elision is built.** The runner-to-runner noise floor (0b→0c
swung −14m with zero runtime-code change) exceeds any per-phase delta; the
decisive evidence is that every battery passed WITH all guards active — no
batch deadline, ratchet, or timeout was breached. The guards' cost is within
CI tolerance, so per the plan's own rule 5a collapses into a documented
non-change. Revisit only if a measured regression appears; the extraction
command below re-runs in one pass.

**Measurement protocol (written 2026-09-22; the numbers land with the stack's
CI runs).** The per-phase guard cost is read from CI's `test (ubuntu-latest)`
job durations on consecutive stack branches — each branch is the previous
plus exactly one phase, so the delta IS that phase's guard cost over the
full corpus compile+run:

```bash
for b in safe-mode-0a safe-mode-0c safe-mode-1 safe-mode-2; do
  id=$(gh run list --branch $b --workflow test.yml --limit 5 \
        --json databaseId,conclusion,headSha \
        --jq '[.[] | select(.conclusion == "success")][0].databaseId')
  echo "$b $(gh run view $id --json jobs --jq \
    '.jobs[] | select(.name == "test (ubuntu-latest)") |
     ((.completed_at | fromdate) - (.started_at | fromdate))')"
done
```

Branches 0a→0c share identical runtime codegen (0c is evaluator-only), so
their spread measures noise; 0c→1 adds the `__yo_idx_chk` guards; 1→2 adds
the div guards. Decision rule: if the 0c→1 delta is within noise (< ~2%),
5a stays a documented non-change and the phase collapses into 5b; if it
exceeds budget, build the two dominating-guard shapes below and re-measure.

Two canonical dominating-guard shapes, recognized at emission:

- a `while(i < LEN)` loop header dominating accesses to `i`-indexed
  elements/cells of the thing whose length is the *same emitted expression*;
- a `cond((i < LEN) => …)` test dominating the accesses in its arm.

Match conservatively: same length-source expression string, same function, dominated
block only; on any mismatch, emit the guard. Before building this, **measure whether
the C compiler already does it** — the guard helper returns the index, so a dominating
`i < n` compare and the guard's `i >= n` compare are textbook CSE at `-O2`, and
`-O0`/`-O1` self-builds are the only candidates. If `-O2` recovers everything, 5a
shrinks to a documented non-change and the phase collapses into 5b.

### 5b Verifier-driven elision (tier 1) — FV gate LIFTED 2026-09-23, design not started

The gate this section named is closed: FV V1–V7 landed, including V6's remaining
slices and the `assumed()`/`outside-subset` visibility work
(`plans/backlog/FORMAL_VERIFICATION.md`, V7 COMPLETE banner, #785). What
remains is design, and it belongs in its own plan when picked up (§14 R8). The
three questions it must answer are listed below the original sketch.

Original sketch:

Attach Layer-2 refinements — `requires(rhs != i32(0))` on the Div contracts,
`requires(i < self.len())` on Index contracts — and let `yo verify` discharge them at
call sites; codegen consumes the discharged set and drops guards. This is the
dependent-types position's own canonical example, and it must not be designed further
here: it depends on `plans/backlog/FORMAL_VERIFICATION.md` landing its remaining V6
slices, on the `assumed()`/`outside-subset` holes being visible (the yo-design
instructions' verifier section), and on a real decision about coupling codegen to an
offline, optional-Z3 tool (`yo check` today skips-without-hint when Z3 is missing —
#760 — and that split must survive). Sketch only until then.

The questions for the 5b plan (added by the 2026-09-23 audit):

1. **No Z3 dependency in codegen.** `yo compile` without a solver must keep
   emitting every guard. Elision is an optimization, enabled only by a
   discharged-obligation set that `yo verify` produced for the same source.
2. **The channel.** How a discharged obligation names its guard site: a
   stable per-site id that survives between `yo verify` and `yo compile`,
   including across `--emit-chunks` units.
3. **Soundness of the set.** `assumed()`, `outside-subset`, timeout, and
   `unknown` outcomes must never elide a guard. Over-elision needs the canary
   discipline 5a specified: a test that fails if a guard disappears without a
   proof.

## 9. Phase 6 — strict mode (deferred sketch)

An opt-in (`--safe=strict`, or `pragma(Pragma.SafeStrict)`) where an unprovable,
unhandled trapping site is a **compile error** naming the site and the remedy
("cannot prove `i < 10` at foo.yo:7:3 — use `get(i)`, add a guard, or install a
handler"). Semantically it is Phase 5b plus a compiler flag that turns "guard emitted"
into "error reported" — D7 (Phase 0c) is its first slice, already pulled forward: strict
mode extends the same principle from class 1 (failure in the type, banned now) to class
2 (value-level preconditions, banned where provable, checked elsewhere) and to the
deliberate-abort vocabulary. Do not build it before 5b exists; do not make it the
default ever (it outlaws container indexing and arithmetic-as-written — the
std-stability and boilerplate arguments of §0).

## 10. Cross-cutting: staging, gates, traps this campaign will hit

**Sequencing.** 0a → 0b → 0c → 1 → 2 → 3a → 3b → 3c → 4 → 5a → (5b, 6 deferred). 0c is
evaluator-only and independent of 0a/0b and of the codegen phases — it can land in
parallel with Phase 1 if that helps review latency. Each
phase (and each 3x slice) is its own PR, squash-merged; work in a worktree under
`$HOME/Workspace/Yo-wt/`, commit and push before every heavy gate run.

**Standard battery per phase** (AGENTS.md): `yo check ./src` first;
`yo compile src/main.yo --skip-c-compiler`; fast suite with both excludes; `yo test
./std`; `tests/internal` one file at a time; `S1=/tmp/yo-s1 P=local bash
scripts/bootstrap/fixpoint_only.sh` (stage-1 copied outside the repo, same tree);
`BIN=/tmp/yo-s1 OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh` with
`known-failing.tsv` ratchet updates.

**Seed staging.** Phases 0a–0b and 1–4 change only codegen emission and one prelude
comment — no Yo-source API changes — so no seed version is involved and no `build.yo`
builtin rules apply. Phase 0c changes the evaluator and migrates `src/` — still plain
Yo source with no new API, so the seed compiles it unchanged; the new gate activates
only in binaries built from this tree, and the gate + migration must land together or
`yo check ./src` fails (which is the first gate anyway). The seed keeps compiling the
new compiler source unchanged; the new
binary's *own* emitted C gains the checks from its first self-compile. That
self-compilation is exactly where latent compiler bugs surface; treat each as a find,
not a regression.

**Traps specific to this campaign** (each has bitten before — see the instruction
files): any `.github/skills/` cheatsheet edit re-records SEVEN cli-cases; prelude
edits shift emitted-C counters so byte-identity gates are invalid — use the
normalized-diff / output-diff recipes in testing.instructions; new runtime C must be
C11-clean under `-Werror=incompatible-pointer-types` (clang 22 on windows-11-arm) —
prototype with `zig cc -target x86_64-windows-gnu`; declared-before-used in the
two-buffer emitter (hoist forward declarations like `runtime_core.yo` does); wasm
legs for anything width-adjacent; cli-case fixtures get `yo fmt` before `--record`;
embedded Yo in scripts/workflows is covered by GATE 8 (`scripts/check-embedded-yo.sh`)
— semantics changes don't remove forms, but run it anyway.

**Perf budget.** Record the §4 protocol numbers in every phase's PR. Escalation order
when over budget: (1) verify the C compiler's CSE at the shipped `-O` level, (2) build
5a's two shapes, (3) widen the literal fold. Never: weaken a check or make semantics
`-O`-dependent (D4).

## 11. Documentation and instruction updates (per phase, not a cleanup at the end)

**Audit 2026-09-23.** Done: `MEMORY_SAFETY.md` en+zh (the class-1 ban and the
integer-overflow table), the `bytes` doc comment in the prelude, and the
E0611 registry entry with `yo explain`. Not done: everything else in this
list (§14 R4). The worst gap is in `.github/skills/yo-syntax/syntax-cheatsheet.md`,
which still teaches that *runtime signed overflow wraps (`-fwrapv`)*. Since
#837 that is false, and every agent reading the cheatsheet learns the wrong
semantics.

- `docs/en-US/MEMORY_SAFETY.md` + `docs/zh-CN/MEMORY_SAFETY.md`: after Phase 1 the
  "All indexing is bounds-checked" claim becomes true; after 2–3 add the arithmetic
  semantics table (trap on div-by-zero/MIN-div/overflow/shift, saturating casts) and
  the failure ladder (§0 of this plan, in user language).
- `docs/*/DESIGN.md`: an "Arithmetic and failure semantics" section; the
  comptime/runtime consistency argument.
- `docs/*/STRINGS.md`: `str.bytes` contract change (traps on OOB).
- `docs/*/ALGEBRAIC_EFFECTS.md`: the Phase 0a guarantee — an escaped unwind aborts
  with a message instead of exiting silently.
- With Phase 0c: `docs/*/MEMORY_SAFETY.md` documents the class-1 ban and the
  exemptions; the new diagnostic enters `src/diagnostics_registry.yo` with its
  `yo explain` entry and a `yo fix` repair; `.github/instructions/yo-design.instructions.md`
  + the skills cheatsheet record the rule and the criterion (→ SEVEN cli-case
  re-records).
- `.github/instructions/c-codegen.instructions.md`: the new runtime helpers
  (`__yo_idx_chk`, `__yo_div_guard*`, the arithmetic family), the shared-index-emitter
  rule ("never write `->data[` outside the helper"), the no-GNU-builtins checked
  arithmetic scheme.
- `.github/instructions/yo-design.instructions.md` + the syntax cheatsheet in
  `.github/skills/` (→ SEVEN cli-case re-records): the arithmetic trap semantics and
  the ladder.
- `plans/README.md`: this file's backlog entry (added with the doc).

## 12. Effort and dependency summary

| Phase | Deliverable | Depends on | Risk | Size |
| --- | --- | --- | --- | --- |
| 0a | escaped unwind loud — LANDED (#828); belt re-landed with the install-frame fix (#858) | — | — | small |
| 0b | `--sanitize undefined` works — LANDED (#829) | — | none | tiny |
| 0c | class-1 panic vocabulary banned in safe files (D7) — LANDED (#831); 19-site src migration (155 of 163 were already exempt) | D7 (decided) | extraction-path bypass gated too | small–medium |
| 1 | checked fixed-Array/`str.bytes` indexing — LANDED (#833); H3 retired (Slice deleted) | 0b (as instrument) | latent compiler OOBs surface; perf | medium |
| 2 | checked int `/` `%` incl. `MIN/-1` — LANDED (#835) | 0b | latent `/0` bugs; perf | small–medium |
| 3a | overflow + neg traps (D1) — LANDED (#837) with the `wrapping_*` escape hatch and the wrap-site migration; #841 caught two more sites | D1/D4 (adopted) | perf; the biggest semantic change | medium |
| 3b | shift guards — LANDED (#837) | 3a infra | low | small |
| 3c | saturating float→int casts (D2) — LANDED (#837) | ruling D2 (adopted) | low | small |
| 4 | OOM audit — LANDED (#836): cycle-collector scratch realloc NULL-deref fixed | — | low | small |
| 5a | local elision — CLOSED as a documented non-change (§8 measurement) | — | — | — |
| 5b | verifier-driven elision | FV campaign (LANDED V1–V7; gate lifted) | design not started (§8 questions) | large |
| 6 | strict mode | 5b | — | deferred |

## 13. Decisions (all ruled 2026-09-22: every recommendation adopted)

- **D1 — overflow policy.** RECOMMEND trap on signed *and* unsigned overflow and
  `-MIN`, all `--optimize` levels. Alternatives: unsigned-wraps (C-defined, but
  silent-wrong); Rust's debug/release split (rejected: `-O`-dependent semantics);
  always-wrap (rejected: silent-wrong).
- **D2 — float→int out-of-range cast.** RECOMMEND Rust-style saturating, NaN→0
  (mainstream LLM prior). Alternative: trap (more ladder-consistent).
- **D3 — escaped-unwind exit.** RECOMMEND abort with message (rc 134). Alternative: a
  soft distinct exit code (plumbing through the worker-thread `main`, and collides
  with the main-return-value family).
- **D4 — are checks semantics or debug aids?** RECOMMEND semantics: present and
  identical at `-O0`–`-O3`; only proofs (5) remove them.
- **D5 — slice/substring clamp inconsistency.** `str.slice_copy` *clamps* out-of-range
  (`std/prelude.yo:7194-7198`) while `String.substring` clamps ranges but panics on
  rune-interior offsets. RECOMMEND documenting the clamp as intended this campaign
  (changing it is a std behavior change with no UB behind it), revisit under strict
  mode.
- **D6 — a standing UBSan CI leg.** RECOMMEND adding an optional workflow leg after
  0b proves it stable; make it a required check only with the manual
  branch-protection update the workflow rules require.
- **D7 — panic vocabulary in safe files.** **DECIDED 2026-09-22 (maintainer): ban
  class 1.** Safe files may not call a function whose signature erases a fallible type
  into its payload with a trap — `Option.unwrap`/`expect`, `Result.unwrap`/`unwrap_err`
  — because the caller is discarding failure information the type already gave them.
  Deliberate abort (`panic`/`assert`) and class-2 value-level traps stay legal; comptime
  `unwrap` stays legal (decidable ⇒ checked at compile time); the endgame upgrades the
  spelling to `requires(is_some)` under Phase 5b rather than killing it. Full criterion,
  mechanism, exemptions, and governance: §3, Phase 0c.

## 14. Remaining work (audit 2026-09-23)

In landing order. Each item is its own PR, stacked; none merges before the
v0.2.40 release publishes.

**Progress:** R1–R5 are done on the stack `safe-mode-5-ratchet` →
`safe-mode-5-comptime-panic` → `safe-mode-5-docs` → `safe-mode-5-oracles`. R6
ran on `safe-mode-5-ubsan`: one finding fixed, one class awaiting a ruling. R7
and R8 are open.

- **R1 — close the std unwrap ratchet. DONE.** Migrate the 9 remaining calls in
  safe std files and drop the blanket std branch of
  `is_class1_panic_exempt_file` (§3 0c exemptions). Positive test: `yo check
  ./std` and `yo test ./std` under a tree-built compiler.
- **R2 — a comptime panic is a compile error. DONE** (`issues/fixed/a-comptime-panic-is-not-a-compile-error.md`). A `__yo_panic` reached while a
  comptime function body is executing must fail the compile, carry its message,
  and point at the call site. Today it is `rc 0` from `check` plus a clang error,
  or a message-less "Function body is not evaluated correctly" (§3 0c
  carve-out). Needs an `issues/` entry plus a fails-before/passes-after test.
- **R3 — raw-subscript residue: VERIFIED NOT REACHABLE (2026-09-23).** Every
  raw `.data[` left in `src/codegen` indexes with a compiler-chosen in-range
  value. The array drop/dup walks and the constructor fill loop over `0..N`.
  `__yo_dup_array_element` / `__yo_drop_array_element` are generated only by
  `src/evaluator/builtins/dup.yo` with the literal indices `0..N-1`, so the
  unguarded `direct_ref` fallback in `rc_fns.yo` never sees a user index.
  Measured: an `Array(Node, 3)` (`Node :: ref(...)`) read at a runtime index
  of 3 emits `arr.data[__yo_idx_chk((size_t)(i), (size_t)(3), …)]` and aborts
  with `index out of bounds: 3 not in [0, 3) (at r3.yo:8:8)`, rc 134.
  Appendix A's literal grep acceptance cannot pass as worded; read it as "no
  user-controlled index reaches a raw subscript", which holds.
- **R4 — the §11 docs and instruction debt. DONE.** The verifier doc's "overflow is defined semantics" claim was fixed too. Proofs stay sound for every run that returns, but trap-freedom is not an obligation yet, which is an input to 5b. The cheatsheet overflow line
  (this re-records the seven skill cli-cases), `yo-design.instructions.md`
  (the class-1 rule and the arithmetic semantics), `c-codegen.instructions.md`
  (the `__yo_idx_chk` / div / overflow / shift / cast helper family and the
  no-raw-subscript rule), `DESIGN.md` "Arithmetic and failure semantics",
  `ALGEBRAIC_EFFECTS.md` (the 0a guarantee), and `STRINGS.md` (`bytes(i)`
  traps). All of these land in both en-US and zh-CN.
- **R5 — the missing oracles. DONE.** cli-cases `int-add-overflow-panics`,
  `int-neg-overflow-panics`, `int-min-div-neg-one-panics`,
  `str-bytes-oob-panics`, and `compile-allocator-fixed-oom-shapes`. The last
  one re-executes itself per shape under a 64 KiB fixed heap: async task
  spawn, thread spawn, and `String` growth. It pins that each shape dies with
  an allocation diagnostic and never a segfault. All three did, measured on
  macOS.
- **R6 — the UBSan acceptance run. RUN 2026-09-23; one class open.** A
  self-built compiler with `--sanitize undefined` was run over `yo check ./src`.
  - **Run 1** aborted on the first RC increment: small RC headers were read
    through the full 56-byte header type. Fixed on `safe-mode-5-ubsan`
    (`issues/fixed/small-rc-header-accessed-through-the-full-header-type.md`).
  - **Run 2** aborted on `header->dispose_fn(ptr)`: every runtime callback is
    called through `void (*)(void*)` while defined with a typed parameter
    (4,910 casts in the compiler's own C). This is still open
    (`issues/runtime-callbacks-are-called-through-an-incompatible-function-pointer-type.md`)
    and needs a ruling: emit `void*`-typed callbacks, or accept and document
    the ABI reliance.
  - **Run 3** (`--cflags '-fno-sanitize=function -fsanitize-recover=all'`, so
    every site is reported) finished `check ./src` 279/279 with **zero** UBSan
    reports across div/rem, shift, bounds, pointer-overflow, type-mismatch
    (object size and alignment), and float-cast checks. The handler set was
    verified from the binary's imports, so this is not a vacuous zero. Signed
    overflow has no UBSan check here: `-fwrapv` defines it, and Phase 3 traps it.
  - D6's optional CI leg waits on the function-type ruling, because that
    class aborts at the first dispose.
- **R7 — governance cross-check.** §3's `public_safe_report` class-1 section,
  which turns a renamed or newly added `Option`/`Result` extraction method that
  can reach `__yo_panic` into a report diff. Nothing in-tree exercises it yet,
  because the list is three names on two types. Lowest priority.
- **R8 — the 5b plan.** A separate design doc answering §8's three questions.
  Phase 6 waits on it.

## Appendix A — emission-site checklist (grep anchors, `develop @ a1df43578`)

| What | Where | Grep anchor |
| --- | --- | --- |
| Fixed-array Index inline (trait call) | `src/codegen/exprs/generation.yo:486` | `)->data[` in `_generate_index_trait_call` |
| Fixed-array Index inline (builtin arm) | `src/codegen/exprs/inline_fns.yo:410-417` | `BF_YO_ARRAY_INDEX` |
| Address-of index path | `src/codegen/exprs/ptr_fns.yo` | `is_index_trait_address_of` |
| RC element dup read | `src/codegen/exprs/rc_fns.yo:197-262` | `__yo_dup_array_element` / `.data[` |
| `str` byte access | `src/codegen/exprs/inline_fns.yo:328-335` | `BF_YO_STR_BYTE` |
| Slice index builtin | `inline_fns.yo` / `generation.yo` builtin arms | `__yo_slice_index` |
| Int `/` | `src/codegen/exprs/inline_fns.yo:222` | `BF_YO_OP_DIV` |
| Int `%` | `src/codegen/exprs/inline_fns.yo:122-129` | `_mod_op` |
| `+ - *` | `inline_fns.yo:219-221` | `BF_YO_OP_ADD/SUB/MUL` |
| Shifts | `inline_fns.yo:236-237` | `BF_YO_OP_BIT_LEFT_SHIFT/RIGHT_SHIFT` |
| Negate | `inline_fns.yo:179-195, 224` | `_unop_narrowed` |
| Casts | `inline_fns.yo:289-306` | `BF_YO_AS` |
| Post-`main` escape check | `src/codegen/functions/generation.yo:1434-1471` (POSIX), `:1474+` (Windows), WASM direct | `__yo_user_main` |
| Sanitize validation/consumption | `src/main.yo:3397`, `:4015-4035`; help `:7632`/`:7682` | `sanitize` |

Final grep acceptances once Phases 1–3 land:
`rg -n -- '->\[|\.data\[|\.ptr\[' src/codegen --glob '*.yo'` → only the shared
checked-index helper; `rg -n -- '"/"|"%"' src/codegen/exprs/inline_fns.yo` → only
inside `_div_op`/`_mod_op`; a self-built compiler run under `--sanitize undefined`
over `yo check ./src` reports zero arithmetic/indexing UB.
