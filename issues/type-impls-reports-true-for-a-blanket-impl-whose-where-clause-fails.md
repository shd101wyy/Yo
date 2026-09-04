# `Type.impls` reports `true` for a blanket impl whose `where` clause is NOT satisfied

**Status: OPEN.**

**Severity: soundness (reflection).** `Type.impls(*(NonSend), Send)` answers
`true`. The prelude's rule is `impl(generic(T : Type), where(T <: Send), *(T),
Send())` — a pointer is `Send` only when its pointee is — and the bound is
being ignored.

**Found** 2026-09-05, and it is worth saying how: it was invisible until
`comptime_assert` was made to fire inside function bodies
(`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`).
`tests/basic.test.yo:279` has asserted the correct answer since it was written;
the assertion had simply never run. Turning 1559 dormant assertions on produced
exactly **one** failure across the whole suite, and this is it.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
NonSend :: ref(struct(v : i32));
_A :: Type.impls(NonSend, Send);
_B :: Type.impls(*NonSend, Send);
_C :: Type.impls(*i32, Send);
_D :: Type.impls(Array(NonSend, 4), Send);
_E :: Type.impls(?*NonSend, Send);
main :: (fn() -> unit)({
  println(`NonSend          Send = ${_A}   want false`);
  println(`*NonSend         Send = ${_B}   want false`);
  println(`*i32             Send = ${_C}   want true`);
  println(`Array(NonSend,4) Send = ${_D}   want false`);
  println(`?*NonSend        Send = ${_E}   want false`);
});
export(main);
```

```
NonSend          Send = false   want false     OK
*NonSend         Send = true    want false     WRONG
*i32             Send = true    want true      OK
Array(NonSend,4) Send = true    want false     WRONG
?*NonSend        Send = true    want false     WRONG
```

Three of the prelude's where-bounded blanket impls report satisfied when the
bound is not met. The bound is honoured for the bare `ref(struct(…))`, so this
is specifically about matching a GENERIC impl against a constructed type.

(The suite only surfaces the pointer one because `comptime_assert` stops at the
first failure in a `begin` block; `tests/basic.test.yo:284`'s `Array` assertion
is the next in line.)

## Why it matters

`Send` is the gate on what may cross a thread boundary. A raw pointer to a
non-`Send`, non-atomically-refcounted object reporting `Send` is exactly the
unsoundness the trait exists to prevent.

It also undermines the audit's own enforcement pins. `plans/STD_API_AUDIT.md`
§8 O7 records that the `Acyclic` tests use
`comptime_assert(Type.impls(payload, Send))` **specifically so that "the
expected error can only be Acyclic's"** — a guard that both cannot fire (until
the `comptime_assert` fix lands) and would answer wrongly if it did. The O7 and
`std/sync` bound pins should be re-verified once this is fixed.

Note the *instantiation* check is a different code path and appears to work —
O7's "verified BOTH ways" result stands on a self-referential element failing
instantiation. This bug is in the reflection query
(`__yo_type_impls` → `type_implements_trait_bool` → `type_implements_trait`,
`src/evaluator/trait_checking.yo:649`), which is what `Type.impls` exposes to
user code and to derive rules.

## Where to look

`src/evaluator/trait_checking.yo`'s `type_implements_trait`. The negative-impl
and comptime fast paths at the top are fine; the defect is in the generic-impl
matching further down, which evidently matches an impl's PATTERN
(`*(T)`, `Array(T, N)`, `?(T)`) against the target without then discharging the
impl's `where` constraints against the bound `T`.

The concrete-impl path already knows how to do this —
`check_self_constraints_violation_msg` (same file) walks a trait's own
`self_constraints` and calls `type_implements_trait_bool` per constraint. The
generic-impl match needs the equivalent for the impl's `where` clause, with the
pattern's captured type arguments substituted in.

## Fix shape, and the trap in it

After a generic impl's pattern matches, evaluate its `where` constraints
against the captured bindings and treat a failure as "this impl does not
apply" — continue searching rather than reporting `true`.

**This tightens trait resolution, which is the dangerous direction.** Follow the
repo's own rule for a new rejection (see
`issues/fixed/`-era guidance and the "guards that skip emission" lesson): every
newly-rejected shape needs an **over-rejection canary** — a case that must keep
compiling — because a `where` clause that fails to discharge for an unrelated
reason (an unresolved `SomeT` during def-time evaluation, a recursive
instantiation) would now silently remove a legitimate impl. Expect the
`Option`/`Eq` and `Acyclic` blanket impls to be the sensitive ones; the comment
at the top of `type_implements_trait` records a previous incident of exactly
that shape (`issues/fixed/yo-self-option-eq-ref-enum-not-specialized.md`).

Gate it with `yo check ./std` + `yo check ./src` + the full suite + a stage-2
self-compile, not just the targeted tests.

## Regression test

`tests/basic.test.yo:275-284` already contains the right assertions and needs no
change — it only needs the `comptime_assert` fix to be live for them to count.
Add the `Array` and `?*` cases as separate tests so one failure does not mask
the others, and add a positive canary (`*i32`, `Array(i32, 4)`) so a fix that
over-rejects is caught too.
