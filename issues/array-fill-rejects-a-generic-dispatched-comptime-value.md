# `Array.fill` rejects a generic-dispatched comptime value — and does it as an FTT stub

**Status:** OPEN. Found 2026-09-16 while trying to close the `Array(T, N)`
`Default` row of `plans/STD_API_STABILIZATION.md`.

## Symptom

`Array(T, N).fill` is declared `fill : (fn(comptime(val) : T) -> comptime(Self))`
under `where(T <: Comptime)`. A LITERAL satisfies `comptime(val)`, even inside a
generic function. A value produced by a **generic-dispatched trait call** does
not — even when `T` is bounded `Comptime` and the concrete `T`'s `default()` is
itself a compile-time constant.

Measured with the same generic shape in both arms
(`issues/repros/array-fill-rejects-a-generic-dispatched-comptime-value.yo`):

| fill value | result |
| --- | --- |
| `i32(0)` — literal | **works**, prints 3 |
| `T.default()` — generic dispatch | **FTT stub** |

The failure mode is the bad one: `yo compile` exits **rc=0**, and the binary
aborts at run time with

```
yo: FATAL: reached yo_id_..._ret_Array_i32__3_, whose body failed to transpile —
its definition-time evaluation failed and was swallowed.
```

`yo check` on the same file also exits **0**, because `check` never evaluates
function bodies ([[yo-check-src-std-are-a-filter-not-a-gate]]). So nothing
short of running the binary reports this.

## Narrowed 2026-09-16 — `fill` and generics are both fine; the trait DISPATCH is not

Four probes in the same generic shape, so only one thing varies:

| probe | body | result |
| --- | --- | --- |
| A | `-> Array(T, usize(3))`, value passed through, no construction | **OK** |
| C | `Array(T, usize(3))(x, x, x)` — explicit construction, same `(Default, Comptime)` bound | **OK** |
| D | `Array(T, usize(3)).fill(T(0))` — `fill`, generic element, comptime LITERAL | **OK** |
| G2 | `Array(T, usize(3)).fill(T.default())` — `fill`, generic element, TRAIT CALL | **FTT stub** |

So none of these is the cause: the generic return type (A), the `Comptime`
bound (C), `fill` itself (D), or `fill` with a generic element type (D again).

What fails is specifically **a generic-dispatched trait method call in a
`comptime(...)` argument position**. `T(0)` is comptime-evaluable without
knowing which impl to pick; `T.default()` requires resolving the `Default` impl
for the bound `T` first, and that resolution has not happened when
`fill`'s `comptime(val)` is checked — even though after specialization `T` is
`i32` and `i32.default()` is the constant `0`.

The emitted C names the symptom exactly. The stub is

```
yo_id_..._ret_Array_T____Default___Comptime___3_
```

— the return type still carries the UNSUBSTITUTED `T` with its bound, while a
sibling function in the same file is correctly `Array_int32_t_3`.

## What it blocks

**`Array(T, N)`'s `Default`**, which is the only spelling available:

```rust
impl(
  generic(T : Type, U : usize),
  where(T <: (Default, Comptime)),
  Array(T, U),
  Default(default : (fn() -> Self)(Array(T, U).fill(T.default())))
);
```

That impl registers, compiles, and aborts. Narrowing the bound from `Default`
to `(Default, Comptime)` does not help — the probe above already carries the
`Comptime` bound.

## This row is NOT blocked on value substitution — the plan mis-attributes it

`plans/STD_API_STABILIZATION.md` lists `Array(T,N)` `Default` beside the byte
conversions under
`plans/backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`, on the reasoning that
"a `default()` generic over `N` is the same substitution problem". It is not.

- The byte conversions needed an associated constant in a LENGTH position.
  That landed in #714 and they are written
  (`feat/std-byte-conversions`, pending the seed bump).
- `Array` `Default` needs no such thing: a bare generic `N` was ALWAYS a legal
  length, and `impl(generic(T : Type, U : usize), Array(T, U), …)` is how std
  already writes `Eq`/`Ord`/`Clone`/`Hash` for arrays. What it needs is the
  ability to produce N copies of a value that is not a literal — which is the
  "runtime element-wise initializer Yo has no spelling for yet" the row's own
  text names, and which this defect is the precise form of.

So closing the value-substitution row does not close this one, and the two
should be tracked apart.

## The lead above is REFUTED — measured 2026-09-17

The specialization-mint lead recorded below was tested with a gated `[ctspec]`
print at `src/evaluator/calls/function.yo`, reporting `any_ct`, `all_known` and
whether a spec is minted, on BOTH the failing and the working case.

**The traces are identical.**

| trace line | broken `fill(T.default())` | working `fill(T(0))` |
| --- | --- | --- |
| `any_ct=true all_known=true mint=true` | 20 | 20 |
| `any_ct=true all_known=false mint=false` | 3 | 3 |
| `any_ct=true all_known=true mint=true` (2nd fid) | 2 | 2 |

Same function ids, same counts, same values, 25 lines each. The
`all_known=false` entries the lead pointed at are present in the WORKING case
too, so they are ordinary and not the cause. The comptime-value specialization
mint behaves the same whether the call succeeds or FTTs, so **it is not the
mechanism** and a fix there would have changed nothing.

That also means `fill` never reaches this predicate under a distinguishing
path — the difference between the two programs is invisible here entirely.

### A hypothesis that SURVIVED measurement — the unknown-arg execution gate

Measured 2026-09-17, after the mint was ruled out. `evaluate_comptime_fn_call`
(`src/evaluator/calls/comptime_fn.yo`, ~line 849) carries an **execution gate
for unknown arguments**: if any argument value `is_unknown_val`, it returns
`UnknownVal(return_type)` **without executing the body**. Its own comment
describes the consequence in a neighbouring case — "the self arg has lost its
value — `evaluate_comptime_fn_call`'s unknown-arg gate then refuses to
execute".

`fill` IS a comptime fn (`fn(comptime(val) : T) -> comptime(Self)`), so this
gate is on its path. Instrumented with a gated `[ctgate]` print and run on both
cases:

| case | `[ctgate]` lines | `any_arg_unknown=true` |
| --- | --- | --- |
| broken `fill(T.default())` | 1791 | **12** |
| working `fill(T(0))` | 1790 | **10** |

**The broken case hits the gate twice more than the working one.** That is a
real discriminator — unlike the mint, whose traces were byte-identical across
the same pair. It also explains why the mint looked identical: the divergence
is upstream of it, exactly where those traces implied.

Mechanism, consistent with every observation so far: `T.default()` cannot
resolve a `Default` impl while `T` is abstract, so it arrives as an
`UnknownVal`; the gate then declines to execute `fill`; no array is
constructed; and the caller ends up an FTT stub. `T(0)` needs no impl
resolution, arrives known, and the body runs.

**Narrowed further without a rebuild**, by bucketing the same traces on the
argument COUNT the gate reports:

| bucket | broken `fill(T.default())` | working `fill(T(0))` |
| --- | --- | --- |
| `any_arg_unknown=false nargs=1` | 1305 | **1306** |
| `any_arg_unknown=true  nargs=1` | **9** | 7 |
| `false nargs=2` / `nargs=3` / `nargs=5` | 434 / 29 / 11 | 434 / 29 / 11 |
| `true nargs=2` | 3 | 3 |

Every bucket is identical EXCEPT `nargs=1`, where the working case has one more
KNOWN hit and the broken case has more UNKNOWN ones. `fill` takes exactly one
argument (`comptime(val) : T`), and the two programs differ ONLY in that
argument. So a single-argument comptime call flips from known to unknown
between them, in the only bucket that moves.

That is much stronger than the raw 12-vs-10 count: it localises the flip to
one-argument calls and rules out the multi-argument traffic entirely.

**Still not a formal identification.** The print carries no callee id, so this
is an argument from arity and from the programs' only difference, not a direct
observation that the flipping call is `fill`. Adding the callee id to the
`[ctgate]` print would settle it and costs one build. Given four refuted
mechanisms in this family, that build is worth spending before any fix.

### Where that leaves it

The remaining explanation is the one recorded as competing: the receiver type
is not bound at the point the difference is decided, so `T.default()` cannot
resolve to an impl while `T(0)` needs no impl to resolve. The emitted stub name
supports it — `..._ret_Array_T____Default___Comptime___3_` still carries the
UNSUBSTITUTED `T` with its bound, beside a correctly-substituted
`Array_int32_t_3` in the same file.

Next probe should instrument where the ARGUMENT is evaluated rather than where
the spec is minted: find the point at which `T.default()` yields no value, and
print whether `T` is bound there. Do not write a fix before that print exists —
this is the fourth hypothesis on this defect family to be refuted by
measurement on 2026-09-16/17, after TypeValue interning and a trait-id
collision (for the prelude line-count defect) and `force_in_flight_field` (for
the inherent-constant one).

## A LEAD, not a confirmed root cause

`src/evaluator/calls/function.yo` (~2433-2468) decides whether to mint a
specialization keyed on comptime argument VALUES. Its own comment says it fires
only when "every flagged arg's value is compile-time KNOWN", and it sets
`ou_all_known = false` whenever an evaluated arg's `value` is `.None`, an
`UnknownVal`, or a `TypeVal` still carrying unresolved SomeTs. Without the mint,
the call falls through to the non-specializing path — and that comment records
the same downstream symptom this issue has, an FTT spliced at the C call site.

`fill`'s `val` is comptime-flagged, and `T.default()` plausibly presents as
`.None` at that point, which would match exactly.

**This is a reading of the code, NOT a verified diagnosis.** It has not been
instrumented, and the obvious competing explanation — that `T` simply is not
bound yet when the check runs, so the dispatch cannot resolve regardless — is
equally consistent with the evidence, and the emitted stub's unsubstituted
`Array_T____Default___Comptime___3` name mildly favours it.

Whoever takes this should settle which it is FIRST, with a gated print at that
predicate rather than by reasoning: three plausible chains were followed and
refuted on adjacent defects on 2026-09-16 (TypeValue interning and a trait-id
collision for the prelude line-count defect; `force_in_flight_field` for the
inherent-constant one), each costing a build.

## Fix shapes

1. **Make `comptime(val)` accept a generic-dispatched call whose result IS a
   comptime constant after specialization.** The specialization knows `T`, so
   `T.default()` is constant-foldable at that point; the failure is that the
   check runs before or without that knowledge.
2. **A runtime element-wise initializer** — the thing the row originally asked
   for. Broader: it would also give `Default` for arrays whose element type is
   NOT `Comptime` (`String`, owning types), which fix 1 would still exclude.

(2) subsumes (1) for this row but is the larger change.

## Whatever the fix, the gate is running the binary

`check` is green and `compile` is rc=0 today. Any test for this must execute
the program, or grep the emitted C for the FTT comment
([[yo-self-ftt-measurement-methodology]]) — a compile that "succeeds" proves
nothing here.
