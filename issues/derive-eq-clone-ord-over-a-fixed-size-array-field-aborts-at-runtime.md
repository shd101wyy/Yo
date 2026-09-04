# `derive(Eq)` / `derive(Clone)` / `derive(Ord)` on a type with an `Array(T, N)` field passes `yo check`, links, and `abort()`s at runtime

**Status: OPEN.** **Class**: crash — `yo check` says OK, `yo compile` exits 0,
and the binary dies with SIGABRT (rc=134) and no diagnostic of any kind.

**Found**: 2026-09-04, measuring the `net` row of the std API audit. The row
asks for `Eq`/`Hash`/`Ord`/`Clone` on `IpAddr`, whose `V6` payload is
`Array(u16, usize(8))` (`std/net/addr.yo:31`), on the premise that these are
"a derive away". They are not.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

My :: enum(V4(a : u8), V6(segments : Array(u16, usize(8))));
derive(My, Eq(My));

main :: (fn() -> unit)({
  s := Array(u16, usize(8)).fill(u16(0));
  s(usize(7)) = u16(1);
  x := My.V6(s);
  y := My.V6(s);
  unsafe(printf("before compare\n"));
  cond(
    (x == y) => { unsafe(printf("equal\n")); },
    true => { unsafe(printf("not equal\n")); }
  );
});
export(main);
```

Observed (`yo 0.2.24`):

```
$ yo check derive_eq_array.yo --std-path ./std
check: derive_eq_array.yo — evaluator OK

$ yo compile derive_eq_array.yo --std-path ./std --optimize 2 -o dea.out
Using system allocator                                   # rc=0, no diagnostic

$ ./dea.out
before compare
$ echo $?
134
```

Expected: a compile-time error naming the missing `Eq` impl on
`Array(u16, 8)`.

The same three lines reproduce for `derive(My, Clone)` (prints `before clone`,
rc=134) and for `derive(My, Ord(My))` after the required prior `Eq` derive
(prints `before cmp`, rc=134).

`derive(My, Hash)` is the control, and it behaves correctly — it is a hard
`yo check` error:

```
error: No matching call found with arguments:
(__v_segments.hash)(hasher)
  --> auto-generated://
// === START auto-generated code ===
{ match(self,
    .V4(__v_a) => { hasher.write_u64(u64(0)); __v_a.hash(hasher); },
    .V6(__v_segments) => { hasher.write_u64(u64(1)); __v_segments.hash(hasher); }
  ); }
// === END auto-generated code ===
```

## Root cause

Three mechanisms stack. All three are needed to turn a missing impl into a
silent runtime abort.

**1. `Array(T, N)` has no `Eq` / `Ord` / `Clone` / `Hash` impl at all.**
`std/prelude.yo:5695-5698` gives it exactly four:

```rust
impl(generic(T : Type, U : usize), where(T <: Send), Array(T, U), Send());
impl(generic(T : Type, U : usize), Array(T, U), Acyclic());
impl(generic(T : Type, U : usize), where(T <: Comptime), Array(T, U), Comptime());
impl(generic(T : Type, U : usize), where(T <: Runtime), Array(T, U), Runtime());
```

So the derive rules — `__derive_eq` (`std/prelude.yo:6782`), `__derive_clone`
(`:6893`), `__derive_ord` (`:7137`) — generate a body that compares, clones or
orders a field whose type implements none of it.

**2. The derive rule's body is evaluated in a def-time trial that SWALLOWS the
error.** `YO_DEBUG_SWALLOW=1 yo compile … --emit-c --skip-c-compiler` on the
`Clone` case shows the error being raised and dropped:

```
[anon-trial] auto-generated://
// === START auto-generated code ===
match(self,
    .V4(__v_a) => .V4(__v_a.clone()),
    .V6(__v_segments) => .V6(__v_segments.clone())
  )
// === END auto-generated code ===
[anon-swallow] error: No matching call found with arguments:
(__v_segments.clone)()
```

Note that this is the *same* error class the `Hash` derive reports as fatal —
so the failure mode is inconsistent between derive rules, not inherent to the
missing impl.

**3. For `Eq` and `Ord` the underlying error is softer still, because `==` on a
type with no `Eq` impl evaluates to `unit` instead of erroring.** The swallowed
causes reported for the `Eq` case are

```
[swallow] error: Expected bool type for "and" argument, got:
[swallow] error: Expected enum type or primitive type (integer, bool) for match expression, got unit
```

i.e. the generated `&&` chain got a `unit` where it wanted a `bool`. That
`==`-yields-`unit` behaviour is a defect in its own right and is filed
separately as
`issues/equality-operator-without-an-eq-impl-evaluates-to-unit.md`; fixing it
removes the softest of the three failure paths.

The swallowed body then reaches codegen as an untranspilable function, and
codegen rewrites it to an `abort()` stub guarded by
`__attribute__((error(…)))` (`src/codegen/functions/generation.yo:826`). That
guard is supposed to fail the build at every surviving call — and it does at
`--optimize 0`:

```
$ yo compile derive_eq_array.yo --std-path ./std --optimize 0 -o dea0.out
dea0.out.c:1415:34: error: call to 'fn_yo_id_7544' declared with 'error' attribute:
  yo: the body of fn_yo_id_7544 failed to transpile — its definition-time evaluation
  failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would
  abort at runtime
```

but not at `--optimize 2`, which is what the repo builds with. That is the
third defect, filed separately as
`issues/ftt-abort-stub-error-attribute-does-not-fire-above-optimize-0.md`.

## Fix

Two independently useful halves. Both are wanted; neither alone is sufficient.

**(a) Give `Array(T, N)` the missing generic impls** in `std/prelude.yo`, next
to the four at `:5695-5698`:

```rust
impl(generic(T : Type, N : usize), where(T <: Eq(T)),    Array(T, N), Eq(Self)(…));
impl(generic(T : Type, N : usize), where(T <: Ord(T)),   Array(T, N), Ord(Self)(…));
impl(generic(T : Type, N : usize), where(T <: Clone),    Array(T, N), Clone(…));
impl(generic(T : Type, N : usize), where(T <: Hash),     Array(T, N), Hash(…));
```

each a straight element loop over `N`. **This is currently blocked**: the `Eq`
impl type-checks and specializes, but the `==` operator call site emits
`(// Unknown type: Array(u16, N))` into the argument cast and the C does not
compile — see
`issues/array-const-generic-length-unresolved-in-the-operator-call-cast.md`.
That codegen bug must land first.

**(b) Make a swallowed derive-rule failure fatal at the derive site.** A derive
rule is generated code with no user to blame, so there is no reason for its
definition-time evaluation to be a swallowing trial at all. The precedent is
the C18/C19 fix, which flags a flow violation before throwing so that an async
closure's swallowed def-eval error re-raises at check time. The message should
name the derive and the offending field, e.g.
`derive(Eq) on My: field "segments" of type Array(u16, 8) has no Eq impl`.

Do NOT make FTT markers globally fatal instead — that was tried and reverted
(`tests/fn.test.yo` and `tests/algebraic_effects.test.yo` carry markers in dead
superseded-generic code); see
`issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`.

**In the meantime, `std/net/addr.yo` must hand-write its impls, not derive
them** — which is also what `std/path.yo` did for `Path` — `Eq` at `:636`, `Clone` at
`:689`, `Hash` at `:713`, `Ord` at `:740`, all four hand-written and none
derived.

## Breaking change

No. Adding the `Array` impls is additive, and half (b) turns a program that
aborts at runtime into one that fails to compile — code that was already broken.

## Regression test

- `tests/derive.test.yo`: a type with an `Array(T, N)` field that derives `Eq`,
  `Ord`, `Clone` and `Hash`, compares equal/unequal values, clones, sorts and
  hashes. This test is impossible today and is the real proof of half (a).
- `tests/array.test.yo`: `Array(i32, 4) == Array(i32, 4)` directly, plus
  `.clone()`, `.cmp()` and a `HashMap(Array(u8, 4), i32)` insert+lookup — the
  last is the only test that proves `Eq` and `Hash` agree.
- A NEGATIVE test for half (b): a type with a field whose type implements
  nothing (`NoEq :: struct(x : i32)` nested in another struct) that derives
  `Eq` must be a HARD compile error, not an `abort()`. Verify it is red today
  (it exits 134).
