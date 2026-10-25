# Should `addr_of` of a `&T` parameter be rejected?

**Kind:** design question — an open decision, not a defect.

**Status:** open. Found 2026-10-25 while writing the custom-allocator rules
(`plans/backlog/ALLOCATOR_PLACEMENT.md` §10.1 C6, §11).

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
