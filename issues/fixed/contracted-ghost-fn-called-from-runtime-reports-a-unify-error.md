# A contracted `ghost_fn` called from a runtime body reports an internal unify error

**Status:** FIXED 2026-09-19. Surfaced by the
`plans/backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md` B2 task-1 probe.

**Fix:** `src/evaluator/calls/function.yo` — the ghost-context guard now calls
`flag_flow_violation(...)` before it throws, so the def-time trial swallow
re-raises that diagnostic instead of discarding it. Same contract the
non-callable-argument rejection in the same file already used.

**Reproducer:** `issues/repros/contracted-ghost-fn-runtime-call.yo`
**Fixtures:** `tests/spec/fixtures/negative/ghost_fn_contracted_runtime_call.yo`,
`…_quiet.yo`, `tests/spec/fixtures/valid/ghost_fn_contracted_ghost_call.yo`

## The error

```
error: Cannot unify incompatible types: "unit" and "i32"
   --> issues/repros/contracted-ghost-fn-runtime-call.yo:22:29
   |
22 |   (fn(x : i32, requires(x > i32(0)), ensures(result > i32(0))) -> (result : i32))({
   |                             ^^^
```

The caret is on the `i32` inside the definition's **own `requires` clause**. Nothing
is wrong there: the same clause verifies cleanly when the function is not called
from a runtime body.

## What should happen

`g` is a `ghost_fn`, so a call from a runtime body is illegal by design, and the
evaluator already has the right diagnostic for it
(`src/evaluator/calls/function.yo:4698`):

```
error: a ghost_fn is callable only from ghost context (contract clauses,
       ghost(...) bindings, ghost_fn bodies) — it has no runtime semantics
```

That is exactly what an **uncontracted** `ghost_fn` produces, anchored at the call.
Adding contract clauses to the signature replaces a correct, actionable error with
an internal type-checker failure pointed at the wrong line — and at a construct
the author wrote correctly.

## Measured boundary

Each row is one file, `yo check` with `pragma(Pragma.Verify)`. Only the second
row misbehaves.

| `ghost_fn`? | contracts? | called from | result |
| --- | --- | --- | --- |
| yes | no | runtime body | intended "callable only from ghost context", anchored at the CALL |
| **yes** | **yes** | **runtime body** | **`Cannot unify … "unit" and "i32"`, anchored at the DEFINITION** |
| yes | yes | `ghost(v := g(n))` | verifies; both fns `ok` |
| yes | yes | another fn's `ensures(... g(n))` | verifies; both fns `ok` |
| yes | yes | not called | verifies; `ok`, 1 obligation proved |
| no | yes | runtime body | verifies; `ok` (control — everyday contracted call) |

So the trigger is the conjunction: **`ghost_fn` wrapper + contract clauses + a call
from a non-ghost body.** Either factor alone is fine.

## Root cause

The guard was never missing and the diagnostic was never wrong. **The correct
error is thrown, and then swallowed.**

Instrumenting the guard (`src/evaluator/calls/function.yo`) and running the
reproducer under `YO_DEBUG_SWALLOW=1` shows the whole sequence in three
consecutive lines:

```
[GUARDDBG] call at tmp/bug.yo:2 callee_fid=yo_id_9846…6123000000 is_ghost=true in_ghost_ctx=false
[swallow]  error: a ghost_fn is callable only from ghost context (contract clauses, …)
error: Cannot unify incompatible types: "unit" and "i32"
```

The guard is reached, `is_ghost_fn` is **true**, the context is correctly **not**
ghost, and it throws the right message. But the call is being evaluated inside
`_trial_eval_fn_body`'s def-time swallow, which discards the throw; evaluation
then limps on and some downstream node fails instead. That downstream failure is
what reached the user — anchored at the ghost fn's own `requires` clause, a line
they wrote correctly.

This is the same class as the `ctl`-handler def-eval swallow
(`plans/` C18/C19): a deliberate REJECTION thrown where the trial eval cannot
distinguish it from an unported-feature error. `src/types/flowability.yo` exists
for exactly this — the throwing site flags the violation, and the def-time caller
re-raises the recorded message through the real `exn`. The fix adds that flag,
matching the non-callable-argument rejection a few hundred lines below in the
same file.

### Two hypotheses that were tested and REFUTED

Recorded so they are not tried again.

1. **"`evaluate_ghost_fn` never registers a contracted fn, so `is_ghost_fn` is
   false."** Wrong twice over: the verifier demonstrably *inlines* a contracted
   ghost fn (a caller proves `n >= g(n)`, which needs the body, not the callee's
   `ensures`), and the guard probe prints `is_ghost=true` outright.

2. **"`param_types` arrives empty, so the clause is type-checked with the
   parameter as `unit`."** This was written into an earlier revision of this
   issue as CONFIRMED, on the strength of an operand-order argument — flip
   `x > i32(0)` to `i32(0) < x` and the `unit` follows `x`. The argument was
   plausible and the conclusion was wrong. Instrumenting the site printed
   `labels=1 types=1 result=i32` on the failing path, identical to the passing
   one. The parameter was never mis-typed; the `unit` comes from the value the
   swallowed call left behind.

   The lesson is the one already in the pitfalls list: an error's token says
   nothing about who evaluated it. Two rounds of operand-shape probing produced
   a confident, wrong mechanism, and only instrumentation settled it.

### There is no silent-acceptance case

An earlier revision claimed `requires(x > x)` was "the worse half" — accepted
silently with the parameter mis-typed. That is also wrong. Measured across five
files, the only shapes that misreport are the ones whose clause contains a
literal:

| clause | before the fix |
| --- | --- |
| `requires(x > i32(0))` | `Cannot unify …` — wrong message |
| `ensures(result > i32(0))` | `Cannot unify …` — wrong message |
| `requires(x > x)` | ghost-context error — **correct** |
| `requires(true)` | ghost-context error — **correct** |

A literal-carrying clause gives the swallowed evaluation something downstream to
trip over; without one, nothing else fails and the rejection reaches the user on
the next, non-swallowed evaluation. The illegal call was always rejected — only
the message was wrong. `…_quiet.yo` therefore pins behaviour that already
worked, as a canary against a fix that repairs the noisy path by disturbing the
quiet one.

## Why it matters

B2 (lemmas) makes contracted `ghost_fn`s the normal way to write a spec
function, so this shape stops being exotic. The first mistake a user makes with
a lemma — calling it from real code — was answered with a compiler-internal
message blaming their contract, when the evaluator had the right diagnostic all
along and merely could not get it out.

## Verification

Red-first, with the stock compiler: both negative fixtures reported the unify
error (or, for the literal-free one, already reported correctly), and the valid
fixture was accepted. After the fix, both negative fixtures must report the
ghost-context error and the valid fixture must still verify.
