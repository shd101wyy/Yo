# `sizeof` of a pointer to an unsized pointee is one word, so `Box.new` of a struct holding an `AnyError` allocates short

**Severity:** S1 (a heap-buffer-overflow from safe Yo: every `Box.new(v)`, `ArrayList.push` or other
`sizeof`-sized allocation of a value that holds a `Box(Dyn)` (every `AnyError`), a `*Dyn`, a `&Dyn` or a
`*[T]` field under-allocates by one word per such field and the copy-in writes past the block)

## Symptom

```yo
(inner : AnyError) = dyn(NotFound(path : `a`));
(one : AnyError) = dyn(Context.new(`reading`, inner));
```

`tests/error_ergonomics.test.yo`'s "Context nests, and each layer adds a prefix" row, under the harness's
ASan:

```text
WRITE of size 40 ... 0 bytes after 32-byte region
```

`Context` is `struct(message : String, cause : AnyError)`: 24 + 16 = 40 bytes in C, but the `Box.new`
specialization allocated `span + 32`.

## Root cause

`get_size_of_type` (`src/types/utils.yo`) answered pointer size for every `Rc(.Pointer(_))` and
`Rc(.Reference(...))`. Under decision 49 S2 a pointer to an unsized pointee (`Dyn(...)`, `[T]`, a tail
struct) is the fat `{ data, vtable | len }` pair: codegen lays it out so (`is_unsized_pointee` =
`!type_is_sized`). `Box(Dyn(T))` is a newtype over `*Dyn(T)`, so `sizeof(Box(Dyn(T)))` folded to 8 while
C's `sizeof` is 16, and every aggregate containing one was laid out one word short at compile time.
Before the flip `Box(Dyn)` was intercepted to the legacy thin dyn handle, so the mismatch never surfaced.

## Fix

The `Pointer` and `Reference` arms answer `2 ×` pointer size when the pointee is not `type_is_sized`.
Alignment is unchanged (both words are pointers).

## Test

`tests/dyn.test.yo`: "a Box(Dyn) and a *Dyn are two words, and a struct holding one is laid out so"
(sizeof rows plus a `Box.new` of a struct holding an `AnyError`), and the error_ergonomics row above
(ASan-clean). Both fail before the fix and pass after.
