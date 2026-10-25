# The container-reachability walk is imprecise at fn-typed payloads and exotic type nodes

**Severity:** S3

Filed by the B6-a review (VBD B6-a, `src/types/flowability.yo`). Rule (b) of
`_reject_if_container_reachable` asks `_type_may_reach_any_of` whether a sibling
argument's type can hold one of the types an element borrow hangs from. Two
imprecisions, in opposite directions, are accepted for now:

## N2: the walk answers yes for a nested plain `Func` field (conservative)

A struct, tuple or `Option` holding a plain `Func` field beside `&mut xs(i)`
is REJECTED: the walk's `Rc(.Func(...)) => true` arm (added with the walk,
2026-10-25) fires at every depth, and a function value inside an aggregate may
be a closure that captured the container. The evaluator forbids storing a
closure in a bare `Func` slot (a closure needs an `Impl(Fn(...))` wrapper or a
`Dyn(Fn(...))` box, `tests/impl_fn_field_rejection.test.yo`), so such a field
can only hold a non-capturing `fn` — the reject is a false positive. Inherited
from the base by construction (the walk never distinguished the two), and the
safe direction; refining it needs a "this slot cannot hold a closure" fact the
type alone does not carry.

## ExternOpaqueT / unresolved TypeAppT: the walk answers no (the other direction)

Two TypeValueNode variants fall into the walk's `_ => false` arm, so a sibling
of either shape is ACCEPTED beside `&mut xs(i)` even though it may reach the
container:

- `ExternOpaqueT` — an opaque C type (`extern("Yo", X : Type)`, `c_include`). A
  C structure can embed a handle to a Yo value only through raw pointers handed
  to it by Yo code, so the practical window is narrow, but the walk's contract
  ("a value that cannot hold one cannot reach it") is not provable for a type
  whose layout only the C compiler knows. `DynT` answers `true` for exactly
  this reason; `ExternOpaqueT` should too.
- `TypeAppT` — a generic constructor applied but not substituted to a concrete
  aggregate. The evaluator substitutes most applications eagerly, so what
  survives to the walk is an application the evaluator could not reduce (an
  open or registered-but-unresolved constructor); its fields are unknown, which
  is the same situation as an unresolved `SomeT`, and that arm answers `true`.

Not reproduced: constructing a user program whose sibling argument's resolved
type is an `ExternOpaqueT` or a surviving `TypeAppT` at an element-borrow call
requires an evaluation path this filing did not find (every attempted generic
sibling arrived at the walk already substituted, and an extern-opaque sibling
cannot name a Yo container type at all). The gap is structural, read off the
match in `_type_may_reach_any_of`; a reproducer would be the acceptance
condition for the fix.

## Recommendation

One arm each in `_type_may_reach_any_of`:

```yo ignore
Rc(.ExternOpaqueT(name : _, c_name : _)) => true,
Rc(.TypeAppT(constructor : _, args : _)) => true,
```

with the FnTraitT/FutureTraitT/Func precedents in the same match (B6-a fixed
`FutureTraitT` there). For N2, either accept the false positive (S3: rare
shape — a `Func` field beside an element borrow) or teach the walk that a
BARE `Func` slot cannot hold a closure, mirroring the evaluator's own rule.
Over-rejection is the cost until then.
