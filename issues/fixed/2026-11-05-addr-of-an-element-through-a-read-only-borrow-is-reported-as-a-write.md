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

## Fix

`addr_of` (`evaluate_address_call`, `src/evaluator/builtins/ptr_fns.yo`) promotes its place's element accesses to `index_mut` through `call_promote_index_places_for_write` with `is_addr_of : true`. The hook (`PromoteIndexPlacesFn`, `src/evaluator/context.yo`) takes that flag, and the other write sites default it to `false`. `_promote_index_call` (`src/evaluator/calls/index_trait.yo`) passes it on. Its read-only-root E0908 now has a separate message for `addr_of`:

```text
error[E0908]: Cannot take `addr_of(xs(usize(0)))`: it yields a `*T`, which can write the element, and `xs` is a read-only borrow.
help: to read the element, use it in place: index it (`xs(usize(0)).f`), match it through `&xs(usize(0))`, or pass `&xs(usize(0))` to a `&T` parameter; to write it, declare `xs : &mut T` (or borrow it with `&mut`)
```

The code and the other write sites' text are unchanged. Whether `addr_of` of a read-only place should be allowed at all (a const pointer) is still the design question the Recommendation leaves open.

Test: `tests/index.test.yo` has a `comptime_expect_error` on the reproducer that matches the new message. The v0.2.74 seed prints the old `Cannot write …` text.
