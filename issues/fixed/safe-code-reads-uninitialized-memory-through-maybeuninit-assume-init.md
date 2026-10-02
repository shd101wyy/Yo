# Safe code reads uninitialized memory through `MaybeUninit.assume_init`

**Severity:** S1 — a file with no `pragma(Pragma.AllowUnsafe);` executes a read
of uninitialized memory (UB the API's own doc promises)

**Found**: 2026-10-01, by the safe-mode handover §3.2 audit
(`plans/SAFE_MODE_HANDOVER.md`): `assume_init*` is one of the audited
"pointer-free signature, unsafe behavior" classes; `ArrayList.set_len` was the
S1 that motivated the audit, and this is its prelude-side sibling. **Fixed**:
same day, with the same token technique #1075/#1076 established for
`ArrayList.assume_init(n, spare)`.

## Symptom

`MaybeUninit(T)`'s three members are all reachable from safe code:
`new() -> Self` and `assume_init(own(self) -> BaseType)` have pointer-free
signatures, and `as_ptr()` — the one gate that fires — is never needed on the
UB path. The method's own doc says "**Undefined behavior if not initialized**"
(Rust's `assume_init` is an `unsafe fn` for exactly this reason), yet this file
compiles clean with no pragma:

```rust
main :: (fn() -> unit)({
  m := MaybeUninit(i64).new();
  v := m.assume_init();
  println(v);      // prints whatever bytes the uninit slot held
});
export(main);
```

The legitimate use — allocate, get `as_ptr()`, let FFI write through it, then
`assume_init` — already holds the pointer; only the UB shortcut needed
nothing.

## Root cause

Same class as `set_len`: the safe-mode gate is type-based, and neither
`new()`'s result type (`MaybeUninit(T)` wraps `BaseType`, no pointer) nor
`assume_init`'s signature mentions `*(T)`, so nothing on the `new().assume_init()`
path ever surfaces a raw pointer.

## Fix

`assume_init` now takes the `as_ptr()` result as a witness — a pointer only
unsafe-capable code can hold, exactly `ArrayList.assume_init(n, spare : *(T))`'s
shape:

```rust
m := MaybeUninit(time_t).new();
p := m.as_ptr();
time(.Some(p));
timer := m.assume_init(p);
```

The witness is not inspected (privileged code can already do anything; the gate
is the point). Every caller in the tree already held the pointer: prelude's
`Array.fill` and `tests/prelude.test.yo` both call `as_ptr()` first; the
`tests/sys/*` FFI tests read through the raw pointer and never call
`assume_init` at all.

**Why the extern declaration also gained a `witness` parameter** (the shape is
load-bearing, and a first cut without it broke the bootstrap): the seed lowers
`assume_init` through the inline-builtin-alias rule
(`src/codegen/utils/index.yo` — "a wrapper is transparent exactly when its
parameters, in order, are what the builtin's value slots should receive"), and
the alias emitter renders `args[0]` of the CALL SITE. A two-parameter method
whose body calls `__yo_maybe_uninit_assume_init(Self, BaseType, self)` is NOT
transparent (the body's value args `[self]` ≠ params `[self, written]`), so it
is emitted as a real C function — and its body's DIRECT extern call hits the
alias-only emitter, which renders the first body argument, the comptime `Self`
TYPE, as a value: `return (__yo_t_...);` — invalid C, `Array.fill` failed the
C compile under the seed (measured). Passing the witness through to the extern
(`..., self : _Self, witness : *(BaseType))`) restores `[self, written] ==
[self, written]`: the method is transparent again, call sites inline to
`((mu))` under the seed and the tree alike, and the emitter never sees the
type arguments. A `_assume_init_plain` one-parameter back door kept the seed
shape but was measured STILL CALLABLE from a safe file — prelude methods carry
no visibility owner (`issues/prelude-methods-have-no-visibility-owner.md`) —
and was removed.

## Verification

- `tests/safe_code_structural_gates.test.yo` pins
  `comptime_expect_error(m.assume_init())` — red before (no error), green
  after (arity error: the pointer-free spelling no longer exists).
- `tests/prelude.test.yo`'s "Test 'MaybeUninit'" runs the privileged round
  trip with the witness and still checks consumption (`own`) with
  `comptime_expect_error`.
