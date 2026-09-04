# `derive(T, Ord(T))` without a prior `derive(T, Eq(T))` kills module evaluation and blames the type's next use

**Status: OPEN.** **Class**: api-lie — `yo check` reports the module OK, and
`yo compile` then reports `Variable "T" not found` at a line where `T` is
perfectly in scope. The real error — an unsatisfied `where(Self <: Eq(Rhs))` on
the `Ord` trait — is never shown.

**Found**: 2026-09-04, measuring the `net` row of the std API audit.

**Related**: `issues/bare-derive-form-kills-module-eval.md` records the same
*surfaced* symptom for a different trigger (the parameterless form
`derive(Point, Eq)`). This is a second trigger with a different cause, and the
fix below is a different fix; the two should be closed together, since the
containment measure — never let a derive rule's failure escape as a
module-level death — is shared.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));

My :: enum(V4(a : u8), V6(x : u16));
derive(My, Ord(My));

main :: (fn() -> unit)({
  x := My.V4(u8(1));
  y := My.V4(u8(2));
  cond(
    (x < y) => { unsafe(printf("lt\n")); },
    true => { unsafe(printf("ge\n")); }
  );
});
export(main);
```

```
$ yo check ord_no_eq.yo --std-path ./std
check: ord_no_eq.yo — evaluator OK

$ yo compile ord_no_eq.yo --std-path ./std --optimize 2 -o one.out
error[E0401]: Variable "My" not found.
   --> ord_no_eq.yo:10:8
   |
10 |   x := My.V4(u8(1));
   |        ^^
help: did you mean "Rc"?
```

`My` is defined four lines above the reported line. What actually happened is
that the whole module's evaluation died at the `derive`, so by line 10 only the
prelude environment survives — hence the "did you mean `Rc`?".

A struct is identical:

```rust
S :: struct(a : u8);
derive(S, Ord(S));
```

```
error[E0401]: Variable "S" not found.
   --> ord_struct.yo:10:8
help: did you mean "!"?
```

Adding `derive(My, Eq(My));` *before* the `Ord` derive makes both work (the
binary prints `lt`). That is why `tests/derive.test.yo:58` and `:144` pass — the file
derives `Eq` first, at `:9` for `Point` and `:119` for `Direction`.

## Root cause

`Ord` constrains its `Self` to be `Eq` — `std/prelude.yo:643-667`, whose trait
body ends with the constraint at `:666`:

```rust
    where(Self <: Eq(Rhs))
```

So `impl(My, Ord(My))` without an `Eq(My)` impl violates a where clause. The
evaluator detects this correctly; the problem is only that a DERIVE swallows the
diagnostic while a hand-written impl does not.

Written by hand, the same violation is reported perfectly — right message,
right anchor:

```rust
S :: struct(a : u8);
impl(
  S,
  Ord(S)(
    (<) : (fn(lhs : Self, rhs : S) -> bool)(lhs.a < rhs.a),
    (<=) : (fn(lhs : Self, rhs : S) -> bool)(lhs.a <= rhs.a),
    (>) : (fn(lhs : Self, rhs : S) -> bool)(lhs.a > rhs.a),
    (>=) : (fn(lhs : Self, rhs : S) -> bool)(lhs.a >= rhs.a)
  )
);
```

```
error: Type "S" does not implement required constraint "(== : fn(lhs : Self, rhs : S) -> bool, != : fn(lhs : Self, rhs : S) -> bool)" from trait ""'s where clause.
  --> ord_manual.yo:7:1
  |
7 | impl(
  | ^^^^
```

Same violation, same compiler, one useful error and one useless one. The
difference is that `__derive_ord` (`std/prelude.yo:7137`, registered at
`:7255`) builds the `impl(...)` as generated code that is evaluated inside the
def-time trial, which discards the throw; the module-level evaluation then
aborts without ever binding `My`/`S`, and the first later reference to the type
becomes the reported error.

(The `where(...)` clause is also the one place the constraint is written down —
the `Ord` doc comment does not mention needing `Eq`, and neither does
`tests/derive.test.yo`.)

## Fix

Two parts. Do both.

1. **Diagnose the missing supertrait at the derive site.** `__derive_ord`
   already receives the target type; before emitting the `impl`, check that an
   `Eq` impl for it is registered and, if not, fail with a message that names
   the cure:
   `derive(Ord) on My requires Eq — add derive(My, Eq(My)) first`.
   The same shape applies to any future derive rule for a trait with a `where`
   clause on `Self`, so implement it generically from the trait's constraint
   list rather than special-casing `Ord`.

2. **Stop a derive rule's failure from becoming a module-level death.** The
   generated `impl` must be evaluated in a context that re-raises rather than
   swallows, anchored at the `derive(...)` statement. Precedent: the C18/C19
   fix flags a flow violation before throwing so a swallowed def-eval error
   re-raises at check time. Without this part, the next unanticipated derive
   failure produces the same lying `Variable "X" not found`, and `yo check`
   will keep reporting the module as OK.

Part 2 is the shared half with
`issues/bare-derive-form-kills-module-eval.md` — that issue's `derive(Point,
Eq)` splices an invalid `Eq()` trait application and dies the same way. Fixing
part 2 makes both errors land at the `derive`, and each then needs its own
message (part 1 here; "derive: trait arguments required" there).

## Breaking change

No — both parts only replace a misleading error with an accurate one.

## Regression test

`tests/derive.test.yo`:

- `derive(S, Ord(S))` on a struct with no `Eq` impl must be a compile error
  whose message names `Ord`, `Eq` and `S` — verify it is red today (today it
  reports `Variable "S" not found`).
- The same for an enum.
- `derive(S, Eq(S)); derive(S, Ord(S));` must keep working, and so must the
  combined form `derive(S, Eq(S), Ord(S))` — the over-rejection canary.
- `yo check` on the failing case must FAIL. Today it prints "evaluator OK",
  which is the part that lets this reach `yo compile` at all.
