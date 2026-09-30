# `&(A(i))` / `&(K.f)` into a compile-time constant emits `/* skip generating value */`

**Status:** FIXED 2026-09-29 (branch `explicit-allocators-fixes`)
**Severity:** S2 — a valid program fails at the C compiler with "expected expression"; binding the constant with `:=` instead of `::` is the workaround
**Found:** 2026-09-29, fixing `issues/fixed/address-of-a-module-level-constant-emits-a-placeholder.md` (the whole-value case).

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
P :: struct(x : i32, y : i32);
_K :: P(x : i32(3), y : i32(4));
_A :: Array(i32, 3)(i32(10), i32(20), i32(30));
main :: (fn() -> unit)({
  pa := &(_A(1));
  assert((pa.* == i32(20)), "element");
  pf := &(_K.y);
  assert((pf.* == i32(4)), "field");
});
export(main);
```

`yo check` passes; `yo compile` fails in the C compiler:

```
error: expected expression
  int32_t* _file____home_temp_120392781611459211260 = /* skip generating value */;
```

## Cause

`evaluate_address_call` (`src/evaluator/builtins/ptr_fns.yo`) builds the
pointer from the operand's `comptime_ref`, and three of its four shapes share
one value: an array element (`ArrayRef`), a struct field (`StructRef`) and a
tuple field (`TupleRef`) all become
`EvalValue.PtrVal(cell1(ArrayVal(elements)), index)`. The whole-value fix
renders a pointer to a whole constant as a static, but here codegen cannot
render the aggregate the pointer points into: for an array every element has
the pointee's type, for a struct the siblings do not, and the `PtrVal` does not
say which it is. Rendering the element alone would be wrong for arrays, where
`p.add(1)` must reach the next element.

## Suggested fix

Keep the aggregate's type in the pointer (a `PtrVal` variant for fields, or the
container type beside the cell), so codegen can emit the whole array or struct
as one static and return `&static.data[i]` / `&static.f`.

## Resolution (2026-09-29)

`EvalValue.PtrVal` (`src/value.yo`) gained a third field, `aggregate_ty`: the
type of the aggregate an element or field pointer points into, `.None` for a
pointer to a whole value. `evaluate_address_call` records it at the four
`comptime_ref` constructions (`_aggregate_type_of`: the object of `obj.f`,
else the receiver of `a(i)`). Codegen then renders the WHOLE aggregate as one
static (the same `comptime_pointer_static` the whole-value fix uses) and
returns the address inside it: `&S.data[i]` for an array, `&S.f` for a
struct, `&S._i` for a tuple. Array elements therefore stay adjacent, so
pointer arithmetic across the array is sound. The other `PtrVal` sites carry
the field through (`clone_value.yo`) or ignore it.

Test: `tests/ptr_constant_address.test.yo` (array element with arithmetic and
`offset_from`, struct field, nested struct field, tuple field, a `::`-bound
element pointer).
