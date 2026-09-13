# A generic function returning `Impl(Future(T))` miscompiles at a second `T`

**Status: FIXED 2026-09-13.** The value-param shape was fixed 2026-09-12
(#619); the closure-param shape — the one that blocked `spawn_blocking` — is
fixed now. See "FIXED 2026-09-13" below for what it actually was; the sections
before it are the investigation record, kept because four of the attempts in it
are measured NEGATIVES that are worth not repeating.
**Found:** 2026-09-12, writing `spawn_blocking` for waker step 5
(`plans/WAKER_BASED_SCHEDULING.md`).
**Pre-existing:** reproduces identically on the published **v0.2.31**.

## Symptom

Three different C errors depending on the shape, all the same root: ONE
specialization's view of `T` is used where another's belongs.

| shape | error |
| --- | --- |
| `fn(generic(T), v : T, io : Io) -> Impl(Future(T, Io))`, async body `v` | the AWAIT temp is `void*` (T never resolved) while the sync future's `result` is `int32_t` / the struct |
| same with a closure param `f : Impl(Fn() -> T)` | `conflicting types for closure_yo_id_…` — ONE async-block closure emitted, returning `void*`, with a `Pair`-typed body |
| an `io.await` inside the async body | `sm->result` typed `int32_t` in the specialization whose `T` is a struct |

Either instantiation ALONE compiles and runs. The pair does not.

## Reproducers

* `issues/repros/generic-future-return-two-t-plain-param.yo`
* `issues/repros/generic-future-return-two-t-closure-param.yo`
* `issues/repros/generic-future-return-two-t-with-await.yo`
* `issues/repros/generic-future-return-three-t-closure-param.yo` — **the
  discriminating one.** At two instantiations a lag, a swap and a reversal are
  the same permutation; at three they are not. See "MEASURED 2026-09-13: it is
  a LAG BY ONE" below.

The four A/B shapes the fix has to move, added 2026-09-13 so the gate table in
"The sharp A/B" is runnable rather than described:

* `issues/repros/generic-future-return-two-t-method-call.yo` — the one that
  ALREADY WORKS. It is the canary, not the target: an over-eager fix un-fixes
  it silently, and it is the cheapest way to notice.
* `issues/repros/generic-future-return-two-t-explicit-receiver.yo`
* `issues/repros/generic-future-return-two-t-impl-no-self.yo`

**All of them now use `Pair(lo : 3, hi : 5)`, deliberately.** They used
`hi : 4`, which sums to 7 — the same value the `i32` instantiation prints for
`a`. A miscompile that renders the `Pair` call with the `i32` specialization's
type would then print the RIGHT number for the wrong reason, and the difference
between "compiles and prints a=7 b=7" and a genuine pass would be invisible.
With `hi : 5` the expected output is `a=7 b=8`, and the two cannot collide.
(Noted as a hazard in the 2026-09-13 handover before it had bitten; changed
here so it cannot.)

## Root cause of the value-param shape, and its fix

The evaluator DOES compute the right per-call return type. `YO_DEBUG_RRE=1`
prints it:

```
[rre] callee=wrap old=true hkt=Impl : (Future[Future](i32) Io : Io)  resolved_ret=Impl : (Future[Future](R) Io : Io)
[rre] callee=wrap old=true hkt=Impl : (Future[Future](Pair) Io : Io) resolved_ret=Impl : (Future[Future](R) Io : Io)
```

`hkt` is the re-evaluated return-type EXPRESSION, per call, and it is correct
both times. It was thrown away: the adoption gate in
`_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) accepted a
re-evaluated type only when it was SomeT-free, or when every SomeT in it
resolved through its own cell. An `Impl(...)` existential is itself a SomeT
with an empty resolution cell, so an async return could never pass either arm —
`resolved_ret` stayed the declared, unresolved `Impl(Future(R) Io)`, every
caller shared it, and the await site rendered it `void*`.

The gate gains a third arm: adopt when the re-evaluated type no longer mentions
any of THIS CALLEE'S OWN forall binders, because substitution is then complete
for this call and what remains are existentials rather than type variables. It
is gated on `rre_old_wanted`, which is what keeps the recorded adoption hazard
out — the per-call closure-`F` family leaves a substituted return whose SomeTs
all resolve concretely, so the re-eval is never wanted there in the first place.

### The binder test must compare IDs, not names

The first cut compared binder NAMES, and produced a compiler in which *the same
program compiled or not according to what its type variable was called*:

| receiver forall | method forall | result |
| --- | --- | --- |
| `U` | `R` | compiles |
| `A` | `B` | compiles |
| `T` | `Q` | **miscompiles** |
| `U` | `E` | **miscompiles** |

`T` and `E` are the names the PRELUDE's own `Future(T, E)` declaration uses, and
those binders ride along inside the re-evaluated `Impl(Future(i32) Io)` — so a
name comparison reported "still mentions `T`" for any user generic that happened
to be called `T`, which is the most natural name there is. The fix reads the
binder IDs off the declared return type (`_rre_binder_ids`), applying the name
filter exactly once, where the names are unambiguously the callee's.

## FIXED 2026-09-13 — two bugs, and the first was hiding the second

The defect was **two** independent bugs stacked. That is why every partial
attempt recorded below moved the symptom without removing it: each one fixed
part of the first bug, and the second was invisible until the first was gone.
A third mistake — mine, in the shape of the fix itself — is recorded at the end
of this section, because the way it was caught matters more than the one-line
change that fixed it.

### Bug 1 (evaluator) — a freshening that silently freshened nothing

The direction in "the fix direction" was right: give a user generic callee's
forall binders per-call identity, upstream of parameter binding. Applying
`_freshen_io_builtin_callee` at the FuncVal arm of `evaluate_function_call` is
the right PLACE, and it does not work, because that helper builds its
substitution from the declaration's own `forall_types` entries and
`substitute` matches a `SomeT` by **(name, frame_level)** (`subst_lookup`,
`src/types/substitution.yo`).

For a user generic, `R`'s occurrence inside the parameter's `Fn` bound does not
carry the same `frame_level` as the `forall_types` entry. So the substitution
missed precisely the occurrence that matters, the call "was freshened", and the
emitted C did not move by a single byte.

The fix collects every **(name, frame_level) SITE** the binder actually occurs
at — walking into an `Impl`'s required traits and through the `Fn` / `Future`
members, the same walk `_rre_binder_ids` does — and substitutes one fresh
`SomeT` per binder NAME at all of them. Every attribute but the id and the
resolution cell is copied, so a `where(R <: (Send, Acyclic))` bound survives.

> **The generalisable part: a freshening is only as per-call as its key.** This
> codebase had already been bitten once by comparing binders by NAME (the
> ID-vs-name table above). This is the same error one level down — the key was
> a *pair*, and the second half of it was wrong. "It ran" and "it did anything"
> are different claims; only a trace of the ids before and after separates them.

With bug 1 alone fixed, all three of the evaluator's channels became correct
for the first time: the prototypes went `[T2, T0, T1]` → `[T0, T1, T2]`, the
state-machine structs' `result` fields `[T0, T0, T1]` → `[T0, T1, T2]`, and
each generation already called its own closure and built its own struct. The
program still did not compile — 9 C errors became 5, of a different kind.

### The trap inside Bug 1's fix, caught only by a real caller

The first working version of the site collector matched SomeTs **by NAME**
against the callee's forall names. Everything was green: `check ./src`
275/275, `check ./std` 175/175, all seven reproducer shapes, ten async test
files. And `std/thread.yo`'s `spawn_blocking` still miscompiled at a second
`T`.

Eight reductions were built up toward its shape — `own(cb)`, a
`where(T <: (Send, Acyclic))` bound, `std/sync`'s `Channel(T)`, a `Park`
awaited inside the async block, a nested `Thread(unit).spawn` capturing both
`cb` and the channel, the std-internal `__yo_async_blocking_begin/end`
brackets. **Every one of them compiles.** Then one variable was changed:
`spawn_blocking`'s binder renamed from `T` to `RB`, nothing else. It compiled
and ran.

The prelude's own `Future(T, E)` declaration names its binders `T` and `E`, and
they ride along inside a re-evaluated `Impl(Future(i32) Io)`. A name-keyed
collector therefore swept up the prelude's binders for any user generic that
called its own binder `T` — **so the program's fate depended on what its type
variable was CALLED**, and `T` is the most natural name there is. The collector
now keys on the ids taken off the callee's own `forall_types`.

Three things about this are worth more than the fix:

* **It is the SAME mistake, one level down, as the ID-vs-name table above** —
  which is in this document, one screen up, and which this fix's own doc
  comment cites. Reading a hazard is not the same as applying it. Both cuts
  compared binders by name; the first compared them as strings, the second as a
  (name, level) pair whose second half only narrowed the mistake.
* **A test suite that shares a naming convention cannot see a name-sensitivity
  bug.** Every one of the five reproducers that exercises the CLOSURE-PARAM
  path — the path this fix gates on — names its binder `R`. (Two others use
  `T`: the plain-param shape and the method-form-with-await, and neither
  reaches the freshening, so neither could have caught it.) The blindness was
  by construction, not by bad luck. `tests/async_generic_future_return.test.yo`
  now carries cases named `T` and `E` deliberately.
* **The negatives did the work.** Eight bisect steps that each ruled an
  ingredient OUT left exactly one difference standing, and it was a difference
  nobody would have thought to vary. The last of them is kept as
  `issues/repros/spawn-blocking-closest-non-reproducing-shape.yo` — a negative
  control.

### Bug 2 (codegen) — a prototype and its definition computed from different rules

`generate_function_declaration` derives the C return type with
`_return_type_override`; `generate_function` derived it with
`_async_override_return_type`, which is only that helper's Future-returning
arm. `_return_type_override` has a second arm: when the declared result IS a
`SomeT` (or contains one) and the BODY's `ExprInfo` knows the concrete, take
the body's type. The definition never had it, so the prototype said `int32_t`
and the definition said `void*`, and C rejects the pair:
`conflicting types for 'closure_yo_id_…'`.

**`generate_function`'s own comment asserts the invariant its code breaks** —
"MUST match the forward declaration's override (generate_function_declaration
uses the same helper)". It did not use the same helper. A comment stating an
invariant is not a test of one, and this one had been false long enough to be
load-bearing for a reader.

It stayed latent because the shared resolved-concrete registry always held SOME
entry for the declared binder id, so both passes rendered a real type and merely
disagreed about WHICH — a miscompile rather than a hard error. **Bug 1 did not
cause bug 2; it stopped hiding it.** Removing the accidental registry entry
turned a silent wrong answer into the compile error it always was.

The fix is to call `_return_type_override` in both places. It delegates to
`_async_override_return_type` verbatim whenever the result implements `Future`,
so every async signature is spelled exactly as before.

**Same helper was necessary and not sufficient — it needs the same INPUTS too.**
`declarations.yo` computes `body_for_decl := if(is_erm, None, body)`: it
suppresses the body for an effect-record member, because a ctl handler's result
is stashed in `__yo_unwind_value` rather than returned, so the body's ExprInfo
type is NOT the C return type. Passing the body unconditionally on the
definition side recreated the very asymmetry being fixed, in the opposite
direction — `void` definitions under value-typed prototypes, taking out
`tests/async_await`, `async_generic_param_capture` and
`generic_impl_async_self`. The invariant to hold is "same helper AND same
arguments"; half of it is not half a fix.

### The mistake in the fix's own shape — a gate keyed on shape, not on channel

With both bugs fixed the first version of the gate asked a structural question:
does this callee take a closure parameter whose `Fn` bound mentions a forall
binder that also survives into the declared result? Every shape in the
reproducer table answers yes, and so does `spawn_blocking`.

So does something else entirely. The iterator and stream combinators are
`fn(generic(B), f : Impl(Fn(A) -> B)) -> Stream(B)` — the same shape, arrived at
for unrelated reasons. Freshening them mints a `B` for the receiver that the
next call in the chain does not look up, and

```
ch.filter(...).map(...)   then   chain.collect(io)
```

fails with `No matching call found with arguments: (chain.collect)(io)`.
A/B, measured: `tests/async/channel.test.yo` is **18/18 under the v0.2.32 seed**
and **fails to compile** under the branch carrying the shape-keyed gate.

The fix is not a combinator exception. It is to key the gate on the CHANNEL the
whole defect is about: the concrete behind an `Impl(Future(R, ...))` is
published under the binder's **id** by the io.async stamp and read back through
that same id by `io.await`, which is precisely what one shared binder cannot
serve for two instantiations. A combinator's `B` is carried by ordinary
per-call substitution and never needs an id. `type_implements_future` on the
declared result is the test, and it is one line:

```yo
if(!(type_implements_future(gc_res)), {
  return(ft);
});
```

**How it got that far.** `check ./src` (275/275) and `check ./std` (175/175)
were green — they are evaluator-only, a filter rather than a gate, and they were
green through every wrong version of this fix. Thirteen hand-picked async and
thread test files were green too, and that is the more dangerous of the two,
because a chosen set looks like evidence. It was chosen from where the bug was
believed to live, which is a subset of the blast radius of a change to dispatch.
The regression surfaced only under the full fast suite
(`yo test ./tests --exclude tests/internal --exclude tests/cli-cases`), which
was run to fill CI wait time rather than because the process called for it.
Final gate on the landed fix: **4206 passed, 0 failed, 271 files.**

---

## The investigation record (was: "What is still open")

> **Everything from here down is HISTORY, written while the defect was open.**
> It is kept, not rewritten, because four of the attempts below are measured
> negatives — each one cost a compiler build, and the point of keeping them is
> that nobody pays for them twice. Read the present tense as "as of the date on
> the heading". The section that supersedes all of it is
> "FIXED 2026-09-13" above.

The CLOSURE-PARAM shape —
`fn(generic(R), f : Impl(Fn() -> R), io : Io) -> Impl(Future(R, Io))` — still
miscompiles. It is a different defect, and as of 2026-09-12 it is measured
rather than hypothesised.

### The sharp A/B

One variable, four programs, all against develop's compiler
(`issues/repros/generic-future-return-two-t-closure-param.yo` and three
variants of it):

| the call | result |
| --- | --- |
| `b.run(() => …, io)` — METHOD-CALL syntax on an impl method | **compiles, runs, `a=7 b=8`** |
| `Box3.run(b, () => …, io)` — the same method, explicit receiver | fails |
| an impl entry with no `self` | fails |
| a free function, with or without a leading parameter | fails |

So it is the METHOD-CALL path that is special — not `self`, not
free-vs-impl, which is what the earlier note in this document guessed. The
method arm of `evaluate_function_call`
(`src/evaluator/calls/function.yo`, the `_with_resolved_concrete` bridge) reads
the SPECIALIZATION's body ExprInfo and pins the result with it; no other call
arm does, so every other shape falls through to the shared channel below.

### What the emitted C shows

Both async-block generations exist (`closure_…000000`, `closure_…000001`) and
so do both `_sync_fut_t` structs. What disagrees is the closure's own C return
type: the PROTOTYPE loop and the BODY loop render the same fid differently, and
across the two generations the renderings are crossed.

### What the evaluator shows

Three probes, on a compiler built for the purpose (`YO_DEBUG_CAPTURE` already
existed; `[fidty]` traces `register_func_type`, `[proto]` traces
`generate_function_prototype`, `[aclos]` traces the closure body/return
unification):

```
[fidty] closure_…16430952469372288712000000 := fn(io : Io) -> T
[fidty] closure_…16430952469372288712000001 := fn(io : Io) -> i32

[aclos] fid=…000000 ioasync=true ret=T   body=R   bodyconc=false
[aclos] fid=…000001 ioasync=true ret=i32 body=i32 bodyconc=true

[proto] …000000 ret_str=<Pair struct> result=T   some=true    <- DECLARATION pass
[proto] …000001 ret_str=int32_t       result=i32 some=false   <- DECLARATION pass
[proto] …000000 ret_str=int32_t       result=T   some=true    <- BODY pass
[proto] …000001 ret_str=int32_t       result=i32 some=false   <- BODY pass
```

Read it in order:

* **Generation 0** (the `i32` call) registers its result as the BARE SomeT `T`
  — io.async's own forall. Its body `f()` types as `R`, the enclosing generic's
  forall, also unresolved. A bare SomeT is rendered by
  `resolve_some_type_to_concrete`, which reads the per-object cell first and
  then the GLOBAL id→concrete table. That table is one entry per DECLARATION,
  shared by every call, so generation 0's return renders as whatever was
  written last: the `Pair` struct when the prototypes are emitted, `int32_t` by
  the time the bodies are — the prototype/definition split, from one type that
  changed under two readers.
* **Generation 1** (the `Pair` call) is worse: its result is already the
  CONCRETE `i32` — the FIRST call's binding, baked in before the closure was
  even typed. Swapping the two calls swaps the answer exactly
  (`Pair` first ⇒ generation 1 registers `-> Pair`), which is the signature of
  a stale global, not of a mis-ordered emission.

### The first suspect, and why it is NOT the writer

`src/evaluator/calls/helper.yo`'s closure-param binder does
`register_some_resolved_concrete(fn_res_id, cl_res3)` against the id of the
DECLARED bound's result — `R` itself, one object for the whole program — which
looks like exactly the shared write this needs. It is not: the trace shows that
registration happening with the RIGHT value at each call (`2027 := i32`, then
`2027 := Pair`). Correct, per call, and not the leak. The next section names the
writer that is.

Worth keeping in view anyway, because the same file carries the ANTIDOTE
pattern with the rationale already written out ("This call now OWNS `flabel`:
drop any resolution a PREVIOUS call left … TS mints a fresh SomeType per call
for every forall binder") — the mechanism a real fix should copy, applied to the
channel that actually carries the stale value.

### The writer, named

Two fixes were tried against the two channels above and BOTH were measured to
be no-ops for this shape — recorded so nobody spends the builds again:

* draining the SomeT's per-lineage `resolved_concrete` cell at the point where
  a call takes ownership of its forall binder. The trace says
  `[own] flabel=T id=1708 cell=0` — by then the cell on the object the clear
  can reach is already EMPTY, so there is nothing to drain. The stale value is
  not there.
* snapshotting the io.async action closure's result into a per-generation cell
  at the call. It returns "nothing to pin": at generation 0 the result does not
  resolve at all yet.

Tagging all fifteen `register_some_resolved_concrete` call sites named the real
writer, and it is none of them — the line is emitted by the ONE untagged site,
`_resolve_some_types_deep` (`src/evaluator/types/function.yo`, the nested
wrapper loop). It resolves a nested SomeT **by NAME** out of the env chain
(`get_value_of_some_type_from_env`) and registers what it finds whenever the
resolution came from the env:

```
[own] flabel=T id=1708 cell=0     <- this call takes ownership of T
[src-] 1708                        <- registry entry dropped
[src+] 1709 := Io
[src+] 1708 := i32                 <- re-registered from the ENV, i32 = call 1's R
[fid-src] closure_...000001        <- and only THEN is generation 1 minted
```

So the stale datum is a `T := i32` VARIABLE BINDING left in the env chain by the
previous call, in a frame the per-call ownership rebind does not shadow. That is
the same poison path `calls/helper.yo` already documents for
`evaluate_function_parameter_type_again` ("the re-evaluation reads `T`/`E` BY
NAME from the shared mutable env chain, concretizing the action closure's
expected with a SIBLING call's resolution") and works around with
`use_param_type_directly`; `_resolve_some_types_deep` has the same read and no
such guard. `io.async` is declared in the PRELUDE, whose env is cached for the
whole program, which is why the binding outlives the call.

### MEASURED 2026-09-13: there are TWO `T`s, and the freshened one is correct

Candidate 0 below (probe the env the resolution reads) was run. It does not
implicate the caller-vs-callee env at all — every resolution reads the same
module env (`frames=2`). What it shows instead is that **two distinct SomeTs
named `T` are live**, and only one of them tracks the call:

```
call 1 (i32)                            call 2 (Pair)
[envres] T id=1712 -> i32  from_env=1   [envres] T id=1712 -> Pair from_env=1   <- freshened: CORRECT
[envres] T id=1708 -> i32  from_env=0   [envres] T id=1708 -> i32  from_env=1   <- declared:  STALE
                                        [envres] R id=2027 -> Pair from_env=0   <- correct, via the registry
[fid-src] closure_…000000               [fid-src] closure_…000001
```

`1712` is the per-call binder `_freshen_io_builtin_callee` mints; it resolves
i32 then Pair, exactly right. `1708` is io.async's DECLARED `T`; it resolves
i32 both times, and at the second call it comes back `from_env=true` — a stale
concrete binding the env still carries, confirmed for an id that never owned it.

So the freshening machinery WORKS and the defect is that something still
resolves the DECLARATION's `T` instead of this call's freshened one. That
reframes the fix and shrinks it: rather than teaching the resolver to reject a
stale binding (candidate 1, which needs a new `VariableRare` channel), find the
path that still reaches for `1708` after `_freshen_io_builtin_callee` produced
`1712`, and have it use the freshened binder. Both are still worth listing, but
this ordering is now evidence-backed rather than a guess.

Note also what is NOT wrong: `R` (the enclosing generic's binder, id 2027)
resolves correctly at both calls — i32 then Pair — via the registry, not the
env. Earlier drafts of this document suspected `R`; it is fine.

### MEASURED 2026-09-13: it is a LAG BY ONE, not a clobber

Two Ts was the right observation and the wrong frame. Extending the reproducer
from two instantiations to **three** turns a symptom that reads like
"last writer wins" into one that cannot be: with three, the answers are neither
all-the-same nor reversed, they are **shifted by exactly one**.

`three_t.yo` — the closure-param reproducer with a third instantiation:

```rust
Pair :: struct(lo : i32, hi : i32);
Trip :: struct(a : i64, b : i64, c : i64);
wrap2 :: (fn(generic(R : Type), f : Impl(Fn() -> R), io : Io) -> Impl(Future(R, Io)))(
  io.async((io : Io) => f())
);
main :: (fn(io : Io) -> unit)({
  a := io.await(wrap2(() => i32(7), io), io);                        // T0 = i32
  b := io.await(wrap2(() => Pair(lo : i32(3), hi : i32(4)), io), io); // T1 = Pair
  c := io.await(wrap2(() => Trip(a : i64(1), b : i64(2), c : i64(3)), io), io); // T2 = Trip
});
```

**What is CORRECT in the emitted C**, and worth stating because it rules out a
whole family of guesses: the three `wrap2` specializations exist, are named for
their own `T` (`..._i32_...`, `..._Pair_...`, `..._Trip_...`), and each captures
the right user closure — the `f` parameter is paired correctly with its
generation every time. The three async generations exist as
`closure_…000000/1/2` in source order, and each one's capture holds the matching
`f`. Nothing is collapsed and nothing is mispaired.

**What is wrong** is only the TYPE each generation is rendered with:

| generation | captures `f` returning | its `T` should be | local temp + prototype say | its sm struct's `result` says |
| --- | --- | --- | --- | --- |
| `…000000` | i32 (call 0) | i32 | **Trip** (T2) | int32_t — correct |
| `…000001` | Pair (call 1) | Pair | **i32** (T0) | **int32_t** (T0) |
| `…000002` | Trip (call 2) | Trip | **Pair** (T1) | **Pair** (T1) |

Read the last two columns as permutations of `[T0, T1, T2]`:

- local temp + prototype: `[T2, T0, T1]` — gen *k* gets `T(k-1 mod 3)`, a lag of
  one **with wraparound**.
- `sm->result`: `[T0, T0, T1]` — gen *k* gets `T(k-1)`, a lag of one **clamped**
  at the first call (which is therefore right by position, not by luck).

A shared cell with last-writer-wins gives `[T2, T2, T2]`. A first-writer-wins
memo gives `[T0, T0, T0]`. A reversed list gives `[T2, T1, T0]`. **None of those
is what is there.** Two independent channels both lag by exactly one call, which
is the signature of a value being READ before the current call's stamp is
WRITTEN — each read sees the previous call's stamp — rather than of two
generations racing for one slot.

That also explains why the two-instantiation reproducer was so misleading: at
n = 2 a lag-by-one and a swap and a reversal are the same permutation. The
third instantiation is what separates them, and it is cheap — this table came
from one `--emit-c` run, no compiler instrumentation.

**The method, worth reusing.** Several mechanisms predicted the n = 2
observation equally well — last-writer-wins on a shared registry key, a
reversed list, a swap — so the evidence could not choose between them, and no
amount of instrumenting the *suspected* site would have helped: each theory
points at a different site. Extending the OBSERVATION until the candidates
disagree is what settled it, and it cost one recompile of a twelve-line
program. Reach for that before reaching for a probe whenever two or more
mechanisms fit the data.

It equally explains the `[bridge]` framing being the wrong place to look first:
a bridge that copies the right value at the wrong TIME produces exactly this,
and so does a correct bridge reading a registry that is one stamp behind. The
question to answer next is therefore **ordering**, not keying: which of the
stamp sites runs after the read that consumes it.

### DISPROVEN 2026-09-13: the two wrapper bridges are a stale WRITE, not the cause

The lag pointed straight at `_evaluate_funcval_runtime_call`'s post-specialization
re-bridge, and instrumenting it looked damning. At all three calls
`resolved_ret` is **correct** — `Future(i32)`, `Future(Pair)`, `Future(Trip)` —
while `rb_binfo.ty`, the stamp on the specialization's own body expr, reads
`Future(i32)`, `Future(i32)`, `Future(Pair)`: lagged by one, and
`_with_resolved_concrete` then overwrites the correct value with it. So the
comment above that bridge ("the spec's body is a fresh-id clone with its own
stamp") is FALSE for this shape — the clone shares the original's body expr id,
and the stamp is written after the bridge reads it.

That write is genuinely stale. **It is also inert here**, which is the part that
matters. Guarding BOTH bridges — skip when the call already resolved a concrete
future output, so the bridge can only supply what is missing and never contradict
what is present — produces emitted C that is **identical** for the three-T
reproducer: prototypes still `[T2, T0, T1]`, definitions still `[T1, T0, T1]`,
same 9 C errors. `check ./src` 275/275 and `check ./std` 175/175 stay green and
both known-good shapes still pass, so the guard is harmless; it is simply not a
fix, and it was reverted rather than landed on the strength of a plausible story.

**What codegen actually reads.** The closure generations are separate FuncVals
with distinct func_ids (`closure_yo_id_<fid>000000/1/2` — the generation suffix
is part of the id), so `function_c_name` gives each its own C name, and the
return type in the PROTOTYPE comes from that fid's REGISTERED `Func` type. The
io.async stamp reads the same place:

```yo
.FuncVal(__fvd2, _) => match(
  get_func_type(__fvd2.*.func_id),
  .Func({ result : rr }) => if(!(is_some_type(rr)), {
    register_some_resolved_concrete(oid.clone(), rr.clone());
  }),
```

— it takes the closure's registered result and publishes it as the future
OUTPUT's concrete under the freshened output id `oid`, which is what every
`io.await` then resolves through. So the prototype, the body's local temp and
the state machine's `result` field all descend from **one** value, which is why
all three lag together instead of disagreeing three different ways. Any fix that
does not correct that registration is patching a downstream copy.

**The question left is two-valued**, and one probe at that stamp site settles it:

1. the REGISTRATION lags — generation *k*'s fid is registered with `T(k-1)`; or
2. the READ is of the wrong generation — call *k* reaches `get_func_type` with
   generation *k-1*'s fid.

(2) is not idle: yo-self mints a per-reference FuncVal GENERATION with a fresh
func_id on re-evaluation, so a call holding the FuncVal it evaluated BEFORE the
newest mint would produce exactly this. Against it: the emitted C pairs every
generation with the correct `f` closure, so the argument side is not stale.

### ROOT CAUSE, MEASURED 2026-09-13: one shared binder id, and a cell that lags it

A probe on the two registration sites — `register_some_resolved_concrete` at
`check_and_add_argument`'s Fn-bound result (`src/evaluator/calls/helper.yo`)
and `register_func_type` at the closure re-registration
(`src/evaluator/values/anonymous_function.yo`) — produces this ledger for the
three-T reproducer, in evaluation order:

```
[closure-rereg] fid=closure_…13068471…000000  body_ty=i32     <- the user closure f0
[fnres-reg]     fn_res_id=2027 <- i32          closure_fid=f0
[closure-rereg] fid=closure_…74814973…000000  body_ty=Pair    <- the user closure f1
[fnres-reg]     fn_res_id=2027 <- Pair         closure_fid=f1
[closure-rereg] fid=closure_…54161240…000001  body_ty=i32     <- ASYNC GEN 1  (lagged)
[closure-rereg] fid=closure_…11628041…000000  body_ty=Trip    <- the user closure f2
[fnres-reg]     fn_res_id=2027 <- Trip         closure_fid=f2
[closure-rereg] fid=closure_…54161240…000002  body_ty=Pair    <- ASYNC GEN 2  (lagged)
```

Three facts, each of which the emitted C then follows exactly:

1. **`fn_res_id` is 2027 at all three calls.** That is `R` from `wrap2`'s
   DECLARED `f : Impl(Fn() -> R)`. The declaration is evaluated once, so every
   call registers its concrete against the SAME id: `i32`, then `Pair`, then
   `Trip`, last write winning. There is no per-call identity here at all —
   `_freshen_io_builtin_callee` freshens io.async's OWN `T`/`E`, and nothing
   freshens the USER function's forall binder reached through a closure param.

2. **Async generation 0 is never re-registered.** It has no `[closure-rereg]`
   line — grep count 0. At the first call `R` is still abstract, the site's
   `has_some == 0` gate rejects the body type, and no per-generation type is
   recorded. So gen 0 has nothing of its own and resolves `R` through the
   shared registry, which by emission time holds the LAST write, `Trip`.

3. **Generations 1 and 2 are re-registered one call behind.** Gen 1's body
   types `i32` even though 2027 already held `Pair` when it ran, and gen 2's
   types `Pair` after 2027 held `Trip`. So the body evaluation is NOT reading
   the registry — it reads the SomeT's own per-object `resolved_concrete` cell,
   which `resolve_some_type_to_concrete` consults FIRST and which is stamped on
   a different schedule. The cell trails the registry by exactly one call.

That reproduces the observed prototypes `[T2, T0, T1]` term for term: gen 0
takes the registry's final `Trip`, gen 1 its own recorded `i32`, gen 2 its own
recorded `Pair`. The apparent "rotation" was never a rotation — it is one
shared-id last-write (gen 0) sitting next to two one-step-stale cells.

**So the two channels disagree, and which one you read decides which wrong
answer you get.** Both are wrong for the same underlying reason: the binder has
no per-call identity. The registry answers "the last call's T" and the cell
answers "the previous call's T"; neither can answer "this call's T", because
there is only one `R` object for every instantiation.

**That makes the fix structural, not a guard.** The two bridges and the
`has_some == 0` gate are all downstream of a binder that cannot distinguish
calls. The direction this points at is candidate 3 below — per-call identity for
the callee's forall binders, the thing `_freshen_io_builtin_callee` already does
for io.async and which the method-call path gets for free (it reads the
SPECIALIZATION's own body, a genuinely fresh clone, which is why that one shape
works). Extending freshening from the io.async builtin to any generic callee
whose return mentions its own binder is the shape of the fix; the obstacle in
candidate 3 — names compared as data in `_skip_fallback`, the reserved `"Impl"`,
and the `fv_mn == flabel` forall-label match — is what has to be solved to get
there, and it is now the ONLY thing between this defect and `spawn_blocking`.

### DISPROVEN 2026-09-13: making the two channels AGREE is not the fix

The obvious reading of the root cause is "two channels disagree, so stamp them
in lockstep". It was built: at the `check_and_add_argument` Fn-bound
registration, drain the SomeT's per-lineage `resolved_concrete` cell and push
the same concrete the registry is about to receive, so the cell can no longer
trail it.

It MOVES the result — the three-T reproducer goes from 9 C errors to 8 — and it
is still wrong, which is the useful part: agreement is not identity. Both
channels are keyed on ONE id for every instantiation, so making them agree only
means both now answer "the LAST call's R" instead of one answering that and the
other "the previous call's". Any fix that leaves the key shared is choosing
which wrong answer to get.

### DISPROVEN 2026-09-13: freshening the callee TYPE at the call is not enough

The structural direction below (per-call identity for the callee's own forall
binders) was implemented at what looked like the right place — the FuncVal arm
of `evaluate_function_call`, where `callee_info_opt.ty` is first taken, ahead of
the parameter types, the forall list and the declared result, and therefore
ahead of parameter binding. The freshened type flows into `fv_param_types`,
`ret_type`, `callee_func_type_opt` and so into `spec_ct`, the type
`create_specialized_function_inline` specializes against.

It FIRES, verified rather than assumed — a `YO_DEBUG_FRESHEN` trace prints one
`[freshen-callee]` line per call, three for the three-T reproducer — and the
emitted C is **byte-identical** to the baseline apart from the `break;` lines
#661 added. A probe at the registration site says why:

```
[freshen-callee] fn(generic(R) f : Impl : (Fn() -> R), io : Io) -> Impl : (Future[Future](R) Io : Io)
[fnres-reg] id=2027 <- i32
[freshen-callee] ...
[fnres-reg] id=2027 <- Pair
[freshen-callee] ...
[fnres-reg] id=2027 <- Trip
```

`2027` is the DECLARED `R`, at all three calls — exactly the baseline ledger.
So the freshened binder never reaches the site that publishes the concrete.

**Two candidate reasons, and they are separable.** `substitute` matches a
`SomeT` by **(name, frame_level)** (`subst_lookup`, `src/types/substitution.yo`),
while `_freshen_io_builtin_callee` builds its substitution from the entries of
the declaration's own `forall_types`. If `R`'s occurrence inside the parameter's
`Fn` bound does not carry the same `frame_level` as that entry, the substitution
silently misses precisely the occurrence that matters, and a type that "was
freshened" comes back unchanged where it counts. The other candidate is
`create_specialized_function_inline`'s deliberate override
(`decl_pt = rp_ae.parameter_type`, `src/evaluator/calls/helper.yo`), which
replaces the declared parameter with the CALL's recorded one whenever that still
carries an Fn-trait carrier — if the recorded one descends from the unfreshened
declaration, per-call identity is dropped there instead.

Note what this does NOT disprove: the direction. It says the surgery is in the
wrong PLACE or the wrong MECHANISM, not that per-call identity is the wrong
answer. Whichever candidate holds, the lesson generalises — **a freshening built
on a name-keyed substitution is only as per-call as its key**, and this codebase
has already been bitten once by comparing binders by name (the ID-vs-name table
above).

### What to try next, and the obstacle each candidate hits

Not another name-based special case — that is what the first cut of the
value-param fix got wrong (see the ID-vs-name table above). Three candidates,
each read far enough to name what stands in its way, so the next attempt starts
from a design rather than a hunt.

**The shape of the problem.** TS gets per-call identity for free: it mints a
fresh `SomeType` OBJECT per call and identity is the object. yo-self's env is
keyed by NAME, so a per-call freshened binder (`_freshen_io_builtin_callee`
mints a fresh id) is still looked up by the name `T` — and finds whatever the
previous call bound under that name. Every candidate below is a different answer
to "how does a name-keyed env carry per-call identity".

0. **DONE — and it refuted itself; see the measurement above.** The original
   text is kept because the refutation is the useful part:
   `_resolve_some_types_deep` is called at the three stamp sites with
   `call_result_*.caller_env` ("Resolve through the CALL's env, where the
   enclosing specialization binds the binder concretely"). That is the right
   env for the ENCLOSING function's binder. It is NOT obviously the right env
   for the CALLEE's own forall `T`, which `try_to_call_function_with_arguments`
   binds into `callee_env` — where Step 6's per-call marker lives. A by-name
   read of `T` against the CALLER's chain cannot see that marker and can see a
   previous call's concrete binding instead, which is exactly the observed
   shape. Cheapest to falsify: print the env identity (module path + frame
   count) at the `nres_from_env` registration and compare it with the env Step 6
   bound the marker into. If they differ, the fix may be as small as resolving
   a callee-owned binder against the callee env, and candidates 1-3 below are
   not needed.

1. **Make the READ identity-aware.** `_do_chain_resolve`
   (`src/types/env_lookup.yo`) ALREADY guards this: a concrete resolution is
   adopted only if `_was_self_bound(env, name, id)` — did this env ever bind
   this NAME to a SomeT with THIS id. A freshened binder was never self-bound,
   so that guard correctly says no. The hole is the fallback right after it:
   `_def_frame_confirms_binding` is **id-blind** — it looks up the definition
   FRAME for the name, finds a concrete type, and confirms on
   `type_to_string` equality. A freshened SomeT copies the original's
   `frame_level`, so it inherits the previous call's binding through exactly
   that fallback. *Obstacle:* the fallback exists because "the self-referential
   marker is gone once `synthesize_types` rebinds the variable to the concrete
   type" — by then the id is no longer recoverable from the env, so making it
   id-aware needs a new channel recording WHICH SomeT id a concrete binding was
   made for. The place for that channel is `VariableRare` (`src/env.yo`), the
   existing bag for infrequently-used `Variable` fields, set by
   `_bind_some_type`; `_def_frame_confirms_binding` would then need a
   `_lookup_by_frame` variant that returns the VARIABLE rather than its
   TypeValue, and must fall back to today's behaviour when the field is unset
   or it will over-reject every binding made by a site that does not set it.
   Bounded, but not a one-liner.

2. **Do not let a freshened binder claim the declaration's frame.** If
   `_freshen_io_builtin_callee`'s fresh SomeTs carried no `frame_level` (or a
   per-call one), `_def_frame_confirms_binding` would return `false` for them
   via its own `_some_frame_level` → `.None` early-out, and candidate 1's hole
   closes with no new channel. *Obstacle:* `frame_level` is load-bearing for
   `_lookup_by_frame` elsewhere; this needs the def-frame consumers audited
   before it can be called safe.

3. **Per-call NAMES, not just per-call ids.** The honest translation of TS's
   object identity into a name-keyed env. *Obstacle:* names are compared as
   data in several places — `_skip_fallback`'s `_nsn == "E"`, the reserved
   `"Impl"`, and the forall-label match `fv_mn == flabel` in
   `try_to_call_function_with_arguments`, whose labels come from the FuncVal's
   `forall_names` rather than from the type. Renaming the type's binders alone
   desynchronises that match.

The A/B for any of them is the four-program table above: the method-call form
must keep working and the other three must start. Gate with `check ./src` and
`check ./std` FIRST — both are minutes, and this is the hottest type-resolution
path in the evaluator, so an over-narrowed guard shows up there long before the
suite.

`std/thread.yo`'s `spawn_blocking` has exactly this shape, which is why waker
step 5 (`plans/WAKER_BASED_SCHEDULING.md`) is not landed with it.

## What is NOT the trigger

Measured, one variable at a time — none of these makes it pass:

* free function vs impl method;
* a generic receiver (`Box3(U)`) vs a concrete one;
* `Impl(Future(T))` vs `Impl(Future(T, Io))`;
* a bare tail vs an explicit `return(r)`;
* a by-value closure param vs `inout`;
* the definition living in another module;
* result types `i32`+struct vs `i32`+`String`;
* an `io.await` inside the async body vs none (it changes WHICH error, not whether there is one).

## What DOES pass, and is the lead

`std/async/mutex.yo`'s `with_lock`:

```rust
with_lock : (fn(generic(R : Type), self : Self,
                body : Impl(Fn(inout(v) : T) -> R), io : Io) -> Impl(Future(R)))(
  io.async((io : Io) => {
    io.await(self.lock(io), io);
    r := body(self._value);
    self.unlock();
    return(r);
  })
)
```

called twice on ONE `Mutex(i64)` with an `i64` body and a `String` body compiles
and runs (`tests/async_mutex.test.yo`, and standalone). Its history is
`issues/fixed/future-wrapper-return-shared-across-specializations.md` — the
same class, fixed in 2026-08-30 for the valueless-closure-callee stamp sites by
resolving `ret_type_rt` through `_resolve_some_types_deep(_, caller_env)`
before stamping. So a correct path EXISTS; the reproducers above take a
different one. Finding what `with_lock` does that the reproducers do not is the
whole of the remaining work — the list above is what it is NOT.

## Re-instrumenting this, if it ever comes back

The fix ships ONE trace, behind `YO_DEBUG_FRESHEN`, inside
`_freshen_generic_closure_callee` — it prints the callee type and the binder ids
before and after freshening, which is what separates "the freshening ran" from
"the freshening did anything". The other two probes that cracked this were
deliberately NOT shipped: both sit on the compiler's hottest path, and neither
file is otherwise touched by the fix. Re-add them the same way if needed:

* `src/evaluator/calls/helper.yo`, at the Fn-bound registration inside
  `create_specialized_function_inline` — print `fn_res_id` and the concrete it
  is about to be registered with. One line per closure-param specialization;
  this is the ledger that shows whether the id is per-call or shared.
* `src/evaluator/values/anonymous_function.yo`, just before
  `register_func_type` — print the func_id and `body_ty`. This is what shows an
  async generation being re-registered one call stale, and which generations get
  no registration at all.

If you do, cache the env lookup in a module-level `bool` the way
`_g_anon_dbg_swallow` already does in that file, rather than calling
`dbg_env.get(...)` per specialization.

## Impact — was the last blocker on the std API campaign

`std/thread.yo`'s `spawn_blocking` was correct and worked at one instantiation
per program; a second `T` in the same program miscompiled. That is why it was
not exported. It is exported now, and `tests/spawn_blocking.test.yo` — live
from `issues/repros/spawn-blocking-tests.yo` — uses two different `T`s
precisely because that pair is what used to break.

`spawn_blocking` needed the THIRD layer of this fix to work — see "The trap
inside Bug 1's fix" above. Every reproducer written for this issue named its
binder `R`; `spawn_blocking` names it `T`, and that was the difference.

Promoting that parked file surfaced a second, unrelated defect worth naming
here because parking is what hid it: two of its four tests used
`io.await(handle, io)` on an `io.spawn` result, which does not type-check —
`io.spawn` returns a JOIN HANDLE, awaited as `handle.await(io)` and yielding
`Option(T)`. The compiler reports that as an INTERNAL COMPILER ERROR
(`issues/io-await-on-a-join-handle-is-reported-as-an-internal-compiler-error.md`).
Both were invisible for as long as the file sat outside every gate. **A test
that has never once been run is a draft**, however well argued — parking it
next to the code is not the same as keeping it honest.
