# The verifier walks past a `panic`, so a diverging path refutes `ensures` or emits an ill-sorted term

**Severity:** S2 — valid verified code whose only failing path ends in `panic(...)` is reported `refuted` (with a counter-example that takes the panic path) or `solver-error`, although the docs list `panic` paths as verified.

**Status:** open. **Found:** 2026-11-04 by the Ada/SPARK lessons audit (`plans/backlog/ADA_SPARK_LESSONS.md`), reproduced on a tree binary of develop `8559f3a26` with the pinned Z3 5.1.0.

## Reproducer

```yo
pragma(Pragma.Verify);
{ panic } :: import("std/assert");

// Statement position: the panic arm is the only path where r <= 0.
k2 :: (fn(x : i32, ensures(r > i32(0))) -> (r : i32))({
  if(x <= i32(0), {
    panic("reachable");
  });
  x
});

// Value position, i32-sorted sibling arm.
k3 :: (fn(x : i32, ensures(r > i32(0))) -> (r : i32))(
  cond(
    (x > i32(0)) => x,
    true => panic("neg")
  )
);

// Value position, bool-sorted sibling arm.
kb :: (fn(x : i32, ensures(r == false)) -> (r : bool))(
  cond(
    (x > i32(0)) => panic("pos"),
    true => false
  )
);
```

`yo verify` reports:

```
refuted  k2 — ensures#0: REFUTED  counter-example: x = #x00000000
solver-error  k3 — ensures#0: SOLVER-ERROR  z3 rejected the script: (error "line 8 column 110: Sorts (_ BitVec 32) and Bool are incompatible")
refuted  kb — ensures#0: REFUTED  counter-example: x = #x00000001
```

Every counter-example is an input that takes the panic path, where the function never returns, so `ensures` is vacuous there.

## Root cause

`src/verifier/vc.yo` (~L4634), the `panic` case of the expression walk:

```yo ignore
if(head == "panic", {
  // Diverging path — contributes nothing (SPARK's stance).
  return(Option(VcTerm).Some(Rc.new(VcTermNode.BoolLit(true))));
});
```

A diverging call is given the VALUE `true` and the walk continues:

- in statement position the path condition is not cut, so the code after the `if` is reached with `x <= 0`;
- in value position `true` is merged with the sibling arm's value: an ill-sorted `ite` for an `i32` arm (k3), and a wrong `true` result for a `bool` arm (kb).

The docs claim the opposite (`docs/en-US/FORMAL_VERIFICATION.md` subset table: "`panic` paths ✅ verified"; `plans/backlog/FORMAL_VERIFICATION.md` "`panic(...)` — diverging path: no obligations after it"). The plan text's "SPARK's stance" is also inaccurate: SPARK requires a raise / `pragma Assert (False)` point to be proved unreachable (SPARK UG §5.2.7), it does not merely exempt it.

## Fix direction

- Make `panic` a dead path: assume `false` from that point on the current path (cut the path condition), and in value position give it a fresh unconstrained term of the expected sort so the `ite` stays well-sorted.
- Whether a reachable `panic` should additionally be an obligation (`panic-unreachable`, SPARK's rule) is a separate decision, best decided together with `issues/questions/2026-10-14-overflow-trap-freedom-as-a-default-obligation.md`. Under partial correctness the dead-path fix alone is the sound minimum.
- Fixture set: `valid/panic_paths.yo` (k2, k3, kb proving) plus a bugged twin whose non-panic path violates `ensures`, so it must still refute. Correct the two doc sentences.
