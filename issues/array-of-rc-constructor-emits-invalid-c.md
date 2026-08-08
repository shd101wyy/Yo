# `Array(Box(i32), N)(...)` constructor emits invalid C

**Status:** OPEN. Pre-existing (reproduced with the aliasing Stage-0 audit
changes stashed), affects **both** compilers. Found 2026-08-08 while trying
to build a regression test for the Stage-0 indexed-borrow hole.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));

H :: ref(struct(a : Array(Box(i32), 2)));

mk :: (fn() -> H)(
  H(a : Array(Box(i32), 2)(box(i32(42)), box(i32(7))))
);

main :: (fn() -> unit)({
  h := mk();
  unsafe(printf("%d\n", h.a(0).*));
});

export(main);
```

TS compiler:

```
/tmp/arr2.c:1678:194: error: expected expression
```

The **array-literal** form (`H(a : [box(i32(42)), box(i32(7)),])`) compiles
under the TS compiler but fails the same way under the self-hosted binary:

```
/tmp/s0_sh.c:1443:116: error: expected expression
```

So: neither compiler emits valid C for the `Array(T, N)(...)` constructor
with RC element types, and yo-self additionally cannot emit the literal form.
Non-RC element types (`Array(i32, 5)(0, 1, 2, 3, 4)`,
tests/algebraic_effects.test.yo:865) are fine, so this is specific to
RC-typed elements — presumably the per-element dup/init emission.

## Why it matters beyond the crash

It **blocks a regression test**. The Stage-0 audit found that an INDEXED
borrowed argument was unprotected (see
`issues/borrowed-arg-invalidated-by-aliased-container-mutation.md`, Stage-0
audit section). The only shape that reproduces it is a fixed-size `Array`
field, because:

- `Array` element reads are inline, non-owning, and carry an `UnknownValue`
  — exactly the combination the Stage-0 marker used to skip;
- `ArrayList` element reads go through the Index trait and produce an
  OWNING temp, so they were already safe at `+0` and do **not** discriminate.

The fixes are landed and verified by hand (the reproducer flipped from 101 to
42), but the permanent test cannot be checked in until this codegen bug is
fixed, because it must run under both compilers in the gate battery.

**When fixing this, add that test** — the reproducer above plus a callee that
replaces/reassigns the array element in a loop while a borrow of it is live.
