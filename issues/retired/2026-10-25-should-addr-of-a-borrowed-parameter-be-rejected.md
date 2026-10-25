# Should `addr_of` of a `&T` parameter be rejected?

**Kind:** design question (decided; the error landed in the same PR).

**Status:** DECIDED 2026-10-25: option 3, an error (the maintainer's verdict
below), implemented as E0921. Found 2026-10-25 while writing the
custom-allocator rules (`plans/backlog/ALLOCATOR_PLACEMENT.md` §10.1 C6, §11).

## Verdict (maintainer, 2026-10-25)

**Option 3.** `addr_of(x)` where `x` is a `&T` parameter, `self : &Self`
included, is a compile error, with a help line naming the forms that do give
the caller's address: take `x : *T`, or `&mut T` (which lowers to `T*`), or
pass `addr_of(place)` from the caller. Reason: decision 34 lowers `&T` to a
by-value copy, so a `&T` parameter has no stable address, and in generic code
the lowering depends on the instantiated type.

## As implemented (E0921)

- **Where.** `evaluate_address_call` (`src/evaluator/builtins/ptr_fns.yo`)
  raises E0921 when the operand is a `&T` parameter passed by value, or a
  place inside one: a field of a value struct, tuple or union, or an element
  of a fixed-size array it holds. `yo explain E0921` has the entry, in English
  and Simplified Chinese. It is not a mechanical repair (the signature and
  every caller change), so it has no `yo fix` rewrite.
- **What the lowering is today.** Every `&T` parameter of a non-projection
  function reaches C by value, whatever the size of `T` (`fn_param_is_ptr_borrow`,
  `src/types/utils.yo`); the `const T*` lowering for a large `T` that
  `plans/VALUES_BY_DEFAULT.md` describes does not exist yet. Probed on v0.2.70:
  a 1-field struct, a 10-field struct, a `String`-holding struct and a generic
  `T` at both sizes all print `different`. So there is no size of `T` where
  `addr_of` of a `&T` parameter returned the caller's address.
- **Not E0921, by design:**
  - A projection's `&T` parameter (a function returning `&T` or `&mut T`,
    decision 24). `fn_param_is_ptr_borrow` passes it as a pointer, so its
    `addr_of` IS the caller's address, and the prelude depends on that:
    `Array`'s `Index.index` is `__yo_array_index(addr_of(self), idx)` on
    `self : &Self`. Rejecting it uniformly would break every array subscript.
  - The `addr_of(receiver)` the evaluator synthesizes when a method taking
    `self : *Self` / `self : &*Self` is called on a value (`sh.area()` with
    `sh : &Dyn(Shape)` in `tests/dyn.test.yo`, `tests/rc_cell.test.yo`). The
    program writes no `addr_of`, and the pointer lives for the call. Its
    callee token carries `AUTO_REF_RECEIVER_PATH` (`src/expr.yo`).
  - A place behind a pointer or a shared cell: `addr_of(self.*)` and
    `addr_of(self.f)` on an `atomic(ref(struct))` (std's atomics, `Once`,
    `Mutex`, `Cond`), a `ref(struct)` handle's field (the crypto hashers'
    `addr_of(self._buf(0))`), an `Index` element of a collection.

## Inventory (2026-10-25)

Found by checking `std`, `src`, `tests` (outside `tests/internal` and
`tests/cli-cases`) and `markdown_yo` with the new error, plus a grep of
`docs/`, `.github/` and `plans/` for `addr_of` of a `&T` parameter.

| Site | Action |
| --- | --- |
| `std/` | none: every `addr_of(self...)` on a `&Self` receiver is behind a pointer or in a shared cell, or is a projection |
| `src/` | none |
| `tests/ptr.test.yo` `_addr_of_param` (`v : &T`) | the parameter is by value again (`v : T`), as in the repro of `issues/fixed/address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md`; the pointer was read inside the call, so it never dangled |
| `markdown_yo` `markdown_to_html` (`options : &Options`, `src/parser.yo`) | takes the address of a local `options.clone()` (`Options` derives `Clone`); the pointer was used only inside the call, so it never dangled. Branch `fix/addr-of-borrowed-options` of markdown_yo |
| docs, instructions, skills | no example took `addr_of` of a `&T` parameter; `plans/backlog/ALLOCATOR_PLACEMENT.md` §11 already uses `self : &mut Self` |

No site was a latent dangling pointer: each pointer was used only while the
call ran.

## The question

Decision 34 lowers a `x : &T` parameter to `T x` (a by-value copy) for a small
`Copy` `T`, and to `const T*` otherwise (`plans/VALUES_BY_DEFAULT.md:251`,
`:2264-2267`). In the by-value case, `addr_of(x)` inside the callee is the
address of the callee's copy, not of the caller's place. Under
`pragma(Pragma.AllowUnsafe)` this compiles silently. The reproducer
(`issues/repros/2026-10-25-addr-of-a-borrowed-parameter-is-the-address-of-a-copy.yo`,
v0.2.70) prints `different`: the pointer `where_is(&s)` returns is not
`addr_of(s)`, and it dangles once `where_is` returns.

The lowering is by design and stays. The question is only whether the compiler
should say something when unsafe code takes the address of such a parameter.
The custom-allocator section hit it directly: an allocator method written
`allocator(self : &Self)` packs the address of a copy into `ctx`.

## Options

1. Leave it: `addr_of` is an unsafe operation and the lowering is documented.
2. A warning on `addr_of(x)` where `x` is a `&T` parameter.
3. An error on `addr_of(x)` where `x` is a `&T` parameter, with a help line
   naming the forms that do give the caller's address: take `x : *T` (or
   `&mut T`, which lowers to `T*`), or pass `addr_of(place)` from the caller.

## Recommendation

Option 3. The address is never the one the author meant: a `&T` parameter has
no stable address in Yo by decision 34, so there is no correct use to protect.
An error costs nothing in valid programs and turns a silent dangling pointer
into a compile-time message, which matters most in exactly the code (allocators,
FFI) that runs without other checks.
