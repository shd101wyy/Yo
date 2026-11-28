# Capabilities and handlers: keep `ctl` and `unwind`, make them correct, then make handlers real

> **Archived 2026-11-28: superseded by VERDICTS-96 (Fable 5.2) before anything
> in it was built.** The maintainer adopted VERDICTS-96 the same day: `ctl` and
> `unwind` are deleted and errors are values. The plan of record is
> [`ERRORS_AS_VALUES`](../backlog/ERRORS_AS_VALUES.md). None of the K-items is
> built, and the seven findings of §3 are retired with the mechanism at E-5.
> §5 (handlers on frames, T1–T9) is the record a generators question starts
> from (`issues/questions/2026-11-28-generators-on-frames.md`). The text below
> is frozen as it stood on 2026-11-28.

**Status: BACKLOG — decided 2026-11-28 by VERDICTS-95 (Fable 5.2) and adopted
under the maintainer's rule of the same day: "If Fable still suggests we delete
ctl/unwind then lets just plan to delete them, and lets stop fixing their bugs.
Otherwise lets make concrete plan for how to get them right." VERDICTS-95
recommends keep, so this is the plan to get them right. VERDICTS-94's deletion
(its E-5, `ctl` and `unwind` out in v0.2.86) is withdrawn; its E-1 (`try`,
v0.2.83) and E-2 (the error-style pilot with the ±3% gate) stand. Nothing is
built. The seven findings of the two verdicts are filed with this plan (§3).**
The fact base is `origin/develop` `c1f2221be` and the installed v0.2.80; the
verdicts' probes are in the coordinator's `v94-probes/` and `v95-probes/`.

Related: [`ALLOCATION_FREE_ASYNC`](../backlog/ALLOCATION_FREE_ASYNC.md) (the frame
protocol the real handlers reuse; AFA-3 carries K-8),
[`STD_RUST_ALIGNMENT`](../backlog/STD_RUST_ALIGNMENT.md) (L-1, `try(expr)`, is E-1),
[`IO_INTERFACE_AND_STD_RUNTIME`](../backlog/IO_INTERFACE_AND_STD_RUNTIME.md) (`Io` as an
interface value; the effect row), [`REFERENCES_AND_ORIGINS`](../backlog/REFERENCES_AND_ORIGINS.md)
(O3, O4, O5, O10, which K-7 applies to handlers),
[`BORROW_CHECKER_COMPLETENESS`](../backlog/BORROW_CHECKER_COMPLETENESS.md) (P4,
second-class closures), [`SELF_VERIFICATION`](../backlog/SELF_VERIFICATION.md) (lever L2,
which is K-12), [`POST_VBD_PLAN`](../backlog/POST_VBD_PLAN.md) (lanes and release map).
VERDICTS-89 (the generic-resume rule, PR A and PR B) is upstream of K-5.

## 1. The decision and why

**What Yo has.** Capability parameters plus one checked non-local exit
(VERDICTS-94 §1). A handler's `return(v)` is a C `return` from an ordinary
function; `unwind(v)` is a thread-local flag, a value buffer and a test after
every call that may unwind. No continuation is captured. In Koka's terms Yo
implements two of the three operation kinds: `fun` (the handler answers) and
`final ctl` (the handler never resumes). The third, a handler that holds the
continuation, is missing.

**Keep, do not delete** (VERDICTS-95, rank 1 of six paths, 40% against 30% for
deletion; without the differentiation goal it would repeat VERDICTS-94):

- **Differentiation.** The maintainer (2026-11-28): "I personally tend to keep
  algebraic effect as that makes Yo different from Rust." Rust has no stable
  generators (`gen` blocks are unstable) and no handlers. Fixed-size,
  allocation-free generators, coroutines and lexically scoped handlers with
  borrows across a suspension are a large differentiator; today's mechanism
  under an honest name is a small one (VERDICTS-95 §4).
- **The core is sound to fix.** Eight PRs of size S or M close every soundness
  finding of VERDICTS-94 and VERDICTS-95 and the generic-resume encoding
  (§2). Two of them (K-1, K-3) were already in VERDICTS-94's delete plan as its
  E-0b, and one (K-6) as its E-0c, so the first move is the same on either path.
- **Real handlers are feasible on AFA frames** (VERDICTS-95 §2.1). The surface
  already has two of the three cases; capability passing already marks every
  function a suspension passes through, so a selective transform needs no
  inference; AFA's "a started frame is a place that never moves" already makes a
  borrow across a suspension legal without `Pin`. A perform becomes a fourth
  resume status beside pending, ready and aborted, and dropping a continuation is
  the abort walk. The route is the existing state-machine lowering, not stack
  switching (no per-architecture assembly, plain C11 on wasm32-wasi; §2.4 there).

**What this plan is not.**

- Not "keep as is" (rank 6): the badge is half true and the core has an S1 type
  confusion (F1, F5).
- Not "(d) in full" as a destination (rank 3): fixing everything and keeping
  `exn` as std's error mechanism costs 13 PRs and the verifier's exception
  lever. Whether std and `src/` keep `exn` is decided separately (§4).
- Not async rebuilt on handlers (rank 5). Handlers share async's lowering and
  keep its surface; they replace the flag protocol underneath (VERDICTS-95
  §2.5).

The fallback if H-0's gate says no is in §5.

## 2. The core: K-1 to K-12

"Core" is K-1 to K-6, K-8 and K-10: 8 PRs, S or M, about 3–4 lane-weeks,
v0.2.82–84. K-7 and K-9 are the rest of "correct"; K-11 and K-12 are built only
if the error style stays on `exn` (§4). Sizes are VERDICTS-95's estimates from
reading the code (S up to two days, M up to a week, L one to two weeks).

| # | What | Closes | Size | Release | Depends on |
| --- | --- | --- | --- | --- | --- |
| — | VERDICTS-89 PR A (the resume rule R1, R2's `return` half) and PR B (R2's fall-through half and its sweep) | `issues/2026-11-25-a-generic-ctl-handler-that-resumes-with-its-resume-value-loses-it-at-a-non-scalar-resume-type.md` (S1); the fall-through abort | S; S–M | v0.2.81; v0.2.81–82 | — (unchanged by this plan) |
| **K-1** | A synchronous frame catches an unwind only when `__yo_unwind_target` is one of its own handler literals (`unwind_catch_condition` over `context.unwind_catches`, as `await.yo` does). `_call_is_handler_installation` is deleted | F1 (S1), F4 (S2) | M | v0.2.82 | — |
| **K-2** | A frame saves the in-flight unwind's value and target before it runs drops on an escape path and restores them after, wherever it re-arms the flag today | F5 (S1); the docs' "do not unwind from a `Drop` impl" caveat | M | v0.2.82 | VBD row 14 (implicit drop deleted) |
| **K-3** | A `ctl` value is not an `fn`; a closure at a `ctl` slot is an error; a control-bound value cannot be written through a `&mut` (F6's stopgap). A call through a plain function value never unwinds, so the may-unwind decision is exact | F3, F2, F6; a hello-world's 26 flag tests go to 0 | M | v0.2.82 | — |
| **K-4** | A `-> never` call compiles in statement position and coerces through a field or a parameter (VERDICTS-89 findings 2 and 3). Code after a `never` call is accepted today with no diagnostic (VERDICTS-95 `q11`), so the flip has no unreachable-code fallout | the blockers of `-> never` | S + S | v0.2.82–83 | — |
| **K-5** | `Exception.throw : (ctl(error : AnyError) -> never)`, with a `yo fix` repair; `generic` on a `ctl` is an error; `ResumableException` (0 users) and the generic-resume code (about 925 lines) are deleted | "does not return" encoded as a polymorphic result | M | compiler v0.2.83; std one seed later (v0.2.84) | K-4; PR A and PR B |
| **K-6** | Delete the dead effect code (about 1,200 lines: `effect-analysis.yo` and its types, `get_evidence_parameters`, `EvidenceParameter`, `_module_type_contains_ctl_field`, three write-only context fields) | — | S | v0.2.82–83 | — |
| **K-7** | A handler value carries the origin of its installer. The control-bound predicate and its 11 call sites are replaced by O3, O4 and O10. A non-escaping closure may capture a handler once P4 lands | the escape rules as one structural check; F6 for good; F7; the two bundle issues; lets bundles go (§5) | L | v0.2.83–84, lane A | N2c–N2f; P4 for the capture half |
| **K-8** | Unwind through embedded frames is AFA's `aborted` status with a target; the abort walk drops in place | `issues/2026-11-26-an-effect-unwound-tasks-locals-are-dropped-when-its-last-handle-is-released.md` (S2) | M, inside AFA-3 | v0.2.83–84 | AFA-3 |
| **K-9** | The other open issues, one PR each (list below) | 5 of the 9 open issues | 5 × S–M | v0.2.83–85 | the S1 first (v0.2.83) |
| **K-10** | Docs and positioning (§6): the name, the three false sentences, the page rename | the name | S | v0.2.82 | — |
| **K-11** | An unwinding call is elaborated as the early exit `try(expr)` produces: `try` exits mid-expression with temporaries live, which is the unwind-path problem, so it is built once | the largest historical defect class (drops, temporaries and flags on unwind paths); about 480 unwind-only lines go | L | v0.2.84–85 | E-1 (L-1); **only if E-2 keeps `exn`** |
| **K-12** | Verifier lever L2: a throw is an exit path, a call to a throwing callee splits, an `Exception` parameter is an opaque token | 13.7% of `src/` signatures enter the verifier's subset | L | v0.2.85–86, lane E | **only if E-2 keeps `exn`** |

K-9's issues:

| Issue | Severity |
| --- | --- |
| `issues/2026-10-24-a-construction-passed-to-an-unknown-effect-callee-escapes-the-borrow-assert.md` | S1 |
| `issues/canonicalize-throw-inside-io-async-corrupts-the-heap-on-windows.md` | S2 |
| `issues/2026-10-23-an-unwind-in-a-closure-returning-a-string-drops-a-temp-declared-after-it.md` | S2 |
| `issues/an-effect-handler-local-moved-out-after-a-conditional-unwind-leaks.md` | S3 |
| `issues/2026-11-05-the-ctl-in-a-shared-cell-diagnostic-names-field-star-and-suggests-a-value-struct-for-an-rc-payload.md` | S3 |

The two bundle issues wait for K-7 and the row question of §5:
`issues/2026-10-20-an-effect-binder-bound-only-through-a-future-parameter-resolves-to-io.md`
(S2) and `issues/an-io-await-with-the-wrong-effect-bundle-passes-check.md` (S3).

**Order and ownership.** K-1, K-2, K-3 and K-10 go first in v0.2.82, before
AFA-2 starts on the same codegen files; K-4 and K-6 as lanes allow. The core is
one lane for two releases (v0.2.82–83). K-7 belongs to lane A, K-8 to the AFA
lane, K-12 to lane E. Nothing here displaces VBD, AFA or the `Io` plan.

**Gates beyond Tier 1.** K-1 and K-3 change emitted C on every program: an
emit-diff of `src/main.yo` with each change explained, and the fixpoint. K-1,
K-2 and K-3 turn the verdicts' probes into tests (`p01`, `p01b`, `p05`, `p08`,
`p03b`, `q01`, `q01b`, `q04`, `q04b`, `q05`). K-6 is emit-diff identity.

## 3. The findings filed with this plan

Each doc carries the probe as a repro under `issues/repros/`, the output of the
v0.2.80 seed and the root cause as the verdict states it. None has a test yet:
each lands with the K-item that fixes it.

| Finding | Issue | Severity | Closed by |
| --- | --- | --- | --- |
| F1 (VERDICTS-94) | `issues/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind.md` | S1 | K-1 |
| F2 (VERDICTS-94) | `issues/2026-11-28-a-capturing-closure-at-a-ctl-slot-passes-check-and-emits-invalid-c.md` | S2 | K-3 |
| F3 (VERDICTS-94) | `issues/2026-11-28-a-ctl-value-is-accepted-at-an-fn-slot-so-a-handler-leaves-its-install-frame.md` | S2 (S1 with F1) | K-3 |
| F4 (VERDICTS-94) | `issues/2026-11-28-a-handler-record-built-inline-in-the-call-is-not-an-installation.md` | S2 | K-1 |
| F5 (VERDICTS-95) | `issues/2026-11-28-a-drop-that-catches-its-own-unwind-replaces-the-value-of-the-unwind-in-flight.md` | S1 | K-2 |
| F6 (VERDICTS-95) | `issues/2026-11-28-a-handler-leaves-its-install-frame-through-a-mut-reference.md` | S2 (S1 with F1) | K-3 (stopgap), K-7 |
| F7 (VERDICTS-95) | `issues/2026-11-28-a-callback-cannot-fail-through-a-captured-handler.md` | S3 | K-7 |

## 4. The error style: E-1 and E-2

The mechanism and the error style of `std/` and `src/` are separate decisions
(VERDICTS-95 §5). VERDICTS-94 bundled them; this plan does not.

- **E-1, v0.2.83:** L-1 as planned in `STD_RUST_ALIGNMENT`, the `try(expr)`
  builtin, seed split (the builtin one release before `std/` and `src/` use it).
- **E-2, v0.2.83, on a dev-built compiler:** `plans/ERRORS_AS_VALUES.md` and
  a `yo fix --errors-as-values` migration (VERDICTS-94 §4 (c) gives the
  type-directed rewrite). The pilot converts `std/fs`, `src/build-runner.yo`
  and `src/lsp/`, about 40% of the handler installs, with async. An evals run
  writes the same tasks in both styles. **The gate:** stage-2 `check ./src`
  wall and RSS, `yo.c` size, and `-O0` `check ./src` on the default stack, each
  within +3% of the base. This is **decision 2** of the schedule (§7).

What each outcome means here:

| E-2 says | Then |
| --- | --- |
| **`Result`** (the gate passes; VERDICTS-95 expects this at 65%) | VERDICTS-94's E-3 (std flips, v0.2.84) and E-4a–d (`src/` by directory, v0.2.85–86) run. K-11 and K-12 are not built: the verifier proves `Result` contracts today (VERDICTS-94 `p09`). `Exception` leaves `std/error` once `src/` no longer uses it. `ctl` and `unwind` stay, and carry only what they are uniquely for: capabilities whose handler answers or aborts, then real handlers. VERDICTS-94's E-5 is not taken |
| **`exn` stays** (the gate fails) | K-11 (v0.2.84–85) and K-12 (v0.2.85–86, lane E) are scheduled. std's D1 rule ("effects on the `io` path, `Result` for pure transforms") and the `try_*` twins stay. The error value lost at a `spawn` stays until K-7 and §5 |

VERDICTS-94's fallback for a failed gate, (b2) "exceptions only", is not this
plan's fallback: under VERDICTS-95 a failed gate keeps the full mechanism and
schedules K-11 and K-12.

## 5. Real handlers: H-0 to H-6

The design is VERDICTS-95 §2: typing rules T1–T9, the state-machine route, the
costs and the verification position. The surface is a sketch; its spellings are
open:

```yo ignore
// A clause may capture: it cannot leave the `handle` expression.
total := handle(
  Emit(i32)(emit : ({ &mut sum }(v) => { sum.* = (sum.* + v); return(()) })),  // resume now
  out => evens(n, out)
);
// `unwind(a)` ends the `handle` expression with `a`; `(v, k) => ...` keeps the continuation `k`.
for(gen(out => evens(i32(10), out)), v => println(v));
```

- **T1:** a capability field is `fn(ps) -> R` (the handler is a function),
  `ctl(ps) -> never` (it never resumes) or `ctl(ps) -> R` (it holds the
  continuation). After K-5 no `ctl(ps) -> R` with `R` other than `never` is
  left in `std/` or `src/`, so the general meaning needs no new keyword.
- **T2:** a function is suspendable iff a parameter or capture type contains a
  `ctl(ps) -> R` operation; capability passing is the colouring.
- **T4, T7:** a continuation `k : Resume(R, A)` is affine: resumed at most
  once (a second use is E0901), dropped by the abort walk. No multi-shot.
- **T5:** `cap` and `k` carry the `handle` slot's origin and are not
  `Escapable` (O10); this replaces the control-bound predicate (K-7).
- **T6:** a borrow of a performer's local live across a perform is legal by O5,
  as AFA restates it: the frame is a started place in the installing frame's
  `handle` slot.

| PR | Release | Seed | Content | Size | Gate |
| --- | --- | --- | --- | --- | --- |
| **H-0** | v0.2.85–86 | no | No compiler code. `plans/HANDLERS_ON_FRAMES.md`; an executable model of T1–T9 with a negative corpus, as N0 was for origins; VERDICTS-95's C model `m1_gen.c` extended with drops and the abort walk; benchmarks: a generator, a tree walk, an incremental parser; the model-authorship eval (below) | M | **Go or no-go by the maintainer** (decision 3) |
| **H-1** | v0.2.87 | A | `handle(h, cap => body)` on today's lowering: the delimiter is an expression and a clause may capture. `unwind` ends the `handle`. A handler literal outside a `handle` becomes an error with a `yo fix` repair | L | the tree's catch sites rewritten by the repair; cli-diff |
| **H-2** | v0.2.88 | A | A `ctl(ps) -> R` operation performed in a `handle` body suspends it: the frame in the `handle` slot, `k`, `return` as a loop, drop as the abort walk; `gen` and `for` | L | ASan suites; the model's chain within 1.5× of the hand-written iterator; 0 allocations |
| **H-3** | v0.2.89–90 | A | Suspendable functions (T2): embedded children, boxed recursion, the status return for every capability-taking function. Deletes the flag protocol, the value buffer and the install-site code | L to XL | fixpoint; emit-diff of `src/main.yo` explained; a hello-world has 0 unwind tests |
| **H-4** | v0.2.90 | B | std: the generator bridge to `Iterator`, docs in both languages, the pack, `yo effects` reporting `suspends`. The docs page takes the name "effect handlers" | M | develop's battery; `markdown-yo` rebuilt |
| **H-5** | v0.2.91, on demand | A, B | Boxed first-class continuations (T9); a perform that crosses an `io.await`; the direct-leaf resume for boxed recursion | L | decided by H-4's users |
| **H-6** | a question, filed with H-3 | — | Suspendable closures through generic higher-order functions (where Rust's effect generics and Zig's colourless async stalled) | XL | — |

Dependencies: nothing starts before AFA-3 except H-0. H-1 needs K-7. H-2 needs
AFA-3 and AFA-7. H-3 is the PR that replaces the thread-local protocol and so
the defect classes of F1, F4 and F5 for good. VERDICTS-95's estimate: H-0 to
H-4 are 10–12 lane-weeks; 75% that H-1 to H-3 can be made sound, 50% that H-3
lands by v0.2.90, 35% that H-6 is ever worth building.

**H-0's gate (decision 3).** The maintainer decides go or no-go on two inputs:

- **The model's numbers.** The extended `m1_gen.c` with drops and the abort
  walk, on the three benchmarks. VERDICTS-95's hand-written model puts embedded
  frames at +10% to +40% over a hand-written iterator for chains of 0–8 levels,
  and recursion as the weak case (a boxed frame per call).
- **The eval.** The same tasks written two ways, from a pack page only, before
  any compiler work: with generators and handlers, and with iterators and
  closures. The tasks are a generator, a stateful traversal, an incremental
  parser and a catch that recovers with locals in scope. It uses the BEND B4
  evals corpus's harness (lane D). It measures how often the model's first
  program passes `yo check` and its tests, and how many repair rounds it needs.
  Its question is whether models write the new idiom (VERDICTS-95 §2.7: a
  `yield` generator is high-prior, a clause that names its continuation is not).

**If H-0 says no.** With errors already on `Result` (E-2 passed), the fallback
is VERDICTS-95's rank 2: VERDICTS-94's E-5 is taken as written and `ctl` and
`unwind` are deleted, which is small by then. With errors still on `exn`, the
plan stops at the core plus K-7, K-9, K-11 and K-12 (VERDICTS-95's rank 3), and
the name stays "capabilities and handlers".

## 6. The name

- **Retire "algebraic effects" now**, in every option: no equational theory is
  stated and no continuation is captured (VERDICTS-95 §3.3).
- **Until H-3: "capabilities and handlers".** README line: "Explicit
  capabilities with lexically scoped handlers: I/O, allocation and failure are
  parameters; a handler answers an operation or ends the computation that
  raised it. No ambient authority."
- **After H-3 (H-4 renames the page): "effect handlers"**, qualified as
  "one-shot, lexically scoped, allocation-free", the term Effekt and Koka use,
  true by then.

**What K-10 changes** (v0.2.82; docs in both languages, describing only the
current language, with no history):

- `docs/en-US/ALGEBRAIC_EFFECTS.md` and `docs/zh-CN/ALGEBRAIC_EFFECTS.md`
  become `CAPABILITIES_AND_HANDLERS.md`. The links follow (`README.md`,
  `docs/zh-CN/README.md`, both `INDEX.md`, `ASYNC_AWAIT.md`,
  `ERROR_HANDLING.md`), and so do the mentions of "algebraic effects" in
  `CTFE.md`, `MEMORY_SAFETY.md` and `ADVANCED_TYPES.md`, both languages.
- The three false sentences of VERDICTS-94 §9: `ALGEBRAIC_EFFECTS.md:5` ("one-shot
  delimited continuations": nothing is captured); `README.md:31` ("async is the
  builtin `Io` effect": `Io` is an interface value after IO-1b);
  `ASYNC_AWAIT.md:5` and its "Lazy Start via Algebraic Effects" section (async
  is a compiler transform).
- The "Semantics" sentence that F1 falsifies ("A frame that only passes a
  handler along never catches its unwind") is true again after K-1; rules 3, 5
  and 8 of the typing rules are restated as K-3 lands; the `Drop` caveat goes
  with K-2.
- The positioning sentence of `plans/ROADMAP.md` ("adds algebraic effects"), the
  `about/` pages' mentions, `pack/context.md`'s effects section and
  `.github/instructions/yo-design.instructions.md` and `c-codegen.instructions.md`.
- Not the code: `src/` identifiers and comments that say "effect" follow the
  code that changes them.

## 7. The schedule

VERDICTS-95 §6, with this plan's names. Each row is a target, not a gate: an
item that is not ready slides to the next row.

| Release | Mechanism (K) | Error style (E) | Handlers (H) |
| --- | --- | --- | --- |
| v0.2.81 | Untouched. VERDICTS-89 PR A. F1–F7 filed (this plan) | — | — |
| v0.2.82 | K-1, K-2, K-3, K-10; PR B; K-4 and K-6 as lanes allow | — | — |
| v0.2.83 | K-5 (compiler); K-7 starts; K-9's S1 | E-1 `try`; E-2 pilot and evals: **decision 2** | — |
| v0.2.84 | K-5 (std, on the new seed); K-7; K-8 inside AFA-3; K-9 | E-3 if decision 2 says `Result` | — |
| v0.2.85–86 | K-9's rest; K-11 and K-12 only if errors stay on `exn` | E-4a–d | H-0: **decision 3** |
| v0.2.87–88 | — | — | H-1, H-2 |
| v0.2.89–90 | — | — | H-3, H-4; the name becomes "effect handlers" |

(Decision 1 was this plan's: keep.)

## 8. Open questions

1. **H-0's thresholds.** VERDICTS-95 makes H-0 a maintainer's call on the eval
   and the model's numbers and sets no number. Before H-0 runs: what eval margin
   between the two styles, and what model cost on the tree walk, is a no.
2. **The surface spellings** of `handle`, `k.resume`, `gen` and `Resume(R, A)`
   (VERDICTS-95 §2.2 marks them open). H-0 fixes them.
3. **K-5's form and the `-> never` question.** VERDICTS-89 §6 recommends filing
   "a non-resuming operation is `ctl(...) -> never`" under `issues/questions/`;
   it is not in the tree. K-4 files it with this plan's answer (adopted) and K-5
   implements it.
4. **K-3's diagnostics:** new E06xx codes or existing ones for "a `ctl` value at
   an `fn` slot", "a closure at a `ctl` slot" and "a control-bound value written
   through a `&mut`". Assigned at merge.
5. **The effect row after K-7.** With a handler carrying an origin, a cold
   future that captures one is an ordinary borrowing future, and VERDICTS-94's
   E-6 ("should `Future(T, E)` keep a row?") is answered "no row" (VERDICTS-95
   §2.5). Decided with ALLOCATION_FREE_ASYNC, after K-7; it is what deletes the
   bundles (about 2,100 lines).
6. **The open `issues/questions/` docs** are answered by this plan, as
   VERDICTS-95 §3.1 maps them, and each is closed by the PR that implements its
   answer:
   - `issues/retired/2026-10-14-effect-operation-contracts.md`: operation
     contracts, VERDICTS-95 §2.6;
   - `issues/retired/by-value-effect-rows-with-ctl-carrying-handlers.md`: K-7;
   - `issues/questions/with-lock-and-with-permit-cannot-see-an-unwind.md`: H-2's
     code after the resume;
   - `issues/retired/2026-10-23-should-a-test-whose-unwind-escaped-the-body-fail.md`:
     yes.
7. **Verification of handlers.** A `handle` expression, a clause with `k` and a
   generator need a protocol specification (Dafny's `iterator`, Hazel in Iris)
   and stay outside the verifier's subset, as `io.async` bodies do today
   (VERDICTS-95 §2.6). DEFAULT_ON_VERIFICATION loses nothing it has.
