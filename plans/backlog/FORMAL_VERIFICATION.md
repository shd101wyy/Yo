# Formal Verification — Dafny-style compile-time verification for Yo

> **Status: ACTIVE PLAN — revised 2026-09-04.**
> This revision replaces the 2026-05 draft's recommendation ("land Phase 0,
> park the verifier"). The decision is now made: **Yo builds a compile-time,
> SMT-backed verifier in the Dafny / SPARK tradition**, because Yo's design
> center is LLM authorship and contracts-with-proofs are the strongest oracle
> an LLM authoring loop can get. It aligns with
> [`ROADMAP.md`](../ROADMAP.md) Phase 1 ("Formal verification — the flagship").
>
> Three decisions shape everything below:
>
> 1. **Compile-time verification, not runtime-only.** `requires(...)` /
>    `ensures(...)` are today lowered to runtime `assert(...)`. The verifier
>    discharges them **statically with Z3** (Dafny model): a violated
>    contract is a *compile error with a concrete counter-example*.
> 2. **Z3 only.** One solver, pinned and versioned. CVC5, CBMC, KLEE and
>    SeaHorn integrations from the old draft are **dropped** (see
>    [Decision log](#decision-log)).
> 3. **No magic `result` keyword.** A post-condition names the return value
>    through Yo's **existing labeled-return syntax**: `-> (result : i32)`.
>    The 2026-05 draft's magic identifier is removed (breaking change, see
>    [Breaking-change ledger](#breaking-change-ledger)).
>
> Phase 0 (the contract *surface*, runtime-checked) is **landed**; the
> verifier phases V1–V7 below are the implementation plan.

---

## Table of contents

1. [Goal & positioning](#goal--positioning)
2. [Non-goals](#non-goals)
3. [Current state — audited 2026-09-04](#current-state--audited-2026-09-04)
4. [The surface](#the-surface)
5. [Named returns in `ensures(...)` — the decision](#named-returns-in-ensures--the-decision)
6. [Verification semantics](#verification-semantics)
7. [Architecture](#architecture)
8. [SMT encoding reference](#smt-encoding-reference)
9. [Solver harness: Z3, pinned, deterministic](#solver-harness-z3-pinned-deterministic)
10. [Diagnostics & counter-examples](#diagnostics--counter-examples)
11. [CLI & pipeline integration](#cli--pipeline-integration)
12. [Implementation plan — phases V1–V7](#implementation-plan--phases-v1v7)
13. [Test strategy](#test-strategy)
14. [Design for LLM authorship](#design-for-llm-authorship)
15. [Trade-offs accepted](#trade-offs-accepted)
16. [Breaking-change ledger](#breaking-change-ledger)
17. [Decision log](#decision-log)
18. [Risks](#risks)
19. [Open questions](#open-questions)
20. [History & audit trail](#history--audit-trail)
21. [References](#references)

---

## Goal & positioning

Make Yo a language where **correctness properties are proved at compile
time**, with a graduated cost model:

- **Free** — properties the compile-time evaluator already discharges
  (literal arithmetic, CTFE-evaluable predicates, comptime contracts).
  No solver involved; these are already compile errors today.
- **Cheap** — properties Z3 discharges in milliseconds on the verifiable
  subset: bounds, non-zero divisors, sign reasoning, linear arithmetic,
  `cond`/`match` path reasoning, modular call-site obligations.
- **Annotated** — loop invariants, `decreases` measures, ghost values:
  properties the user (usually an LLM) must *state* before Z3 can prove
  them.
- **Runtime fallback** — anything the solver cannot discharge within its
  deterministic budget degrades to today's runtime `assert(...)` in
  `VerifyOrAssert` mode. Verification is adoptable file-by-file and
  clause-by-clause; this is the pragmatic wedge Dafny never had, and it
  is why **`VerifyOrAssert` is the flagship mode** (per ROADMAP Phase 1).

Yo's design center is **LLMs as primary code authors**. Contracts are the
artifact that converts silent LLM hallucination into compile errors with
concrete counter-examples: an LLM that writes `requires(...)` /
`ensures(...)` alongside its implementation gets a second oracle (beyond
the typechecker and test runner) saying "wrong, here is the exact input
that breaks it" — closing the iteration loop without the LLM having to
invent inputs that trigger the bug.

The pitch: **"Every function carries an executable specification.
`yo verify` turns it into a proof — or a counter-example — without
leaving the source file."**

This is Dafny's verification semantics and SPARK's gradual-adoption
model, adapted to Yo's syntax, algebraic-effect model, C11 codegen
pipeline, and LLM-author focus.

## Non-goals

- **No full dependent types.** No Π/Σ types, no value-indexed type
  families beyond existing GADTs. Refinements are predicates attached to
  existing types.
- **No interactive theorem proving.** No tactic language, no proof
  states, no stepping through obligations. Either Z3 discharges the VC or
  the author edits the annotations.
- **No second solver.** Z3 only. The solver-facing surface (SMT-LIB 2
  over stdio) is deliberately generic, but nothing else is wired, tested,
  or supported. Multi-solver support is a non-goal until there is a
  demonstrated need.
- **No external bounded model checkers.** The CBMC / KLEE / SeaHorn
  annotation emitters from the old draft are dropped.
- **No capability lattice / taint tracking** in this plan. The old
  draft's Phase 4 (Untrusted/Trusted/Secret ranks, constant-time crypto)
  was new infrastructure orthogonal to VC generation; it moves to
  `plans/backlog/` thinking when the core verifier exists.
- **No type invariants** (`invariant(...)` on struct/object types) in the
  initial phases — loop invariants only. Type invariants interact with
  every constructor and `inout` method; deferred (Open Question 6).
- **No verified compiler.** The Yo→C lowering stays unverified; proofs
  are at the Yo source level.
- **No float reasoning.** `f32`/`f64` are outside the verifiable subset
  (Open Question 4).
- **No mandatory verification.** Code without contract annotations and
  without a verification pragma compiles exactly as today.

## Current state — audited 2026-09-04

A full audit of the landed Phase 0 surface, against the actual tree. File
references are current paths (the 2026-05 draft cited the retired
TypeScript compiler — `src/expr.ts`, `src/evaluator/builtins/contracts.ts`,
`src/types/compatibility.ts`, …; all such citations in this revision point
at the live `.yo` sources).

### What works today (Phase 0 — landed)

| Capability | Where | Notes |
| --- | --- | --- |
| Contract builtins registered: `requires`, `ensures`, `invariant`, `ghost`, `ghost_fn`, `old` | `src/expr.yo:60-65` (`BF_REQUIRES` … `BF_OLD`) | Parse as ordinary `FnCallExpr` nodes; no parser changes were needed |
| Signature extraction of `requires(...)` / `ensures(...)` into side tables | `src/evaluator/types/function.yo` (`g_func_requires_exprs` / `g_func_ensures_exprs`, `register_func_*_exprs`, `copy_func_contract_exprs`, `get_func_*_exprs`) | Keyed by fn-type-expr id, re-keyed to the FuncVal id. The `TypeValue.Func` struct cannot carry `AstExpr`s (definitions must not depend on expr), hence the side-table design — the verifier reuses these tables as its contract input |
| Strict clause-zone order `generic(0) → params(1) → where(2) → requires(3) → ensures(4)` | `_clause_zone` / `_zone_label` in `src/evaluator/types/function.yo` | Out-of-order clause is a syntax error with a "Move X before Y" hint |
| Single-call rule + zero-argument rejection | `src/evaluator/builtins/contracts.yo` (`_reject_zero_arg_marker`) | Two `requires(...)` clauses in one signature is a syntax error |
| Runtime lowering: contracts spliced into the body as `assert(P, "requires failed: ...")` / `comptime_assert(...)` | `wrap_function_body_with_contracts` in `src/evaluator/builtins/contracts.yo`; called from `src/evaluator/calls/function_type.yo:888` | Dispatches on `isCompileTimeOnly` of the return. `ensures` wraps the body as `{ snapshots; requires-asserts; <binding> := (<body>); ensures-asserts; <binding> }`; unit returns skip the binding |
| `old(...)` entry-snapshot hoisting | `_hoist_old_in` in `src/evaluator/builtins/contracts.yo` | Each `old(e)` becomes `__yo_contract_old_K := e` at entry, rewritten into the predicate |
| Magic `result` identifier inside `ensures(...)` | `_RESULT_IDENTIFIER` in `src/evaluator/builtins/contracts.yo` | **To be replaced** by named returns (Phase V1) — see below |
| Loop `invariant(...)` must be the first statement of the `while` body | enforced in the `while` evaluation path | Placement anywhere else (including nested branches) is rejected |
| Pragmas `Pragma.Verify`, `Pragma.VerifyOrAssert`, `Pragma.NoContracts` | prelude `Pragma` enum; mapping in `src/evaluator/builtins/pragma.yo` | `Verify`/`VerifyOrAssert` parse and warn "verify mode not implemented". `NoContracts` fully works (erases the splice) |
| `std/spec/` skeletons | `std/spec/refine.yo`, `std/spec/numeric.yo` | `Refine(T)`/`NonZero`/`Bounded`/`NonEmpty`/`Positive`/… are identity type aliases today; the predicate parameter does not exist yet |
| Tests | `tests/spec/`: `contracts_phase0.test.yo` (31 tests), `pragma_no_contracts.test.yo`, `pragma_verify.test.yo`, `refine_types.test.yo` | All green as of this audit (`yo test ./tests/spec/contracts_phase0.test.yo` → 31/31) |

### The labeled-return syntax already exists (and is currently dropped)

Yo already parses **labeled returns**: `-> (name : i32)`, `-> (comptime(name) : i32)`.
The function-type evaluator validates the label
(`src/evaluator/types/function.yo:3810-3945`, `return_label`), then —
today — **drops it**: nothing downstream binds or reads the label.

Measured behavior (this audit, `tmp/fixme.yo`):

```rust
f :: (fn(x : i32, ensures(retval >= i32(0))) -> (retval : i32))( ... );
// → Error: Variable "retval" not found.
```

So the syntax the new design needs is already legal; only the plumbing is
missing. That is Phase V1.

### What is missing (the gap the verifier fills)

1. **No compile-time discharge.** Contracts are runtime asserts. A
   violated `requires` is a panic at run time, discovered only when
   someone runs the code with a triggering input.
2. **No caller-side obligations.** The runtime model checks `requires`
   inside the callee at run time. Dafny-style modular verification needs
   the *caller* to prove each callee's `requires` statically and to
   *assume* the callee's `ensures` afterwards.
3. **No path conditions, no symbolic state.** `EvalValue.UnknownVal`
   means "type known, value unknown" and carries no symbolic
   information. There is no SSA, no constraint accumulation across
   `cond`/`match`, no loop reasoning.
4. **No solver integration at all.** No SMT-LIB emission, no Z3
   acquisition/pinning, no verdict plumbing, no counter-example
   rendering.
5. **`result` is a magic identifier** bound by the wrapper lowering, not
   tied to the signature — the exact design this revision removes.
6. **`Refine(T)` ignores its predicate** — refinement aliases are
   documentation today.

### Stale claims removed from the 2026-05 draft

| Old claim | Reality |
| --- | --- |
| "Recommended near-term commitment is Phase 0 only; Phase 1+ parked" | Superseded — ROADMAP Phase 1 makes verification the flagship; this doc is the implementation plan |
| Phase-1 estimate "13–19 person-months" built on *extending the evaluator* with path-condition tracking (old audit §B1: 4–6 months for that alone) | The architecture changed: a **separate verifier pass** over the evaluated AST (Dafny/Boogie shape), not an evaluator extension. Path conditions live inside the verifier, where they belong. Revised per-phase estimates in [Phases V1–V7](#implementation-plan--phases-v1v7) |
| "VIR (Verification IR)" as a pipeline stage with its own design doc | Replaced by an **in-memory VC term representation** (`src/verifier/terms.yo`) and direct SMT-LIB 2 emission. No persisted IR, no separate VIR document |
| Backend matrix (Z3, CVC5, CBMC, KLEE, SeaHorn) | **Z3 only** |
| `result` magic identifier (old §A4, §D4 debated reserving it as a keyword) | Removed. Named returns instead |
| Capability lattice / taint ranks (old §B5) | Deferred — not in this plan |
| Phase-0 progress cited "26 tests across 3 files" | Now 4 files; `contracts_phase0.test.yo` alone has 31 tests |
| `while(runtime((i < n)), {...})` in examples | Outdated — `while` conditions are runtime by default; write `while(i < n, {...})` |
| TS-era paths (`src/expr.ts:742`, `src/evaluator/types/function.ts`, `src/types/compatibility.ts`, `src/evaluator/memory-safety.ts`, `src/codegen/functions/generation.ts`, `src/version-cache.ts`, …) | All retired with the TypeScript compiler (frozen at `src-attic-final`); current paths used throughout |

## The surface

Six primitives exist today (`requires`, `ensures`, `invariant`, `ghost`,
`ghost_fn`, `old`); the verifier adds three (`decreases`,
`forall_val`/`exists_val`, `==>`) and one real type constructor
(`Refine(T, predicate)`), plus the three verification pragmas that already
parse.

### 1. `requires(...)` — pre-condition

Lives in the function-type signature clause-list, after parameters and
`where(...)` (zone order is enforced today):

```rust
divide :: (fn(
  x : i32,
  y : i32,
  requires((y != i32(0))),
) -> i32)((x / y));
```

One `requires(...)` call takes one or more predicates as arguments; they
are conjoined. Per-argument source spans are preserved so a failure
pinpoints the exact predicate. Zero arguments and multiple `requires(...)`
clauses are syntax errors (enforced today).

**Verification semantics:** at the callee, `requires` is *assumed* (the
callee may use it); at each **call site**, every predicate must be
*proved* under the caller's path condition. In the runtime-only mode
(today's behavior) it is checked by the entry assert.

### 2. `ensures(...)` — post-condition

Same signature clause-list, after `requires(...)`:

```rust
abs :: (fn(
  x : i32,
  ensures(
    ((result >= i32(0)) && ((result == x) || (result == -(x)))),
  ),
) -> (result : i32))(
  cond((x >= i32(0)) => x, true => -(x))
);
```

**Verification semantics:** the callee must prove every predicate on
every normal-exit path, with the return label bound to the returned
value; call sites *assume* the predicates after a proved call.

### Named returns in `ensures(...)` — the decision

**There is no magic `result` keyword.** A post-condition names the return
value with Yo's **existing labeled-return syntax**; the label is an
ordinary binding whose scope is the contract clauses:

```rust
// Any label works — it is the user's name, declared in the signature:
fn(ensures((answer < i32(0)))) -> (answer : i32)

// Same identifier convention users already know from parameters:
fn(inout(n) : i32, ensures((n == (old(n) + i32(1))))) -> unit
```

Why this beats a magic identifier (old draft §A4/§D4, resolved by
decision):

1. **It is the syntax Yo already has.** Parameters are named in the
   signature; the return value is a parameter of the post-condition.
   `-> (result : i32)` is exactly that, parsed since before Phase 0.
2. **No scope magic.** The 2026-05 draft needed a "magic identifier,
   in scope only inside `ensures(...)`" with a keyword-reservation audit.
   A labeled return is a normal binding introduced by a normal syntax
   element — the evaluator binds it exactly where the wrapper already
   binds its internal result value today.
3. **Self-documenting signatures.** `-> (count : usize)` reads as a
   contract-visible name; callers and LLMs see one vocabulary. (Ada and
   SPARK name their out-parameters; Eiffel's `Result` and Dafny's
   `result` are the keyword approach — Yo goes the Ada way because Yo
   already has the surface.)
4. **No collision story.** `std/imm` has local `result` bindings today;
   the Phase-0 workaround ("wrapper-bound local, not a keyword") was
   clever but fragile. With labels, `result` is just a name a user may
   pick — or not.

Rules:

- **Labeled non-unit return:** the label is bound in every `ensures(...)`
  predicate to the function's returned value. The wrapper lowering binds
  `<label> := (<body>)` instead of today's `result := (<body>)`.
- **Unlabeled non-unit return:** the return value is not nameable in
  `ensures(...)`. Predicates may still constrain parameters and
  `old(...)` expressions. If a predicate references an unbound identifier
  and the return is unlabeled, the diagnostic appends a targeted hint:
  *"to name the return value in `ensures(...)`, label the return:
  `-> (<name> : i32)`"*. (The base error is the ordinary
  `Variable "x" not found.` — the hint is additive, not a new error
  class.)
- **Unit return:** no return binding exists. `-> (name : unit)` parses;
  referencing `name` in `ensures(...)` errors ("unit-returning function
  has no return value to name"). The wrapper keeps today's unit special
  case (no `void` binding in emitted C).
- **Tuple/aggregate returns:** the label names the whole value;
  predicates project fields from it (`result.0`, `result.left`, …).
- **`ghost_fn` specifications follow the same rule** — a ghost function's
  `ensures(...)` binds its own labeled return.
- **`old(...)`** refers to a parameter's entry-time value (already
  implemented as entry snapshots; the verifier encodes it as a two-state
  variable — see [Loops & mutation](#loops-mutation-old-and-decreases)).

Migration for code relying on the magic `result`: add the label —
`-> (result : i32)`. The 10 `ensures` sites in `tests/spec/` and the
cheatsheet example are the known in-repo migration set (Phase V1 task).

### 3. `invariant(...)` — loop invariant

Lives as the **first statement of a `while` body** (placement enforced
today). Multiple predicates are conjoined arguments of one call:

```rust
sum_to :: (fn(
  n : i32,
  requires((n >= i32(0))),
  ensures((result == ((n * (n + i32(1))) / i32(2)))),
) -> (result : i32))({
  i := i32(0);
  acc := i32(0);
  while(i < n, {
    invariant((i >= i32(0)), (i <= n), (acc == ((i * (i + i32(1))) / i32(2)))));
    i = (i + i32(1));
    acc = (acc + i);
  });
  acc
});
```

**Verification semantics:** the invariant must hold on loop entry and be
re-established by every iteration; the exit path assumes
`invariant && !(cond)`. `break`/`continue` interact precisely — see
[Loops & mutation](#loops-mutation-old-and-decreases).

Struct/object **type invariants** are out of scope (non-goal above).

### 4. `ghost(...)` / `ghost_fn(...)` — specification-only code

Two distinct builtins (split resolved old audit §A3):

- `ghost(name := expr)` — a binding visible only to contracts and other
  ghost code; **erased before codegen** (today it evaluates at runtime as
  a transparent marker — V5 makes erasure real; see the
  [breaking-change ledger](#breaking-change-ledger)).
- `ghost_fn(fn_value)` — marks a function as specification-only: callable
  only from contract context, erased at codegen. Ghost spec functions
  return ordinary `bool`.

```rust
permutation :: ghost_fn((fn(
  a : Slice(i32),
  b : Slice(i32),
) -> bool)(
  (Multiset.from_slice(a) == Multiset.from_slice(b))
));
```

### 5. `decreases(...)` — termination measure (new builtin, Phase V4)

A signature clause after `ensures(...)` (zone 5) for recursive functions,
and a loop-body statement immediately after `invariant(...)` for loops:

```rust
factorial :: (fn(
  n : u32,
  requires((n <= u32(12))),
  ensures((result == fact_of(n))),
  decreases(n),
) -> (result : u32))( ... );
```

- Without `decreases(...)`, recursive functions and annotated loops get
  **partial correctness only** (Dafny's default): the post-condition is
  proved *assuming* termination; no termination proof is attempted.
- With it, the verifier proves the measure is non-negative (well-bounded)
  and strictly decreases at each recursive call / loop back-edge.
  Measures may be integer expressions or lexicographic tuples
  (`decreases((a, b))`).

### 6. Quantifier builtins — `forall_val`, `exists_val`, `==>` (new, Phase V5)

Well-formed **only inside ghost context** (contract clauses, `ghost(...)`
bindings, `ghost_fn` bodies) — enforced by an `is_ghost_context` flag on
the evaluation context (resolves old audit §A5). Calling them from
ordinary runtime code is a compile error, mirroring how `unwind(...)`
is only well-formed inside `ctl(...) -> R`:

```rust
sorted_quantified :: ghost_fn((fn(s : Slice(i32)) -> bool)(
  forall_val((i : usize), (j : usize),
    (((i < j) && (j < s.len())) ==> ((s(i)) <= (s(j))))
  )
));
```

ASCII spellings on purpose — LLM training data and copy-paste safety
(old draft's "no ∀/∃/⇒" stance, kept).

### 7. `Refine(T, predicate)` — refinement types (real implementation, Phase V6)

`Refine(T, p)` becomes a genuine comptime type constructor: erased to
`T` at codegen (zero runtime cost), distinct at the type level, with
construction sites generating proof obligations:

```rust
NonZero :: (fn(comptime(T) : Type) -> comptime(Type))(
  Refine(T, (x) => ((x != T(0))))
);

safe_div :: (fn(num : i32, denom : NonZero(i32)) -> i32)((num / denom));
```

- `Refine(T, p) <: T` freely (erasure); `T → Refine(T, p)` requires
  proving `p(x)` at the coercion site (a VC).
- Composition normalizes: `Refine(Refine(T, p), q)` ≡
  `Refine(T, (x) => (p(x) && q(x)))`.
- Entry paths: literal construction (CTFE discharges when the value is
  known), `.check(...)` returning `Option(Refine(T, p))`, and
  `.unchecked(...)` under `pragma(Pragma.AllowUnsafe)`.
- Today's one-argument `Refine(T)` aliases in `std/spec/` gain the
  predicate parameter in V6 — breaking change for the skeleton API
  (ledger entry 3).

### Verification modes (pragmas exist today; semantics land in V3)

| Pragma | Mode | Behavior |
| --- | --- | --- |
| (default — no verification pragma) | `runtime` | Contracts lower to runtime `assert(...)` / `comptime_assert(...)` — **today's behavior, unchanged** |
| `pragma(Pragma.Verify);` | `verify` | Contracts and auto-obligations (AoRTE, below) are proof obligations. Refuted ⇒ compile error with counter-example. Unprovable-within-budget ⇒ compile error. Runtime asserts are **not** emitted (the proof replaces them) |
| `pragma(Pragma.VerifyOrAssert);` | `verify+` | Try to prove. Proved ⇒ erased (no runtime cost). Refuted ⇒ compile error (a refutation is a bug, never assert-worthy). Budget-exhausted ⇒ fall back to today's runtime assert. **Flagship mode** |
| `pragma(Pragma.NoContracts);` | `ignore` | Contracts erased entirely (works today) |

A CLI global override `--verify-mode {runtime,verify,verify+,ignore}`
selects per invocation; the pragma is source-of-truth when present.

## Verification semantics

### Modular verification: callee and caller obligations

The Dafny model, exactly:

| Site | `requires(P)` | `ensures(E)` |
| --- | --- | --- |
| **Callee verification** (function's own file, any verify mode) | **Assume** `P` on entry | **Prove** `E` on every normal-exit path, return label bound |
| **Call site** (in any verified function) | **Prove** `P[args/params]` under the caller's path condition | **Assume** `E[args/params]` after the call |

This gives compositional reasoning: a caller never opens the callee's
body; it reads only the signature. It also means contracts are usable
*without* the callee itself being verified — a contract on a function in
a `runtime`-mode file is still assumed at verified call sites (the
callee's file decides whether *its* body must prove anything).

### The verifiable subset

Verification is defined over a **subset of Yo** that grows per phase
(SPARK's approach: a defined verifiable subset, not all-or-nothing). In
`verify`/`verify+` files, a function whose body uses a construct outside
the current subset produces a precise error:
`cannot verify: <construct> is outside the verifiable subset (phase V3)`
— or, in `verify+`, degrades the function to runtime asserts.

| Construct | Status |
| --- | --- |
| Integer/bool arithmetic, comparisons, logical ops, `cond`, `match`, `if` | V3 |
| Let bindings (`:=`, `::`), field access, tuple/struct/enum construction | V3 |
| Calls to contract-carrying or verified pure functions; CTFE-computable calls | V3 |
| `assert(P)` sites (become obligations), `panic` paths (exempt from `ensures`) | V3 |
| Slices/arrays with `len` (index bounds are auto-obligations) | V3 |
| `while` loops with `invariant(...)`; `break`/`continue` | V4 |
| Recursion (with `decreases(...)` for termination) | V4 |
| `ghost(...)`, `ghost_fn(...)`, quantifiers, `old(...)`/`inout` two-state, `Seq`/`Multiset`/`Set` | V5 |
| Trait-method calls under trait contracts; generic functions; `Refine` | V6 |
| `object` types (heap references), `str`/`String` content, floats | **out of subset** initially — `object` and strings are planned (V6+); floats open-ended non-goal |
| Effects (`ctl` handlers, `io.await`), `unsafe(...)`, raw pointers, `asm(...)`, FFI `extern`, parallelism | **outside the subset** — a verified function body may not contain them (effects double as the frame rule, below) |

### Purity and the effect frame rule

A verified function must be **checked-pure** at the syntactic level Yo
already exposes: no effect parameters used in the body, no `ctl(...)`
handlers, no `await`, no `unsafe`, no `asm`, no FFI calls, no writes to
module-level globals. This is exactly ROADMAP Phase 1's "leverage the
effect system as the frame rule": the hardest part of verifying
imperative code — framing what a call may modify — falls out of
machinery that already exists. A call in a verified body may only target:

1. **CTFE-computable** callees (arguments all comptime-known) — folded to
   constants, no VC;
2. callees **with contracts** — prove `requires`, assume `ensures`
   (regardless of the callee's own file mode);
3. callees **verified in the same compilation without `ensures`** —
   `requires` still proved; the result is unconstrained beyond its type
   (sound, occasionally useful);
4. a **whitelisted set of pure builtins** with hand-written SMT axioms
   (`min`, `max`, `abs`, … — the whitelist grows per phase);
5. anything else ⇒ subset error (or `verify+` fallback).

### Integer semantics: bitvectors matching the C output

Yo compiles to C11 with `-fwrapv` (signed wrap defined as two's
complement — `src/main.yo:1892`). The verifier models integers as **exact
-width bitvectors**: `i32` → `(_ BitVec 32)`, with
`bvsdiv`/`bvudiv`/`bvurem` for division per signedness, `bvshl`/`bvlshr`
for shifts, sign/zero extension for widening casts `i32(x)`, truncation
for narrowing. The model is *exactly* the emitted C semantics — a proof
is a proof about the program that runs. Widths (including `usize`) come
from the active `CompilationTarget` (`src/target.yo`), so a
`wasm32-wasip1` verification uses 32-bit `usize`.

Overflow is **not an obligation by default** (wrapping is defined
semantics, not a bug). Opt-in overflow checking arrives with
`std/spec/numeric.yo` predicates (`NoOverflow(...)`) in V6 — an ordinary
`ensures` predicate, no special machinery.

### Automatic obligations — absence of runtime errors (SPARK's AoRTE)

In `verify`/`verify+` files, the verifier generates obligations **no
contract asked for**, on every verified function:

- every slice/array index `s(i)`: prove `i < s.len()` (and, for
  mutation, `s` is not borrowed-immutably — refined per phase);
- every `/` and `%`: prove the divisor non-zero;
- every shift: prove the shift amount is within the operand width
  (C-level UB otherwise).

This is the single highest-value feature for LLM authorship: bounds and
divide-by-zero bugs — the classic LLM hallucination class — become
compile errors with concrete counter-example inputs, on *unannotated*
code. `yo verify ./file.yo` with zero contracts written still catches
them.

### Loops, mutation, `old`, and `decreases`

**`while` encoding (V4).** Standard havoc-invariant rule over the loop's
assigned locals (computed by a new assigned-variable scan of the body —
the same walk style as the flowability analysis):

1. Prove `invariant` holds on entry (under the pre-path-condition).
2. Assume `invariant && cond`; havoc assigned vars; execute the body
   symbolically; prove `invariant` re-established.
3. Exit path: `invariant && !(cond)` (plus break-path disjuncts, below).

`break` exits mid-iteration where the invariant is not yet re-established,
so the exit condition is the disjunction
`(invariant && !(cond)) || Φ_break` where `Φ_break` collects each break
site's path condition. `continue` jumps to the head, so the invariant
must hold **at each `continue` site** (an extra obligation at the
statement, not just at the back-edge).

**`inout(name) : T` parameters and `old(...)` (V5).** `inout` params get
a two-state encoding: an entry snapshot variable (exactly today's
`__yo_contract_old_K` binding, but symbolic) and a mutable current
variable. `old(e)` reads the snapshot state. Locals mutate in single
assignment style (SSA renaming); struct fields copy by value (Yo structs
are value types), so no heap model is needed for them. `object` types
stay outside the subset (their reference semantics need a heap model —
deferred with the type-invariant work).

**`decreases(...)` (V4).** Loop variant: the measure must be
non-negative and strictly decrease every iteration. Recursive functions:
each `recur(...)` site proves the measure of the actuals is strictly
smaller than the formals'. Integer measures use `BV` ordering;
lexicographic tuples compare component-wise.

### `comptime` functions need no VCs

The existing rule carries over unchanged: a comptime function's contracts
lower to `comptime_assert(...)` and the CTFE engine fully evaluates them
at specialization time — already a compile error, no solver involved. The
verifier only sees functions with at least one runtime parameter. The
comptime/runtime boundary inside contracts is exactly the boundary that
already separates `comptime_assert` from `assert`.

### Ghost erasure

In verify modes, `ghost(...)` bindings and `ghost_fn(...)` definitions
are consumed by the verifier and **erased before codegen** (V5; see
ledger). In `runtime`-mode files, `ghost`/`ghost_fn` remain accepted
no-op markers (today's behavior) so specification text never breaks
compilation of unverified code. A non-ghost expression referencing a
ghost binding is a compile error ("ghost value escapes specification
context").

## Architecture

```
Yo source
   ↓
Lexer / Parser                        (unchanged — contracts are builtin calls)
   ↓
Evaluator                             (unchanged core: types, CTFE, contracts
   ↓                                   extracted to side tables; mode dispatch
                                       suppresses the assert splice in `verify`)
Function bodies + ExprInfo + contract side tables
   ↓
Verifier pass  (new: src/verifier/)   per function, fresh state
   ├── terms.yo   — in-memory VC term IR (SSA-ish, typed)
   ├── vc.yo      — symbolic execution of the body → obligation set
   ├── encode.yo  — terms → SMT-LIB 2 text
   ├── z3.yo      — solver process harness (spawn, query, verdict)
   ├── builtin_axioms.yo — whitelisted pure builtins as SMT axioms
   ├── report.yo  — verdicts → diagnostics, counter-example rendering
   └── driver.yo  — scheduling, budgets, caching, mode wiring
   ↓
{ Proved | Refuted(counter-example) | Unproven(budget) | SubsetError }
   ↓
Codegen                               (emits runtime asserts only for
   ↓                                   `runtime` mode and `verify+` fallbacks)
C compiler
```

### Why a separate pass, not an evaluator extension

The 2026-05 audit's central cost finding (§B1: "path-condition tracking is
a fundamentally new evaluator capability — 4–6 person-months alone") was
correct *for the architecture it evaluated*: teaching the shared
evaluator to accumulate symbolic constraints while it type-checks. This
plan chooses the Dafny/Boogie shape instead: verification is a **separate
consumer** of the evaluator's *outputs* — the specialized function body
AST, `ExprInfo` (types, per-node annotations), and the contract side
tables. The evaluator stays a concrete interpreter; the verifier is its
own symbolic executor with its own state. Consequences:

- No new evaluator modes, no risk to the self-hosting bootstrap path.
- Path conditions, SSA renaming, and havoc logic live in `src/verifier/vc.yo`
  where they can be unit-tested in isolation (`tests/internal/verifier.test.yo`)
  without compiling a whole module through the evaluator first.
- The verifier's input is *post-specialization* (generics already
  monomorphized where applicable), so it never reimplements trait
  dispatch — except where V6 deliberately verifies generic bodies
  abstractly.
- The evaluator's `clone_expr_fresh_ids` discipline (fresh node ids per
  spliced predicate) already guarantees the side-table predicates can be
  re-walked safely.

The verifier pass runs **after module evaluation and before codegen**,
inside `yo check`, `yo compile`, and `yo test` when any file in the
import closure carries `Pragma.Verify`/`Pragma.VerifyOrAssert` (or the
`--verify-mode` flag says so), and as the whole job of `yo verify`.

### The assert-splice interaction (mode dispatch)

Today `wrap_function_body_with_contracts` splices asserts at
function-definition time. The verifier changes the dispatch:

- `runtime` / `ignore` — unchanged (splice / erase), regardless of solver.
- `verify` — **suppress the splice entirely**; the verifier consumes the
  predicates from the side tables instead. Predicates still get one
  diagnostic evaluation pass (types checked, `old(...)` validated) so
  malformed predicates error cleanly even though no assert is emitted.
- `verify+` — splice first (today's lowering), then, after the verifier
  reports, **strip the asserts whose predicates were Proved** (a
  post-evaluation body rewrite keyed by the spliced node ids, before
  codegen). Refuted predicates never survive to codegen (they are compile
  errors); budget-exhausted ones keep their asserts. Net effect: proofs
  cost zero runtime, fallbacks keep today's safety.

The `verify+` strip pass must follow `ExprInfo.macro_expansion` for any
spliced predicate inside macro-derived code — the same discipline the
dup/drop optimizer already documents.

## SMT encoding reference

One reference table per concept; the encoder (`src/verifier/encode.yo`)
implements exactly this.

### Sorts

| Yo type | SMT-LIB 2 |
| --- | --- |
| `bool` | `Bool` |
| `i8`/`u8` … `i64`/`u64`, `usize` | `(_ BitVec 8\|16\|32\|64)` (usize width per target) |
| tuples, `struct(...)` | `declare-datatypes` constructor with selectors |
| `enum(...)` | `declare-datatypes` one constructor per variant |
| `Option(T)` / `Result(T, E)` | datatypes (`.Some`/`.None`, `.Ok`/`.Err`) |
| `Slice(T)` / `Array(T, N)` | pair: `(Array (_ BitVec 64) Elem)` + `len : (_ BitVec 64)` |
| `str` / `String` (V5) | `Seq (_ BitVec 8)` (byte sequences; content reasoning V5+) |
| `Refine(T, p)` (V6) | erased — the sort of `T`; `p` becomes an obligation |
| `object(...)` | out of subset |

Logic header: `(set-logic ALL)` (BV + arrays + datatypes + sequences
exceeds any single `QF_*` combination; `ALL` is what Dafny/Boogie-style
tools emit).

### Operators

| Yo | SMT-LIB |
| --- | --- |
| `+ - *` | `bvadd bvsub bvmul` (exact-width) |
| `/` `%` | `bvsdiv`/`bvudiv`, `bvsrem`/`bvurem` **+ non-zero obligation** |
| `<< >>` | `bvshl`/`bvlshr` (logical; arithmetic right-shift `>>` on signed types maps to `bvashr`) **+ width obligation** |
| `~ & \| ^` | `bvnot bvand bvor bvxor` |
| `== != < <= > >=` | `=`, `distinct`, `bvult/bvule/…` per signedness (`bvslt` signed) |
| `&& \|\| !` | `and or not` (short-circuit preserved via path-condition structure) |
| widening cast `i64(x)` | sign/zero extension (`(_ sign_extend 32)` / `(_ zero_extend …)`) |
| narrowing cast `i32(x)` | `(_ extract 31 0)` |
| `forall_val` / `exists_val` | `forall`/`exists` with auto E-matching triggers (V5) |
| `==>` | `=>` |

### Statements → symbolic execution

- `name := expr` — SSA bind: fresh term variable, path condition
  unchanged.
- `cond(c1 => e1, c2 => e2, …)` / `match(x, .Pat => e, …)` — branch:
  execute each arm under `Φ ∧ ci`, join states; `__yo_panic` arms join as
  diverging paths (exempt from `ensures`).
- `while` — the havoc-invariant rule above.
- `assert(P)` — obligation: prove `Φ ⇒ P`.
- `panic(...)` — diverging path: no obligations after it (process aborts
  before any observable contract violation — SPARK's stance).
- assignment `x = e` / `inout` writes — SSA rename + two-state `old`
  bookkeeping (V5).
- call — per the purity rules table above (prove requires / assume
  ensures / constant-fold / axiom / subset-error).

### Verdicts

| Verdict | `verify` | `verify+` |
| --- | --- | --- |
| **Proved** (unsat) | nothing (no assert emitted) | erase the assert |
| **Refuted** (sat + model) | **compile error** + counter-example | **compile error** + counter-example |
| **Unproven** (rlimit exhausted / `unknown`) | compile error "could not prove" | keep the runtime assert, emit a warning |
| **SolverError** (crash/missing) | compile error with fix hint | keep the runtime assert, emit a warning |

## Solver harness: Z3, pinned, deterministic

### Acquisition

- **One pinned Z3 version** (start: Z3 4.13.3), recorded in a manifest
  constant in `src/verifier/z3.yo`. Bundled *once* per machine into
  `~/.cache/yo/solvers/z3-<version>-<target-triple>/` following the
  version-cache model (`src/version_cache.yo`, releases fetched from
  GitHub Releases). Target triples reuse `src/target.yo` vocabulary.
- `YO_Z3_PATH` env var overrides discovery (CI, offline, or a locally
  built solver). `yo verify --solver-path <path>` is the CLI form.
- Missing solver: `verify` mode ⇒ hard error with the fetch command;
  `verify+` ⇒ deterministic fallback to runtime asserts + warning (a
  missing solver never fails a `verify+` build).

### Determinism (hard requirement, not nice-to-have)

Same source + same compiler version + same pinned Z3 ⇒ **byte-identical
verdicts**, on every run and every machine:

- **`rlimit` budget, not wall-clock.** Every query runs with
  `(set-option :rlimit N)` (default 5,000,000 ≈ a few seconds of BV
  work). Z3's rlimit is deterministic resource accounting; the same
  query consumes the same budget everywhere. A wall-clock
  `(set-option :timeout …)` exists only as a crash guard and, if it ever
  fires *before* the rlimit, the verdict is `Unproven` with a
  "budget-exhausted" message — never a different logical outcome.
- Fixed `(set-option :random-seed 0)`; no time-derived seeds anywhere.
- **One fresh Z3 process per function.** Incremental `push`/`pop`
  within a function shares assumptions; nothing crosses function
  boundaries, so no solver-state flakiness bleeds between files.
- Solver version bumps are deliberate release-note events (like seed
  releases), never a side effect.
- The verification cache (below) keys on the solver pin, so a bump
  invalidates honestly.

### The query protocol

Each obligation is asserted with a name (`(! term :named vc12)`) with
`:produce-unsat-cores true`:

- `unsat` ⇒ Proved; `(get-unsat-core)` identifies *which clauses*
  participated, powering "smallest violated clause" diagnostics.
- `sat` ⇒ Refuted; `(get-model)` / `(get-value …)` over the query's
  input variables yields the counter-example, mapped back through name
  mangling to source variables.
- `unknown` ⇒ Unproven.

### Name mangling

Source identifiers are encoded as `__yo_v<fn>_<name>` (function-unique
prefix + sanitized source name) so counter-examples render as the user's
own names. Mangled names are stable across runs (deterministic walk
order) — required for the cache and for readable golden tests of emitted
SMT-LIB.

### Caching

`~/.cache/yo/verify-cache/<key>.json`, key = hash of (function source
text, contract predicates, callee contract set, solver pin, mode,
options). Stores the verdict + counter-example. `yo verify` and
`verify+` builds consult it before spawning anything; any input change
invalidates. Cache hits are reported (`cached: proved`) so CI logs stay
honest. No cross-machine sharing, no partial keys.

## Diagnostics & counter-examples

Verifier output is ordinary compiler diagnostics — same format, same
severity channel, same LSP plumbing as typechecker errors. Required
shape, per finding:

```
error: could not prove: requires((i < arr.len()))
  --> src/foo.yo:42:9
   |
42 |     arr(i)
   |        ^
   = path: arr.len() == 0 (from `requires((arr.len() >= usize(1)))` being unprovable)
   = counter-example: i = 0, arr.len() = 0
   = hint: add `requires((arr.len() > usize(0)))` or guard the call with a length check
```

Requirements (carried from the 2026-05 draft's LLM section, now normative):

- **Counter-examples as Yo literals** the author can paste into a test.
- **Per-clause attribution** via unsat cores: the *smallest* violated
  clause, not a conjunction dump (the single-call multi-predicate shape
  preserves per-argument spans for exactly this).
- **Suggested edits where derivable** — the missing-`requires` hint is
  mechanical; the "label your return" hint appears on unbound names in
  `ensures` with unlabeled returns.
- **Structured output**: `--format json` emits verdicts as JSON
  (`{function, clause, verdict, counterexample, hint}`) for agentic
  loops; same content as the text diagnostics.

## CLI & pipeline integration

- **`yo verify [path]`** — new subcommand: evaluate + verify, no
  codegen. Flags: `--verify-mode`, `--solver-path`, `--rlimit`,
  `--format {text,json}`, `--explain <fn>` (show the VC set and each
  verdict for one function), `--no-cache`.
- **`yo check` / `yo compile` / `yo test`** — run the verifier pass when
  any file in the import closure is `verify`/`verify+` (or the flag is
  given). The pass reuses the already-evaluated module state; no double
  evaluation.
- **`build.yo` step option** — `yo build -Dverify=true` flips the
  project's mode for one build (CI matrices).
- **CI** — a dedicated `verify` job: installs the pinned Z3, runs
  `yo verify ./std/spec ./tests/spec/fixtures`, publishes the JSON
  report as an artifact. Required check once V3 lands.

## Implementation plan — phases V1–V7

Phase 0 (the contract surface, runtime-checked) is **landed** and
described in [Current state](#current-state--audited-2026-09-04). Each
phase below is independently shippable, gated on its exit criteria, and
ordered by dependency. Estimates assume one focused contributor.

### Phase V1 — Named-return contract binding (removes magic `result`)

**Scope:** thread the already-parsed `return_label`
(`src/evaluator/types/function.yo:3810-3945`) into the contract surface.

Tasks:

1. Store the return label alongside the contract predicates: extend the
   side-table registration (`register_func_requires_exprs` /
   `register_func_ensures_exprs` and their `copy_*` re-keying) with a
   `g_func_return_label : HashMap(String, String)` — same keys, same
   lifecycle.
2. `wrap_function_body_with_contracts`
   (`src/evaluator/builtins/contracts.yo`): bind **the label** instead
   of `_RESULT_IDENTIFIER`; unlabeled non-unit returns bind the internal
   name `__yo_contract_result`; unit returns keep the no-binding case.
3. The unbound-identifier hint: when an `ensures` predicate fails
   resolution with an unlabeled non-unit return, append the
   "label the return" note to the ordinary not-found error.
4. Reject `-> (name : unit)` label references inside `ensures(...)` with
   the unit-specific message.
5. Migrate in-repo users: the 10 `ensures(result ...)` sites in
   `tests/spec/*.test.yo`, the cheatsheet example
   (`.github/skills/yo-syntax/syntax-cheatsheet.md` "Design-by-contract
   clauses"), and any `src/`/`std/` hits (grep
   `ensures(result` — expected zero outside tests).
6. Tests: extend `tests/spec/contracts_phase0.test.yo` — labeled return
   binding, arbitrary label names, unlabeled + param-only `ensures`,
   unit-return rejection, tuple-return projection through the label.

**Exit criteria:** `ensures(pred)` resolves the return value **only**
through the label; no magic identifier remains anywhere in `src/`;
all `tests/spec/` green; cheatsheet updated.

**Estimate:** ~1 week.

### Phase V2 — Solver harness & verifier skeleton

**Scope:** everything needed to talk to Z3, before any real VC.

Tasks:

1. `src/verifier/z3.yo`: pinned-version manifest; discovery
   (`YO_Z3_PATH` → `~/.cache/yo/solvers/…`); download/install into the
   cache following the `src/version_cache.yo` release-fetch pattern;
   `Z3Runner` wrapping `std/process/Command`
   (`std/process/command.yo` — piped stdio already supports this) with
   spawn/query/verdict parsing (`sat` / `unsat` / `unknown`, model and
   unsat-core extraction).
2. Determinism options wired: `rlimit`, `random-seed 0`, timeout
   backstop; one process per function with `push`/`pop` batches.
3. `src/verifier/terms.yo`: the in-memory VC term representation (sorts,
   terms, quantifiers, named assertions) — pure data, no I/O, fully
   unit-testable.
4. `src/verifier/encode.yo`: terms → SMT-LIB 2 text. Golden-string unit
   tests (emitted text is deterministic, so exact-match goldens work).
5. `src/verifier/driver.yo`: per-function scheduling, budget
   application, verdict aggregation, cache read/write.
6. `yo verify` subcommand in `src/main.yo` (dispatch skeleton; verifies
   nothing real yet, runs the harness self-test: encode `1+1==2` →
   unsat, `1+1==3` → sat + model).
7. Tests: `tests/internal/verifier.test.yo` — runner mocked (canned
   sat/unsat) for hermetic unit tests; real-solver tests behind
   `YO_TEST_Z3=1` env guard. CI job installs the pinned Z3.

**Exit criteria:** `yo verify` runs on any project, exercises Z3
end-to-end (self-test obligations), reports harness health, caches
results; no language behavior changed yet.

**Estimate:** ~2–3 weeks.

### Phase V3 — Straight-line verification + auto-obligations (the Dafny core)

**Scope:** the flagship loop closes. Pure, loop-free functions verify;
callers discharge callee `requires`; AoRTE obligations fire on
unannotated code.

Tasks:

1. Mode dispatch in `wrap_function_body_with_contracts` (suppress splice
   in `verify`; V3 initially keeps the splice in `verify+` and does not
   yet strip proved asserts — stripping lands with task 6 below).
2. `src/verifier/vc.yo`: symbolic execution over the specialized body —
   bindings, arithmetic, `cond`/`match` path conditions, field access,
   enum construction/projection; callee-side (assume requires → prove
   ensures) and caller-side (prove requires → assume ensures)
   obligations; `assert` sites; diverging `panic` paths; recursion ⇒
   explicit "requires decreases(...) — Phase V4" subset error.
3. Encoding per the [SMT reference](#smt-encoding-reference): bitvectors
   (widths from `CompilationTarget`), datatypes, slice/array as
   array+len pairs; casts; the pure-builtin axiom whitelist (`min`,
   `max`, `abs`).
4. AoRTE obligations: index bounds, div/mod non-zero, shift width —
   always on in `verify`/`verify+`.
5. Diagnostics: counter-example rendering through name mangling;
   unsat-core clause attribution; the JSON format.
6. `verify+` stripping pass: remove asserts for Proved predicates
   (body rewrite keyed by spliced node ids; follows
   `ExprInfo.macro_expansion`).
7. Purity/substrate gating: the subset table's V3 row enforced with
   precise "outside the verifiable subset" errors.
8. Tests: `tests/spec/verify_straight_line.test.yo` (positive proofs),
   `tests/spec/fixtures/negative/*.yo` + `tests/internal/verifier_negative.test.yo`
   (expected-failure harness invoking `yo check` as a subprocess and
   asserting the diagnostic text, mirroring the cli-diff scoring shape).
   Every negative fixture pairs with a deliberately-bugged twin that
   must Refute with the right counter-example.

**Exit criteria:** with Z3 installed, `yo verify` on a `verify`-mode file
proves `abs`/`min`/`max`/`clamp`-style functions' `ensures`, rejects a
deliberately wrong post-condition at **compile time** with a concrete
counter-example, and proves bounds/div-by-zero on an unannotated
function. `verify+` erases proved asserts (verified by inspecting
`--emit-c` output in a test).

**Estimate:** ~5–7 weeks.

### Phase V4 — Loops, invariants, termination

**Scope:** `while` verification, `decreases(...)`, recursion, `break`/
`continue` semantics.

Tasks:

1. Assigned-variable scan for loop havoc (body walk; document the
   `macro_expansion` discipline).
2. The havoc-invariant rule; entry/iterate/exit obligations; break-path
   disjunction; `continue`-site obligations.
3. `decreases(...)` builtin: signature clause (zone 5) + loop statement
   position (immediately after `invariant(...)`); zone-order enforcement
   extended; arity/type checks (integer or tuple of integers).
4. Recursion: `recur` sites get contract assume/prove + measure
   decrease obligations; unannotated recursion stays partial-correctness.
5. Tests: verified `sum_to` (the doc example above), in-place
   `binary_search` (loop invariant), `factorial` (decreases), negative
   twins (wrong invariant ⇒ Refuted with iteration counter-example;
   non-decreasing measure ⇒ Refuted).

**Exit criteria:** a loop-based in-place insertion sort's *loop*
obligations (bounds only; the permutation property needs V5) verify;
a broken invariant is a compile error naming the failing iteration.

**Estimate:** ~4–6 weeks.

### Phase V5 — Ghost code, quantifiers, two-state reasoning

**Scope:** specification-only computation — the vocabulary real
functional correctness specs need.

Tasks:

1. `is_ghost_context` evaluation flag; ghost-context gating for
   `forall_val`/`exists_val`/`==>` (new builtins in `src/expr.yo`,
   handlers in `src/evaluator/builtins/contracts.yo`).
2. Quantifier encoding with auto E-matching triggers; trigger-stability
   guidance in diagnostics ("quantifier-heavy predicate could not be
   discharged within budget — try instantiating at a concrete element").
3. `ghost(...)` codegen erasure + ghost-escape errors; `ghost_fn(...)`
   full semantics (callable only from ghost context; erased).
4. Two-state `inout`/`old(...)` symbolic encoding (entry snapshots as
   symbolic pre-state).
5. `std/spec/` collections: `Seq(T)` → SMT `Seq`; `Set(T)` → Array-sort
   membership; `Multiset(T)` → elem→count array; `from_slice`, equality,
   size operations. String content reasoning (`str` → `Seq (_ BitVec 8)`)
   for `NonEmpty`/length predicates.
6. Tests: insertion sort now verifies `sorted(s)` **and**
   `permutation(s, old(s))` via ghost `Multiset`; `ghost` bindings absent
   from `--emit-c` output; quantifier misuse outside ghost context
   rejected.

**Exit criteria:** the Phase-V4 insertion sort gains the full
functional spec (sorted + permutation) and proves it. `std/spec/`
ghost collections are usable in `requires`/`ensures`.

**Estimate:** ~5–6 weeks.

### Phase V6 — Traits, generics, refinements, std/spec maturation

**Scope:** contracts across abstraction boundaries; refinement types
become real; the stdlib starts carrying executable specifications.

Tasks:

1. Trait-level contract semantics: an impl declaring contracts must
   prove `trait.requires ⇒ impl.requires` (contravariant) and
   `impl.ensures ⇒ trait.ensures` (covariant, same return label);
   impls without contracts inherit the trait's (assumed at dispatch).
   Signature extraction already parses trait-field contracts (Phase 0);
   this adds the proof obligations at impl registration
   (`src/evaluator/values/impl.yo` integration point).
2. Generic functions verified **abstractly**: type variables become
   uninterpreted sorts; trait constraints (`where(T <: Ord)`) contribute
   their method contracts as axioms; monomorphized call sites discharge
   through the generic's own contracts.
3. `Refine(T, predicate)`: real type constructor — distinct at the type
   level, erased at codegen, construction-site VCs, `Refine(T,p) <: T`
   erasure rule, composition normalization. Rework `std/spec/refine.yo`
   + `numeric.yo` aliases to real predicates (breaking change — ledger
   entry 3). `.check(...)` / `.unchecked(...)` entry paths.
4. `decreases` for mutually recursive functions (lexicographic across
   the clique) if cheap; else documented non-goal.
5. Dogfood: annotate `std/collections/array_list.yo`
   (`get`/`set`/`add` bounds + len post-conditions) and
   `std/collections/hash_map.yo` core ops; run `yo verify` over those
   modules in CI; fix what the verifier finds (expected: real bugs —
   each becomes an `issues/fixed/` entry with a reproducer, per repo
   convention).
6. Tests: trait-contract variance (valid impl passes; strengthened
   requires rejected with the proof failure), generic `head` on
   `NonEmpty(Slice(T))` (the doc's worked example, now verifying),
   refinement construction-site rejection with counter-example.

**Exit criteria:** `std/collections/array_list.yo` carries verified
bounds contracts; the worked example below verifies end-to-end;
`yo verify ./std/collections` is green in CI.

**Estimate:** ~6–8 weeks.

### Phase V7 — Productization

**Scope:** make verification a first-class product surface.

Tasks:

1. LSP (`src/lsp/`): hover on a contract-bearing function shows its
   contracts and verification status; verifier diagnostics already flow
   through the standard channel; a "counter-example" inline lens.
2. `yo verify --explain <fn>`: the VC set, per-obligation verdicts, and
   solver stats for one function.
3. `--format json` stabilized and documented; agentic-loop recipe added
   to the skills files.
4. Docs: `docs/en-US/FORMAL_VERIFICATION.md` +
   `docs/zh-CN/FORMAL_VERIFICATION.md` (user-facing tutorial); update
   `.github/skills/yo-syntax/syntax-cheatsheet.md`,
   `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`, and
   `.github/instructions/yo-design.instructions.md` with the final
   surface.
5. Cache telemetry: `yo verify --stats` reports hit rates and time
   saved.
6. Release notes: solver pin management documented; `yo verify` in the
   VS Code extension's task list.

**Exit criteria:** a user (human or LLM) can go from zero to a verified
module using only shipped docs; CI runs verification on std fixtures as
a required check.

**Estimate:** ~2–3 weeks.

### Total

**~25–34 focused weeks (~6–8 months)** for V1–V7, with the flagship
loop (compile-time proofs with counter-examples on the verifiable
subset) landing at **V3, ~8–11 weeks in**. The 2026-05 estimate of
13–19 person-months applied to a different architecture (evaluator
extension + persisted VIR); the separate-pass design and the
subset-scoping are what bring it down. V1–V3 is the recommended first
commitment; V4+ re-plan gate: after V3 ships, re-evaluate against real
usage before continuing.

## Test strategy

| Layer | Where | What |
| --- | --- | --- |
| Term/encode unit tests (hermetic, no solver) | `tests/internal/verifier.test.yo` | VC construction, SMT-LIB golden strings, mangling, verdict parsing (mocked runner) |
| Real-solver unit tests | same file, `YO_TEST_Z3=1`-gated | `1+1==2` unsat; `1+1==3` sat+model; rlimit budget behavior |
| Positive verification | `tests/spec/verify_*.test.yo` | Programs that must *prove* in `verify` mode (and still run green in `runtime` mode) |
| Negative verification | `tests/spec/fixtures/negative/*.yo` driven by `tests/internal/verifier_negative.test.yo` | Each fixture must fail `yo check` with the expected diagnostic (subprocess harness asserting error text; the same scoring shape as `scripts/cli-diff-test.sh`) |
| Bugged twins | alongside each positive test | Every positive fixture has a deliberately-broken twin whose Refute message and counter-example are asserted — guards against a verifier that "proves" by encoding wrongly |
| Runtime parity | existing `tests/spec/*` | Phase-0 behavior must not regress: `runtime` mode still lowers to asserts |
| CI | new `verify` workflow job | Installs pinned Z3; `yo verify ./std/spec ./tests/spec`; uploads JSON report |

Every bug the verifier finds in `std/` during dogfooding gets an
`issues/` entry + reproducer per repo convention, and its regression
test joins `tests/spec/`.

## Design for LLM authorship

Yo's audience is LLMs writing code. This inverts several conventional
verifier design choices (kept from the 2026-05 draft, now normative):

### Determinism is mandatory

- Pinned solver; rlimit budgets (deterministic), never wall-clock
  semantics; fixed seeds; fresh process per function; cache keyed on the
  solver pin. Same input ⇒ same output, always. An LLM cannot form a
  stable model of "what works" around a flaky verifier.
- LLM-facing guidance must be *reproducible*: a counter-example that
  differs run-to-run is noise; ours are functions of the input alone.

### Errors must be locally actionable

- Counter-examples as paste-able Yo literals; smallest violated clause
  via unsat cores; mechanical hints (missing `requires`, label-the-return,
  instantiate-the-quantifier). The diagnostic format section above is a
  hard spec, not aspiration.

### Specs are ordinary Yo

- No second dialect: contracts are builtin calls, predicates are
  ordinary `bool` expressions, quantifiers are calls, ghost values are
  bindings. The new vocabulary (`decreases`, `forall_val`, `exists_val`,
  `==>`) is tiny and gated to ghost context so it adds no ambient noise.
- Named returns strengthen this: the post-condition's variable is
  declared in the signature by normal syntax, not keyword magic an LLM
  must remember is context-sensitive.

### Token efficiency

- Single-call conjoined clauses; reusable `Refine` aliases (`NonZero(i32)`
  is one token where `requires((x != i32(0)))` is many); **AoRTE means
  the highest-frequency LLM bug class (bounds/div-zero) needs no
  annotations at all**; partial correctness by default (no mandatory
  `decreases`).
- Contracts cost 1.5–3× source lines on annotated functions. The
  mitigation is that the *counter-example* replaces test-case invention —
  the LLM spends tokens on the fix, not the reproduction.

### The verifier is the inner loop

- Verification runs from `yo check`/`yo compile`/`yo test` when pragmas
  say so — "fails to verify" is just another compile error, not a
  separate tool to remember. `yo verify` is the CI/batch form.
- Structured JSON output for agentic loops; LSP surfaces the same
  verdicts.

### What this rules out (unchanged)

- Tactic languages (Coq/Lean) — global proof-state reasoning is exactly
  what LLMs are bad at.
- Interactive proof stepping — discharges or edit the annotations.
- Pretty-printed math notation — ASCII keywords match training data.
- Out-of-band annotations (`.spec` files, IDE-only metadata) — one
  artifact, the `.yo` source.

## Trade-offs accepted

- **Compile time.** Verified files pay 10–100× on the verifier pass.
  Opt-in per file/pragma; `yo verify` separates the slow job for CI;
  the cache absorbs repeat runs. `runtime` mode never pays.
- **Annotation burden.** Real functional correctness (V5-level specs)
  needs invariants and ghost code — the expensive annotations exist
  because the properties are real. AoRTE + automatic requires-checking
  at call sites deliver value before any of that.
- **Subset enforcement.** `verify` mode rejects constructs outside the
  subset. This is a feature (SPARK's discipline) but it means verified
  code is a dialect of Yo that lags the full language; the subset table
  is the contract and grows per phase.
- **Solver dependence.** Z3 is a large external dependency — mitigated
  by pinning, caching, the `YO_Z3_PATH` escape hatch, and `verify+`'s
  never-blocked-by-solver fallback.
- **Quantifier flakiness.** E-matching instantiation can exhaust budgets
  unpredictably. Mitigations: deterministic budgets make failures
  *stable*, guidance-level diagnostics suggest instantiation, and V3–V4
  (the flagship surface) are quantifier-free.
- **No proofs for the whole program.** Local, per-function,
  property-by-property proof; composing into end-to-end guarantees is
  the spec author's job (as in Dafny).

## Breaking-change ledger

| # | Change | Phase | Migration |
| --- | --- | --- | --- |
| 1 | Magic `result` identifier removed; `ensures` binds the labeled return | V1 | Add the label: `-> i32` becomes `-> (result : i32)`. In-repo: 10 `tests/spec` sites + cheatsheet example |
| 2 | `ghost(...)` / `ghost_fn(...)` erased from codegen (today: transparent runtime evaluation) | V5 | Ghost bindings were spec-only by contract; grep for `ghost(` uses in runtime expressions — expected zero |
| 3 | `Refine(T)` gains the predicate parameter (`Refine(T, p)`); std/spec aliases attach real predicates | V6 | Most call sites use the named aliases (`NonZero(i32)`), which keep their signatures; direct `Refine(T)` uses add a predicate |
| 4 | `verify`/`verify+` files gain strict obligations (compile errors) | V3 | Opt-in by pragma — `runtime` default is untouched; adopting a pragma is the migration |

## Decision log

| # | Decision | Rationale | Supersedes |
| --- | --- | --- | --- |
| D1 | Build the compile-time SMT verifier (this plan) | ROADMAP Phase 1 flagship; LLM-authorship oracle | 2026-05 "Phase 0 only, park Phase 1+" |
| D2 | **Z3 only** | One solver, pinned, tested; multi-solver is support surface without users (user decision, 2026-09-04) | Old backend matrix (CVC5/CBMC/KLEE/SeaHorn) — dropped, not deferred |
| D3 | **Named returns, no magic `result`** | Uses existing labeled-return syntax; no keyword magic, no scope rules, self-documenting (user decision, 2026-09-04) | Old §A4/§D4 keyword debate; Phase-0 `_RESULT_IDENTIFIER` |
| D4 | Separate verifier pass, not evaluator extension | Dafny/Boogie shape; isolates symbolic state; avoids destabilizing the self-hosting evaluator; re-scopes old §B1's cost | Old "extend the evaluator with path conditions" |
| D5 | In-memory VC terms + direct SMT-LIB 2; no persisted VIR | The IR existed to keep "the SMT backend stupid"; an in-memory term type does that without a pipeline stage | Old §B2 (separate `FORMAL_VERIFICATION_VIR.md`) |
| D6 | Bitvector integer semantics | Matches emitted C (`-fwrapv`) exactly — proofs are about the program that runs; overflow opt-in later | (implicit in old draft's theories; now pinned) |
| D7 | rlimit-based deterministic budgets | Reproducibility is a hard requirement for LLM authors; wall-clock is a crash guard only | Old "per-function timeout (default 10s)" |
| D8 | AoRTE obligations always-on in verify modes | Highest LLM value per token: bounds/div-zero on unannotated code | — |
| D9 | `VerifyOrAssert` (`verify+`) is the flagship mode | Gradual adoption; proofs cost zero runtime; solver can never block a build | ROADMAP alignment |
| D10 | Capability lattice / taint tracking deferred | Orthogonal infrastructure (old §B5); not needed for the core Dafny surface | Old Phase 4 |
| D11 | Type invariants deferred | Interacts with every constructor/`inout` method; loop invariants first | Old §"invariant on struct/object types" |
| D12 | `decreases` partial-correctness default | Dafny's stance; termination proofs opt-in | Old Open Question 3 (resolved: adopt Dafny default) |

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Encoding/semantics mismatch (SMT model ≠ emitted C) | Medium — the subtle bugs live here | Bitvector widths from `CompilationTarget`; bugged-twin test discipline; dogfooding on `std/` where runtime behavior is heavily tested |
| Quantifier blowup (V5) | High for ambitious specs | Quantifier-free flagship surface (V3–V4); deterministic budgets make failure stable; guidance diagnostics |
| Solver regressions on version bumps | Medium | Pin + cache keying; bumps are deliberate release events with a re-verification CI run |
| Verification too slow on real modules | Medium | Per-function budgets, cache, `yo verify` as a separate CI job, subset errors fail fast |
| Side-table keying breaks under specialization | Low — `copy_func_contract_exprs` already handles re-keying | V1 extends the same lifecycle; unit tests cover specialization paths |
| `verify+` strip pass corrupts bodies | Medium — body rewriting is delicate | Strip keyed by spliced node ids (fresh per splice); `macro_expansion` discipline documented; `--emit-c` diff tests |
| Scope creep toward a theorem prover | High (history says so) | Non-goals section is binding; tactic/interactive/second-solver requests close as "non-goal" |

## Open questions

1. **`object` heap model.** When `object` types enter the subset (V6+),
   flat per-class heaps (Burstall-Bornat) vs. full separation logic.
   Recommendation: flat heaps keyed by abstract reference, forbid
   cycles in verified code initially — decide when V6 shapes it.
2. **Trait contracts with generic quantification** (old §B3): contracts
   on `map`-style methods quantify over the function parameter. V6
   designs this against the abstract-generic encoding; the trait
   variance rule (V6 task 1) is the fallback if quantified trait
   contracts prove too expensive.
3. **String content reasoning depth.** `Seq (BV8)` gives length and
   byte-level predicates cheaply; UTF-8 structural properties
   (`Utf8Valid`) may need axiomatized predicates rather than direct
   encoding. Decide in V5.
4. **Floats.** Still a non-goal (QF_FP is slow and rarely what LLM
   systems code wants). Revisit only with a concrete user.
5. **`inout` aliasing.** Two `inout` params aliasing the same value is
   possible at call sites; the two-state encoding assumes distinct
   snapshots. Options: forbid aliased `inout` in verified calls (check
   at call-site obligation time) or merge states. Decide in V5.
6. **Type invariants.** If adopted later: obligation at every
   constructor + `inout` method exit; interacts with V6 trait
   contracts. A separate addendum when prioritized.
7. **Async verification.** Per-state verification over the generated
   state machine (old draft's idea) is plausible but unscoped; await
   points as yield boundaries. Parked until the core is done.

## History & audit trail

- **2026-09-04 (this revision).** Full audit against the live tree;
   decisions D1–D12; phases V1–V7 replace the old Phase 1–6; old audit
   findings re-dispositioned: §A1 (clause order — resolved & landed),
   §A2 (invariant placement — resolved & landed), §A3 (ghost split —
   resolved & landed), §A4 (result scope — **superseded** by D3 named
   returns), §A5 (ghost-context flag — V5 spec), §B1 (evaluator
   extension cost — **superseded** by D4 architecture),
   §B2 (VIR underspecified — **superseded** by D5), §B3 (trait
   contracts — V6 scope), §B4 (Refine complexity — V6 scope),
   §B5 (capability lattice — D10 deferred), §B6 (CBMC/KLEE mapping —
   **dropped** with D2), §C1 (13–19 p-mo estimate — re-based on D4/D5),
   §C2 (60% framing — corrected framing kept), §D1–D5 (implementation
   notes — folded into V1–V3 with current paths), §E1 (unit-return
   contracts — resolved: no return binding, param-only predicates),
   §E2–E3 (forall/comptime params — comptime params are CTFE-evaluable
   in contracts; no special case needed), §E4 (`.check` cost — V6:
   `.check` is an ordinary runtime `Option` gate, cost is the
   predicate's), §E5 (specialization — side tables re-key via
   `copy_func_contract_exprs`; verifier input is post-specialization),
   §F1/F2 (stale claims — removed).
- **2026-05-26.** First audit added to the draft; "Phase 0 only"
   recommendation; 13–19 p-mo estimate for the evaluator-extension
   architecture.
- **Phase 0 (landed before this revision).** Contract surface + runtime
   lowering + pragmas + std/spec skeletons + tests; see
   [Current state](#current-state--audited-2026-09-04) for the audited
   inventory.

## Worked example: verified `NonEmpty(Slice(T)).head()`

Target state after V6 (updated from the old draft to named returns):

```rust
pragma(Pragma.VerifyOrAssert);

{ Refine } :: import("std/spec/refine");

NonEmpty :: (fn(comptime(T) : Type) -> comptime(Type))(
  Refine(Slice(T), (s) => ((s.len() > usize(0))))
);

head :: (fn(
  forall(T : Type),
  s : NonEmpty(Slice(T)),
  // requires((s.len() > usize(0))) — implied by the refinement on `s`
  ensures((result == (s(usize(0))))),
) -> (result : T))((s(usize(0))));

main :: (fn() -> i32)({
  arr := Array(i32, usize(3))(i32(1), i32(2), i32(3));
  slice := arr.as_slice();

  // Construction site: the refinement's VC (`slice.len() > 0`) discharges
  // by CTFE (the array literal's length is a compile-time 3) — no SMT call.
  ne := NonEmpty(Slice(i32))(slice);
  first := head(forall(i32), ne);
  assert((first == i32(1)), "first should be 1");

  // From dynamic data — the runtime gate:
  match(NonEmpty(Slice(i32)).check(some_runtime_slice()),
    .Some(ne2) => { println(head(forall(i32), ne2)); },
    .None => println(`empty`)
  );
  i32(0)
});
export(main);
```

What the verifier does:

- `NonEmpty(Slice(i32))(slice)` — construction VC `slice.len() > 0`,
  discharged by CTFE from the literal length (no solver round-trip).
- `head(ne)` — no caller obligation beyond the refinement (carried by
  the type); after the call, `ensures` gives `first == ne(0)`.
- Inside `head`, `s(usize(0))` — the AoRTE bounds obligation discharges
  from the refinement's predicate on `s`.
- Zero runtime cost vs. the unannotated version; every caller was forced
  to prove non-emptiness or check at runtime.

## References

- [`ROADMAP.md`](../ROADMAP.md) — Phase 1 (this plan) is the flagship.
- [`MEMORY_SAFETY.md`](../reference/MEMORY_SAFETY.md) — the unsafe
  boundary the verifier refuses to cross.
- [`.github/instructions/yo-design.instructions.md`](../../.github/instructions/yo-design.instructions.md) —
  breaking-change policy this plan operates under.
- [`tests/spec/`](../../tests/spec/) — the Phase-0 test set the verifier
  phases extend.
- External: Dafny (Microsoft Research — verification semantics, partial
  correctness defaults, counter-example reporting), SPARK/Ada (verifiable
  subset, AoRTE obligations, gradual adoption), Boogie (separate-pass
  VC architecture), Why3 (SMT-LIB over stdio, solver budgets), Z3
  (`rlimit` deterministic budgets, unsat cores, `get-model`).
