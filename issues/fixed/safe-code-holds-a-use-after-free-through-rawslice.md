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

`_surfaces_raw_pointer` now recurses: a struct surfaces a raw pointer when any
PUBLIC (`_`-prefixed names are private to their declaring module) field's type
surfaces one, and an enum when any public variant payload field's type does —
depth-capped at 8. `rs := s.raw_bytes()` in a safe file is now:

```
error: Raw pointer values are not available in safe code: '(s.raw_bytes)()' has type 'RawSlice(u8)'.
```

`String.raw_bytes()` and `random_bytes` themselves are unchanged — they stay
privileged plumbing (`std/path.yo`, `std/log.yo` use them inside pragma'd
files). Nothing else in std produces a `RawSlice` or takes one as a parameter.

**Design note — the fix's first cut broke 238 of the compiler's own src
files.** Keying the struct walk on field visibility alone surfaced
`HashMap(String, String).new()` in every file without `AllowUnsafe`:
HashMap's `ctrl : ?(*(u8))` field is PUBLIC BY ACCIDENT (its own Stability
note says so), and an enum wrapping a pointer is one of the shapes that
surfaces. The distinction that holds: reference-semantics structs
(`ref(struct(...))`, every RC-managed container) are exempt — the same call
`type_representation_contains_raw_ptr` makes — because the runtime owns the
lifetime and pointer fields are interior state behind the type's methods
(reading `m.ctrl` is itself gated). The bare-view handout is always a PLAIN
struct: a view is copied, not RC-managed. `tests/safe_code_structural_gates.test.yo`
pins both sides (holding a HashMap is fine; reading `m.ctrl` is not).

## Verification

- `tests/safe_code_structural_gates.test.yo` (a pragma-LESS file) pins
  `comptime_expect_error(String.from("hi").raw_bytes())` — red before the fix,
  green after.
- The reproducer above fails to compile in safe mode and still compiles (and
  runs) with `pragma(Pragma.AllowUnsafe);` added.
- The fast suite (`yo test ./tests --exclude tests/internal --exclude
  tests/cli-cases`) stays green: the only safe-code holders of
  pointer-carrying structs were the ones this closes.
