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

### A hypothesis that was tested and REFUTED

The obvious first guess was that `evaluate_ghost_fn`
(`src/evaluator/builtins/contracts.yo:571`) fails to register a *contracted* fn,
because it registers by reading the inner expression's `ExprInfo.value` and
matching `.FuncVal(gfvd, _)` — leaving `is_ghost_fn` false so the guard cannot fire.

That is wrong. `register_ghost_fn` and `register_ghost_fn_def` sit in the same match
arm, and the def table is what lets the verifier INLINE a ghost fn
(`src/verifier/vc.yo:3817`). In the probe where a caller's contract says
`ensures(result >= g(n))` with `result = n`, the caller verifies `ok` — which needs
`n >= g(n)`, provable only from the inlined body (`g(n) = n`), not from `g`'s own
`ensures` (`result > 0`) treated as an uninterpreted contracted callee. So
registration does happen for contracted ghost fns.

### The current, better-supported hypothesis

The message is `Cannot unify incompatible types: "unit" and "i32"` with the caret on
the `i32` of `i32(0)` inside `requires(x > i32(0))` — that is, *expected* `unit`,
*given* `i32`, at the right-hand operand of the comparison. The reading that fits the
caret is that **`x` is bound to `unit`** when the clause is re-evaluated, so `x >
i32(0)` unifies `unit` against `i32`. A parameter binding going to `unit` is what a
call-time re-binding with no arguments would produce — and `ghost_fn`s legitimately
have no runtime arguments to pass.

This is still a hypothesis. It has not been confirmed against the code, and the
previous one looked at least as good before it was tested. Confirm it — by finding
which binder re-binds the callee's parameters on this path and what it binds `x` to
— before writing any fix.

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
