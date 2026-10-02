# Safe code holds a use-after-free through `String.raw_bytes() -> RawSlice(u8)`

**Severity:** S1 — a file with no `pragma(Pragma.AllowUnsafe);` writes into freed
heap memory (a 100%-safe-file heap-use-after-free WRITE, proven under ASan)

**Found**: 2026-10-01, by the safe-mode handover §3.2 audit
(`plans/SAFE_MODE_HANDOVER.md`): "the safe-mode gate keys on raw pointers in a
signature, so any public std function whose *behavior* is unsafe but whose
*type* is pointer-free slips through." **Fixed**: same day, by teaching the
raw-pointer value gate to see through structs with a PUBLIC pointer field.

## Symptom

`RawSlice(T)` is `struct(ptr : *(T), len : usize)` — its `ptr` field is PUBLIC.
The value gate (`_surfaces_raw_pointer`, `src/evaluator/exprs/_expr.yo`) checked
`*(T)` and an enum wrapping one, but deliberately NOT structs, on the theory
that "only privileged code can read the field out — that read is itself a
pointer-typed expression and is gated." The theory misses that safe code never
needs to read the field: it can pass the whole struct to a public function that
uses the pointer inside. `String.raw_bytes()` produces one and
`std/crypto/random.random_bytes(buf : RawSlice(u8))` consumes it — both with
pointer-free signatures as written at the call site.

This file — no pragma, nothing gated — compiles clean and then writes 36 random
bytes into freed memory:

```rust
{ String } :: import("std/string");
{ random_bytes } :: import("std/crypto/random");
{ Exception } :: import("std/error");

main :: (fn() -> unit)({
  exn := Exception(throw : (err -> { unwind(()); }));
  s := String.from("hello world, this is a longer string");
  rs := s.raw_bytes();
  s.clear();
  s.push_str("another string long enough to force a fresh allocation and free the old buffer entirely");
  random_bytes(rs, exn);
});
export(main);
```

```
$ yo compile probe_uaf.yo --sanitize address --allocator system -o probe_uaf && ./probe_uaf
=================================================================
==2839232==ERROR: AddressSanitizer: heap-use-after-free on address 0x7b482d8e2010
WRITE of size 36 at 0x7b482d8e2010 thread T1
0x7b482d8e2010 is located 0 bytes inside of 36-byte region [0x7b482d8e2010,0x7b482d8e2034)
freed by thread T-1 here:
```

The free is `push_str`'s reallocation of the string's byte buffer; `rs.ptr`
still points into it. `RawSlice`'s own doc says "for PRIVILEGED (pragma'd)
code" and the prelude annotates the parameter gate accordingly — but nothing
enforced it on the value path.

## Root cause

The gate's struct exemption treated "field read is gated" as equivalent to
"value is inert". It is not: a PUBLIC pointer field makes the struct a bare
view — safe code can hand it to any public function taking the same struct
type, and that function reaches the pointer for you. The distinction that
makes std's managed types safe is that their pointer fields are PRIVATE
(`_`-prefixed, module-private per E0405): `ArrayList._ptr`, iterator `_ptr`,
`JoinHandle`'s internals. `RawSlice.ptr` is public, which is precisely the bare
view shape.

## Fix

`String.raw_bytes()` is deleted; the raw view is `String.ptr() ->
?*(u8)` — `ArrayList.ptr()`'s exact shape. The POINTER result is the
gate: a raw pointer value is a compile error in safe code (the existing
value gate), so a safe file cannot hold the buffer at all. `std/path.yo`'s
Hash impl, `std/imm/string.yo`'s `from_string` and `tests/str.test.yo` were
the only callers (all privileged) and now take `ptr()` + `.len()`
themselves.

## Why the fix is per-API, not a wider gate (two measured attempts)

The obvious "class fix" — teach the value gate to see through structs whose
pointer fields are public — is NOT sound, because public-pointer-field does
not mean unsafe:

- **Cut 1** surfaced `HashMap(String, String).new()` in 238 of the
  compiler's own src files: HashMap's `ctrl : ?(*(u8))` field is PUBLIC BY
  ACCIDENT (its Stability note says so). Exempting reference-semantics
  structs (the call `type_representation_contains_raw_ptr` makes) fixed
  that…
- **Cut 2** (ref-structs exempt, private fields skipped) broke every safe
  user of `Allocator` — `arena.allocator()` in `tests/string/string_builder.test.yo`
  and 58 suite failures: Allocator is a plain struct of function pointers
  with public fields, safe by design.

A managed container's pointer field is interior state behind its methods
(HashMap), and a function-pointer table is behavior, not memory
(Allocator); only RawSlice is a bare view. That distinction is semantic,
not structural, so the gate stays shallow (`*(T)` + an enum wrapping one)
and each API that hands out storage gets the pointer-shaped signature the
gate already understands — exactly the #1076 spare-capacity precedent
("a `RawSlice` token was measured passing through safe code"). The
`random_bytes(RawSlice)` sink stays reachable only from files that can
construct a RawSlice, i.e. privileged ones.

## Verification

- `tests/safe_code_structural_gates.test.yo` (a pragma-LESS file) pins
  `comptime_expect_error(String.from("hi").ptr())` — red before the fix
  (the `raw_bytes()` spelling compiled), green after; plus boundary pins
  that HOLDING a HashMap stays legal while reading its `ctrl` field stays
  gated.
- The reproducer above fails to compile in safe mode and still compiles
  (and runs, ASan-clean) with `pragma(Pragma.AllowUnsafe);` added — the
  privileged shape passes the pointer explicitly.
