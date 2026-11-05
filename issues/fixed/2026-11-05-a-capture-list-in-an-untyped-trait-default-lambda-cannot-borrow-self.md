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

Reproducer: `issues/repros/2026-11-05-trait-default-lambda-self-capture-e0926.yo`. Before the fix, `yo compile` on it fails with the E0926 above. With the default typed, it prints nothing and exits 0.

## Why std is not affected yet

std's `{ &self, io }` defaults pass only because std is E0926-exempt until N3
(`is_deref_rule_exempt`, `src/evaluator/memory_safety.yo`, decision 43 step 2 N1e-1). When N3
deletes the exemption and migrates std, `std/io/index.yo`'s three untyped `Reader`/`Writer`
defaults hit this bug.

## Root cause

The fault is not in the parameter binder. The materialized body's `self` is a reference binding, as in the typed form. What differs is the second evaluation.

1. The first evaluation of `&self.*` rewrites the node `self.*` to the atom `self`. The atom's token sits at the `*`'s position, and N1e-1's `note_reference_deref_site` records that position as a deref site (`src/evaluator/exprs/property_access.yo`).
2. The untyped default's `io.async` body is evaluated again from that rewritten node during the per-impl materialization, the `instantiated here` note.
3. The capture-list evaluator (`src/evaluator/values/anonymous_function.yo`) takes the place's root and field path from the AST (`_cap_place_root`). It found the bare atom `self` with no `*` hop and reported E0926 for a bare `&self`.

The identifier evaluator and the reference-field constructor (`calls/type.yo`) already skip a name at a deref site (`is_reference_deref_site`). The capture-list check did not. A closure capture (`(f : Impl(Fn(…))) = ({ s : &self.* }(…) => …)`) and a local borrow (`y := &self.*`) in the same untyped default were never affected: neither re-evaluates through the rewritten node.

`{ &self, v }` reports E0926 too, but that one is the rule working: a pun of a reference binding borrows the referent and is spelled `{ self : &self.* }`. `yo fix --migrate deref` writes exactly that when it migrates std's `Reader`/`Writer` defaults.

## Fix

The capture-list check now treats a root name at a deref site as the written `r.*` (`!is_reference_deref_site(&root_tok)` beside `deref_rule_applies`, the same guard the other two sites use).

## Test

`tests/trait_default_inout_self.test.yo`, "an untyped default lends &self.* to its future through a capture list": the reproducer's default, awaited, reading the receiver through the borrow. It fails with this E0926 before the fix. The reproducer `issues/repros/2026-11-05-trait-default-lambda-self-capture-e0926.yo` compiles and exits 0.
