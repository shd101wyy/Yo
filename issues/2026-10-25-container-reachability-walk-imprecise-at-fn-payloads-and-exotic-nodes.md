# The container-reachability walk answers "cannot reach" for `ExternOpaqueT` and unresolved `TypeAppT`

**Severity:** S3

Filed by the B6-a review (VBD B6-a, `src/types/flowability.yo`). Rule (b) of
`_reject_if_container_reachable` asks `_type_may_reach_any_of` whether a sibling
argument's type can hold one of the types an element borrow hangs from. Two
TypeValueNode variants fall into the walk's `_ => false` arm, so a sibling of
either shape is ACCEPTED beside `&mut xs(i)` even though it may reach the
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

## Reproducer

Not produced: constructing a user program whose sibling argument's resolved
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

with the FnTraitT/FutureTraitT/Func precedents in the same match (B6-a already
fixed `FutureTraitT` there). Over-rejection risk is the cost: every
extern-opaque sibling beside an element borrow would be rejected until the
walk learns the C layout, which S3 accepts.
