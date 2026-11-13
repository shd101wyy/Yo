# A trait-qualified operator call through a generic impl emits invalid C

**Severity:** S2 — a valid program that calls an operator through its trait (`Eq(W(i32)).(==)(a, b)`) with the impl generic (`impl(generic(T : Type), …, W(T), Eq(W(T))(…))`) passes `yo check`, and the C compiler then rejects it, so no binary is built.

Found 2026-11-13 by the `d49` lane (decision 49 S2) while writing the `[T]` `Eq` rows: `Eq([i32]).(==)(a, b)` fails the same way. The installed v0.2.77 fails on the sized reproducer below, so it is not new. The operator spelling (`a.* == b.*`) works and is what the S2 tests use.

## Reproducer

`issues/repros/2026-11-13-a-trait-qualified-operator-call-through-a-generic-impl-emits-invalid-c.yo`:

```yo ignore
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), where(T <: Eq(T)), W(T), Eq(W(T))((==) : (fn(lhs : &Self, rhs : &W(T)) -> bool)(lhs.v == rhs.v)));
_e :: (fn(a : &W(i32), b : &W(i32)) -> bool)(Eq(W(i32)).(==)(a, b));
```

`yo compile` emits `((bool (*)(void*, …))__yo_t_<n>._u61__u61_)((void*)((*a)), (*b))`: a call through a trait-record value `__yo_t_<n>` that is never declared (`use of undeclared identifier`), with the operands passed by value where the record's slot takes pointers.

## Root cause

Not investigated. The call takes the trait-value dispatch path (a `Dyn`-style record lookup) instead of resolving the generic impl's specialization for `W(i32)` statically, as a method call or the operator does.

## Test

Owed with the fix: the reproducer as a runtime row (`tests/trait_qualified_call.test.yo` or beside the existing trait-qualified call rows), asserting `true` for equal values and `false` for unequal ones.
