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

**Accurate framing:** Yo's compile-time evaluator provides the AST
traversal, type-environment, and CTFE infrastructure a VC generator
would hook into. It does NOT provide path-condition tracking, symbolic
state, loop-invariant reasoning, contract substitution at call sites,
or SMT encoding. So the evaluator serves as the verifier's _front-end_;
the verification _back-end_ is a substantial new component built on top
of (not derived from) the existing pass. (An earlier draft claimed "60%
of a VC generator" — that was rhetorical and misleading; see audit §B1
and §C2 below.)

---

## The surface — six primitives

The verification surface consists of five new builtin calls
(`requires`, `ensures`, `invariant`, `ghost`, `ghost_fn`), one new type
constructor (`Refine`), and one new pragma value (`Pragma.Verify` and
its variants). Three ghost-context builtins (`forall_val`, `exists_val`,
`==>`) appear later, in the spec-module section. Everything else is
reused.

`ghost` and `ghost_fn` are split rather than overloaded: `ghost(name := expr)`
introduces a ghost binding, while `ghost_fn(fn_value)` marks a function
as ghost-only. See [Standard library spec module](#standard-library-spec-module--stdspec)
for why the split matters (resolves audit §A3 ambiguity).

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

### Runtime vs comptime contracts

A contract clause inherits the comptime-ness of its host function from
Yo's existing typing rule: a function whose return is wrapped in
`comptime(...)` is comptime-only, with all parameters comptime. The
contract behaves accordingly:

| Function shape                                  | `requires(P)` / `ensures(P)` lowers to | Failure timing                           |
| ----------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| `(fn(...) -> T)` (runtime)                      | `assert(P, "...")`                     | Runtime panic on each violating call     |
| `(fn(comptime(...)) -> comptime(T))` (comptime) | `comptime_assert(P, "...")`            | Compile error at the violating call site |

The predicate `P` itself follows the same rule: a comptime function's
contract may only reference comptime-evaluable values, and the
predicate is fully evaluated at call-site specialization time. A
runtime function's contract may reference runtime parameters, and the
predicate is evaluated each time the function is called.

The dispatch is mechanical: at lowering time (Phase 0 task #6), look
at `functionType.return.isCompileTimeOnly`; emit `comptime_assert`
if set, `assert` otherwise. No new syntax is needed — the user
writes `requires(P)` either way, and the typing context picks the
right enforcement mechanism. This also means a contract migrated from
a runtime function to a comptime function (by adding `comptime(...)`
to the return) automatically tightens from "runtime check" to
"compile error" without any change to the predicate.

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

**Placement rule:** inside a `while(...)` body, `invariant(...)` must be
the **first non-comment statement**. Placing it later, in a `cond` /
`match` branch, or after any other statement is a syntax error. This
prevents semantic ambiguity about where in the loop the invariant must
hold (audit §A2): it always means "holds at the loop head, every
iteration." The evaluator enforces this position check at
function-body evaluation time, parallel to how `pragma(...)` is
restricted to the file top.

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

**Ghost specs** wrap their `fn` value in `ghost_fn(...)` — a distinct
builtin from the binding form `ghost(name := expr)`. The two are split
to avoid the parsing ambiguity flagged in audit §A3 (`ghost(f)` where
`f` is a function value would otherwise be indistinguishable from a
ghost binding). A ghost function is erased at codegen and callable only
from contract context (`requires`, `ensures`, `invariant`, `ghost(...)`
bindings, the body of another `ghost_fn`, or another ghost-context
expression). It returns ordinary `bool`, so the typing rule about
`comptime` return / `comptime` params is satisfied:

```rust
permutation :: ghost_fn((fn(
  a : Slice(i32),
  b : Slice(i32),
) -> bool)(
  (Multiset.from_slice(a) == Multiset.from_slice(b))
));

sorted_quantified :: ghost_fn((fn(s : Slice(i32)) -> bool)(
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
async state machine the codegen already generates (`src/codegen/async/`).
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
`exists_val` / `==>` / `ghost(...)` / `ghost_fn(...)` set, and those are
gated to ghost context so they don't add ambient noise.

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

| Prerequisite                                 | Why                                                                                                                                                                                                                                                                       | Approximate scope                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Path-condition tracking in the evaluator** | `UnknownValue` is flat today; verification needs a `Φ` that accumulates across `cond`/`match` branches                                                                                                                                                                    | Largest single piece. Natural extension of CTFE machinery                                                                                                                      |
| **Purity gate for contract bodies**          | Contracts must not perform I/O, allocate, or `unwind`                                                                                                                                                                                                                     | Reuses effect signature — contract is well-formed iff its effect bundle is empty                                                                                               |
| **Quantifier/implication builtins**          | `forall_val((bind), ..., P)`, `exists_val(...)`, `==>`                                                                                                                                                                                                                    | Parsing is just builtin calls; evaluator must treat them as logical, not computational. Well-formed only inside ghost context (parallels `unwind(...)` inside `ctl(...) -> R`) |
| **`ghost_fn(...)` as a distinct builtin**    | Marks a function as ghost-only: erased at codegen, callable only from contract context. Lets ghost-only specs return ordinary `bool` (not `comptime(bool)`), satisfying the comptime-return-requires-comptime-params rule. Split from `ghost(name := expr)` per audit §A3 | New builtin paralleling `ghost(...)` — minimal evaluator wiring                                                                                                                |
| **`result` magic identifier**                | Refers to the function's return value inside `ensures(...)`                                                                                                                                                                                                               | Scope-restricted to `ensures(...)` bodies                                                                                                                                      |
| **`old(...)` snapshot**                      | Refers to a parameter's entry value inside `ensures(...)`                                                                                                                                                                                                                 | Evaluator + codegen support for ghost copies                                                                                                                                   |
| **Equality semantics for `object` types**    | Pin down identity vs structural `==`                                                                                                                                                                                                                                      | Mostly a decision, not code. But blocks reasoning about `object`-valued contracts                                                                                              |
| **Subtyping rule `Refine(T, p) <: T`**       | Refinement erasure direction; the reverse is what costs proof obligations                                                                                                                                                                                                 | Single rule in `src/types/compatibility.ts`                                                                                                                                    |

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
- Phase 1+ requires 13–19 person-months of focused work — revised
  upward from the original "6–12" estimate per audit §C1. Breakdown:
  path-condition tracking (4–6 mo), VIR design+construction (2–3 mo),
  Z3 SMT-LIB 2 encoder (2–3 mo), `result`/`old(...)` evaluator support
  (1–2 mo), `Refine` subtyping (1–2 mo), contract gathering (1 mo),
  integration+testing (2 mo). At Yo 0.1.x — with bootstrap, build
  system, parallelism, WASM, and stdlib expansion all competing for the
  same budget — this is a poor allocation.
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

**Progress (updated as sub-tasks land):**

- [x] Register contract builtins (`requires`, `ensures`, `invariant`, `ghost`, `ghost_fn`, `old`) as no-op markers; signature-level `requires`/`ensures` are skipped during function-type parameter processing; codegen lowers them to empty C output.
- [x] Add `Pragma.Verify` / `Pragma.NoContracts` / `Pragma.VerifyOrAssert` (Verify and VerifyOrAssert emit a one-time per-file "verify mode not implemented" warning; NoContracts is silent and codegen-erase is a later sub-task).
- [x] `result` magic identifier + `old(...)`: `result` resolves to the function's return value inside `ensures(...)` (bound by the ensures wrapper — no global keyword reservation needed, so `std/imm`'s local `result` bindings keep working). `old(expr)` snapshots the entry-time value of `expr` (hoisted into a binding before the body runs), giving correct semantics for mutated `ref(name) : T` parameters.
- [x] Extract `requires` / `ensures` from function-type signatures into `FunctionType.requiresExprs` and `FunctionType.ensuresExprs`. Single-call rule enforced (duplicate `requires(...)` / `ensures(...)` clauses are a syntax error). Zero-argument forms rejected. **Strict clause order enforced** via a zone check: `forall(0) → params(1) → where(2) → requires(3) → ensures(4)` must be non-decreasing left-to-right; an out-of-order clause errors with "X appears after Y".
- [x] Enforce loop `invariant(...)` first-statement rule (rejection works across nested cond/match branches; nested while loops are checked separately when their own evaluator fires).
- [x] Lower `requires(...)` to `assert(P, "requires failed: ...")` (runtime functions) or `comptime_assert(P, "requires failed: ...")` (comptime functions). Dispatch via `functionType.return.isCompileTimeOnly`. Splices synthetic FnCallExpr nodes into the body before evaluation in both function paths (`evaluateAnonymousFunctionImplementation` and `function-type.ts`). Honors `pragma(Pragma.NoContracts);` — contracts erased entirely.
- [x] Lower `ensures(...)` to assert at function return. Wraps the body as `{ <old snapshots>; <requires>; result := (<body>); <ensures>; result }` (non-unit return) or `{ <old snapshots>; <requires>; <body>; <ensures> }` (unit return — avoids `void result`). Comptime functions use `::` bindings and `comptime_assert`.
- [x] Add `Refine` / `NonZero` / `Bounded` / `NonEmpty` as comptime type constructors. Phase 0 implementations are type aliases (predicate parameter not yet wired up — added when verifier lands in Phase 2).
- [x] Ship `std/spec/refine.yo` + `std/spec/numeric.yo` skeletons. Numeric module also has `Positive`, `Negative`, `NonNegative`, `NonPositive`, `Even`, `Odd` aliases.
- [x] Tests under `tests/spec/` (parse / runtime / reject) — 26 tests across `contracts_phase0.test.yo`, `pragma_no_contracts.test.yo`, `refine_types.test.yo`.

**Phase 0 is complete.** All contract surface parses; `requires`/`ensures`
enforce at runtime (or compile time for comptime functions); `old(...)`
captures entry values; refinement-type aliases are available. The SMT
verifier remains a separate, larger effort (Phase 1+).

**Implementation plan:**

- Register `requires`, `ensures`, `invariant`, `ghost`, `ghost_fn` in
  `BuiltinFunctions` (`src/expr.ts:742`). Parser changes are minimal —
  these all parse as normal `FnCallExpr` nodes today.
- **Function-type signature extraction**: extend the four-pass parameter
  processing in `src/evaluator/types/function.ts` to recognize
  `requires(...)` and `ensures(...)` as contract clauses (not regular
  parameters). Canonical order: `forall(...), ...params..., where(...),
requires(...), ensures(...)`. Multiple `requires(...)` or `ensures(...)`
  clauses in the same signature is a syntax error (single-call rule).
- **Trait-level contract syntax**: ensure trait declarations can carry
  `requires`/`ensures` clauses in their method signatures (the same
  signature-extraction pass works for trait fields, since trait fields
  are function types). Phase 0 only parses these; trait-level contract
  _semantics_ (how impls inherit/override them) is deferred to Phase 4.
  This addresses audit §B3 as a syntax commitment without committing to
  verification semantics.
- **Loop invariant placement enforcement**: at function-body evaluation,
  if `invariant(...)` appears in a `while` body, require it to be the
  first non-comment statement; flag any other placement as a syntax
  error.
- Lower contracts to `assert(...)` in default mode (so contract-bearing
  code still runs). Codegen modification in
  `src/codegen/functions/generation.ts`: emit `assert` calls at function
  entry for `requires`, at each `return` for `ensures` (with `result`
  bound to the return value).
- Add `pragma(Pragma.Verify);`, `pragma(Pragma.NoContracts);`,
  `pragma(Pragma.VerifyOrAssert);` to `PragmaKind` in
  `src/evaluator/memory-safety.ts`. Phase 0 emits a warning "verify mode
  not implemented" for the latter two; `Pragma.NoContracts` works fully
  (erases contracts at codegen).
- Reserve `result` as a keyword (currently a valid identifier — audit a
  search of the repo for existing uses and rename if needed). Restrict
  its scope to `ensures(...)` clause bodies. `old(...)` is added as a
  new builtin call, scope-restricted similarly.
- Add `Refine`, `NonZero`, `Bounded` as comptime type constructors.
  Construction in `verify`-less files just acts as a newtype (predicate
  ignored).
- Ship `std/spec/` skeleton — `refine.yo`, `numeric.yo` only. The full
  layout described in [Standard library spec module](#standard-library-spec-module--stdspec)
  lands incrementally as later phases need it.
- New tests under `tests/spec/`:
  - `contracts_parse.test.yo` — every contract example in this doc parses.
  - `contracts_runtime.test.yo` — contracts become asserts in default mode.
  - `contracts_reject.test.yo` — `comptime_expect_error` tests for:
    duplicate `requires(...)` clauses, `invariant(...)` not first in loop
    body, `ghost(f)` where `f` is a function value (must use `ghost_fn`),
    `forall_val(...)` outside ghost context.

**Exit criteria**: every example in this document parses. Existing tests
all pass. New `tests/spec/contracts_runtime.test.yo` confirms
`requires/ensures` become asserts in default mode. `Pragma.Verify` parses
and warns. Negative tests in `contracts_reject.test.yo` all reject as
expected.

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

## Audit Notes & Open Concerns

> **Added 2026-05-26.** This section captures concerns raised during
> audit of the plan against the current codebase (`src/evaluator/`,
> `src/codegen/`, `src/types/`, `src/parser.ts`, `src/expr.ts`).

### Resolutions

Audit findings folded into the rest of the document on 2026-05-26:

| Finding | Status   | Where in doc                                                                                         |
| ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| §A2     | Resolved | Loop `invariant(...)` must be first non-comment statement of loop body; evaluator enforces.          |
| §A3     | Resolved | Split `ghost(name := expr)` (binding) from `ghost_fn(fn_value)` (ghost function).                    |
| §B3     | Resolved | Phase 0 lands trait-level contract _syntax_ (parsing only); semantics deferred to Phase 4.           |
| §C2     | Resolved | "60% of a VC generator" reframed accurately at end of "Why Yo is unusually well-positioned" section. |
| §D1-D5  | Resolved | Implementation pointers folded into the Phase 0 description (file locations, registration steps).    |
| §F1     | Resolved | Worked-example explanation corrected: CTFE provides the length, not slice-flowability.               |
| §F2     | Resolved | `src/codegen/effects/` → `src/codegen/async/` corrected.                                             |

Findings still treated as open (tracked in Phase 1+ scoping):

| Finding | Status   | Reasoning                                                                                                |
| ------- | -------- | -------------------------------------------------------------------------------------------------------- |
| §A1     | Open     | Implementation-detail concerns about parameter-processing order; resolved during Phase 1 implementation. |
| §A4     | Open     | `result` scope/forward-ref questions — resolved when `ensures(...)` evaluation lands in Phase 1.         |
| §A5     | Open     | Ghost-context flag design — Phase 1 implementation detail.                                               |
| §B1     | Open     | Path-condition tracking — the core Phase 1 work; estimate revised below.                                 |
| §B2     | Open     | VIR underspecified — to be split out into `plans/FORMAL_VERIFICATION_VIR.md` before Phase 1 begins.      |
| §B4     | Open     | Refine subtyping requires SMT for non-literal cases — Phase 1/2 design.                                  |
| §B5     | Open     | Capability lattice is new infrastructure — Phase 4 scope.                                                |
| §B6     | Open     | CBMC/KLEE annotation mapping — Phase 5 scope.                                                            |
| §C1     | Accepted | Phase 1 estimate revised: 13-19 person-months (was "6-12"). Reflected in Recommended Near-Term Scope.    |
| §E1-E5  | Open     | Design questions to revisit per phase.                                                                   |

The Phase 1 estimate has been adjusted upward to reflect §C1; the
recommended near-term commitment remains Phase 0 only.

### A. Syntactic & Semantic Concerns

#### A1. `requires`/`ensures` placement in function signatures

The plan puts `requires((y != i32(0)))` and `ensures((result >= i32(0)))`
inside the function type signature as if they are regular parameters. This
is consistent with `where(T <: Copy)` already living in the signature, but
creates implementation challenges:

- **Parsing**: In Yo, `requires(expr)` is indistinguishable from any other
  builtin call at parse time. The parser produces a `FnCallExpr` with
  `func` being the identifier `requires`. The evaluator must later
  recognize this as a contract rather than a regular parameter. The same
  parser-level ambiguity affects `ensures` and `invariant`.
- **Ordering within the signature**: The current function parameter
  processing pipeline in `src/evaluator/types/function.ts` has four passes:
  (1) forall, (2) pre-scan comptime, (3) where clause, (4) regular
  parameters. `requires`/`ensures` would need to be recognized in one of
  these passes and extracted before the regular parameter processing
  tries to treat them as runtime parameters.
- **Syntactic position**: Should `requires` come before or after
  `where(...)`? Before or after runtime parameters? The existing examples
  in the plan are inconsistent about this.
- **Duplicate detection**: The plan says "multiple `requires(...)` clauses
  are a syntax error" — this is an evaluator-level check that must be
  added to `evaluateFunctionType`.

**Recommendation**: Define a canonical order: `forall(...), ...params...,
where(...), requires(...), ensures(...)`. The evaluator should extract
`requires` and `ensures` by name (checking if the parameter label matches
the builtin name) before processing parameters.

> **Resolution: DONE — strict order enforced.** A zone check at the top
> of `evaluateFunctionParameters` assigns each clause a zone
> (`forall=0, params=1, where=2, requires=3, ensures=4`) and rejects any
> clause whose zone is less than the running max ("X appears after Y in
> the function signature"). Extraction is by builtin name as
> recommended. Covered by `clause order: …` tests in
> `contracts_phase0.test.yo`.

#### A2. `invariant(...)` placement in loop bodies

The plan shows `invariant(...)` as a statement inside the loop body:

```rust
while(runtime((i < n)), {
  invariant((i >= i32(0)) && (i <= n), ...);
  i = (i + i32(1));
  acc = (acc + i);
});
```

Concerns:

- Syntactically, this is a regular function call that evaluates to `()`,
  so it's a legal Yo expression. But semantically, `invariant` could appear
  **anywhere** in the body (including after the first statement), which
  is wrong — loop invariants must hold at the loop head.
- Dafny, F\*, and Why3 all place invariants **at the loop keyword** (before
  the body), not inside it. The plan's approach conflates the invariant
  with the body statements.
- If `invariant(...)` appears inside a `cond` branch within the loop, what
  does it mean? The plan doesn't address this.

**Recommendation**: Consider moving `invariant(...)` to a clause on
`while(...)` itself: `while(runtime(cond), body, invariant(P1, P2))`.
This is syntactically cleaner and prevents misplacement. Alternatively,
require that `invariant(...)` be the **first** expression in the loop
body and enforce this at evaluation time.

#### A3. `ghost(...)` ambiguity — binding vs function wrapping

The plan uses `ghost(...)` for two distinct purposes:

1. Ghost bindings: `ghost(orig_sum := ((a + b) + c));`
2. Ghost functions: `permutation :: ghost((fn(...) -> bool)(...));`

The evaluator would need to distinguish these forms:

- The binding form looks like an assignment `name := value` inside a
  function call.
- The function-wrapping form wraps a `FunctionValue`.
- If a user writes `ghost(f)` where `f` is a runtime function, is that a
  ghost binding of `f` or a ghost-wrapping of `f`? Ambiguous.

**Recommendation**: Use distinct syntax. Keep `ghost(name := expr)` for
bindings. Use a separate marker for ghost functions — e.g.,
`ghost_fn((fn(...) -> bool)(...))` or a pragma-like annotation.

#### A4. `result` magic identifier scope

The plan introduces `result` as a magic identifier visible only inside
`ensures(...)` bodies. This requires:

- Modifying variable resolution in the evaluator (`src/evaluator/calls/helper.ts`
  and `src/env.ts`) to recognize `result` as a synthetic binding in a
  restricted scope.
- The evaluator must know the function's return type inside `ensures(...)`
  before the body is evaluated. Since the return type is parsed as part of
  the function type (`-> T`), this is available, but the `ensures(...)`
  bodies are parsed before the return type — creating a forward-reference
  problem at the expression level.

**Question**: Can `result` appear inside a `Refine` predicate's lambda?
E.g., `fn(x : i32, ensures(SomeRefine(result).property)) -> i32`. This
seems reasonable but adds scope complexity.

#### A5. Quantifier builtins and ghost context enforcement

The plan introduces `forall_val`, `exists_val`, and `==>` as builtin calls
that are well-formed only inside ghost context (contract bodies, ghost
function bodies, `ghost(...)` bindings). This requires:

- A new evaluator context flag (`isGhostContext`) parallel to the existing
  `isCompileTimeOnly` flag.
- Detection: Is `ensures(...)` evaluation ghost context? Is a `cond` inside
  an `ensures(...)` ghost context?
- **Interaction with `comptime`**: `forall_val` / `exists_val` are not
  `comptime` functions (they reason about runtime values). But they are
  also not runtime functions (they have no C representation). This creates
  a new category: "ghost-only but not comptime-only."

### B. Architectural Concerns

#### B1. Path-condition tracking is a fundamentally new evaluator capability

The plan (line 68) says "Yo's compile-time evaluator is already 60% of a
verification condition generator." This overstates the evaluator's current
capabilities. **The evaluator has zero path-condition infrastructure.**

- `UnknownValue` is a placeholder meaning "compile-time type is known but
  value is not." It carries zero symbolic information — no constraints,
  no SSA variable, no relationship to other unknowns.
- The `isExecuting` flag toggles between "evaluate concretely" and
  "analyze types only." In analysis mode, branches are merged via
  `mergeAndCheckEnvs` for type compatibility only — there is no "in this
  branch, we know condition X is true" propagation.
- There is no SSA construction, no term rewriting for `old(...)`, no
  symbolic heap model.

Building path-condition tracking requires:

1. Extended `UnknownValue` with constraint sets.
2. The evaluator threading constraints through `cond`/`match` branches.
3. A fresh representation for symbolic heap state.
4. SSA conversion (or working in a form the SMT backend accepts).

This is not "the other 40%" — it is closer to building a symbolic executor
from scratch on top of the evaluator. The existing flowability pass and
CTFE analysis are entirely concrete-value analyses; they do not generalize
to symbolic reasoning.

**Revised estimate**: Path-condition tracking alone is 4–6 person-months
of focused work. Combined with VIR construction, VC generation, and Z3
encoding, Phase 1 is more plausibly 9–15 person-months total.

#### B2. VIR (Verification IR) is critically underspecified

The plan dedicates 20 lines to VIR (lines 342–361) but this is the
architectural centerpiece. Critical open design questions:

- **SSA vs direct AST lowering**: Does the evaluator produce VIR directly
  (as it evaluates), or is there a post-processing pass that lowers the
  evaluated AST to VIR? The plan says "Walk the function body in SSA
  order, building a path condition Φ" — but the evaluator doesn't produce
  SSA.
- **Side-effect modeling**: How are RC operations, `consume(...)`, and
  `ref` parameter writes modeled in VIR? These are implicit in today's
  evaluator.
- **Heap model**: The plan says objects are "opaque references with a heap
  model." What heap model? Separation logic? Burstall-Bornat? A flat array
  model?
- **Function calls**: Are callee functions inlined into the VIR, or modeled
  via their contracts (modular verification)?
- **Emergency conditions**: How are `panic(...)`, `unwind(...)`, and
  assertion failures modeled? As VCs or as proof obligations?

**Recommendation**: The VIR design should be written up as a separate
document (`plans/FORMAL_VERIFICATION_VIR.md`) before Phase 1 begins.

#### B3. Trait-level contracts — a fundamental open problem

The plan correctly identifies this as "syntax is undecided" (Open Question
2), but the problem is deeper than syntax.

Yo's traits currently define only **method signatures** (function types
without bodies). For a verifier to use trait-level contracts, every trait
field would need `requires`/`ensures` clauses embedded in its function
type:

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(ref(self) : Self, requires(self.has_next()),
              ensures(match(result, .Some(v) => ..., .None => ...)))
          -> Option(Self.Item))
);
```

But trait fields with generic `forall` parameters make this recursive:
`map` takes `forall(B)` and `f : Impl(Fn(A) -> B)`. The trait-level
contract for `map` must quantify over `B` and `f`, which means the
contract itself is generic.

Furthermore, Yo's generic impl matching (`src/evaluator/values/impl.ts`)
specializes trait methods per concrete type. If the verifier uses the
generic trait contract at call sites, it must reason about the trait
contract without knowing which impl will execute. If it inlines and
verifies against each concrete impl, the work is multiplied by the number
of impls (potentially thousands for a common trait like `Index`).

**Recommendation**: This should be P0, not deferred. Until trait-level
contract syntax and verification semantics are designed, the plan cannot
meaningfully verify any generic function that calls trait methods —
which is most useful functions in `std/`.

#### B4. Refinement type (`Refine(T, p)`) implementation complexity

The plan's `Refine` design implies changes across multiple subsystems:

- **Type synthesis** (`src/evaluator/types/`): `Refine(T, p)` must be
  recognized as a type constructor that wraps `T`. The type synthesis
  pass must unwrap `Refine(T, p)` to `T` for codegen while preserving the
  predicate for verification.
- **Subtyping** (`src/types/compatibility.ts`): `Refine(T, p) <: T` is
  one-way. But what about `Refine(T, p) <: Refine(T, q)`? This requires
  proving `p ⇒ q`, which is a VC — not a simple compatibility check.
- **Predicate composition**: `Refine(Refine(i32, p), q) ≡ Refine(i32, λx. p(x) ∧ q(x))`.
  This requires synthesizing a new lambda at compile time, which is not
  a trivial operation.
- **Predicate evaluation**: The plan says "predicate evaluated at comptime
  by the existing CTFE engine." But most refinement predicates involve
  runtime values (e.g., `(x >= lo) && (x <= hi)`). CTFE can only check
  compile-time-known values. For runtime values, the predicate must go
  to the SMT solver — meaning the evaluator's `UnknownValue` must carry
  enough symbolic information to encode the predicate.

**Question**: Can `Refine` predicates reference mutable state? If `s` is
a `ref(s) : Slice(i32)` and the predicate is `(s(0) > i32(0))`, the
verifier must know that `s(0)` is unchanged between calls.

#### B5. Effect capabilities — verification vs current implementation

The plan describes a capability lattice with ranks and taint levels. The
current algebraic effects implementation has none of this infrastructure:

- Effect parameters are just regular function parameters typed as
  `ctl(...) -> R`. There is no "effect rank" metadata.
- The evaluator doesn't have a notion of `Io` being "more powerful" than
  `Allocator` — these are just nominal types.
- Taint tracking (`Untrusted` → `Trusted`) requires information flow
  analysis, which is orthogonal to value-level VC generation.

The capability enforcement described in the plan would require building a
separate analysis pass (information flow / taint) on top of the verifier.
This is substantial new infrastructure and should be called out as such
in the Phase 4 estimate.

#### B6. CBMC/KLEE/SeaHorn annotation mapping is non-trivial

The plan says "Yo's codegen emits annotations the chosen backend
understands" but the mapping is not 1:1:

- `requires(P)` at caller side → `__CPROVER_assume(P)` before the call
- `requires(P)` at callee entry → `__CPROVER_assume(P)`
- `ensures(P)` at callee return → `__CPROVER_assert(P)`
- `invariant(P)` → `__CPROVER_assert(P)` at loop head AND loop exit
- `assert(P)` → `__CPROVER_assert(P)`

Each of these annotations must be placed at a specific point in the
generated C code, which requires the codegen to be aware of contract
sites. Today, the codegen has no contract concept — this would need
codegen modifications.

### C. Scope & Estimation Concerns

#### C1. Phase 1 scope is substantially underestimated

The plan estimates Phase 1 as "6-12 person-months" but this appears to
account for path-condition tracking, VIR, Z3 integration, and all P0
prerequisites together. Given the complexity analysis above:

- Path-condition tracking: 4–6 months
- VIR design + construction: 2–3 months
- Z3 SMT-LIB 2 encoder: 2–3 months
- `result`/`old(...)` evaluator support: 1–2 months
- `Refine` subtyping: 1–2 months
- Contract gathering from signatures: 1 month
- Integration + testing: 2 months

Total: 13–19 person-months for Phase 1 alone. The upper end of the
original estimate (12 months) is plausible as a minimum, but 18–24 months
is more realistic for a production-quality implementation.

#### C2. The "60% of a VC generator" framing is misleading

The claim that the evaluator is "already 60% of a verification condition
generator" conflates type-checking with verification. The evaluator can:

- Dispatch function calls by name
- Handle `cond`/`match` branching with environment merging
- Track `UnknownValue` for type-level reasoning
- Handle control flow (return, unwind, break, continue)

These are standard compiler infrastructure that every typed language has.
A VC generator additionally needs: symbolic state, path conditions, loop
invariant reasoning, contract substitution at call sites, and SMT encoding.
The evaluator provides none of these. A more accurate framing: the
evaluator provides the **AST traversal and type environment infrastructure**
that a VC generator hooks into, but not the VC generation logic itself.

### D. Phase 0 Implementation Notes

Phase 0 is the only near-term commitment and is well-scoped. Specific
things to watch:

1. **Builtin function detection**: When the parser encounters `requires(x)`,
   `ensures(x)`, `invariant(x)`, or `ghost(x)`, it produces normal
   `FnCallExpr` nodes. These must be registered in `BuiltinFunctions` in
   `src/expr.ts` so the evaluator can dispatch them.

2. **Assert lowering in codegen**: In `runtime` mode, `requires(P)` at
   function entry lowers to `assert(P, "requires failed: ...")`. The
   codegen in `src/codegen/functions/generation.ts` needs to emit these
   assertions at the start of each function body.

3. **`pragma(Pragma.Verify)`**: Add new `PragmaKind` entries (`Verify`,
   `VerifyOrAssert`, `NoContracts`) to `src/evaluator/memory-safety.ts`
   alongside the existing AllowUnsafe. Phase 0 registers them but does
   nothing — emits a warning.

4. **`result` and `old(...)` keywords**: These need to be reserved in the
   parser to prevent their use as variable names. `result` is particularly
   important — it's currently a valid identifier and may appear in existing
   code.

5. **`ghost(...)` as a new builtin**: The evaluator must handle both the
   binding form and the function-wrapping form. For Phase 0 (no verification),
   `ghost(...)` can be a no-op that evaluates its body, identical to
   `begin(...)`.

### E. Design-Specific Questions

#### E1. What are the semantics of unit-returning contracts?

If a function returns `unit`, `result` inside `ensures(...)` is `()`.
What is an `ensures(...)` on a unit-returning function useful for?
The plan's examples all use non-unit return types.

#### E2. How do contracts interact with `forall` parameters?

Consider:

```rust
f :: (fn(forall(T : Type), x : T, requires(/* can we constrain T? */)) -> T)(body);
```

Can `requires(...)` reference `forall`-quantified type variables? The plan
doesn't address this. `T` is a `Type` value, so `requires((T == i32))` is
a type-equality check that the compiler can statically discharge.

#### E3. Can contracts reference `comptime` parameters?

A `comptime(N : usize)` parameter is compile-time only. Can `requires(...)`
reference it? Yes — it's compile-time evaluable. But `ensures(...)`
referencing a comptime parameter is also fine because `ensures(...)` runs
at verification time, which is compile time.

#### E4. How does `Refine(T, p).check(x)` handle predicates with non-trivial runtime cost?

The `.check(...)` method returns `Option(Refine(T, p))`. For expensive
predicates (e.g., `sorted(arr)` on a million-element array), this incurs
real runtime cost in `verify+` mode. Should `.check(...)` be a noexcept
operation, or can it panic on OOM?

#### E5. What happens to contracts in generic function specialization?

When `head :: (fn(forall(T : Type), s : NonEmpty(Slice(T))) -> T)` is
specialized to `head :: (fn(s : NonEmpty(Slice(i32))) -> i32)`, the
contracts must be carried through specialization. The plan doesn't
discuss how contracts survive monomorphization in `src/evaluator/calls/helper.ts`.

### F. Stale Claims in the Plan

#### F1. Slice-flowability doesn't track `len()` values

Lines 1170–1172 claim "the existing slice-flowability machinery already
knows `arr.as_slice().len() == arr.len() == 3`." This is incorrect.
Slice flowability (`src/evaluator/types/flowability.ts`) tracks **pointer
provenance** — whether a slice's data pointer outlives the current frame.
It does NOT track or reason about the numerical length of a slice.
Proving `slice.len() > 0` from a length-3 array literal would require
the CTFE engine (which knows `arr.len() == 3`) combined with a new form
of value-level reasoning that doesn't exist today.

#### F2. `src/codegen/effects/` does not exist

Line 676 references `src/codegen/effects/` as the location of async state
machine codegen. The actual directory is `src/codegen/async/` — there is
no `effects/` subdirectory.

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
   calls `self.method()`, the verifier must verify against the trait's
   specification, not any particular impl. Trait fields therefore need
   to carry `requires`/`ensures` clauses at the trait declaration site
   (the alternative — verifying against every impl — multiplies work by
   impl count). **Syntax decided** (Phase 0 lands trait-level contract
   parsing; same signature-extraction pass as free functions). **Semantics
   open** for Phase 4: how impls inherit or override trait-level
   contracts, how generic `forall` quantification in trait method types
   composes with contracts, how the verifier picks trait contract vs
   impl-specific contract at call sites. See audit §B3.

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

8. **Interaction with `consume(...)` and ownership.** `consume(p.* = v)`
   performs destructive moves on unsafe pointers. How does the verifier
   reason about moved-from values in verified functions? The plan does
   not address ownership semantics in the verification context.

9. **`break`/`continue` in verified loops.** A `break` inside a loop with
   `invariant(...)` is well-defined (invariant holds at break point), but
   `continue` requires the invariant to hold after the jump to the loop
   head — the verifier must check this.

10. **`asm(...)` blocks in verified functions.** Can a function with
    contracts contain inline assembly? If so, the verifier cannot reason
    about the assembler's effects and must either forbid `asm(...)` in
    verified functions or treat it as an opaque assumption.

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

- The `NonEmpty(Slice(i32))(slice)` construction triggers a VC: prove
  `(slice.len() > usize(0))`. Because `slice` was derived from a literal
  array of compile-time-known length 3, CTFE evaluates `arr.len()` and
  `arr.as_slice().len()` to the constant `usize(3)`; the VC `3 > 0`
  discharges by literal evaluation, no SMT call needed. (Note: this
  relies on CTFE-level slice-length propagation through `as_slice()`,
  which would need to be added — slice-flowability tracks pointer
  _provenance_, not length. See audit §F1.)
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
- [`EXPLICIT_EFFECTS.md`](archive/EXPLICIT_EFFECTS.md) — the effect model
  capabilities sit on top of.
- [`UNIFIED_COMPTIME_DESIGN.md`](backlog/UNIFIED_COMPTIME_DESIGN.md) — the
  comptime evaluator the VC generator extends.
- [`GADTS.md`](GADTS.md) — per-variant refinement, the seed of value-
  indexed types.
- [`SLICE_FLOWABILITY.md`](archive/SLICE_FLOWABILITY.md) — example of non-trivial
  static analysis already running in the evaluator.
- [`ASYNC_SM_VARIABLE_OPTIMIZATION.md`](archive/ASYNC_SM_VARIABLE_OPTIMIZATION.md)
  — the state-machine model async verification reuses.
- External: Dafny (Microsoft Research), F\* (MSR Inria), Liquid Haskell,
  Rust + Kani, Frama-C/ACSL, CBMC, KLEE, SeaHorn.
