# A capture list in an untyped trait-default lambda cannot borrow `self`: `&self` and `&self.*` are both E0926

**Severity:** S2 — a trait default written as an untyped lambda `(self, …) -> io.async(…)` cannot lend its `&Self` receiver to the future in user code; the only spellings are rejected, and the typed-default form is the workaround.

Found while migrating `tests/async_unit_tail_await.test.yo` off `ref(struct)` (V5 part B,
branch `vbd/v5-part-b-tests`), on develop 68b45b81d.

## Symptom

A trait default whose body is an untyped lambda and whose future borrows the receiver:

```yo ignore
Sink :: trait(
  put : (fn(self : &Self, v : u8) -> u8),
  (twice : (fn(self : &Self, v : u8, io : Io) -> Impl(Future(u8, IoExn)))) ?=
    (
      (self, v, io) ->
        io.async({ s : &self.*, v }(e : IoExn) => (Self.put(s, v) + Self.put(s, v)))
    )
);
```

```
error[E0926]: `self` is a reference (`&T`): borrowing the value it refers to is spelled `&self.*`
   --> issues/repros/2026-11-05-trait-default-lambda-self-capture-e0926.yo:9:30
```

The diagnostic asks for exactly the spelling the source already has. `{ &self, v }`, the form
std's own `Reader`/`Writer` defaults use (`std/io/index.yo:79`), reports the same E0926. An
implicit capture (`io.async(e => … self …)`) moves `self` instead (E0901 when `Self` is
move-only), which is what the `ref` version of the test relied on: a `ref` handle was copied.

Both other shapes compile and run:

- the same default written typed, `(fn(self : &Self, v : u8, io : Io) -> Impl(Future(u8, IoExn)))(io.async({ s : &self.*, v }(…) => …))`;
- the same body as an impl method (`impl(T, Sink(…, twice : (fn(self : &Self, …) -> …)(io.async({ s : &self.*, v }(…) => …))))`).

Reproducer: `issues/repros/2026-11-05-trait-default-lambda-self-capture-e0926.yo`
(`yo compile <it>` fails with the E0926 above; with the default typed it prints nothing and exits 0).

## Why std is not affected yet

std's `{ &self, io }` defaults pass only because std is E0926-exempt until N3
(`is_deref_rule_exempt`, `src/evaluator/memory_safety.yo`, decision 43 step 2 N1e-1). When N3
deletes the exemption and migrates std, `std/io/index.yo`'s three untyped `Reader`/`Writer`
defaults hit this bug.

## Root cause (not yet located)

The untyped lambda's `self` takes its type from the trait signature (`&Self`), but the
capture-list entry's place is checked as if `self` were a reference binding that the `.*`
does not unwrap: `&self.*` reports the bare-reference error on `self`. The typed form binds
`self` through the ordinary parameter binder and is read correctly, so the difference is in
how the default lambda's parameters are bound (the def-time binder versus
`bind_parameter`; see AGENTS.md "A parameter is bound in three places").

## Workaround

Write the default typed (`(fn(self : &Self, …) -> …)(…)`), or keep the receiver `Copy`.
`tests/async_unit_tail_await.test.yo` keeps its default verbatim (it is the regression's
shape) and makes `Tally` a `Copy` record whose count is module-level.

## Test

The fix adds the reproducer as a case of `tests/async_unit_tail_await.test.yo` (an untyped
default lending `{ s : &self.* }` to its future) and moves this doc to `issues/fixed/`.
