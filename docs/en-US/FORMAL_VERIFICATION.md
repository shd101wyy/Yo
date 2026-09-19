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
bare alias carrying no obligation. The refinement can be spelled
inline in the parameter annotation or through a NAMED alias —
`NonZeroI32 :: refine(i32, non_zero)` then `d : NonZeroI32` (the alias
binds the refinement type itself).

**The std/spec families are real refinements.** `NonZero(T)`,
`Bounded(T, lo, hi)`, `Positive(T)`, `Even(T)`, … attach concrete
predicates by spelling the predicate ghost INSIDE the alias body — the
alias's comptime parameters are in scope at ghost creation, so each
`NonZero(i32)` evaluation creates a fully concrete predicate:

```rust
NonZero :: (fn(comptime(T) : Type) -> comptime(Type))(refine(T, ghost_fn((fn(x : T) -> bool)(x != T(0)))));
```

Composition — `refine(refine(T, p), q)` — acts as the conjunction: the
verifier assumes/proves every predicate in the chain (the type itself
stays nested-distinct). Values are constructed through the runtime
gates — `check_non_zero(x)` / `check_bounded(x, lo, hi)` return
`Option(Refined)` — or the trusted casts `unchecked_non_zero(x)` /
`unchecked(p, x)` (pair with `pragma(Pragma.AllowUnsafe)`). A
comptime-returning function requires all parameters comptime, so the
general wrapper spells its predicate parameter `comptime(p)`; a
comptime predicate can never be *called* at runtime, which is why the
family gates spell their predicates inline rather than taking the ghost
as a runtime value.

**Literal arguments fold — no solver involved.** When the argument of a
refined parameter is a literal (`takes_nz(i32(5))`), the `refine#N`
obligation is constant-folded at emission: the predicate over literals
(`5 != 0`) evaluates to a boolean, and the verdict is recorded without
an SMT call (the summary counts it as `folded`, never as a query).
Folding is conservative — division/remainder (whose zero divisor IS the
AoRTE obligation under proof) and shifts beyond the operand width stay
symbolic.

**Editor integration.** The LSP shows a function's contracts on hover —
requires/ensures clauses, the return label, a `ghost_fn` marker for
spec-only predicates, and the file's verification mode. Counter-examples
surface as ordinary diagnostics when a verify run refutes an
obligation; per-function verdicts are a `yo verify --explain` query, not
a hover computation (they need the solver).

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

## Laws: claims stated outside the code

A contract lives in the function it constrains, which means the code's author
also owns its specification. A **law** is the other half: a claim written
*about* code, in a file the implementation does not touch.

```rust
pragma(Pragma.Verify);

{ abs_value } :: import("./math.yo");

// LAW: doubling an absolute value over the contracted domain stays non-negative.
abs_doubles_nonneg :: law(
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((abs_value(x) + abs_value(x)) >= i64(0))
  ) -> unit
);
```

The argument is a function **type** with contract clauses and no body. Its
`ensures` predicates are the obligations; its `requires` are assumed on entry
and are what discharge the callees' own `requires` at each call site. A law
evaluates to `unit`, so `name :: law(...)` binds unit and codegen emits nothing.

**A law is proved from the callee's contract, never from its body.** That is the
point, and it is also the constraint: if `abs_value` promises only
`ensures(r >= 0)`, the law above cannot be proved, because two values known only
to be non-negative can overflow when added. The upper bound in the callee's
`ensures` is what makes the claim provable. A law failing this way is usually
telling you the contract is weaker than you thought.

Rules, each of which is a compile error rather than a silent pass:

| rejected | why |
| --- | --- |
| a non-`unit` return | a law has no value; its claim belongs in `ensures(...)` |
| no `ensures(...)` | a law that claims nothing would report a vacuous pass |
| `assumed()` | it would let the claim pass without being proved |
| `decreases(...)` | a law has no recursion to measure |
| a named alias instead of a written-out `fn(...)` type | its clauses cannot be scanned, so a hidden `assumed()` would be ignored |

Laws are reported under their own `law@<file>:<row>:<column>` id, so two laws on
one line stay distinct:

```
  ok       law@spec/math_laws.yo:8:21 [verify] — 3 obligation(s) proved
  refuted  law@spec/math_laws.yo:16:19 [verify]
    law@spec/math_laws.yo:16:19/ensures#0: REFUTED  counter-example: x = #x0000000000000000
```

### The convention: a `spec/` directory the humans own

Nothing in the compiler knows what a "law file" is — this is a convention, and
it is the point of the feature:

1. Keep laws in `spec/`, written by the people who decide what the software must
   do. The implementation may not edit them.
2. Gate them with `yo verify ./spec --strict`, so a run cannot pass because a
   contract was `assumed()` away.
3. Add `spec/` to CODEOWNERS if your host supports it.

In runtime mode (no verify pragma) a law is an accepted no-op marker, so
specification text never breaks an ordinary build. Note the consequence: a law's
predicates are only name-resolved under verification, so a law referring to
something that does not exist is caught by `yo verify`, not by `yo check`.

## Strict mode: a gate that cannot go quietly green

A plain `yo verify` run passes when a function reports `assumed` (its
contracts were declared, its body was never walked) or `outside-subset`
(it promised nothing and the walk could not enter it). That is right for
adopting verification gradually, and wrong for a gate: an agent editing
the code can add `assumed()`, drop an `ensures`, or push a body out of
the subset, and the run stays green with no signal.

`--strict` turns those outcomes into failures:

```bash
yo verify ./spec --strict          # = --deny assumed,outside-subset,unproven
yo verify ./spec --deny assumed    # or name the outcomes yourself
```

The outcome vocabulary is `ok`, `assumed`, `outside-subset`, `unproven`,
`refuted`, `solver-error`, `subset-error`; an unknown name in `--deny` is
a usage error that lists the set. A denied outcome fails in **every**
mode, so `unproven` under `--strict` fails even in `verify+`, where it
would otherwise fall back to a runtime assert.

Every run ends with a summary line — counts for all seven outcomes (zeros
included, so it is greppable), how many of the `ok` results were
*vacuous* (they discharged no obligation at all), the number of solver
queries with the cache hit rate, how many obligations were discharged by
constant folding (no solver), and the wall time:

```
verify: 2 ok, 1 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous) — 3 queries, 2 cached (66%), 1 folded, 46 ms
```

`--format json` carries the same numbers under a `summary` object, plus
`strict` and the `denied` list:

```json
"summary": { "total": 3, "ok": 2, "assumed": 1, "outside-subset": 0,
             "unproven": 0, "refuted": 0, "solver-error": 0,
             "subset-error": 0, "vacuous": 1, "queries": 3,
             "cached": 2, "folded": 1, "elapsed_ms": 46,
             "strict": false, "denied": [] }
```

Each function entry (`functions[]`) carries `fn_id`, `mode`, `outcome`,
`vacuous`, `subset_construct`/`subset_source`, and its `obligations[]` —
one object per obligation with `name`, `verdict` (`proved` / `refuted` /
`unproven` / `solver-error`), `cached`, `folded`, `goal` (the obligation
rendered as SMT-LIB — what the solver was asked), and `model` (the
counter-example bindings, `refuted` only).

`--explain <pattern>` narrows the report to functions whose id matches
(substring — a bare name or a `file:line` both work) and forces the
detailed rendering: every obligation lists its verdict AND its goal
term, for `ok` functions too — the VC set of a verified function is
inspectable, not just the failures:

```
  ok  fn@src/my_spec.yo:12 [verify]
    fn@src/my_spec.yo:12/refine#1: PROVED (folded)
      goal: (not (= (_ bv5 32) (_ bv0 32)))
```

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
refuted  fn@src/math.yo:8 [verify]
    fn@src/math.yo:8/divisor-nonzero: REFUTED  counter-example: y = #x00000000
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
