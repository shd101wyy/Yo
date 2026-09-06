# `derive(T, Ord(T))` without a prior `derive(T, Eq(T))` kills module evaluation and blames the type's next use

**Status: FIXED 2026-09-05.** **Class**: api-lie — `yo check` reported the module
OK, and `yo compile` then reported `Variable "T" not found` at a line where `T`
was perfectly in scope. The real error — an unsatisfied `where(Self <: Eq(Rhs))`
on the `Ord` trait — was never shown.

**Found**: 2026-09-04, measuring the `net` row of the std API audit.

**Related**: `issues/fixed/bare-derive-form-kills-module-eval.md` records the same
*surfaced* symptom for a different trigger (the parameterless form
`derive(Point, Eq)`). They were closed together, by the shared containment
measure — never let a derive rule's failure escape as a module-level death.

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

## Fix (LANDED 2026-09-05)

Part 2 — the shared containment — is what landed, and it subsumes part 1: with
the real diagnostic surfaced, the error already names `My`, names the missing
`(==, !=)` constraint, and points at the `derive`.

`call_registered_derive_rule` (`src/evaluator/builtins/derive.yo`) used
`evaluate_expression` for the final `impl(...)` evaluation. That is the wrapper
with NO outer `exn` — it swallows the throw and hands back an error node — so
the module walk continued with a clobbered env and the first later reference to
the type became the reported error. The impl is now evaluated under a LOCAL
swallowing exception (`_derive_eval_impl`, the `_trial_eval_anon_body` pattern)
whose message is parked in a module-level box and RE-RAISED through the derive's
own `exn`, anchored at the trait argument's token:

```
error: derive on "My" failed: error: Type "My" does not implement required
constraint "(== : fn(lhs : Self, rhs : My) -> bool, != : fn(lhs : Self, rhs : My)
-> bool)" from trait ""'s where clause.
  --> ord_no_eq.yo:7:12
  |
7 | derive(My, Ord(My));
  |            ^^^
```

and `yo check` now FAILS on it instead of printing "evaluator OK".

Part 1 as written (a bespoke `derive(Ord) on My requires Eq — add derive(My,
Eq(My)) first` message synthesised from the trait's constraint list) was NOT
implemented: it would restate what the surfaced constraint error already says.

### Scope of the containment

This covers failures raised while the generated `impl(...)` is REGISTERED —
where-clause violations, invalid trait applications. It does NOT cover a failure
raised inside a generated method BODY: those are eaten one level lower, by the
anonymous-function definition-time trial wall, and still reach codegen as an
`abort()` stub. `Outer :: struct(n : NoImpl); derive(Outer, Eq(Outer))` where
`NoImpl` has no `Eq` still compiles and aborts at runtime. Its root cause is
`issues/equality-operator-without-an-eq-impl-evaluates-to-unit.md` (a `==` with
no impl evaluates to `unit` instead of erroring), which is filed separately and
still open.

## Breaking change

No — both parts only replace a misleading error with an accurate one.

## Regression test (LANDED)

`tests/derive.test.yo`, at MODULE level — `comptime_expect_error` around a
`derive` inside a `test(...)` body is inert (the derive early-returns when
`is_executing` is false and the wrapper then reports "Expected compile error,
but the expression was evaluated successfully"); at module level it observes the
throw. Verified non-vacuous: the same wrapper around a VALID derive fails.

- `derive(OrdNoEqStruct, Ord(OrdNoEqStruct))` with no `Eq` impl — rejected.
- `derive(OrdNoEqEnum, Ord(OrdNoEqEnum))` — the enum shape, rejected.
- `derive(BareTraitArg, Eq)` — the bare form, rejected (the sibling issue).
- Over-rejection canaries: `derive(S, Eq(S)); derive(S, Ord(S));` and the
  combined `derive(S, Eq(S), Ord(S))` both still order and compare.
