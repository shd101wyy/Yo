# Safe code reads `MaybeUninit`'s public `value` field before anything was written

**Severity:** S1. In a file with no pragma, `m := MaybeUninit(Dyn(Fn() -> i64)).new(); v := (m.value)();` passes
`yo check` and calls a zero-filled `Dyn` (ASan: SEGV on address 0x48). `m.value.*` on a `MaybeUninit(Box(i64))` and
the derived `m.clone()` dereference a zeroed `Box` (ASan reports a wild jump: `stack-overflow` with the pc on the
stack). Pre-existing: v0.2.76 accepts all three.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A43). Confirmed on develop `64f33c710`.

Related, and neither covers this route:

- `issues/fixed/safe-code-reads-uninitialized-memory-through-maybeuninit-assume-init.md` closed the
  `new().assume_init()` read by making `assume_init` take the `as_ptr()` result as a witness, a raw pointer only
  unsafe-capable code can hold. The payload is still reachable without `assume_init`: the field itself is public.
- `issues/2026-10-23-an-unwritten-maybeuninit-drops-its-payload.md` (open, S2) is the DROP route: the field-drop
  glue runs `T`'s `Drop` on the zeroed payload. Its fix direction (no drop glue for `MaybeUninit`) leaves a field
  read and the derived `Clone` untouched.

## Reproducers

`issues/repros/2026-11-11-safe-code-reads-maybeuninits-public-value-field-before-anything-was-written.yo`
(negative, expects E0405 once the field is private):

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  m := MaybeUninit(Dyn(Fn() -> i64)).new();
  v := (m.value)();
  println(`OUT: ${v.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
==…==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000048
```

- `…-box.yo` (negative, E0405): `v := m.value.*` on `MaybeUninit(Box(i64)).new()`: ASan `stack-overflow`, pc on the
  stack.
- `…-clone.yo` (negative): `c := m.clone()` on the same unwritten `MaybeUninit(Box(i64))`: the derived `Clone`
  clones the zeroed `Box`, same ASan report.
- `…-pos.yo` (positive control): safe code reaches `MaybeUninit` only through std, here `Array.clone` of two
  `String`s, which writes every slot through `as_ptr()` before `assume_init`. Accepted, ASan clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `(m.value)()` on an unwritten `MaybeUninit(Dyn(Fn() -> i64))` | accepted, SEGV | E0405 |
| `m.value.*` on an unwritten `MaybeUninit(Box(i64))` | accepted, wild jump | E0405 |
| `m.clone()` on an unwritten `MaybeUninit(Box(i64))` | accepted, wild jump | rejected (no `Clone`) |
| `m.value.len()`, `m.clone()` on an unwritten `MaybeUninit(String)` (ledger) | accepted, reads a zeroed `String` (benign today) | E0405 / no `Clone` |
| an unwritten `MaybeUninit(String)` going out of scope (ledger) | accepted, drop on zeroed bytes | the open S2 above |
| `m.assume_init(w)`: `w` must be the `as_ptr()` raw pointer, which safe code cannot hold (the fixed issue) | rejected | rejected |
| `Array.clone`, `Array.fill` (std's own `MaybeUninit` users) | accepted, clean | accept |

## Root cause

Confirmed by reading `std/prelude.yo` ("MaybeUninit"): the type is `newtype(value : BaseType)`, and `value` has no
`_` prefix, so the member-visibility rule (E0405, a `_` member is private to its declaring module) does not apply
and any module may read it. `__yo_maybe_uninit_new` zero-fills the slot (per the open drop issue), which turns the
read into a defined-looking zero for scalars and `String` and into a null vtable or null `Box` for handle types.
The prelude also derives `Clone` for `MaybeUninit(T)` where `T <: Clone`, and that `clone` reads `self.value`. The
fixed `assume_init` gate guarded the documented API and left the field, the derived `Clone`, and the field-drop
glue as three undocumented routes to the same payload.

## Expected

Safe code cannot observe an uninitialized `MaybeUninit` payload (the safe-mode promise the `assume_init` fix
restored; Rust's `MaybeUninit<T>` has no public field and its only reads are `unsafe`). The payload field is
private to the prelude (`_value`, E0405 outside it), and `Clone`/`Copy` are derived only for `T <: Copy`, as
Rust's `impl<T: Copy> Clone for MaybeUninit<T>`: a bitwise copy of a zero-filled slot reads no handle. Std's users
(`Array.fill`, `Array.clone`, `Array.default`, `std/process/command.yo`, `std/sys/tty.yo`) go through `as_ptr()` and
`assume_init` and are unaffected.

## Test

With the fix: `tests/member_visibility.test.yo` (which already probes `MaybeUninit._probe`) gains `m.value` from a
foreign module (E0405); the two negative field reads and the `clone` program go to `tests/origins/unsound/`, and the
positive control stays accepted.

## Fix (2026-11-13, lane `sig`, branch `fix/sig-2`)

`std/prelude.yo`: the payload field is `_value`, private to the prelude (E0405 elsewhere), and `MaybeUninit` derives
neither `Clone` nor `Copy`. The Rust shape (`Clone`/`Copy` for a `Copy` payload only) was tried first and does not
hold in Yo today: a method call ignores a generic impl's `where` clause, so the bounded derive still cloned
`MaybeUninit(Box(i64))`. That defect is filed separately
(`issues/2026-11-13-a-method-call-ignores-a-generic-impls-where-clause.md`, S2). `Copy` requires `Clone`
(decision 36), so both derives go. No std or src code copied or cloned a `MaybeUninit`.

The G-B rows are `tests/origins/unsound/maybe-uninit-field-read.yo`, `maybe-uninit-field-read-box.yo` (E0405) and
`maybe-uninit-clone.yo` (E0610), with the positive control `maybe-uninit-field-read-pos.yo`. The drop route stays
the open `issues/2026-10-23-an-unwritten-maybeuninit-drops-its-payload.md`.
