# D3.9 — the `Hasher` redesign (Rust-style streaming hashing)

**Status: LANDED 2026-08-28** (this PR). Decided by the user 2026-08-24
(plans/STD_API_AUDIT.md D3.9): "full Rust-style `Hasher` trait" — a hash
method that feeds bytes into a pluggable hasher, streaming `write_*`/`finish`,
seeded algorithms, `derive(Hash)` rework, every impl and both map drivers
rewritten.

## Why the old shape had to go before the stability freeze

`Hash` was `(hash) : (fn(inout(self) : Self) -> u64)`: every type produced its
own `u64` and composites folded them with `h * 31 + field`. That fixes the
algorithm into every impl (a map cannot choose a keyed hash, a program cannot
ask for a faster one), makes composite hashing weak (`h * 31` on already-mixed
words), and hashes variable-length data without a prefix-free boundary.
Changing any of that after the freeze would have been a breaking change to
every user `Hash` impl; the redesign is the last breaking edit to that trait.

## The shape

```rust
Hasher :: trait(
  write : (fn(inout(self) : Self, buf : *(u8), size : usize) -> unit),   // required
  finish : (fn(inout(self) : Self) -> u64),                             // required
  write_u8 / write_u16 / write_u32 / write_u64 / write_usize,            // ?= native-endian bytes via write
  write_i8 / write_i16 / write_i32 / write_i64 / write_isize             // ?= the unsigned twin
);
Hash :: trait(
  hash : (fn(generic(H : Type), inout(self) : Self, inout(hasher) : H, where(H <: Hasher)) -> unit)
);
```

- `write`'s `(buf, size)` pair is the D5 byte-slice convention (`io.Writer`
  uses the same), so a hasher and a writer are spelled alike.
- `finish` is a read-out, not a reset (Rust semantics); `SipHasher13.reset`
  exists for reuse.
- Byte layout per type: integers write their own width (`i32` → 4 bytes,
  `usize`/`isize` → 8, `char` → its `u32`, `bool` → one byte, the C-int
  aliases their C width, `longdouble` keeps its `i64` truncation); `String`
  and `ImmString` write the bytes then `0xFF` (prefix-free, as Rust); `Option`
  writes a `u64` tag (0/1) then the payload, `Result` tag 1/2; `Box` forwards;
  `Duration` writes its nanoseconds as `i64`; `derive(Hash)` writes struct
  fields in order and, for enums, the variant index as `u64` then the fields.
  Floats still do not hash (the no-PartialOrd decision).

## `std/hash`

| export | what |
| --- | --- |
| `SipHasher13` | SipHash-1-3, keyed (`new_with_keys(k0, k1)`), streaming, `write_u64` fast path when no bytes are pending, `reset` |
| `Fnv1aHasher` | FNV-1a 64, unkeyed, for short identifiers |
| `DefaultHasher` | alias of `SipHasher13` — what the maps drive |
| `DEFAULT_KEY_0/1` | the fixed keys (`0, 0`) `new()` starts from |
| `hash_one(v)` / `hash_one_with_keys(v, k0, k1)` | one value → `u64` |

The SipHash-1-3 values are pinned (`tests/hash.test.yo`) against an
independent C implementation written from the algorithm description (key =
bytes 0..15, messages = bytes 0..n−1 for n ≤ 16, plus the default-key
hashes of `""`, `"hello"` and the fox sentence), and the FNV-1a values against
the published offset basis / `"a"` vector.

## Maps: deterministic by default, keyed on request

`HashMap(K, V)` and `HashSet(T)` carry `k0, k1` fields; `new()` uses the fixed
default keys, `with_keys(k0, k1)` keys one instance, `_resize` and `clone`
carry the keys. Every bucket hash goes through the one `_hash(self, key)`
method (`DefaultHasher.new_with_keys(self.k0, self.k1)` → `key.hash(h)` →
`finish`).

**Why not Rust's `RandomState` default.** The compiler is itself a Yo program
whose emitted C is shaped by map iteration in places, and the bootstrap gate
compares stage-2 and stage-3 C byte for byte. Randomised keys would make that
comparison — and any user program that prints a map — differ from run to run
(memory: "FIXPOINT_BROKEN with same-content REORDERED C"). So the default is
deterministic, and HashDoS resistance is opt-in per map: seed `with_keys`
from `std/crypto/random`. Yo has no default type parameters, so the algorithm
is not a type parameter of the map (Rust's `S = RandomState`); it is fixed to
SipHash-1-3 and the keys are the pluggable part.

## Seed gating (why `SipHasher13` spells out every `write_*`)

The compiler is compiled by the SEED release, and the compiler's own
`HashMap`s now run `SipHasher13`. The seed (v0.2.19) still has C43, so a trait
`?=` default with `inout(self)` is miscompiled THERE: the first tree build with
the defaults in play produced a compiler that spun forever in
`__yo_main_module_init` (its map globals hashing through the corrupted
default). Measured: the same `hash_one(String)` program hangs when compiled by
the seed and prints the reference value when compiled by the fixed tree
binary. `SipHasher13` therefore overrides all the narrow `write_*` methods
explicitly (also the faster path — no stack round-trip per integer); the
defaults remain for user hashers and `Fnv1aHasher`, which the compiler never
runs. Once a seed carries C43 the overrides are merely an optimisation.

## Consumers moved with it

- `std/imm/map.yo` (HAMT) hashes keys with `hash_one`.
- `src/expr_info.yo` (`module_global_c_suffix`) and
  `src/codegen/chunk_assembly.yo` (chunk assignment) hash with `hash_one`;
  both are deterministic under the fixed keys, so emitted C is stable across
  runs (its VALUES change once, with the algorithm — that is a one-time
  generation skew, not a fixpoint break).
- Tests that called `x.hash()` (`derive`, `prelude`, `imm_string`,
  `duration`) now call `hash_one(x)`; `imm_map`'s all-colliding key impl uses
  the new signature.

## Compiler bugs fixed on the way

1. `issues/fixed/trait-default-inout-self-bound-by-value.md` — a trait `?=`
   default method's parameters were bound into the per-impl materialized body
   env with `is_ref` unset, so `inout(self)` defaults read `self.field` on a
   pointer (clang error) or passed `&(self)` (a `T**`) to sibling methods — a
   silent wrong value under `-w`. The `Hasher.write_u*` defaults are exactly
   that shape. Fixed in `src/evaluator/values/impl.yo` (the default-fill
   binder now restores `is_ref`/`is_reassignable` from `param_is_ref` and
   marks the binding a parameter).
2. `issues/fixed/generic-trait-method-reads-primitive-inout-self-as-pointer.md`
   — the row's original blocker; measured FIXED by events under v0.2.19 (the
   exact `hash(generic(H), inout(self) : Self, inout(hasher) : H)` shape
   hashes values, not addresses). Pinned by `tests/hash.test.yo`.
3. `issues/fixed/open-import-retypes-integer-constants.md` — `open(import(m))`
   bound every non-function, non-struct export from `type_of_eval_value` of its
   VALUE, so `DEFAULT_KEY_0 :: u64(0)` arrived as `i32` (the named import kept
   `u64`). Fixed in `src/evaluator/exprs/open.yo` (declared type from the
   namespace struct type for every member).
