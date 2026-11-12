# A borrowing future bound with a spelled type is rejected as second-class

**Severity:** S3. `(f : Impl(Future(unit, Io))) = io.async({ &x }(io : Io) => …)` is E0909 "`f` would hold a
borrowing future … cannot be bound to a local", while the same binding without the annotation, `f := io.async(…)`, is
accepted and freezes `x` until `f`'s last use. A valid program is rejected; the workaround is to drop the type.
Pre-existing: v0.2.76 gives the same E0909.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C9). Confirmed on develop `64f33c710`. The ledger grouped
this with `issues/2026-11-11-a-non-generic-impl-future-parameter-rejects-a-borrowing-future-operand.md` (C10); the
two have different causes in the source, so they are two documents.

## Reproducers

`issues/repros/2026-11-11-a-borrowing-future-bound-with-a-spelled-type-is-rejected-as-second-class.yo`
(positive, expects accept):

```yo
main :: (fn(io : Io) -> unit)({
  x := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  (f : Impl(Future(unit, Io))) = io.async({ &x }(io : Io) => {
    io.await(yield(io), io);
    println(`OUT: ${x.*}`);
  });
  io.await(f, io);
});
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76
error[E0909]: `f` would hold a borrowing future: it borrows `x` (a place in the future's origin), so it is second-class (plans/VALUES_BY_DEFAULT.md §3.13 A2) and cannot be bound to a local.
```

- `…-write.yo` (negative, expects E0911 after the fix): the same binding, then `sink(x)` before the await. Today it
  stops at the binding with E0909; after the fix the error must move to `sink(x)`, as for `f := …`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `(f : Impl(Future(unit, Io))) = io.async({ &x } …)`, awaited | E0909 at the binding | accept |
| the same, `x` moved before the await (probe `t01`) | E0909 at the binding | E0911 at the move |
| `f := io.async({ &x } …)`, awaited | accepted | accept |
| `f := io.async({ &x } …)`, `x` written before the await (corpus row `async-cold-start-write`) | E0911 | E0911 |

## Root cause

`note_second_class_binding` (`src/evaluator/utils.yo`) rejects a borrowing future held by a binding unless the
caller passes `bound_by_init : true` (decision 43 step 4: "a `:=` binding holds the future with the places of its
origin frozen until its last use"). `src/evaluator/exprs/initialization_assignment.yo` (the `:=` path) passes it;
the typed declaration `(f : T) = v` is evaluated by `src/evaluator/exprs/assignment.yo`, whose call
(`note_second_class_binding(&variable, &sc_ri.ty(), …)`) does not, so a first binding with a spelled type is judged
like a reassignment of an existing local. The same function already knows the case: a few lines above, under
`is_typed_binding_lhs`, it calls `bind(…)` because "a typed declaration `(h : T) = v` binds `h` as `h := v` does";
the second-class call is the one place that was not given `bound_by_init : is_typed_binding_lhs`.

## Expected

Accept, with `x` frozen until `f`'s last use. A typed declaration is a binding by initialization like `:=`; the
annotation names the same opaque future type (`plans/backlog/REFERENCES_AND_ORIGINS.md` O8: "a `:=` binding of one
freezes those places … until the future's last use"). `Impl(Future(unit, Io))` with no origin argument is an
`Impl`, whose concrete type (and origin) is the initializer's; it does not ask for an origin-free future the way
`Dyn(Fn(...))` asks for an `Escapable` payload. Reassigning an existing future local keeps today's rule.

## Test

With the fix: the positive and `…-write.yo` become rows in `tests/origins/corpus.tsv` (`async-typed-binding`,
accept; `async-typed-binding-write`, E0911) and cases in `tests/async_await.test.yo`.
