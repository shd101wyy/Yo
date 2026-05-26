# Formal Verification

> **Status: draft.** Initial design sketch — no code landed. This document
> proposes a layered verification surface for Yo built on the existing
> compile-time evaluator, algebraic effects, and where-clause type system.
> Breaking changes are acceptable per [`yo-design.instructions.md`](../.github/instructions/yo-design.instructions.md).

## Goal

Make Yo a language where **security- and correctness-critical properties can be
proved at compile time**, with a graduated cost model: cheap properties
(non-zero, bounds, ownership) are discharged automatically by the evaluator;
expensive properties (loop invariants, functional correctness, cryptographic
constant-time) are discharged by an opt-in SMT backend or external bounded
model checker.

Yo's design center is **LLMs as primary code authors**. This is the key
audience this plan optimises for: contracts are the artifact that
converts silent LLM hallucination into compile errors with concrete
counter-examples. An LLM that writes `requires(...)` / `ensures(...)`
alongside its implementation gets a second oracle (beyond the typechecker
and test runner) telling it "wrong, here's why" — closing the iteration
loop the same way a unit test does but without the LLM having to invent
inputs that trigger the bug. See [Design for LLM authorship](#design-for-llm-authorship)
below for the LLM-specific constraints this places on the verifier.

The pitch: **"Every function in `std/` carries an executable specification.
LLM-generated code at the application layer opts the same specifications
into a verifier and gets a proof — or a counter-example — without leaving
the source file."**

This is Dafny's surface, F\*'s effect discipline, and Rust+Kani's tooling
shape, adapted to Yo's syntax, algebraic-effect model, C codegen pipeline,
and LLM-author focus.

## Non-Goals

- **No full dependent types.** No `Pi` types, no value-indexed type families
  beyond what GADTs already give. Refinements are predicates attached to
  existing types, not new kinds.
- **No interactive theorem proving in-tree.** No tactic language. The goal
  is automation; properties that need tactics belong in a sibling Coq/Lean
  project.
- **No mandatory verification.** Verification is opt-in per file (via a
  pragma) and per function (via contract annotations). Code without
  annotations compiles exactly as today.
- **No proof of full functional correctness for `std/`.** The plan picks a
  small core (slice access, integer arithmetic, allocator, hash, sort,
  parser limits) and ships proofs for those. The rest gets contracts but
  not necessarily proofs.
- **No verified compiler.** The Yo→C lowering itself stays unverified;
  proofs are at the Yo source level. (CompCert-style verified codegen is a
  separate, much larger project.)
- **No replacement for `assert(...)` or `panic(...)`.** Existing runtime
  assertions stay. Contracts compile to assertions in the default
  configuration; verification is the upgrade path, not the replacement.

---

## Why Yo is unusually well-positioned for this

Yo already carries most of the machinery a verifier needs. The plan is
mostly about exposing it.

| Existing Yo feature                                           | What verification gets from it                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compile-time evaluator** (`src/evaluator/`)                 | Already a partial symbolic interpreter (`UnknownValue`, `arrayElementRef`, slice-flowability). Becomes the verification condition generator.      |
| **`where(...)` clauses on `forall`**                          | Natural home for refinements: `where((x > i32(0)))` instead of trait-only constraints.                                                            |
| **Algebraic effects with `ctl(...) -> R`**                    | Effects become **capabilities**. A function with no `io : Io` parameter provably performs no I/O. A function with no `raise : Raise` cannot fail. |
| **`unsafe(...)` markers + per-file pragma**                   | Verifier can refuse to enter unsafe regions, or be told to assume their contracts. Trust boundary is already greppable.                           |
| **GADTs with `-> recur(T)`**                                  | Variant-indexed type refinement is already possible. Verifier extends this to value-indexed.                                                      |
| **Nominal types, no implicit coercion**                       | No SMT axioms needed to reason about coercion. `i32(x)` to `i64` is an explicit, modelable cast.                                                  |
| **C11 backend, `-fwrapv` (signed wrap defined)**              | Two's-complement wrap-around is a stable semantic target. SMT bitvector theory matches the C output.                                              |
| **`comptime_expect_error`, `comptime_assert`**                | The reject-this-program testing surface already exists. Verification failures plug into the same mechanism.                                       |
| **Object types have RC reference semantics**                  | Aliasing is contained: `object(...)` types have shared mutable state; `struct(...)` types do not. The verifier can rely on this dichotomy.        |
| **Pure-functional combinators on `Option`/`Result`**          | Most stdlib higher-order code is already pure. Verification gates pure functions cheaply.                                                         |
| **No operator precedence**                                    | Source AST is already a tree of explicit calls; no precedence parsing inside the verifier.                                                        |
| **Slice flowability R1–R4 analysis** (`SLICE_FLOWABILITY.md`) | Proof that the evaluator already does non-trivial static reasoning per-call. The verifier extends, not replaces, this pass.                       |

The shortest framing: **Yo's compile-time evaluator is already 60% of a
verification condition generator.** This plan describes the other 40%.

---

## The surface — six primitives

The verification surface consists of four new builtin calls
(`requires`, `ensures`, `invariant`, `ghost`), one new type constructor
(`Refine`), and one new pragma value (`Pragma.Verify` and its variants).
Three ghost-context builtins (`forall_val`, `exists_val`, `==>`) appear
later, in the spec-module section. Everything else is reused.

### 1. `requires(...)` — pre-condition

A pre-condition is a `bool` expression that must hold on entry. It appears
**inside the function type signature**, alongside parameters, `forall(...)`,
and `where(...)` — the same clause-list shape Yo already uses for type
constraints:

```rust
divide :: (fn(
  x : i32,
  y : i32,
  requires((y != i32(0))),
) -> i32)((x / y));
```

A single `requires(...)` call takes one or more predicates as arguments;
they are conjoined. This matches the shape of `where(T <: A, U <: B)`,
`cond(c1 => r1, c2 => r2)`, and every other multi-clause Yo construct.
The verifier preserves per-argument source spans so failure messages
still pinpoint the violated predicate:

```rust
binary_search :: (fn(
  forall(T : Type),
  arr : Slice(T),
  key : T,
  where(T <: Ord),
  requires(
    sorted(arr),
    (arr.len() <= usize(0x7FFFFFFF)),
  ),
) -> Option(usize))(body);
```

`requires()` with zero arguments is a syntax error — omit the clause
entirely if there is no precondition. Multiple `requires(...)` clauses in
the same signature are also a syntax error (use one call with multiple
arguments).

### 2. `ensures(...)` — post-condition

A post-condition lives in the same signature clause-list and refers to
the function's **result** via the magic identifier `result` (in scope only
inside `ensures(...)`):

```rust
abs :: (fn(
  x : i32,
  ensures(
    (result >= i32(0)),
    ((result == x) || (result == -(x))),
  ),
) -> i32)(cond(
  (x >= i32(0)) => x,
  true => -(x)
));
```

Like `requires(...)`, a single `ensures(...)` call takes one or more
predicates; multiple `ensures(...)` clauses in the same signature are a
syntax error.

`ensures(...)` clauses also see all parameters, plus `old(expr)` for the
parameter value on entry (relevant when `ref(name) : T` parameters are
mutated):

```rust
increment :: (fn(
  ref(n) : i32,
  requires((n < i32(0x7FFFFFFF))),
  ensures((n == (old(n) + i32(1)))),
) -> unit)({
  n = (n + i32(1));
});
```

### Why signatures, not bodies

Function contracts (`requires`, `ensures`) live in the signature for
three concrete reasons:

1. **Modular reasoning at call sites.** A caller proves a call by reading
   only the callee's signature. Putting the contract in the body would
   force callers to open the implementation file.
2. **Trait declarations have no body.** Yo's trait fields are pure
   function types (`next : (fn(ref(self) : Self) -> Option(Self.Item))`).
   For trait methods to carry contracts, the contracts must live in the
   function type. Anything else makes the language inconsistent.
3. **Overlap with `where(...)`.** `where(...)` already lives in the
   signature clause-list. `requires(...)` is its value-level cousin —
   they belong in the same place.

The other contract primitives stay in bodies because they have no
signature to attach to: loop `invariant(...)` is part of the loop, type
`invariant(...)` is part of the type, `ghost(...)` is a binding.

### 3. `invariant(...)` — loop and type invariant

For `while` loops: an invariant must hold before each iteration and after
the loop exits. Loop invariants live in the loop body (the loop has no
signature):

```rust
sum_to :: (fn(
  n : i32,
  requires((n >= i32(0))),
  ensures((result == ((n * (n + i32(1))) / i32(2)))),
) -> i32)({
  i := i32(0);
  acc := i32(0);
  while(runtime((i < n)), {
    invariant(
      ((i >= i32(0)) && (i <= n)),
      (acc == ((i * (i + i32(1))) / i32(2))),
    );
    i = (i + i32(1));
    acc = (acc + i);
  });
  acc
});
```

`invariant(...)` follows the same single-call rule: one call per loop
(or one per type body), with all predicates as comma-separated arguments.

For struct/object types, `invariant(...)` appears as a top-level field-like
declaration. The invariant must hold after every constructor call and after
every method whose receiver is `ref(self) : Self` or `self : Self` (for
object):

```rust
SortedList :: object(
  _data : ArrayList(i32),
  invariant(sorted_strict(self._data.as_slice()))
);
```

### 4. `ghost(...)` — spec-only binding

`ghost(...)` introduces a binding visible only to the verifier and other
ghost code. It appears in the function body and is erased before codegen.
Because it is bound in the body, signature-level `ensures(...)` cannot
reference it directly — use `old(...)` or recompute the ghost expression
in the post-condition:

```rust
swap_three :: (fn(
  ref(a) : i32,
  ref(b) : i32,
  ref(c) : i32,
  ensures((((a + b) + c) == ((old(a) + old(b)) + old(c)))),
) -> unit)({
  // body uses ghost(...) freely for intermediate spec values:
  ghost(orig_sum := ((a + b) + c));
  // ...rotate the three values...
});
```

Ghost bindings can hold any value, including comptime-only constructions
like sets, multisets, sequences (defined in `std/spec/`, see below). They
never appear in C output.

### 5. `Refine(T, predicate)` — refinement type

A refinement type is a value type paired with a predicate over its values.
At runtime it is **identical** to `T` (zero overhead). At verification time
the predicate is added to the path condition whenever a value of the type
is observed:

```rust
NonZero :: (fn(comptime(T) : Type) -> comptime(Type))(
  Refine(T, (x) => (x != T(0)))
);

Bounded :: (fn(comptime(T) : Type, comptime(lo) : T, comptime(hi) : T) -> comptime(Type))(
  Refine(T, (x) => ((x >= lo) && (x <= hi)))
);

// Use:
safe_div :: (fn(num : i32, denom : NonZero(i32)) -> i32)((num / denom));
```

The predicate is an ordinary Yo comptime lambda. Construction sites either
prove the predicate or fail to compile:

```rust
x := NonZero(i32)(i32(5));     // OK — 5 != 0 by literal evaluation
y := NonZero(i32)(read_i32()); // ERROR if `read_i32` doesn't return NonZero
y := NonZero(i32).check(read_i32()); // OK — `check` returns Option(NonZero(T))
```

### 6. `pragma(Pragma.Verify);` — file-level verification gate

Like `Pragma.AllowUnsafe`, a file opts into being verified:

```rust
pragma(Pragma.Verify);

// All `requires/ensures/invariant` in this file must be discharged
// statically; failure to prove is a compile error.
```

Files without the pragma compile contracts to runtime assertions (mode
`runtime`, see below) — no proof obligation.

---

## Verification modes

Every file is in one of four modes for verification, set by pragma
combination:

| Pragma combination                 | Mode      | Contract behaviour                                          |
| ---------------------------------- | --------- | ----------------------------------------------------------- |
| (default — no verification pragma) | `runtime` | Contracts compile to `assert(...)` calls                    |
| `pragma(Pragma.Verify);`           | `verify`  | Contracts are proof obligations; failure is a compile error |
| `pragma(Pragma.VerifyOrAssert);`   | `verify+` | Try to prove; fall back to runtime assert if unprovable     |
| `pragma(Pragma.NoContracts);`      | `ignore`  | Contracts erased entirely (use for release/benchmark)       |

The CLI also offers a global override: `yo compile --verify-mode {runtime,
verify, verify+, ignore}` for build-system control. The pragma is the
source-of-truth when present.

`verify+` is the production mode: properties the SMT backend can discharge
cost nothing at runtime; the rest fall back to assertions, matching the
behaviour user code has today.

---

## Architecture

```
Yo source
   ↓
Lexer / Parser                        (no changes; contracts parse as builtin calls)
   ↓
Evaluator                             (gather contracts; partial evaluation)
   ↓
Verification IR (VIR)                 (new — per-function VC generation)
   ↓
SMT encoder (Z3 / CVC5)               (new — or external BMC, see below)
   ↓
{ Discharged, Refuted-with-counterexample, Timeout }
   ↓
Codegen                               (emits assertions per mode)
   ↓
C compiler
```

### Verification IR (VIR)

A small intermediate language between Yo's AST and the SMT solver. VIR is
SSA, has explicit branches, and represents:

- **Bitvector** integers with width (matching the C codegen exactly).
- **Booleans**.
- **Tuples, structs, enums** as algebraic datatypes (SMT-LIB `declare-datatypes`).
- **Arrays / Slices** as `(Array Int Element)` with an explicit `length`.
- **Object types** as opaque references with a heap model (one heap per
  object class, indexed by an abstract reference).
- **Effects** as uninterpreted functions tagged with capability rows
  (handlers turn into axioms).
- **`old(...)`** as a snapshot of pre-state, modelled as a separate frame.

The point of VIR is to keep the SMT backend stupid: it only sees terms it
already understands. All Yo-specific desugaring (where clauses,
specialization, trait dispatch, async lowering) happens during VIR
generation, before SMT.

### VC generation

For each function with contracts in a `verify` or `verify+` file:

1. Substitute generic parameters with their constraints.
2. Walk the function body in SSA order, building a path condition `Φ`.
3. At each statement, generate a verification condition:
   - **`requires(P)` on entry**: assume `P` (add to context).
   - **`assert(P)` (runtime asserts also become VCs)**: prove `Φ ∧ ¬P` unsat.
   - **Function call `f(args)`**: prove caller satisfies `f`'s `requires`;
     assume `f`'s `ensures` after.
   - **`invariant(P)` at loop head**: prove `P` holds on entry and after
     each iteration's body.
   - **Array/slice index `s(i)`**: prove `(i < s.len())`.
   - **Integer division / mod**: prove divisor non-zero.
   - **`unsafe(p.*)`**: prove `p` is a valid pointer (requires alias
     analysis; see "Unsafe boundary" below).
   - **`ensures(P)` at return**: prove `P` holds with `result` bound.
4. Hand each VC to the SMT backend with a per-function timeout (default 10s).

### SMT backend

Default: **Z3** via stdio (no FFI; the verifier subprocess writes SMT-LIB
2 and parses sat/unsat replies). Alternative: **CVC5**, selectable via
`--solver`. The solver runs out-of-process so a misbehaving solver cannot
take down the compiler.

Theories used:

- `QF_BV` — quantifier-free bitvectors, for all integer arithmetic.
- `QF_ABV` — adds arrays for slice/array models.
- `ADT` — algebraic datatypes for enum/struct/tuple.
- `UFBV` — for axiomatised pure functions across module boundaries.

Quantifiers are avoided by default; when needed (e.g. universal claims
about `Iterator` impls), the verifier instantiates explicitly via E-matching
patterns supplied through ghost code.

### External BMC: CBMC / Kani-style

Some properties (deep loop invariants, complex control flow, FFI) are
better handled by a bounded model checker on the C output. The CLI exposes
this as an alternate backend:

```
yo verify --backend cbmc src/sort.yo --unwind 8
yo verify --backend klee src/parser.yo --max-depth 200
```

Yo's codegen emits annotations the chosen backend understands:

- For CBMC: `__CPROVER_assume(...)`, `__CPROVER_assert(...)` next to
  contract sites.
- For KLEE: `klee_assume(...)`, `klee_assert(...)`.
- For SeaHorn: `verifier.assume`, `verifier.assert`.

This makes Yo a friendly source language for existing C verification
tooling without committing to one. See "Backend matrix" below.

---

## Algebraic effects as capabilities

Yo's existing algebraic-effect machinery already gives us a
capability-based security model. The plan promotes this from "nice
documentation" to a verified property.

A function's signature is a complete capability declaration:

```rust
// Pure: no effects → no I/O, no mutation of caller state via ref, no panic.
pure_hash :: (fn(input : Slice(u8)) -> u64)( ... );

// Can fail, cannot do I/O:
parse_int :: (fn(s : str, raise : Raise) -> i32)( ... );

// Can do I/O AND fail; carries a network capability bundle.
fetch :: (fn(url : Url, net : NetCap, raise : Raise) -> Bytes)( ... );
```

### Capability lattice

Each effect type is a capability with a place in a partial order:

```rust
// In std/spec/capability.yo:
Capability :: trait(
  comptime(rank) : Rank,           // Pure < Allocator < FsRead < FsWrite < Net < Spawn
  comptime(taint_level) : Taint    // Untrusted, Internal, Trusted
);
```

The verifier enforces:

- A function with capability rank `R` cannot call another with rank `> R`.
- A function taking `untrusted : Untrusted(str)` cannot pass that value to
  a function expecting `trusted : Trusted(str)` without an explicit
  sanitiser (a function `sanitise : (fn(s : Untrusted(str)) -> Trusted(str))`
  with a discharged contract).
- A `Refine(T, p)` value escaping into an untrusted context loses its
  refinement (the refinement type is dropped on the boundary).

### Concrete security gains

These properties become **provable**, not just convention:

| Property                                        | How                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| No path injection from HTTP input to filesystem | `Untrusted(Path)` cannot reach `FsWrite` without sanitisation.                         |
| No SQL injection                                | `Untrusted(str)` cannot be concatenated into `SqlQuery`.                               |
| No use of uninitialised memory                  | Slice access carries a `Sized(s, n)` refinement.                                       |
| No integer overflow in security-critical paths  | `Bounded(i32, lo, hi)` and arithmetic overflow VCs.                                    |
| Constant-time crypto                            | "No branching on `Secret(T)`" enforced by an effect.                                   |
| Authorization checks not bypassable             | Sensitive APIs require an `Authz` capability that only an auth-checking pass produces. |

The mechanism is identical for all of these: a refinement type or
capability effect that has to be earned to be used.

---

## Standard library spec module — `std/spec/`

A new top-level stdlib directory exposing the verification vocabulary.
Layout:

```
std/spec/
  refine.yo          — Refine, NonZero, Bounded, NonEmpty
  numeric.yo         — Even, Odd, Positive, Negative
  collection.yo      — Sorted, Unique, Permutation, Length
  string.yo          — Utf8Valid, NonEmpty, Trimmed
  pointer.yo         — Live, InBounds, Aligned (for unsafe regions)
  sequence.yo        — Seq(T) — ghost-only ordered collection
  multiset.yo        — Multiset(T) — ghost-only bag
  set.yo             — Set(T) — ghost-only set
  capability.yo      — Capability trait, Untrusted, Trusted, Secret
  proof.yo           — proof tactics: split, by_induction, by_cases
```

No `index.yo` — `std/spec/` follows the multi-submodule pattern of
`std/collections/`, `std/net/`, `std/fs/`. Users import each submodule
explicitly: `{ NonEmpty, Refine } :: import("std/spec/refine");`

`Seq(T)`, `Multiset(T)`, `Set(T)` are ghost-only types — runtime
representation `unit`, erased at codegen. They give specifications
algebraic operations without runtime cost.

Spec predicates come in two flavors, governed by Yo's existing typing
rules:

**Computable specs** are ordinary runtime functions returning `bool`.
They cannot use `forall_val` / `exists_val` / `Multiset` / `Set` because
those are not computable. They are inlined and reasoned about by the
verifier's symbolic executor, and also usable as runtime assertions in
`verify+` mode:

```rust
sorted :: (fn(s : Slice(i32)) -> bool)({
  i := usize(1);
  while(runtime((i < s.len())), {
    if(((s((i - usize(1)))) > s(i)), { return(false); });
    i = (i + usize(1));
  });
  true
});
```

**Ghost specs** wrap their `fn` value in `ghost(...)` — the same builtin
as the binding form `ghost(name := expr)`, extended to function values.
A ghost function is erased at codegen and callable only from contract
context (`requires`, `ensures`, `invariant`, `ghost(...)` bindings, or
the body of another ghost function). It returns ordinary `bool`, so the
typing rule about `comptime` return / `comptime` params is satisfied:

```rust
permutation :: ghost((fn(
  a : Slice(i32),
  b : Slice(i32),
) -> bool)(
  (Multiset.from_slice(a) == Multiset.from_slice(b))
));

sorted_quantified :: ghost((fn(s : Slice(i32)) -> bool)(
  forall_val((i : usize), (j : usize),
    (((i < j) && (j < s.len())) ==> (s(i) <= s(j)))
  )
));

// Sort spec — either computable `sorted` or `sorted_quantified` works:
sort :: (fn(
  ref(s) : Slice(i32),
  ensures(sorted(s), permutation(s, old(s))),
) -> unit)(body);
```

`forall_val((bind1), (bind2), ..., P)`, `exists_val((bind1), ..., P)`,
and `==>` are new builtins. They are well-formed only inside ghost
context — calling them from a non-ghost function is a compile error.
This mirrors how `unwind(...)` is only well-formed inside a
`ctl(...) -> R` body.

---

## Refined types: design details

`Refine(T, predicate)` is a comptime type constructor that returns a
**newtype-like** wrapper:

- At codegen, `Refine(T, p)` lowers to exactly `T`. Zero runtime cost.
- Member access is unchanged: a `Refine(i32, p)` supports the same
  arithmetic as `i32`, with the predicate threaded through the verifier.
- Predicates compose:
  `Refine(Refine(i32, p), q)` is equivalent to `Refine(i32, (x) => (p(x) && q(x)))`.

### Constructor rules

A value enters a refinement type three ways:

1. **Literal proof**: `NonZero(i32)(i32(5))` — predicate evaluated at
   comptime by the existing CTFE engine; non-literal arguments must come
   from a context where the predicate is provable.
2. **`.check(...)` returning `Option(Refine(T, p))`**: runtime check that
   the user can pattern-match on. Generated automatically per refinement.
3. **`.unchecked(...)` inside an `unsafe(...)` wrap**: caller asserts the
   predicate. Only legal in `pragma(Pragma.AllowUnsafe);` files.

### Coercions

`Refine(T, p) <: T` is a one-way subtype (refinement-erasure). The verifier
keeps the predicate in context as long as the value's static type is
refined; once erased, the predicate is gone.

### Refinements vs `where` clauses

There is overlap with existing `where(T <: Trait)`. The rule:

- `where(T <: Trait)` — type-level constraint, used during trait dispatch.
- `requires((x > i32(0)))` — value-level predicate over a runtime parameter.

Both live in the same signature clause-list and are syntactically siblings.
The verifier treats `where(P)` with a `bool` predicate `P` as identical to
`requires(P)`; the spelling difference is documentation only (type-level
intent vs value-level intent):

```rust
// All three signatures are equivalent — pick by intent:

abs :: (fn(x : i32, where((x > i32(-2147483648)))) -> i32)(
  cond((x >= i32(0)) => x, true => -(x))
);

abs :: (fn(x : i32, requires((x > i32(-2147483648)))) -> i32)(
  cond((x >= i32(0)) => x, true => -(x))
);

abs :: (fn(x : Bounded(i32, i32(-2147483647), i32(2147483647))) -> i32)(
  cond((x >= i32(0)) => x, true => -(x))
);
```

Choose `where(...)` for a constraint that's primarily about _which types
this applies to_. Choose `requires(...)` for a value-level boundary
condition. Choose `Refine(T, p)` when you want the predicate to flow
through call chains as part of the type.

---

## Interaction with existing language features

### `unsafe(...)` and the safe boundary

The verifier respects [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md): inside an
`unsafe(...)` expression, the verifier requires explicit pointer
contracts:

```rust
pragma(Pragma.AllowUnsafe);
pragma(Pragma.Verify);

deref_pair :: (fn(
  p : *(i32),
  requires(live(p), aligned(p)),
) -> i32)((unsafe(p.*) + unsafe(p.*)));
```

`live(...)` and `aligned(...)` are predicates from `std/spec/pointer.yo`.
The verifier cannot synthesise these — they have to be axiomatised at the
unsafe boundary, the same way `unsafe(...)` itself is a hand-audited
boundary today.

A file that is `pragma(Pragma.Verify);` but not `Pragma.AllowUnsafe` has
no `unsafe(...)` to worry about; the absence of raw pointers is itself
proved by the existing safety pragma. **This composes cleanly**: safe Yo
code in a `Verify` file is the easy case.

### Algebraic effects

A handler installed with `(name : E) = ((args) -> { ... })` carries the
caller's contract obligations. The verifier:

- Treats handler bodies as additional functions to verify.
- Propagates `unwind(...)` as "this branch does not reach the post-
  condition", so `ensures(...)` doesn't have to hold on unwound paths
  (analogous to how `panic` is treated in Rust+Kani).
- Requires `requires(...)` on every handler call site.

This means **the contract of a function depends on its effect bundle**.
A function `parse_int(s : str, raise : Raise)` only has to `ensures` a
result on the resuming path; the unwinding path is free.

### Async

`Future(T, E)` with `pragma(Pragma.Verify)` is verified per-state in the
async state machine the codegen already generates (`src/codegen/effects/`).
Each await point is a yield in VC generation, with the state-machine
variables forming the verifier's "frame". This reuses
`ASYNC_SM_VARIABLE_OPTIMIZATION.md`'s machinery directly.

### GADTs

GADTs already give per-variant type refinement. With `Refine`, GADTs
become value-indexed:

```rust
// Existing GADT:
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(IntVal(i : i32) -> recur(i32), BoolVal(b : bool) -> recur(bool))
);

// Refined GADT:
PositiveValue :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    PosInt(i : Bounded(i32, i32(1), i32(0x7FFFFFFF))) -> recur(i32),
    True -> recur(bool)
  )
);
```

This lets the verifier discharge claims like "every `PositiveValue(i32)`
contains a value `> 0`" by case-analysis over variants — work the GADT
exhaustiveness checker already does.

### Comptime evaluation

The existing comptime evaluator continues to fully evaluate any contract
it can. Only contracts with at least one runtime parameter (i.e., the
parameter is `UnknownValue`) emit a VC. This means:

- `assert((i32(2) + i32(3)) == i32(5))` is checked at compile time and
  emits no C code — already true today.
- `requires((i32(2) + i32(3)) == i32(5))` does likewise — no VC needed.
- `requires((n != i32(0)))` for a runtime `n` emits a VC.

The boundary between "comptime-evaluable" and "needs the SMT solver" is
the same boundary that already separates `comptime_assert` from `assert`.

---

## Backend matrix

The plan ships **one** native backend (Z3) and integrates with **three**
external backends. Users pick per command:

| Backend       | Strengths                                      | Limits                           | Status  |
| ------------- | ---------------------------------------------- | -------------------------------- | ------- |
| Z3 (native)   | Fast, ships in-tree, BV+arrays+ADT             | Loop invariants must be supplied | Phase 1 |
| CVC5 (native) | Alternative to Z3, sometimes better on strings | Same                             | Phase 2 |
| CBMC          | Mature BMC for C, finds bugs with no contracts | Bounded; slow on big programs    | Phase 3 |
| KLEE          | Symbolic execution, finds reachability bugs    | Coverage-bounded                 | Phase 3 |
| SeaHorn       | Horn-clause based, scales to larger code       | Less mature for our patterns     | Phase 4 |

CBMC integration is particularly low-cost because Yo already emits clean
C11 — Yo source becomes a much friendlier input than hand-written C for
CBMC.

---

## Design for LLM authorship

Yo's audience is LLMs writing code, not humans. This is a hard
constraint on what "good" looks like for the verifier — several
conventional design choices get inverted.

### Determinism is mandatory, not nice-to-have

Humans can reason about flaky SMT timeouts ("let me try again with a
hint"). LLMs cannot — non-determinism prevents the LLM from forming a
stable mental model of "what works." Concrete requirements:

- **Pin solver versions.** Z3 is fetched via `~/.cache/yo/solvers/` at a
  pinned hash, like Yo versions. Upgrading the solver is an opt-in
  release-note item, not a side-effect of installing Yo.
- **Forbid time-dependent solver tactics.** No `(set-option :random-seed
(current-time))`. Seeds are fixed per file.
- **Resource limits fail fast, not degrade.** A timeout reports
  `Unprovable: solver budget exhausted, here is the partial path
condition` deterministically. Same input → same output, always.
- **No incremental solver state shared across functions.** Each function
  is verified in a fresh solver process; flakiness can't bleed between
  files.

### Errors must be locally actionable

A diagnostic that says "unsat" is useless to an LLM. A diagnostic that
says "the call at line 12 cannot satisfy `requires((i < arr.len()))`
because in the path where `arr.len() == 0`, `i` is `0` — try adding
`requires((arr.len() > 0))` to your signature" is fixable. The verifier
must produce:

- **Concrete counter-examples** formatted as Yo literals the LLM can
  paste back into a test.
- **The smallest violated clause**, not the conjunction of all
  preconditions. Per-argument spans on `requires(P1, P2, ...)` exist for
  this reason.
- **Suggested edits where possible** — particularly "add this `requires`
  clause" or "this `ensures` doesn't hold on the unwound path; remove it
  or strengthen the path condition."

### Specs should match implementation syntax

LLMs do well with consistency. A spec language that diverges from Yo
syntax (separate annotation comments, foreign attribute markup) forces
the LLM to context-switch dialects mid-function. The plan deliberately
keeps spec syntax identical to runtime Yo: `requires(...)` is a normal
builtin call, predicates are normal `bool`-returning functions,
quantifiers are calls. The only new vocabulary is the `forall_val` /
`exists_val` / `==>` / `ghost(...)` set, and those are gated to ghost
context so they don't add ambient noise.

### Token efficiency is a real concern

Contracts increase line count by 1.5–3×. This is fine for humans (more
text to read, but clearer intent). For LLMs, every additional token in
the context window is real cost. Mitigations baked into the surface:

- **Single-call form** for `requires` / `ensures` / `invariant` — one
  builtin call with comma-separated predicates, not N separate calls.
- **`Refine(T, p)` makes predicates reusable** — `NonZero(i32)` is one
  token where `requires((x != i32(0)))` is many.
- **Inferred contracts where possible** — array indexing automatically
  carries `requires((i < arr.len()))`; the LLM doesn't have to write it.
- **No mandatory `decreases(...)` in Phase 1–2.** Partial correctness is
  the default; termination annotations are opt-in.

### The verifier is part of the inner loop

For human-authored code, "run the verifier" is a separate command. For
LLM-authored code, the typechecker IS the verifier — there's no
meaningful difference between "this fails to compile" and "this fails to
verify" from the LLM's perspective. So:

- Verification is invoked from `yo check` and `yo compile`, not just
  `yo verify`. (`yo verify` runs only the verifier, useful for CI.)
- Verifier output uses the same diagnostic format as the typechecker.
- The error stream is structured (JSON optional via `--format json`) so
  agentic loops can parse it.

### What this rules out

These conventional verification choices are rejected because they fight
the LLM use case:

- **Tactic languages** (Coq, Lean). Tactics require global reasoning
  about proof state — exactly what LLMs are bad at.
- **Interactive proof modes.** No "the user/LLM steps through the proof
  obligation." Either the SMT discharges it or the LLM edits the
  contract.
- **Pretty-printed math notation** (∀, ∃, ⇒). ASCII keywords (`forall_val`,
  `exists_val`, `==>`) match training data better and avoid Unicode
  copy-paste hazards in LLM output.
- **Out-of-band annotations** (separate `.spec` files, IDE-only
  metadata). Everything lives in the `.yo` source so the LLM sees a
  single artifact.

---

## Trade-offs accepted

This plan is not free. The costs:

- **Compile time.** Verified files are 10–100× slower to typecheck. The
  pragma is opt-in so casual users never pay this cost. CI separates
  `yo compile` (fast) from `yo verify` (slow) and runs them in parallel.
- **Source-level annotation burden.** A verified function has more text
  than an unverified one — typically 1.5–3× as many lines counting
  contracts. For LLM authors this is real token cost in the context
  window; mitigated by single-call clause form, reusable refinement
  types, and inferred contracts on stdlib operations (see
  [Design for LLM authorship](#design-for-llm-authorship)).
- **Solver flakiness.** SMT solvers can time out non-deterministically.
  Mitigations: pin solver versions, ship deterministic options,
  per-function timeouts, and `verify+` mode that falls back to runtime
  assertion when a proof times out (so CI doesn't flake).
- **Subset of language inside contracts.** Contract expressions can use
  any pure Yo expression but cannot perform I/O, allocate, spawn, or call
  non-pure user functions. The verifier rejects impure contracts at parse
  time so this is a syntactic restriction, not a hidden runtime gotcha.
- **No proofs of full programs.** This buys property-by-property local
  proof, not end-to-end correctness. Composing local proofs into a
  whole-program guarantee is the verifier user's job.

---

## Prerequisites

This plan does **not** require dependent types. Refinement types
(`Refine(T, p)`) are predicates attached to existing value types, not
types indexed by runtime values — the same distinction F\*, Liquid
Haskell, and Dafny make. Yo's existing comptime-parameterized type
constructors (`Array(T, N)`, `Bounded(T, lo, hi)`, GADTs with
`-> recur(T)`) already cover everything the plan needs at the type level.

What the plan _does_ need that Yo doesn't have yet, grouped by phase
gate:

### P0 — Required before Phase 1 (pure-function verification)

| Prerequisite                                 | Why                                                                                                                                                                                                                       | Approximate scope                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Path-condition tracking in the evaluator** | `UnknownValue` is flat today; verification needs a `Φ` that accumulates across `cond`/`match` branches                                                                                                                    | Largest single piece. Natural extension of CTFE machinery                                                                                                                      |
| **Purity gate for contract bodies**          | Contracts must not perform I/O, allocate, or `unwind`                                                                                                                                                                     | Reuses effect signature — contract is well-formed iff its effect bundle is empty                                                                                               |
| **Quantifier/implication builtins**          | `forall_val((bind), ..., P)`, `exists_val(...)`, `==>`                                                                                                                                                                    | Parsing is just builtin calls; evaluator must treat them as logical, not computational. Well-formed only inside ghost context (parallels `unwind(...)` inside `ctl(...) -> R`) |
| **`ghost(...)` extended to fn values**       | Marks a function as ghost-only: erased at codegen, callable only from contract context. Lets ghost-only specs return ordinary `bool` (not `comptime(bool)`), satisfying the comptime-return-requires-comptime-params rule | Small extension of the existing `ghost(name := expr)` binding form                                                                                                             |
| **`result` magic identifier**                | Refers to the function's return value inside `ensures(...)`                                                                                                                                                               | Scope-restricted to `ensures(...)` bodies                                                                                                                                      |
| **`old(...)` snapshot**                      | Refers to a parameter's entry value inside `ensures(...)`                                                                                                                                                                 | Evaluator + codegen support for ghost copies                                                                                                                                   |
| **Equality semantics for `object` types**    | Pin down identity vs structural `==`                                                                                                                                                                                      | Mostly a decision, not code. But blocks reasoning about `object`-valued contracts                                                                                              |
| **Subtyping rule `Refine(T, p) <: T`**       | Refinement erasure direction; the reverse is what costs proof obligations                                                                                                                                                 | Single rule in `src/types/compatibility.ts`                                                                                                                                    |

### P3 — Required before Phase 3 (loops, mutable state)

| Prerequisite                             | Why                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **`decreases(...)` termination measure** | Without it, verification is partial-correctness only (Dafny's default — acceptable to ship Phase 1–2 partial)                      |
| **`modifies(...)` frame conditions**     | Bounds which locations a function may mutate; required for `ref(...)` reasoning and object heaps                                   |
| **Heap model for `object` types**        | Acyclic objects are easy (existing cycle-detection pass partitions them); cyclic ones can be excluded from `verify` mode initially |

### Explicitly NOT prerequisites

- **Full dependent types** (Π/Σ, value-indexed type families)
- **A tactic language or proof-term core**
- **Cumulative universes**
- **Higher-rank polymorphism** beyond what `forall(F : (fn(comptime(T) : Type) -> comptime(Type)))` already gives
- **Linearity / uniqueness types** — RC + `ref(...)` cover the cases that matter for our verifier
- **Full SMT theory of floats** — see Open Question 5
- **Verified compilation** — Yo→C lowering itself stays unverified

### Alternative: language-level proof primitives instead of SMT-only

The current design leans on the SMT solver for almost every non-trivial
proof. An alternative worth considering: add a small set of source-level
proof primitives so users can discharge proofs **without** an external
solver, reducing solver-flakiness blast radius. Candidates:

```rust
// Case split — verifier checks each branch independently:
by_cases((x >= i32(0)), (x < i32(0)));

// Structural induction over an inductive type:
by_induction(measure: list.len());

// Apply a named lemma to the current goal:
assert_by((sum >= i32(0)), lemma: positive_sum_lemma);

// Lift a runtime check into the path condition:
assume((y != i32(0)));   // unsafe — must justify outside the verifier
```

This makes Yo less Dafny-shaped and more F\*-shaped. **Trade-off:** more
language surface, but proofs become reproducible (no solver
non-determinism) and reviewable by humans (proofs are source, not solver
state).

The plan currently defers this decision to Phase 2 — Phase 1 ships
SMT-only on pure functions, and we evaluate whether solver flakiness on
real proofs justifies adding proof primitives. If yes, they land before
Phase 3.

---

## Recommended near-term scope

This plan describes a full SMT-backed verifier across 7 phases. **The
recommended near-term commitment is Phase 0 only**, with Phases 1+
explicitly parked.

The rationale:

- Phase 0 (~1–2 weeks of work) ships the surface: parsing `requires` /
  `ensures` / `invariant` / `ghost` / `Refine`, lowering contracts to
  runtime `assert(...)` calls, adding `pragma(Pragma.Verify);` as a
  no-op (warns "verify mode not implemented"). This gives LLM authors
  the spec vocabulary, gives runtime assertion checking for free, and
  creates **no commitment** to building the verifier itself.
- Phase 1+ requires 6–12 person-months of focused work (VIR, Z3
  subprocess, path-condition tracking, refinement subtyping, all P0
  prerequisites). At Yo 0.1.x — with bootstrap, build system,
  parallelism, WASM, and stdlib expansion all competing for the same
  budget — this is a poor allocation.
- Whether to proceed to Phase 1 should be a separate decision made
  after observing: (a) does the Phase 0 surface get organic adoption?
  (b) has Yo's overall shape stabilised enough that a verifier built on
  it won't need a partial rewrite? (c) is there a concrete user (likely
  a stdlib module: `std/crypto`, `std/url`, allocator) whose
  verification would deliver real value?
- If Phase 1 is later approved, the deterministic-solver constraints in
  [Design for LLM authorship](#design-for-llm-authorship) become hard
  requirements, not nice-to-haves.

Phases 1–6 below remain documented as the long-term design, **not as a
near-term commitment.** Treat them as the answer to "if we ever build
the verifier, this is how" rather than "we are building the verifier."

---

## Phases

### Phase 0 — Surface lock-in (no verification yet)

- Parse `requires(...)`, `ensures(...)`, `invariant(...)`, `ghost(...)`.
- Lower contracts to `assert(...)` in default mode (so contract-bearing
  code still runs).
- Add `pragma(Pragma.Verify);`, `pragma(Pragma.NoContracts);`,
  `pragma(Pragma.VerifyOrAssert);` — initially the latter two warn
  "verify mode not implemented" but parse cleanly.
- Add `result` and `old(...)` keywords; restrict their scope to
  `ensures(...)` bodies.
- Add `Refine`, `NonZero`, `Bounded` as comptime type constructors.
  Construction in `verify`-less files just acts as a newtype.
- Ship `std/spec/` skeleton.
- New tests under `tests/spec/` — assert that contract syntax parses,
  contracts run at runtime in default mode.

**Exit criteria**: every example in this document parses. Existing tests
all pass. New `tests/spec/contracts_runtime.test.yo` confirms
`requires/ensures` become asserts in default mode.

### Phase 1 — VIR + Z3, pure functions only

- Implement `src/verifier/vir.ts` — Yo AST → VIR translation.
- Implement `src/verifier/z3.ts` — VIR → SMT-LIB 2 over stdio.
- Verify pure functions only (no `ref`, no effects beyond `Raise`).
- Discharge VCs for: integer arithmetic (BV), boolean operators, struct
  fields, enum variants, `cond`/`match`.
- Wire `pragma(Pragma.Verify);` to actually verify.
- Negative tests: each example with a deliberately wrong post-condition
  must fail to compile with a counter-example.

**Exit criteria**: `std/spec/numeric.yo` proves `abs`, `min`, `max`,
`clamp`. A `tests/spec/binary_search_pure.test.yo` verifies a recursive,
purely functional binary search on a `ComptimeList`.

### Phase 2 — Refinement types

- `Refine(T, p)` becomes first-class.
- Constructor sites trigger VC generation for the predicate.
- Refinements flow through `cond`/`match` (the verifier learns
  `if (x > 0)` narrows `x : i32` to `x : Bounded(i32, 1, MAX)`).
- Standard refinements available: `NonZero`, `Bounded`, `NonEmpty`,
  `Sorted`, `Length(n)`, `Utf8Valid`.

**Exit criteria**: `std/collections/array_list.yo` has a verified
`get(i : Bounded(usize, 0, self.len() - 1))`. Division by `NonZero(T)`
discharges without a runtime check.

### Phase 3 — Loops, ghost, mutable state

- `while` with `invariant(...)` — Hoare rule, with the existing
  flowability pass providing modification-frame information.
- `ghost(...)` bindings.
- `ref(name) : T` parameters and the `old(...)` snapshot.
- `Seq(T)`, `Multiset(T)`, `Set(T)` as ghost-only specification
  collections.

**Exit criteria**: in-place insertion sort verified for `sorted(s)` and
`permutation(s, old(s))` (using the `ref(s)` spec shape from the
[std/spec section](#standard-library-spec-module--stdspec)).
`std/collections/hash_map.yo` verifies "after insert(k, v), get(k) ==
Some(v)".

### Phase 4 — Effects, capabilities, security

- Effect handlers verified as functions.
- `Capability` trait, `Untrusted`/`Trusted`/`Secret` newtypes.
- "Tainted data cannot reach trusted sinks" prove-by-construction.
- `pragma(Pragma.ConstantTime);` for crypto code: no branching on
  `Secret(T)`, verified statically.

**Exit criteria**: `std/crypto/` core primitives verified constant-time.
`std/url/` verifies "no path traversal in normalised paths".

### Phase 5 — External BMC backends

- `yo verify --backend cbmc` — emit `__CPROVER_*` annotations alongside
  Yo's normal C output.
- `--backend klee`, `--backend seahorn` — analogous.
- These backends discharge things the native Z3 backend cannot (deep
  loops without supplied invariants, certain pointer aliasing patterns).

**Exit criteria**: a non-trivial parser (e.g., `std/url`) is run through
CBMC with `--unwind 16` and finds zero issues; a deliberately-bugged
variant finds the bug.

### Phase 6 — User-facing polish

- LSP integration: hover on a refined parameter shows the predicate;
  inline diagnostics for unprovable VCs include counter-examples
  formatted as Yo literals.
- `yo verify --json` for CI integration.
- `yo verify --explain f` shows the verification trace for one function.
- Documentation: `docs/en-US/FORMAL_VERIFICATION.md` and
  `docs/zh-CN/FORMAL_VERIFICATION.md`.

---

## Open questions

1. **`old(...)` in `ensures` for object types.** Object types have
   reference semantics, so `old(obj)` could mean (a) a deep snapshot at
   entry, (b) a snapshot of the receiver pointer (useless), or (c) be
   forbidden. The plan currently picks (a) via a comptime-generated
   `Clone` of the object's value at entry. The cost is real allocation in
   `verify+` mode; in `verify` mode it's ghost-only. Final answer
   deferred to Phase 3.

2. **Trait dispatch and verification.** When `f(self : T, where(T <: Foo))`
   calls `self.method()`, the verifier currently has to verify against
   the trait's specification, not any particular impl. This requires
   `Foo` declarations to carry contracts at the trait level. The
   alternative is to verify against every impl, exploding work. The plan
   leans toward trait-level contracts but the syntax is undecided.

3. **Recursion termination.** `recur(...)` is the only way to write
   recursion in Yo. The verifier needs decreasing-measure annotations
   for termination proofs. Candidate syntax: `decreases(measure_expr);`
   alongside `requires/ensures`. Default for unannotated recursive
   functions is "partial correctness only" (no termination proof). This
   matches Dafny.

4. **Inductive types over `Box(Self)`.** Verifying functions over
   `Box(Self)`-recursive types (trees) is straightforward; verifying
   over `object` types with potential cycles is not. The plan currently
   forbids verified functions from touching cycle-prone object types.
   Long-term, an axiomatised heap model handles this; short-term, it's
   a non-goal.

5. **Floating point.** No `f32`/`f64` reasoning in Phase 1–4. The SMT
   theory of floating point (QF_FP) is slow and rarely what users want.
   Crypto and core security code is integer-only. Float verification is
   a separate, later concern.

6. **Verifying the std prelude.** The prelude is 7000+ lines and self-
   referential. Verifying it from scratch is impractical. The plan
   axiomatises the prelude's contracts and incrementally proves
   modules in priority order: `Option`, `Result`, `Slice`, `Array`,
   `ArrayList`, `HashMap`, then everything else.

7. **Solver portability across platforms.** Z3 ships binaries for
   Linux/macOS/Windows. The verifier subprocess discovery is the
   responsibility of `src/version-cache.ts` analogues — initial plan is
   to bundle Z3 as a downloadable dependency in `~/.cache/yo/solvers/`
   the same way Yo versions are cached today.

---

## Worked example: verified `NonEmpty(Slice(T)).head()`

```rust
pragma(Pragma.Verify);

{ Refine } :: import("std/spec/refine");

NonEmpty :: (fn(comptime(T) : Type) -> comptime(Type))(
  Refine(Slice(T), (s) => (s.len() > usize(0)))
);

head :: (fn(
  forall(T : Type),
  s : NonEmpty(Slice(T)),
  // requires((s.len() > usize(0))) — implied by the refinement on `s`
  ensures((result == s(usize(0)))),
) -> T)(s(usize(0)));

main :: (fn() -> i32)({
  arr := Array(i32, usize(3))(i32(1), i32(2), i32(3));
  slice := arr.as_slice();

  // Direct construction — verifier proves slice.len() > 0 from the array literal.
  ne := NonEmpty(Slice(i32))(slice);
  first := head(forall(i32), ne);
  assert((first == i32(1)), "first should be 1");

  // From dynamic data — must check.
  dyn := some_runtime_slice();
  match(NonEmpty(Slice(i32)).check(dyn),
    .Some(ne2) => {
      h := head(forall(i32), ne2);
      print_i32(h);
    },
    .None => println(`empty`)
  );
  i32(0)
});
```

What the verifier does in this example:

- The `NonEmpty(Slice(i32))(slice)` construction triggers a VC:
  prove `(slice.len() > usize(0))` from the context that `slice` was
  derived from a length-3 array literal. The existing slice-flowability
  machinery already knows `arr.as_slice().len() == arr.len() == 3` — the
  VC discharges by partial evaluation, no SMT call needed.
- `head(ne)` has no proof obligation at the call site — `ne`'s type
  already carries `s.len() > 0`, which discharges the implicit `requires`.
- `s(usize(0))` inside `head` would normally generate a bounds VC
  (`0 < s.len()`). The refinement on the parameter discharges it.

The result is a function with **zero runtime cost vs.** `(fn(s : Slice(T)) -> T)(s(usize(0)))`,
but where every caller has been forced to either pass a statically-known
non-empty slice or check at runtime.

---

## References

- [`MEMORY_SAFETY.md`](MEMORY_SAFETY.md) — the unsafe boundary verification
  trusts.
- [`EXPLICIT_EFFECTS.md`](EXPLICIT_EFFECTS.md) — the effect model
  capabilities sit on top of.
- [`UNIFIED_COMPTIME_DESIGN.md`](UNIFIED_COMPTIME_DESIGN.md) — the
  comptime evaluator the VC generator extends.
- [`GADTS.md`](GADTS.md) — per-variant refinement, the seed of value-
  indexed types.
- [`SLICE_FLOWABILITY.md`](SLICE_FLOWABILITY.md) — example of non-trivial
  static analysis already running in the evaluator.
- [`ASYNC_SM_VARIABLE_OPTIMIZATION.md`](ASYNC_SM_VARIABLE_OPTIMIZATION.md)
  — the state-machine model async verification reuses.
- External: Dafny (Microsoft Research), F\* (MSR Inria), Liquid Haskell,
  Rust + Kani, Frama-C/ACSL, CBMC, KLEE, SeaHorn.
