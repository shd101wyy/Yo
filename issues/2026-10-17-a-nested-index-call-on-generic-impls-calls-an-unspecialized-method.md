# A nested index call on generic impls calls an unspecialized method

**Severity:** S2 — valid programs are rejected by the C compiler: some nested element accesses through generic `Index`/`IndexMut` impls (`mm(i)(k) = v` with a move-only inner key, `o(i)(j)` on a user impl whose `Output` is a generic struct) pass `yo check` and call a C function that is never declared.

**Status:** open. Found 2026-10-17 while landing #1420 (a canary for the
review's write through a move-only key). Both reproducers fail the same way
with the develop-built `yo-dev-5425cd7bf`. Neither involves moving a named
local, so this is not
`issues/fixed/2026-10-17-an-index-call-that-moves-a-named-local-calls-an-unemitted-method.md`.
The cause is not yet known.

## Symptom

```text
error: call to undeclared function 'yo_id_11682532930570127216000000'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
```

In the write case, the undeclared function is the outer access's
`index_mut`, the inner `HashMap(Dk, i32)`'s. The receiver's own access
(`mm(i32(1))`) is specialized and declared.

## Reproducers

A nested write whose inner key is move-only. Every key here is a
temporary, so nothing named is moved (this needs #1420's std, which
lets a move-only key into a `HashMap`):

```yo
{ HashMap } :: import("std/collections/hash_map");
Dk :: struct(n : i32);
derive(Dk, Eq(Dk), Hash);
main :: (fn() -> unit)({
  mm := HashMap(i32, HashMap(Dk, i32)).new();
  mm(i32(1))(Dk(n : i32(2))) = i32(7);
});
export(main);
```

A nested read through a user generic impl, with `i32` subscripts:

```yo
{ assert } :: import("std/assert");
Bag :: (fn(comptime(K) : Type) -> comptime(Type))(struct(v : i32));
impl(generic(K : Type), Bag(K), Index(K)(Output : i32, index : (fn(self : &Self, idx : K) -> &Self.Output)(&self.v)));
Outer :: (fn(comptime(K) : Type) -> comptime(Type))(struct(inner : Bag(K)));
impl(generic(K : Type), Outer(K), Index(K)(Output : Bag(K), index : (fn(self : &Self, idx : K) -> &Self.Output)(&self.inner)));
main :: (fn() -> unit)({
  o := Outer(i32)(inner : Bag(i32)(v : i32(9)));
  assert(o(i32(1))(i32(2)) == i32(9), "nested");
});
export(main);
```

## What passes and what fails

All of these were compiled with #1420's compiler and std. The two
reproducers above fail the same way with the develop binary.

| Access | Outer key | Inner key | Result |
| --- | --- | --- | --- |
| `HashMap` of `HashMap`, read | move-only, named | move-only, named | compiles and runs |
| `HashMap` of `HashMap`, write | `i32` | `i32` | compiles and runs |
| `HashMap` of `HashMap`, write | a `Copy` struct | a `Copy` struct | compiles and runs |
| `HashMap` of `HashMap`, write | move-only, named | `i32` | compiles |
| `HashMap` of `HashMap`, write | `i32` or move-only, named or temporary | move-only, named or temporary | undeclared `index_mut` |
| user `Outer(K)` of `Bag(K)`, read | `i32` | `i32` | undeclared method |

So the write fails whenever the inner `index_mut`'s key is move-only and its
receiver is itself an index call. The single-level write with a move-only key
compiles (`tests/index.test.yo`, "IndexMut: a write through a generic impl
with a move-only named key").

## Where to look

`_specialize_index_method` (`src/evaluator/calls/index_trait.yo`) runs a
trial call whose exception is swallowed. When the trial throws, the access
keeps the generic method value, which codegen never emits. For a nested
access, the trial re-evaluates the receiver, which is itself an index call,
and `_promote_index_call` then runs it again for the write. Printing the
swallowed error in the trial's handler would show which rule fails.
