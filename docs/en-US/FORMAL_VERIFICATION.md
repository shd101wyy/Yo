# Formal Verification

Yo has a compile-time verifier in the Dafny/SPARK tradition: functions
annotated with contracts (and, in verify mode, **unannotated** functions
too) are symbolically executed and their proof obligations are discharged
by the pinned [Z3](https://github.com/Z3Prover/z3) SMT solver. A proof
replaces runtime checks; a refutation is a compile error with a concrete
counter-example. Design record: [`plans/backlog/FORMAL_VERIFICATION.md`](../../plans/backlog/FORMAL_VERIFICATION.md).

```bash
# Verify a file (or directory) — non-zero exit if anything fails
yo verify ./src/my_spec.yo

# Full detail for one function (substring match on the fn@path:line id)
yo verify ./src/my_spec.yo --explain abs

# JSON report
yo verify ./src/my_spec.yo --format json
```

## Contracts

Contracts are builtin calls in the function signature. The return value
is named by the label in `-> (name : T)` — there is no magic `result`
identifier.

```rust
abs_i32 :: (fn(x : i32, ensures(r >= i32(0))) -> (r : i32))(
  if(x < i32(0), i32(0) - x, x)
);

safe_div :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(r == (x / y))) -> (r : i32))(
  x / y
);
```

Verification is **modular** (the Dafny model):

| Site | `requires(P)` | `ensures(E)` |
| --- | --- | --- |
| The function's own file | **assumed** on entry | **proved** on every exit path |
| Any call site | **proved** under the caller's path condition | **assumed** after the call |

A caller never opens the callee's body — it reads only the signature. A
function in a `runtime`-mode file still carries usable contracts at
verified call sites; only its own body goes unverified.

## Modes

| Mode | How to select | Behavior |
| --- | --- | --- |
| `runtime` (default) | no pragma | Contracts lower to runtime `assert(...)` — today's behavior |
| `verify` | `pragma(Pragma.Verify);` | Proof obligations replace asserts; refuted/unprovable ⇒ compile error |
| `verify+` | `pragma(Pragma.VerifyOrAssert);` | Prove when possible; budget-exhausted falls back to the runtime assert |
| `ignore` | `pragma(Pragma.NoContracts);` | Contracts erased entirely |

`yo verify <path>` defaults its target set to `verify` mode; a
`--verify-mode runtime|verify|verify+` flag overrides, and a file's own
pragma is the source of truth when present. Mode effects apply only to
the files being verified — imported files (the standard library, `std/`)
keep their runtime behavior untouched.

## Automatic obligations (AoRTE)

In verify modes the verifier proves things **no contract asked for**, on
every function:

- every `/` and `%`: the divisor is non-zero;
- every `<<`/`>>`: the shift amount is within the operand width.

Index bounds join them as slices enter the subset. This catches the
classic bounds/divide-by-zero bug class on completely unannotated code:

```rust
// No contracts — and still a compile-time error: y = 0 divides by zero.
divide_bugged :: (fn(x : i32, y : i32) -> (r : i32))(x / y);
```

```
refuted  fn@/abs/path.yo:8 [verify]
    fn@/abs/path.yo:8/divisor-nonzero: REFUTED  counter-example: y = #x00000000
```

## The verifiable subset (current state)

Verification is defined over a subset of Yo that grows per phase; a
function using anything outside it gets a precise
`cannot verify: <construct>` error (or, in `verify+`, falls back to the
runtime assert).

| Construct | Status |
| --- | --- |
| Integer/bool arithmetic, comparisons, logical ops, `cond`/`if` | ✅ verified |
| Let bindings (`:=`, `=`), begin blocks, calls to contracted/comptime-foldable callees | ✅ verified |
| `assert(P)` sites, `panic` paths, `old(...)` (identity — no mutation in subset) | ✅ verified |
| `match` over value enums (testers, projections, constructions) | ✅ verified (V3) |
| structs / tuples / ref enums | 🚧 in progress |
| `while` with `invariant(...)` (the havoc rule) | ✅ verified (V4) |
| `decreases(M)` — loop statement variant + recursion measure | ✅ verified (V4) |
| assignments inside `cond` arms (the phi merge); `continue` as the loop body's final statement | ✅ verified (V4.1) |
| `break` (exit-path disjunction), `for` loops | 🚧 V4.2 |
| Ghost code, quantifiers, two-state reasoning | V5 |
| Traits/generics across boundaries, `Refine` | V6 |
| `object`/heap, string content, floats, effects, `unsafe`, FFI | outside the subset |

Integers are modeled as **exact-width bitvectors matching the emitted
C11** (`-fwrapv` two's-complement) — a proof is a proof about the
program that runs. Overflow is defined semantics, not an obligation.

Value enums are modeled as **SMT datatypes**: one
`declare-datatypes` block per query declares every enum the obligations
touch, with constructors and accessors mangled to module-qualified names
(they share the datatype's whole SMT namespace). A `match` lowers to a
nested `ite` over `(is-<Ctor> ...)` testers; pattern bindings become
accessor projections; `.Variant(args...)` constructions become
constructor applications.

`while` lowers to the **havoc-invariant rule**: prove the invariant on
entry; assume `invariant ∧ condition` over a havoced state (every
assigned name becomes a fresh unconstrained constant); execute the body
symbolically; prove the invariant over the resulting state; the exit
path assumes `invariant ∧ ¬condition`. A `decreases(M)` statement after
the invariant additionally proves the measure non-negative over the
havoced state and strictly decreasing across the iteration; a
`decreases(M)` clause in a function signature does the same at every
recursive self-call, which is what makes recursion verifiable at all.
The exact-width bitvector model means **wraparound is real**: a spec
that lets arithmetic overflow will be honestly refuted, so fixtures
carry the bounds their arithmetic needs.

## The solver

One pinned Z3 (see `Z3_VERSION` in `src/verifier/z3.yo`; currently
5.1.0). Resolution order: `YO_Z3_PATH` → the pinned install under
`~/.cache/yo/solvers/` → automatic one-time download from GitHub
Releases. Verdicts are cached per-obligation under
`~/.cache/yo/verify-cache/` (keyed by the sha256 of the query, the pin,
and the run options); pass `--no-cache` to bypass. Determinism comes
from `:rlimit` budgets (not wall-clock) and a fixed `:random-seed 0`.

## Try it

The repository's own battery is a working example — every function
there proves, and each negative fixture next to it has a deliberately
bugged twin that must refute:

```bash
yo verify ./tests/spec/verify_straight_line.test.yo
```
