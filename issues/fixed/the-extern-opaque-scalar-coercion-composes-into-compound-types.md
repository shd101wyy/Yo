# The extern-opaque C-scalar coercion composes into compound types

**Status:** FIXED 2026-09-26 (branch `tss/flow-orientation`).
**Found:** 2026-09-26, while fixing
[`the-flow-relation-is-called-with-its-arguments-reversed.md`](the-flow-relation-is-called-with-its-arguments-reversed.md)
— the reversed argument check had been masking this hole.

## Symptom

Passing `Option(u64)` where `Option(<an extern opaque type>)` is declared
checks clean (the shape `#941`'s canary pins, which passed on develop only
because the argument check called the relation backwards and the reverse
direction genuinely fails):

```rust
{ atomic_ullong : _P38Ull } :: import("std/libc/stdatomic");
sink :: (fn(o : Option(_P38Ull)) -> bool)(o.is_some());
b :: sink(Option(u64).Some(u64(1)));   // accepted: the coercion reached inside
```

Measured on develop (`Type.is_compatible_with`, the relation both ways round):

| pair | verdict |
| --- | --- |
| `Option(u64)` → `Option(_P38Ull)` | **true** (the hole) |
| `G(u64)` → `G(_P38Ull)` for `G :: (fn(comptime(T) : Type) -> comptime(Type))(struct(f : T))` | **true** (the hole) |
| `Tuple(u64)` → `Tuple(_P38Ull)` | **true** (the hole) |
| `Option(i32)` → `Option(i64)` | false (numeric widening never composed) |
| `ArrayList(u64)` → `ArrayList(_P38Ull)` | false |
| `u64` → `_P38Ull` | true (the intended coercion) |

So the C-scalar → extern-opaque coercion was the ONE flow coercion that
composed into a compound type: every other payload/type-argument comparison
already judged concrete pairs invariantly (the C-compatible tag check), and
the pointer pointee was explicitly exact.

## Root cause

The coercion lived inside `_compat_impl`
(`src/types/compatibility.yo`), so it fired at every RECURSION depth with
`mode = Flow`:

- the EnumT arm's lenient variant-payload check (`vp_differ`, `_CompatMode.Flow`);
- the Struct arm's type-argument check (`pay_differ`, `_CompatMode.Flow`);
- the tuple element comparison;
- the `comptime_int`/`comptime_float` widening blocks carried
  `.ExternOpaqueT => true` arms with the same reach.

An initialization rule ("a C scalar value-initializes an opaque C slot, as C
does") has no business deciding whether two INSTANTIATIONS of a container are
the same instantiation.

## Fix

The coercion moved to `are_types_compatible` — the entry point the caller
names — and out of `_compat_impl` (and out of the comptime-widening blocks).
It now applies only when the EXPECTED type the caller passed is itself the
`ExternOpaqueT`: `u64` into `_P38Ull` still flows, `Option(u64)` into
`Option(_P38Ull)` no longer does, at any nesting.

`plans/reference/TYPE_IDENTITY.md`'s flow rule records the non-composition.

## Verification

`tests/type_soundness.test.yo` ("a C scalar initializes an extern opaque, never
the reverse") pins all four: the plain coercion still flows, the reverse still
does not, and the `Option`/`G`/`Tuple` composes are `false` in the relation.
The failing-before canary was the `comptime_expect_error(sink(...))` arm
already present from #941 (it failed on the first build of the branch, passed
after this fix).
