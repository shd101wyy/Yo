# A generic impl member that writes a receiver its trait lends read-only is reported at the `Dyn`, naming a synthesized binding, not at the impl

**Severity:** S3 — misleading diagnostic: the error is right but points at
line 1 and a compiler-made name instead of the impl that broke the trait.

Found 2026-10-13 with the conformance check of
`issues/fixed/an-impl-may-write-a-receiver-its-trait-lends-read-only.md`,
which rejects a non-generic impl at the impl but does not reach a generic
one.

## Reproducer

```yo
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T, n : i32));
M :: trait(m : (fn(self : &Self) -> i32));
impl(
  generic(T : Type),
  Wrap(T),
  M(
    m : (fn(self : &mut Self) -> i32)({
      self.n = (self.n + i32(1));
      self.n
    })
  )
);
main :: (fn() -> unit)({
  a := Wrap(i32)(v : i32(1), n : i32(0));
  (d : Dyn(M)) = dyn(a);
  _r := d.m();
});
export(main);
```

```text
error[E0908]: Cannot pass `__yo_dyn_receiver_m` as the `self : &mut Self` receiver: `__yo_dyn_receiver_m` is a `match` or `for` binding, which borrows its value, ...
  --> tmp/fixme7.yo:1:1
```

## Cause

`_receiver_writes_where_trait_reads` (`src/evaluator/values/impl.yo`) runs
in the member conformance step, which has no resolved trait member type for
a generic impl's member (`expected_method_ty_resolved` is `.None` there), so
the check never sees it. The write is caught later, when the `Dyn` vtable
wrapper is specialized, against a synthesized receiver binding.

## Expected

The same E0908 the non-generic impl gets, at the impl member: either run the
receiver comparison on the generic member's declared signature (the receiver
flags do not depend on `T`), or reanchor the vtable wrapper's error at the
impl member.
