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

### Trait contracts (variance + inheritance)

A trait method may carry contracts in its signature, and an `impl`
method may declare its own for the same method. The pair is checked
against each other at impl registration:

| Obligation | Direction | Why |
| --- | --- | --- |
| `trait.requires ⇒ impl.requires` | contravariant | a dispatch caller proves only the trait's precondition, so the impl may weaken it but never strengthen |
| `impl.ensures ⇒ trait.ensures` | covariant | the trait's promise is the floor, so the impl may strengthen it but never weaken |

```rust
ClampBound :: trait(
  get : (
    fn(self : Self, i : i32, requires(i >= i32(0)), ensures(result >= i)) -> (result : i32)
  )
);

// PROVES: requires weakened to i >= -1, ensures strengthened to result == i.
get_impl :: (
  fn(self : i32, i : i32, requires(i >= i32(-1)), ensures(result == i)) -> (result : i32)
)(i);

impl(
  i32,
  ClampBound(
    get : get_impl
  )
);
```

An impl method declaring **no** contracts of its own **inherits** the
trait method's — they are registered onto the method value like declared
ones, so the method's own verify task proves them against its body (a
proof that needs the inherited `requires` genuinely fails without it).
The variance obligations register as a synthetic
`impl-variance@module:row:label` verify task — one assert per
implication, over the impl's parameters with the return label as one
extra symbolic value — and run through the ordinary pipeline. The impl's
predicates must use the trait's parameter and label spellings; a
mismatch is reported as an unbound name at the obligation. An impl that
strengthens the precondition is refuted with the dispatch
counter-example (`i = 0` for the twin of the example above).

### Generic functions

A **generic** function's contracts discharge at its call sites — the
Dafny modular model again: the generic body is not walked (it is
re-evaluated per specialization), but every monomorphized call site
**proves** the generic's `requires` against the caller's path condition
and **assumes** its `ensures` over a fresh result term. Two pieces of
machinery make that work: the specialization re-keys the contract
tables onto the specialized function id, and the call site evaluates
the signature predicates at the **concrete** argument types (at the
generic's own definition the predicates cannot be evaluated — operators
over the type variable have no comptime impl — so the caller-side
evaluation is what gives the verifier typed predicate nodes).

```rust
pick :: (
  fn(generic(T : Type), flag : bool, a : T, b : T, ensures((result == a) || (result == b))) -> (result : T)
)(if(flag, a, b));

// The caller's own post-condition is provable only THROUGH the assumed
// generic ensures — the verifier never opens the pick body.
caller :: (fn(ensures((r == i32(1)) || (r == i32(2)))) -> (r : i32))(
  pick(true, i32(1), i32(2))
);
```

A caller that violates the generic's `requires` (passing `flag = false`
to a `requires(flag)` callee) is refuted at the call site with a
counter-example.

### Mutual recursion

Mutually recursive functions terminate when every member carries
`decreases(M)` and every call **between clique members** proves the
callee's measure at the actuals strictly below the caller's current
measure — one shared well-founded domain, no lexicographic tuples. The
cliques are derived automatically from the task set's call graph, so an
edge without a decrease (passing `n` unchanged) is refuted:

```rust
is_even :: (fn(n : i32, requires(n >= i32(0)), decreases(n)) -> (r : bool))(
  if(n == i32(0), true, is_odd(n - i32(1)))
);
is_odd :: (fn(n : i32, requires(n >= i32(0)), decreases(n)) -> (r : bool))(
  if(n == i32(0), false, is_even(n - i32(1)))
);
```

### Refinement types — `refine(T, p)`

`refine(T, p)` annotates "a `T` that satisfies the predicate `p`". The
annotation evaluates to `T` — erased, zero runtime cost; values bind,
dispatch and lower exactly as the plain type — while the refinement
rides the function's signature. The predicate is a one-parameter
`ghost_fn` value; the verifier discharges it modularly — a function
**assumes** the refinement of every refined parameter at entry, and
every call site **proves** a `refine#N` obligation for the argument it
passes:

```rust
non_zero :: ghost_fn((fn(x : i32) -> bool)(x != i32(0)));

// No manual `requires` needed: the divisor obligation proves from the
// assumed refinement of `denom`.
safe_div :: (fn(num : i32, denom : refine(i32, non_zero)) -> (r : i32))(num / denom);

// The caller proves `refine#1` (x != 0) under its own requires.
caller :: (fn(x : i32, requires(x != i32(0))) -> (r : i32))(safe_div(i32(7), x));
```

A caller that cannot prove the predicate is refuted with a
counter-example (`d = 0`), while the callee stays verified — one bad
caller does not poison the callee. `refine(T)` with no predicate is a
bare alias carrying no obligation. The refinement attaches to the
`refine(...)` annotation itself; named aliases over refinements
(`NonZero(i32)`) arrive with the `std/spec` refinement surface.

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
| `assert(P)` sites, `panic` paths, `old(...)` (two-state: the function-entry snapshot; body-locals are gated — no entry value) | ✅ verified |
| `match` over value enums (testers, projections, constructions) | ✅ verified (V3) |
| structs / tuples / ref enums | 🚧 in progress |
| `while` with `invariant(...)` (the havoc rule) | ✅ verified (V4) |
| `decreases(M)` — loop statement variant + recursion measure | ✅ verified (V4) |
| assignments inside `cond` arms (the phi merge); `continue` as the loop body's final statement | ✅ verified (V4.1) |
| `break` (exit-path disjunction); `continue` at any statement (proved at the site); `while(runtime(true), ...)` | ✅ verified (V4.2) |
| `for` loops (need the iterator/collection model) | later phases |
| `forall`/`exists`/`==>` in contracts (ghost-only; SMT quantifiers, MBQI instantiation) | ✅ verified (V5) |
| `inout` params — the reassignable two-state binding (`old(v)` reads the entry snapshot) | ✅ verified (V5) |
| `std/spec` ghost collections — Seq (`seq_unit`/`seq_append`/`seq_len`/`seq_nth`, SMT `Seq`), Multiset (`ms_single`/`ms_add`/`ms_count`, elem→count `Array`), Set (`set_single`/`set_add`/`set_contains`, membership `Array`), `str_bytes` (str content as `Seq(u8)`) | ✅ verified (V5) |
| Fixed-length `Array(T, N)` values — `a(i)` reads (`select`), `a(i) = v` index writes (an SSA rebind through `store`), `index-in-bounds` AoRTE obligations, and `ms_of(a)` (the array's elements as a ghost Multiset — what `permutation` specs are made of) | ✅ verified (V5 task 6) |
| Ghost code (`ghost`/`ghost_fn` erasure) | ✅ verified (V5 task 3) |
| Trait-method contracts — INHERITANCE onto clause-less impl methods + the VARIANCE obligations (`trait.requires ⇒ impl.requires` contravariant, `impl.ensures ⇒ trait.ensures` covariant) as synthetic `impl-variance@…` tasks | ✅ verified (V6 task 1) |
| Contracted GENERIC functions at call sites — `requires` discharged and `ensures` assumed per monomorphized call site (the generic body itself stays unwalked) | ✅ verified (V6 task 2) |
| MUTUAL recursion — `decreases(M)` on every clique member; clique-edge calls prove the callee's measure at the actuals (cliques derived from the call graph) | ✅ verified (V6 task 4) |
| Generic bodies verified abstractly (uninterpreted type sorts, trait-constraint axioms), `Refine` | V6 |
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
The exit state is a **fresh havoc generation** — a loop that never runs
keeps its pre-state, which the body's output cannot represent, so the
exit facts are `invariant ∧ ¬condition` over unconstrained constants.
A `break` adds its own exit disjunct: a fresh boolean selects the state
snapshot taken at the break site (its full path condition included),
and everything after the loop is proved under the disjunction. A
`continue` anywhere in the body proves the invariant (and the measure
step) at the statement itself. `runtime(e)` is the identity marker —
`while(runtime(true), { invariant(...); ...; if(done, { break; }) })`
is the verifiable form of "loop until done".
`forall((k : T), P)`/`exists((k : T), P)` lower to SMT
quantifiers over the annotated binders (z3's model-based instantiation
discharges them in these small goals; explicit `:pattern` triggers are
deferred until a benchmark needs them), and `a ==> b` is boolean
implication. All three are **ghost-only** — legal inside contract
clauses, `ghost(...)` bindings, and `ghost_fn` bodies, a compile error
anywhere else (they have no runtime semantics). An `inout` parameter is
the one REASSIGNABLE binding in the subset: the body's `=` rebinds the
current value while `old(v)` keeps reading the entry snapshot.
The exact-width bitvector model means **wraparound is real**: a spec
that lets arithmetic overflow will be honestly refuted, so fixtures
carry the bounds their arithmetic needs.
A fixed-length `Array(T, N)` value is a **BV64-indexed SMT array**:
`a(i)` reads `select(a, i)` (the index zero-extended to 64 bits), and an
index write `a(i) = v` REBINDS the name to `store(a, i, v)` — value
semantics, the same SSA discipline as every other `=`. Reads and writes
at runtime positions carry `index-in-bounds` AoRTE obligations
(`i u< N`, from the compile-time length); reads inside a quantifier body
do not — there the spec's own guards carry the bounds. `ms_of(a)` folds
the array's N elements into a ghost Multiset (elem→count), so
`permutation(s, old(s))` is `forall(x, ms_count(ms_of(s), x) ==
ms_count(ms_of(old(s)), x))` — plain array congruence once N unrolls.
The V5 exit fixture — an in-place insertion sort over `Array(i64, 8)`
proving sortedness AND the permutation through those two quantified
invariants — is `tests/spec/fixtures/valid/spec_insertion_sort.yo`.

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
