# `Array(Box(i32), N)(...)` constructor emits invalid C

**Status:** FIXED 2026-08-08 (both compilers). Pre-existing (reproduced with the aliasing Stage-0 audit
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

## Resolution (2026-08-08)

Three distinct defects, all reached from the one reproducer:

1. **`Array(T, N)(...)` claimed to be a compile-time constant with runtime
   elements.** The constructor path manufactured `UnknownValue` placeholders
   and stamped the array as comptime regardless, so codegen routed it to the
   constant emitter — which has no case for an Unknown and emitted an EMPTY
   initializer slot. The array-LITERAL path already guarded with
   `every(val => !!val)`, which is exactly why literals worked. Fixed by
   mirroring that guard: an `UnknownValue` means "type known, value not" — a
   runtime element — and does not count as a compile-time value.
2. **No codegen dispatch for the runtime constructor shape.** The literal
   reaches `generateAnonymousArray` via its `array` head; the constructor has
   no such head. Now routed by SHAPE (array-typed call + runtime args + no
   comptime value), so both forms share one head-agnostic emitter.
3. **The generated RC tracer subscripted the array WRAPPER.** `Array(T, N)`
   is `Array_..._N { T data[N]; }`, not a bare C array, so
   `sizeof(obj->a)/sizeof(obj->a[0])` and `obj->a[i]` were invalid for any
   ref struct with an `Array(Box(T), N)` field. Both now go through `.data`.

Same root confusion as the Stage-0 marker hole in PR #79: an `UnknownValue`
(runtime) read as a compile-time value. Three separate bugs from that one
conflation — worth watching wherever `$.value` is tested for truthiness.

**The blocked test is now checked in**, along with an array-of-RC test
asserting the constructor and literal forms agree (values AND element `rc`)
and that a fully compile-time array still folds. `tests/rc.test.yo` 33/33
under both compilers.
