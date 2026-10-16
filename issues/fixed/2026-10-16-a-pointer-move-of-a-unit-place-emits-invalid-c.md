# A pointer move of a `unit` place emits invalid C

**Severity:** S2 — valid programs are rejected by the C compiler: `ArrayList(unit).swap`/`reverse`, and any `addr_of`, `__yo_ptr_read` or `__yo_ptr_write` of a `unit` place, emit C that does not compile.

**Status:** fixed 2026-10-16 (branch `fix/hashmap-move-only-key-value`).
Found while making `HashMap` move its values bitwise
(`issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`):
`HashSet(T)` is `HashMap(T, unit)`, so re-inserting a present element moved a
`unit` value through a pointer.

## Symptom

`yo check` passes; the C compiler fails:

```text
tmp/unitptr.c:2331:52: error: expected expression
 2331 |   void* _file____home_temp_1662372105246950020 = (&);
tmp/unitptr.c:2335:8: error: expected expression
 2335 |   (*((&)) = ());
tmp/unitptr.c:2674:23: error: incomplete type 'void' is not assignable
 2674 |         (*(__yo_v_pi) = ((*(__yo_v_pj))));
```

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
Pair :: struct(a : i32, u : unit);
main :: (fn() -> unit)({
  xs := ArrayList(unit).new();
  xs.push(());
  xs.push(());
  xs.swap(usize(0), usize(1));
  p := Pair(a : i32(1), u : ());
  q := addr_of(p.u);
  old := __yo_ptr_read(q);
  __yo_ptr_write(q, old);
});
export(main);
```

## Root cause

`unit` is a zero-sized type: a `unit` field is erased from its C struct, a
unit expression emits no C, and `*unit` is a C `void*`. Three lowerings did not
know that:

- `generate_address_of` (`src/codegen/exprs/ptr_fns.yo`) wrapped the operand's
  code in `(&...)`, and an erased field's code is empty: `(&)`.
- `__yo_ptr_read` (`src/codegen/exprs/inline_fns.yo`) emitted `(*(p))`, a
  dereference of a `void*`.
- `__yo_ptr_write` emitted `(*(p) = (v))`, an assignment to `void` whose right
  side is empty for a unit value.

## Fix

- `addr_of` of a `unit`-typed operand evaluates the operand for its effects
  and yields `((void*)1)`: a dangling, non-null pointer, as Rust's
  `NonNull::dangling()` is for a zero-sized type. Nothing reads or writes
  through it, and non-null keeps `Option(*unit).Some(p)` out of the null niche.
- `__yo_ptr_read` with a `unit` result and `__yo_ptr_write` of a `unit` value
  touch no memory. They evaluate their operands as `((void)(a), (void)(b))`,
  skipping an operand that emits no C, and emit no C when none is left, like
  any other unit expression.

## Verification

- `tests/unit_as_value_type.test.yo`: an `ArrayList(unit)` swaps, reverses and
  removes; a `HashMap(i32, unit)` overwrites and removes.
- `tests/addr_of.test.yo`: `addr_of` of a `unit` field is non-null, and a read
  and two writes through it leave the struct's other field untouched.
- Both failed at the C compiler on develop `36c41e62b`.
