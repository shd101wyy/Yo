# Verifier: while-exit keeps POST-BODY bindings — zero-iteration exits are mis-modeled (unsound)

- **Status:** FIXED on feat/fv4-loops (V4.2, 2026-09-10) — reproducer, probe
  evidence, and guard fixture below; moving to `issues/fixed/` with the V4.2 PR.
- **Component:** `src/verifier/vc.yo` — `_while_term`, step 3 (exit)
- **Severity:** soundness (false PROOF — the worst direction for a verifier)

## Summary

The V4 havoc-invariant rule's exit step keeps the loop body's **post-body
symbolic bindings** and assumes `Inv ∧ ¬Cond` over them. For a loop that can
exit **without ever running an iteration** (cond false at the first head
check), the concrete post-loop state is the **pre-loop** state — which is in
general NOT representable by the body's output. The pinned post-body bindings
then let the verifier "prove" facts that are false at runtime.

## Reproducer

`tmp/zeroloop.yo`:

```rust
pragma(Pragma.Verify);

pin_exit :: (
  fn(
    x : i32,
    requires(x >= i32(0))
  ) -> (result : i32)
)({
  while(x < i32(0), {
    invariant(x >= i32(0));
    x = i32(5);
  });
  assert(x == i32(5));
  x
});
```

Concretely, `x = 100` satisfies the requires; the condition `x < 0` is false
at the first head check, the body never runs, `x` stays `100`, and the assert
`x == 5` **fails at runtime**.

The verifier's walk: entry proves `Inv(x_pre)` (trivially true); havoc binds
`x ↦ hv` and assumes `Inv(hv) ∧ Cond(hv)` = `hv ≥ 0 ∧ hv < 0` (unsat — the
iterate is vacuous, which is fine); the body rebinds `x ↦ 5`; the exit step
pushes `Inv(5) ∧ ¬Cond(5)` **over the binding `5`**. The assert obligation
`¬(x == 5)` is then evaluated over the binding `5` and is unsat — the
verifier reports the assert **proved**. False positive.

## Probe evidence (pre-fix, tmp/zerodrv.yo + local z3 5.1.0)

The `ensures(result == 5)` obligation for the local-variable shape
(`y := x; while(y < 0, { invariant(y >= 0); y = 5; }); y`) encodes as:

```text
(declare-fun ..._x () (_ BitVec 32))
(assert (bvsge ..._x (_ bv0 32)))       ; requires
(assert (bvsge (_ bv5 32) (_ bv0 32)))  ; Inv over the POST-BODY binding — the literal 5
(assert (not (bvslt (_ bv5 32) (_ bv0 32)))) ; ¬Cond over the literal 5
(assert (not (= (_ bv5 32) (_ bv5 32))))     ; ¬ensures over the literal 5
(check-sat) → unsat  →  "proved"
```

The exit pinned `y` to the body's output `5`; the ensures is `5 == 5`.
Concretely `x = 100` never enters the loop and returns `100` — the proof
is false. (The walk-level repro with `assert(x == i32(5))` on the
parameter form additionally trips a separate walk-generality gap —
"untyped expression" when the while is the body's first statement / the
loop assigns a parameter — tracked separately below.)

## Root cause

`_while_term`'s exit step (vc.yo, "Pop the iterate assumptions; push the EXIT
facts permanently") computes `inv_after`/`cond_after` over the CURRENT
`ctx.vars` — i.e. over the walked body's bindings — and leaves those bindings
in place for everything after the loop. The Dafny/Boogie havoc rule instead
takes the exit facts over an **arbitrary** state: any concrete cond-exit
state satisfies `Inv ∧ ¬Cond`, and nothing more. Pinning the exit state to
the body's output adds the constraint "the exit values equal the last
iteration's computed values", which is false when zero iterations ran (and,
with the V4.2 break extension, also false for break exits).

## Fix

At the exit step, **re-havoc** every assigned name to a fresh unconstrained
constant (a new havoc generation) and assume `Inv ∧ ¬Cond` over the fresh
constants. Post-loop reasoning keeps exactly the invariant-and-negated-cond
facts — the standard modular loop rule — and loses the (unsound) post-body
value pinning. Non-assigned names keep their bindings (the loop cannot
change them). The V4.2 break exit-path disjunction builds on this same
fresh-havoc cond-exit disjunct.

Valid fixtures are unaffected: they reason from `Inv ∧ ¬Cond` facts only
(e.g. `sum_to` derives `i == n+1` from `i ≤ n` (Inv) ∧ `i ≥ n` (¬Cond), then
`acc == i·(i+1)/2` (Inv) — no post-body values needed).

## Verification plan

- `tmp/zeroloop.yo` via the standalone driver (`tmp/zerodrv.yo`): before the
  fix, the `assert` obligation is unsat (proved — WRONG); after the fix it
  must be **sat** (refuted — honest).
- The whole V4/V4.1 valid battery (`loop_invariant`, `loop_decreases`,
  `cond_phi_merge`, `loop_continue`, `recursion_decreases`) must stay proved.
- New negative fixture `tests/spec/fixtures/negative/loop_exit_havoc.yo` +
  a z3-gated REFUTED case in `tests/internal/verifier_loops.test.yo`.
