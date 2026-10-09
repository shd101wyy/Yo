# An address-of `&b` passed to a generic `imm` parameter became a borrow under step A

**Severity:** S1: a silent change of meaning; std's `Hasher` default
`write_u16`/`write_u32`/`write_u64` cast a VALUE to a pointer and crashed
(SIGSEGV) for any user `Hasher` that relies on the defaults.

Found 2026-10-10 by the full language suite on the V3b stack
(`tests/hash.test.yo` "a user Hasher gets the default write_* methods through
write", exit 11).

## Mechanism

Step A of V3b Generation B (plans/VALUES_BY_DEFAULT.md, decision 33) made
`&x` to an `imm` parameter a read-only borrow, "a generic one included",
keeping the address-of only for a raw-pointer parameter. Before step A, `&x`
to a generic parameter was the address-of, and the generic inferred `*(T)`.
`unsafe.cast` (`__yo_as`) takes its operand through a generic parameter, so

```rust
b := v;
self.write(unsafe.cast(&b, *u8), usize(2));
```

stopped meaning "the address of `b`, as `*u8`" and started meaning "the
`u16` value of `b`, cast to `*u8`": `write` then read through address `2`.
Nothing failed to type-check, because the cast accepts both.

## Fix

The sites that meant the address say so: `unsafe.cast(addr_of(b), *u8)`
(`addr_of` is Generation A's spelling of the address-of, carried by the
seed). Every other `&x` that step A turned into a borrow was listed with a
traced compiler (`YO_TRACE_AMP_PEEL`, not committed) over std, src, tests
and the CLI fixtures, and each was checked; see the PR for the list.

## Lesson

A change of what an existing spelling MEANS must come with an exhaustive
census of the sites that use it, not only a type-check: the old and new
meanings both type-check wherever the callee is generic.
