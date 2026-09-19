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
   --> issues/repros/contracted-ghost-fn-runtime-call.yo:18:41
   |
18 | g :: ghost_fn((fn(x : i32, requires(x > i32(0)), ensures(result > i32(0))) -> (result : i32))({
   |                                         ^^^
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
- **The failure is in the DEFINITION, forced by the call.** The anchor is the
  definition's clause while the call is elsewhere in the file, and the file
  evaluates cleanly when the call is removed. Consistent with lazy top-level
  bindings (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`): the runtime call forces `g`,
  and the forcing is what fails.
- **It is not about which context forces the def first.** Adding an earlier
  *ghost* use (another fn's `ensures(... g(n))`, which forces `g` in ghost
  context) does not change the error — the later runtime call still fails.
  So this is not a first-force-wins ordering effect.
- **The ghost guard is never reached.** The guard at `function.yo:4693` sits before
  the arity check in the `.FuncVal` arm, yet a *wrong-arity* contracted call
  reports the unify error rather than either the ghost error or an arity error.
  So control does not get as far as that arm with `is_ghost_fn` true.

**Leading hypothesis, NOT yet confirmed:** `evaluate_ghost_fn`
(`src/evaluator/builtins/contracts.yo:571`) registers the callee by reading the inner
expression's `ExprInfo.value` and matching `.FuncVal(gfvd, _)`. If a *contracted*
fn does not present a plain `.FuncVal` there, `register_ghost_fn` never runs,
`is_ghost_fn` is false, the guard cannot fire, and the call proceeds down the
ordinary runtime-call path — where the signature's clause entries are what fails
to unify. This needs confirming against the code before any fix; the alternative
is that registration succeeds and the divergence is further down the call path.

## Why it matters

B2 (lemmas) makes contracted `ghost_fn`s the normal way to write a spec function,
so this shape stops being exotic. Until it is fixed, the first mistake a user makes
with a lemma — calling it from real code — is answered with a compiler-internal
message that blames their contract.

## Fixing it

No workaround: do not special-case the message. Establish why the contracted
`ghost_fn` misses `is_ghost_fn`, fix the registration (or the path that bypasses
the guard) so the guard fires, and keep the existing diagnostic.

Tests to add with the fix:
- `tests/spec/fixtures/negative/ghost_fn_contracted_runtime_call.yo` — the reproducer;
  must report the ghost-context error anchored at the call.
- The uncontracted sibling stays as the canary that the message did not move.
