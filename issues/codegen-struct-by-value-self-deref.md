# Codegen: `(self)` deref passes value instead of pointer for ref-counted objects

**Status:** open

## Symptom

```
error: passing '__yo_struct_yodb87f9d4_id_86' (aka 'struct __yo_struct_yodb87f9d4_id_86_struct')
to parameter of incompatible type '__yo_struct_yodb87f9d4_id_86 *'
(aka 'struct __yo_struct_yodb87f9d4_id_86_struct *'); take the address with &
    __yo_struct_yodb87f9d4_id_3 _temp = fn_..._parse_primary_end((*self), ...);
      |                                                                        ^
note: passing argument to parameter 'self' here
    fn_..._parse_primary_end(__yo_struct_yodb87f9d4_id_86* self, ...);
                             ^
```

## Reproducer

```rust
// repro_struct_by_value.yo
{ ArrayList } :: import("std/collections/array_list");

Foo :: object(
  tokens : ArrayList(usize)
);

impl(Foo,
  new : (fn() -> Self)(Foo(tokens : ArrayList(usize).new())),
  helper : (fn(self : Self) -> unit)(()),
  call_helper : (fn(self : Self) -> unit)(
    Self.helper(self)  // <-- self is Foo*, Self.helper expects Foo*
  ),
);

export(main, Foo);
```

## Root cause

The enclosing function receives `self : Parser*` (a pointer to a ref-counted object).
When calling another method `Self.method(self, ...)`, the codegen dereferences
`self` to `(*self)` to get the VALUE, then passes it as a `&self` arg. But when
the callee ALSO expects `Self*` (pointer), the dereference produces a type mismatch:
`Parser` (value) when `Parser*` (pointer) is expected.

In `src/codegen/exprs/other-fn-call.ts`, the implicit `self` argument generation
dereferences `self` when the callee's first parameter is `Self` (the object type).
For ref-counted objects, `Self` should always be `Self*` at the C ABI.

## Fix location

`src/codegen/exprs/other-fn-call.ts` — the code that generates the implicit
`self` argument for method calls on reference-counted objects.
