# `addr_of(xs(i))` through a read-only borrow is reported as a write through `IndexMut`

**Severity:** S3 — misleading diagnostic: the user takes a raw pointer to an element, and the error talks about writing it through `IndexMut.index_mut`, without saying that `addr_of` needs a writable place (Yo has no const pointer) or what to write instead.

Found by the README example-project rehearsal for v0.2.75. markdown_it_yo's renderer takes `(pair : *StringPair) = addr_of(attrs(usize(i)))` to read an attribute pair through a `&` match binding. Present on develop d76eac577.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
first_ptr :: (fn(xs : &ArrayList(i32)) -> *i32)(addr_of(xs(usize(0))));
export(first_ptr);
```

```text
error[E0908]: Cannot write `xs(usize(0))`: `IndexMut.index_mut` takes `self : &mut Self`, and `xs` is a read-only borrow. Declare it `xs : &mut T` (or borrow it with `&mut`) to write its elements.
```

## Recommendation

When the place comes from `addr_of(...)`, say so: "`addr_of(xs(usize(0)))` takes a `*T`, which can write the element, and `xs` is a read-only borrow". Offer the read-only alternatives: index the element directly (`xs(i).f`), match it through `&xs(i)`, or pass `&xs(i)` to a `&T` parameter. Keep `xs : &mut T` as the fix when a write is intended. Whether `addr_of` of a read-only place should be allowed at all (C's `const T *`) is a design question, not this bug.
