# `Array.fill` accepts a run-time value and turns it into an abort stub

**Status:** OPEN. Found 2026-09-16 while trying to close the `Array(T, N)`
`Default` row of `plans/STD_API_STABILIZATION.md`. The root cause below is
MEASURED; **two attempted fixes have been refuted, both recorded here.**

> **The title and the whole diagnosis below were WRONG until 2026-09-17, and
> the correction is the useful part of this document.** Every section from
> "Symptom" down is the record of an investigation that was measuring the wrong
> variable. It is kept, not rewritten, because the way it went wrong is
> instructive: four probes were run in the same generic shape "so only one
> thing varies", and the thing that actually varied was never in the table.

## What it really is (2026-09-17, measured)

Generics are not involved. This has no generic anywhere and reproduces it:

```rust
h4 :: (fn() -> Array(i32, usize(3)))(Array(i32, usize(3)).fill(i32.default()));
```

The variable is **literal versus call**, not generic versus concrete.
`fill(i32(0))` works; `fill(i32.default())` does not; and `fill(z())` for a
plain `z :: (fn() -> i32)(i32(0))` fails the same way.

And `Array(i32, usize(3)).fill(i32.default())` **is a genuine user error**.
`fill` is declared `fill : (fn(comptime(val) : T) -> comptime(Self))` — it
builds the whole array at compile time, so its argument must be compile-time
known. `i32.default()` is an ordinary run-time call:
`impl(i32, Default(default : (fn() -> Self)(i32(0))))` declares a plain `fn`.
Three independent confirmations that its result is not a compile-time value:

| probe | result |
| --- | --- |
| `println(`${i32.default()}`)` | prints `0` — correct at run time |
| `comptime_assert(i32.default() == i32(0))` | **E1101**, "Expected bool expression" — the comparison is not a comptime bool |
| `impl(i32, Default(default : (fn() -> Self)(i32(0))))` | a plain `fn`, so calling it yields a run-time value |

So the defect is not that the call fails. It is that **the failure is never
reported**. The user writes an ordinary type error and receives a binary that
compiles clean and aborts.

## Root cause — `.None` is the wrong test for "runtime value"

`evaluate_yo_array_fill` (`src/evaluator/builtins/array_fns.yo`) has the right
diagnostic and it is unreachable for the case that matters:

```rust
// Fill value must be compile-time known.
fill_value := match(
  fv_info.value,
  .Some(v) => v,
  .None => { exn.throw(... "expects second argument to be a compile-time known value, got runtime value"); ... }
);
// If fill value is unknown, return an UnknownVal for the whole array.
if(is_unknown_val(fill_value), { ... create_unknown_val(array_type_tv) ... });
```

An `ExprInfo.value` of `.None` means a run-time value — but a run-time value
whose TYPE is known arrives as `.Some(UnknownVal)` instead, and sails straight
past the guard into the `is_unknown_val` arm below, which manufactures an
`UnknownVal` for the whole array and reports nothing. The enclosing
definition's evaluation then fails, is swallowed, and the program aborts with

```
yo: FATAL: reached yo_id_..., whose body failed to transpile - its
definition-time evaluation failed and was swallowed.
```

This is the `.None`-versus-`UnknownVal` trap in its purest form: the check is
present, reads as correct, and cannot fire for the case it was written for.

## REFUTED attempt 1 — a guard in `__yo_array_fill` is unreachable code

The obvious fix is to throw in `evaluate_yo_array_fill` when the fill value is
an `UnknownVal`, outside a def-time trial. It was written, built on
`d126e2c90`, and **does not fire**:

```
NEGATIVE_RC=0 (want non-zero)     # rc=0, the diagnostic absent
ARRAY_TEST_RC=1 -> error: Expected compile error, but the expression was
                   evaluated successfully: (Array(i32, usize(3)).fill)((i32.default)())
```

`fill`'s body is `return(__yo_array_fill(Self, val))`, and the unknown-argument
execution gate in `src/evaluator/calls/comptime_fn.yo` returns
`_ctfe_unknown(return_type)` **without running the body**. So
`evaluate_yo_array_fill` never executes on this path and the guard sits in code
the defect cannot reach.

The trace that says so had been measured HOURS earlier — the `[ctgate]
any_arg_unknown=true` line for `fill` IS the body being skipped. The data was
right; the reading of it was not. Patching inside a body the trace had already
shown to be skipped is the same error as the four-probe table below: holding
the wrong thing fixed and not noticing.

## REFUTED attempt 2 — this is NOT the same defect as the comptime-parameter hole

`fill` is `(fn(comptime(val) : T) -> comptime(Self))`, and the sibling defect in
`issues/` #734 is `c :: (fn(comptime(v) : i32) -> i32)(v)` called as
`c(i32.default())`, which emits C with the argument DROPPED and is caught only
by clang's "too few arguments". Both are an unknown argument bound to a
`comptime(...)` parameter, so they look like one defect with two faces, and the
proposed fix was a single throw at the unknown-argument gate.

**Measured and refuted.** ctgate trace of `c(i32.default())` against the literal
control `c(i32(0))`, set-differencing the fids that reach
`any_arg_unknown=true`: for `fill` that difference is exactly one fid and names
`fill`; **for `c` the difference is EMPTY** — ten gate hits, every one also
present in the control, all ambient std traffic. `c` never reaches the gate.

The symptoms already implied this and it was nearly missed: reaching clang means
codegen ran to completion, which is not what happens downstream of a gate that
returns an unknown without executing. A single throw at the gate would have
fixed `fill`, left `c` untouched, and closed an issue claiming both.

## What is still unknown, and the probe that settles it

Hypothesis, NOT measured: `fill` is comptime-RETURNING so it routes through
`comptime_fn.yo` and meets the gate, while `c` returns `i32` and takes the
ordinary call path, where the comptime parameter is meant to be specialized
away and an unknown argument yields a callee that still expects a parameter the
call site omits.

## REFUTED attempt 3 — the comptime-parameter binding site is not it either

The next candidate was the moment an argument is bound to a parameter flagged
comptime: `check_if_function_parameter_matches_argument` in
`src/evaluator/calls/helper.yo`, one of the four `get_func_param_comptime`
consumers. Instrumented with a gated `[ctparam]` print (label, comptime flag,
arg-unknown, in-trial, both types) and run over BOTH reproducers and BOTH
literal controls:

```
pc_fill_bad  ctparam_lines=2291   ct_only=true total: 482
pc_fill_ok   ctparam_lines=2291   ct_only=true total: 482
pc_c_bad     ctparam_lines=5986   ct_only=true total: 486
pc_c_ok      ctparam_lines=5986   ct_only=true total: 486
set difference (bad minus control), ct_only=true arg_unknown=true:
  fill: (empty)      c: (empty)
```

Identical counts between failing and working in both pairs — the traffic at that
site does not differ at all. And `label=val` (fill's parameter) and `label=v`
(c's) appear **zero times in all four logs**, controls included. So this is not
"reaches the site with the flag false": comptime parameters do not pass through
that function.

## Why the two cases diverge — the code says so

`src/evaluator/calls/helper.yo` (~line 7005) records that TS's
`isFunctionTypeGeneric` "ALSO counts COMPTIME PARAMS, excluding only
comptime-RETURNING functions (those are CTFE'd)". That is the split:

| | `fill` | the comptime-parameter case |
| --- | --- | --- |
| signature | `-> comptime(Self)` | `-> i32` with `comptime(v) : i32` |
| routed as | comptime-RETURNING, so CTFE'd | generic — one instantiation per call site |
| path | `comptime_fn.yo`, meets the unknown-arg gate | specialization, never reaches the gate |
| symptom | `_ctfe_unknown` → abort stub at run time | C emitted with the argument dropped → clang "too few arguments" |

They are divergent **by design**, not by accident, and they need two fixes.
They share a description — an unknown argument where a compile-time value is
required — and a user-visible cause, and nothing else.

## Next probe, for the comptime-parameter half

Target `helper.yo:2066`, where the comment says an explicit `comptime(K)`
param's arg VALUE joins the specialization cache key. Question to instrument:
when that value is an UnknownVal, does the minted spec keep the parameter in
its runtime signature while the call site omits it? That would produce "too few
arguments" exactly. This is a probe target, NOT a mechanism.

Do not write a fix before that print has been read. Three candidate
interception points have now been eliminated, two of them before any fix was
written; the one that was not cost a build and a diff that looked correct.

## How the probe found it, and why the earlier table did not

The decisive instrument was a gated `[ctgate]` print at the unknown-argument
execution gate in `src/evaluator/calls/comptime_fn.yo`, reporting
`any_arg_unknown`, `nargs` and the callee `fid`, run over the broken and
working programs and compared with `comm` over the sorted fid sets. Exactly one
fid differed, and `YO_DEBUG_CTFE` named it `(Array(T, usize(3)).fill)` with
`args=<unknown: Self>`.

Two further facts came out of the same trace and both mattered:

- the gate fires for `fill` **twice**, and only the first is inside a def-time
  trial (`[ctfe-in]` is trial-gated and printed once), so the failure is not an
  artifact of the trial's error path;
- the specialized TYPE is correct — `[pa-fallthrough] prop=len
  obj_ty=Array(i32, 3)` — so only the VALUE channel is degraded. The earlier
  section's claim that the return type "still carries the UNSUBSTITUTED `T`"
  was reading a def-time trial's stub name as if it were the specialized one.

The earlier four-probe table held the generic shape fixed in every row in order
to isolate one variable, and so could not see that the generic shape was not a
variable at all. Shrinking the reproducer — dropping the generic entirely —
took one compile and answered it.

## What it means for the `Array(T, N)` `Default` row

The row is **not** blocked on a compiler fix, and should not be closed by one.
`fill` is comptime-only by construction and that is the correct design: it is
the compile-time initializer, and its whole value is that the fill value is
known at compile time. A run-time element-wise initializer is a DIFFERENT
operation — a loop — and belongs under a different name (an `Array.repeat(v)`
shape) rather than being smuggled in by relaxing `fill`. `Default` for
`Array(T, N)` then either does not exist, or is written over that run-time
operation where `T <: Default`, with the per-element loop explicit at the call
site.

Relaxing `fill` would trade a clear compile error for a silent per-element
run-time loop hidden behind a name that promises compile-time behaviour.

### Two candidate shapes, and the probes that decide between them

Neither is designed here — both are cheap to measure and NEITHER has been
measured yet, so this section is a work item, not a conclusion.

1. **A comptime `Default`.** If `default` were declared
   `(fn() -> comptime(Self))` rather than `(fn() -> Self)` for the primitive
   impls, `T.default()` would be compile-time known and
   `Array(T, N).fill(T.default())` would work with NO compiler change and no
   new API. The cost is that it constrains every `Default` impl — `String`'s
   cannot be comptime — so `Default` would split, or the array impl would need
   a narrower bound than `T <: Default`.

   *Probe:* declare a local type with a comptime-returning `Default` impl and
   `fill` on it. One compile.

2. **A run-time `Array.repeat(v)`.** Note that explicit construction with
   RUN-TIME values already works — probe C of the historical table below built
   `Array(T, usize(3))(x, x, x)` from a run-time parameter and ran. So the
   element-wise path exists; what is missing is producing `N` copies of the
   argument for a generic `N` without writing them out.

   *Probe:* whether the existing comptime fold/variadic machinery can splat
   `N` copies into a construction, or whether this needs an uninitialized-array
   primitive (which would be a genuine language gap and belongs in
   `plans/backlog/`).

Run both before choosing. The historical record below is what a plausible
mechanism chosen without a probe costs.

---

# Historical record — the investigation that measured the wrong variable

## Symptom

`Array(T, N).fill` is declared `fill : (fn(comptime(val) : T) -> comptime(Self))`
under `where(T <: Comptime)`. A LITERAL satisfies `comptime(val)`, even inside a
generic function. A value produced by a **generic-dispatched trait call** does
not — even when `T` is bounded `Comptime` and the concrete `T`'s `default()` is
itself a compile-time constant.

Measured with the same generic shape in both arms
(`issues/repros/array-fill-accepts-a-runtime-value.yo`):

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
  (`feat/std-byte-conversions`, pending the seed bump — since MERGED as #722).
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
