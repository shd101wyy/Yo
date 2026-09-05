# `Array(T, N)` where `T` is a struct emits the array wrapper BEFORE `T`'s definition — `unknown type name`

**Status: FIXED 2026-09-05.** **Class**: crash (build-breaking) — the emitted C
did not compile. Every `Array(T, N)` whose element was a user struct / ref
struct / newtype was affected, so `Array(String, 2)` could not be used at all.

**Found**: 2026-09-05, while giving `Array(T, N)` its `Eq`/`Ord`/`Clone`/`Hash`
impls (`issues/fixed/derive-eq-clone-ord-over-a-fixed-size-array-field-aborts-at-runtime.md`).
The `Clone` impl's regression test wanted an OWNING element type — the one shape
that proves the clone is deep rather than a refcount-shared alias — and the test
could not be written.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

main :: (fn() -> unit)({
  a := Array(String, 2)(String.from("ab"), String.from("cd"));
  println(`${a(0)} ${a(1)}`);
});
export(main);
```

```
$ yo compile strarr.yo --std-path ./std --optimize 2 -o strarr.out
strarr.out.c:323:3: error: unknown type name '__yo_t0'
1 error generated.
yo: error: compile: C compiler failed (exit 1) on strarr.out.c
```

Line 323 is the array wrapper:

```c
typedef struct { // Array wrapper struct
  __yo_t0 data[2];      // __yo_t0 (String) is only FORWARD-declared here
} Array___yo_t0_2;
```

`__yo_t0` has a forward `typedef struct __yo_t0_struct __yo_t0;` above, which is
an INCOMPLETE type — legal for a pointer, illegal as an array element. The
complete `struct __yo_t0_struct { ... };` is emitted further down, with the rest
of the struct declarations.

This is PRE-EXISTING and independent of the `Array` trait impls: it reproduces on
`ca13e3c82` with an unmodified `std/`.

## Root cause

`generate_array_struct_declarations` (`src/codegen/types/generation.yo:57`) emits
ALL array wrappers as one block, sorted by `(length, lexicographic)`. That sort
was added to fix a real ordering bug — a nested `Array(Array(T, 3), 4)` wrapper
emitted before its inner wrapper (`issues/repros/nested-array-wrapper-order.yo`)
— and it is correct for wrapper-inside-wrapper, because an inner wrapper's name
is always shorter. It says nothing about a wrapper whose ELEMENT is a struct
declared in the separate struct-declaration pass.

The two passes are independent and the array block runs first, so:

- wrapper → element struct: **broken** (this issue),
- struct → wrapper (a struct with an `Array(T, N)` field): works only because
  the array block runs first.

Those two constraints point in opposite directions, so no fixed order of the two
whole passes can satisfy both. The emission has to be topological over the actual
dependency graph — each array wrapper placed immediately after its element type's
definition, and each struct after every wrapper it embeds by value.

TS did not hit this because its wrapper registration is lazy and
insertion-ordered and recurses into the element FIRST (`utils/index.ts:599`),
which interleaves the two kinds naturally.

## Fix (LANDED 2026-09-05)

Array wrappers are RELEASED as their element types become available instead of
being emitted as one up-front block (`src/codegen/types/generation.yo`):

- `_array_wrapper_names_sorted` keeps the deterministic `(length, lex)` order,
- `_deferred_decl_cnames` is the set of C names this pass still owes a
  definition for — every wrapper plus every nominal type the topological pass
  will emit; a type whose body is emitted ON DEMAND elsewhere is deliberately
  excluded, so wrappers over it stay ready exactly as before,
- `_drain_ready_array_wrappers` emits every pending wrapper whose element is
  already defined, repeating until a full sweep makes no progress (so a wrapper
  over a wrapper still follows its child without a separate sort),
- the drain runs once before the struct pass and again after EACH nominal type
  the topological pass emits; anything still pending is flushed at the end,
  which is what used to happen to all of them.

`_walk_by_value_dep` also gained the missing `Array` edge: an `Array(T, N)`
field embeds N copies of `T` by value, so the declaring type must follow `T`'s
definition just as a plain `T` field would. Without it the topological sort was
free to place `ArrOfPoint` before `Point`.

## Breaking change

No — the affected programs do not compile today.

## Regression test (LANDED)

- `tests/array.test.yo`: `Array(String, 2)` built, read back, and `.clone()`d
  (the clone must be DEEP: append to the clone's element and assert the
  source's is untouched).
- `tests/derive.test.yo`: `Array(Point, 2)` and `Array(String, 2)` struct
  fields deriving `Eq` / `Ord` / `Clone` / `Hash`, with the same independence
  assertion.
- The existing nested-wrapper case (`issues/repros/nested-array-wrapper-order.yo`)
  stays green through `tests/rc.test.yo` "Rc in different data structures" — it
  is the over-rejection canary for any change to the ordering.
