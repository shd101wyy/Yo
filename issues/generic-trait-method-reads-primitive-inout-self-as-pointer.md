# A trait method with its OWN `generic(...)` reads a primitive `inout(self)` as a POINTER

**Status:** OPEN
**Found:** 2026-08-25, during the D3.9 Hasher design round (STD_API_AUDIT), which
needs exactly this shape.
**Severity:** HIGH — silent wrong answer, no diagnostic, no crash.

## Symptom

```rust
G :: trait(
  g : (fn(generic(S : Type), inout(self) : Self, dummy : S) -> u64)
);
impl(i32, G(g : (fn(generic(S : Type), inout(self) : Self, dummy : S) -> u64)(u64(self))));

i32(42).g(true);   // → 13958672172   (an address); expected 42
```

The value returned is the receiver's ADDRESS. It differs run to run and between
call sites, so it looks like uninitialised data rather than a systematic fault.

## Isolation

The bug needs ALL THREE of these at once. Change any one and it disappears:

| # | condition | drop it → |
| --- | --- | --- |
| 1 | the trait method carries its OWN `generic(...)` parameter | `(fn(inout(self) : Self, dummy : bool) -> u64)(u64(self))` → **42** |
| 2 | the receiver is `inout(self)` | `(fn(generic(S : Type), self : Self, …))` → **42** |
| 3 | the receiver type is a PRIMITIVE | `Wrap :: struct(n : u64)` reading `self.n` → **42** |

A struct receiver survives because a field access goes through the pointer
correctly; only reading a scalar receiver AS A VALUE needs the deref that is
missing.

Not sensitive to where the conversion happens — inline in a call argument, via a
local, or as the direct return value all produce the address.

## Root cause (confirmed in the emitted C)

`yo compile tmp/minrepro.yo --emit-c --skip-c-compiler --release`:

```c
static inline uint64_t yo_id_5085_..._rtparam0_i32_rtparam1_bool_ret_u64(int32_t* self, bool dummy) {
  return ((uint64_t)(self));
}
```

It must be `(*self)`. The C signature is right (`int32_t* self`) — it is the
BODY's read of the receiver that skips the dereference. That is the same
two-channel split as issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md
(#258): the signature comes from `FuncMeta.param_is_ref`, while `p` vs `(*p)` in
the body comes from `Variable.is_ref` in the atom's ExprInfo env
(`_var_read_code`, src/codegen/exprs/atom.yo). #258 fixed the rebind path where a
parameter folded to a comptime constant; the mangled name here
(`…_rtparam0_i32_rtparam1_bool_ret_u64`) says this is a specialization too, so the
likely fix is the same repair applied to whichever rebind serves a trait method
that carries its own `generic(...)`.

**The re-enabled `-w` diagnostics cannot catch this.** The cast is EXPLICIT —
`(uint64_t)(self)` — so `-Wint-conversion` and `-Wpointer-to-int-cast` both stay
silent. #260's diagnostics catch an IMPLICIT prototype mismatch; this class needs
a test.

## Why it matters beyond the repro

D3.9's decided design is a Rust-style `Hasher`:
`hash : (fn(generic(H : Type), inout(self) : Self, inout(hasher) : H) -> unit)`.
Every primitive `Hash` impl is exactly the broken shape, so the hasher would be
fed addresses instead of values — a hash function that silently hashes stack
addresses. The design round found it by writing the trait and asserting a known
FNV-1a value.

The existing bare-`u64` `Hash` is NOT affected: its impls are non-generic
(`(hash) : ((self) -> u64(self))`), so condition 1 never holds.

## Reproducer

`issues/repros/generic-trait-method-primitive-inout-self.yo` (prints got/want).

## Note on syntax

`inout` goes on the LABEL, not the type: `inout(hasher) : H`, never
`hasher : inout(H)` (the latter fails with `Variable "inout" not found`).
`src/evaluator/types/function.yo:3914` states the rule for return slots.
