# A contracted `ghost_fn` called from a runtime body reports an internal unify error

**Status:** OPEN — surfaced 2026-09-19 by the `plans/backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`
B2 task-1 probe (does a contracted `ghost_fn` register a `VerifyTask`?).

**Reproducer:** `issues/repros/contracted-ghost-fn-runtime-call.yo`

```
yo check issues/repros/contracted-ghost-fn-runtime-call.yo --std-path ./std
```

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

## What is established about the cause

- **It is an evaluator bug, not a verifier bug.** Plain `yo check` fails identically;
  it does not need the solver.
- **It needs `pragma(Pragma.Verify)`.** Remove the pragma and the same file reports
  the intended ghost-context error at the call. So it is the clause processing that
  Verify mode turns on — not the `ghost_fn` wrapper by itself — that diverts control.
- **The failure is in the DEFINITION, forced by the call.** The anchor is the
  definition's clause while the call is elsewhere in the file, and the file
  evaluates cleanly when the call is removed.
- **It is not about which context forces the def first.** Adding an earlier *ghost*
  use (another fn's `ensures(... g(n))`, which forces `g` in ghost context) does not
  change the error — the later runtime call still fails. Nor is it about definition
  order: moving `g` below its caller gives the same error.
- **It is not about the inline function-type expression, nor the named result.**
  `g :: ghost_fn(gimpl)` over a separately named contracted `gimpl` fails the same
  way (anchored at `gimpl`'s clause), and so does a `-> i32` signature with no
  `(result : …)` name.
- **The ghost guard is never reached.** The guard at `function.yo:4693` sits before
  the arity check in the `.FuncVal` arm, yet a *wrong-arity* contracted call reports
  the unify error rather than either the ghost error or an arity error. Control does
  not get that far.

### CONFIRMED: the parameter is bound to `unit` when the clause is evaluated

The clause is type-checked with `x : unit` instead of `x : i32`. Five files,
each differing from the reproducer in one clause:

| clause | result |
| --- | --- |
| `requires(x > i32(0))` | `Cannot unify … expected "unit", given "i32"` |
| `requires(i32(0) < x)` | `Cannot unify … expected "i32", given "unit"` |
| `requires(x > 0)` | `… expected "unit", given "i32"` — so it is not the `i32(...)` constructor |
| `requires(x > x)` | **no error** |
| `requires(true)` | no error |

The binary operator reports the left operand as *expected* and the right as
*given*. Flip the operands and the `unit` moves with `x` — the literal keeps its
`i32` on both sides. So it is `x`, the parameter, that carries `unit`. The two
quiet rows agree: `x > x` is `unit` against `unit`, which unifies, and
`requires(true)` never mentions `x`.

`requires(x > x)` passing is the **worse half of this bug**: on that path the
clause is silently type-checked against the wrong type for the parameter and
nothing is reported. The loud unify error is only what happens when the other
operand's type disagrees. Any fix needs a canary for the quiet shape, not just
the noisy one — a clause whose operands are both parameters must not go green
for the wrong reason.

The likely mechanism, now narrow enough to check directly, is that the clause
is evaluated in an environment where `x` is not bound, and the evaluator's
soft "variable not found" fallback yields a unit-typed unknown rather than
raising. `wrap_function_body_with_contracts`
(`src/evaluator/calls/function_type.yo:~1008`) splices each `requires`/`ensures`
predicate into the body as an `assert(...)`, so the clause is re-evaluated
somewhere that the ghost path reaches with a different parameter frame than the
ordinary contracted-function path, which handles the identical clause correctly
(the non-ghost control passes).

### A hypothesis that was tested and refuted

Before the table above, the natural first guess was that `evaluate_ghost_fn`
(`src/evaluator/builtins/contracts.yo:571`) fails to register a *contracted* fn —
it registers by reading the inner expression's `ExprInfo.value` and matching
`.FuncVal(gfvd, _)` — leaving `is_ghost_fn` false so the guard cannot fire.

That is wrong. `register_ghost_fn` and `register_ghost_fn_def` sit in the same
match arm, and the def table is what lets the verifier INLINE a ghost fn
(`src/verifier/vc.yo:3817`). In a probe where the caller's contract says
`ensures(result >= g(n))` with `result = n`, the caller verifies `ok` — which
needs `n >= g(n)`, provable only from the inlined body (`g(n) = n`), not from
`g`'s own `ensures` (`result > 0`) treated as an uninterpreted contracted
callee. So registration does happen for contracted ghost fns.

## Why it matters

B2 (lemmas) makes contracted `ghost_fn`s the normal way to write a spec function,
so this shape stops being exotic. Two costs, and the second is the larger one:

1. The first mistake a user makes with a lemma — calling it from real code — is
   answered with a compiler-internal message that blames their contract, when the
   evaluator already holds the right diagnostic.
2. **On that same path a clause whose operands agree is type-checked against the
   wrong parameter type and says nothing** (`requires(x > x)` is accepted with
   `x : unit`). That is a silent wrong answer in the contract machinery, and it is
   only invisible because a mismatched literal usually turns it into the loud
   error above.

## Fixing it

No workaround: do not special-case the message, and do not suppress the unify
error. The parameter must carry its declared type when the clause is evaluated on
this path; with that fixed, the existing ghost-context guard reports the real
problem on its own.

Tests to add with the fix — note that the noisy shape alone is not enough:
- `tests/spec/fixtures/negative/ghost_fn_contracted_runtime_call.yo` — the
  reproducer; must report the ghost-context error anchored at the call.
- A **quiet-shape canary**: a contracted ghost fn whose clause compares two
  parameters (`requires(x > x)`-style, so today it passes for the wrong reason)
  called from a runtime body. It must report the ghost-context error too. Without
  this the fix can be "green" while the parameter is still typed `unit`.
- A **positive canary**: the same contracted ghost fn used from ghost context still
  verifies, so the fix does not close the legal path.
- The uncontracted sibling stays as the canary that the message did not move.
