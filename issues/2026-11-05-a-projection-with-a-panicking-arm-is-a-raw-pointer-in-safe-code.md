# A projection whose `cond`/`match` has a panicking arm is "a raw pointer value" in safe code

**Severity:** S2 — a valid program is rejected: a safe file cannot write a `-> &T` projection with a `panic` arm (`Option::expect`'s shape), which std (an unsafe-capable tree) can.

Found while giving `OnceCell(T).get_or_init` Rust's `-> &T` result
(the `OnceCell` move-only read S2 filed on `vbd/v5-part-b-tests`),
on develop 68b45b81d. It is not caused by that work: develop rejects the reproducer too.

## Symptom

```yo ignore
_Slot :: struct(ok : bool, d : String);
impl(
  _Slot,
  value : (fn(self : &Self) -> &String)(
    cond(self.ok => &self.d, true => panic("_Slot: not ok"))
  )
);
```

```
error: Raw pointer values are not available in safe code: 'cond((self.ok) => addr_of((self.d)), true => panic("_Slot: not ok"))' has type '*(String)'.
```

Reproducer: `issues/repros/2026-11-05-a-projection-with-a-panicking-arm-is-a-raw-pointer-in-safe-code.yo`.
The same projection without the `panic` arm (`cond(self.ok => &self.d, true => &self.e)`)
compiles, and so does the `match(&self.v, .Some(s) => &s.*, .None => &self.d)` form.

## Where to look

A projection lowers its result to a pointer, and the safe-code gate in
`_evaluate_expression_raw_wrapper` (`src/evaluator/exprs/_expr.yo`) exempts a projection's
result through `_is_projection_result_value`. That predicate accepts a `cond`/`match` whose
every arm is a projection tail or has type `never`. The `panic(...)` arm evidently does not
read as `never` there, so the whole `cond` is judged a raw pointer value. The arm's
recorded `ExprInfo` (or the node the predicate looks it up by) is the first thing to probe.

## Test

The fix adds the reproducer's shape as a test case (a `-> &T` projection with a `panic` arm
in a safe test file) and moves this doc to `issues/fixed/`.
