# Rust-shaped trait and operator spellings get no useful help: `derive(P, PartialEq)`, `derive(P, Eq)`, `where(T <: Ord)`, `flags & !mask`, and `-b` on a moved value

**Severity:** S3 — five misleading or missing diagnostics for the spellings a Rust-trained model writes first; every program is correctly rejected, and the error does not say what to write instead.

**Found:** 2026-11-26, VERDICTS-87, probes `d1`, `d3`, `d4`, `r3`, `u2`.
**Measured:** `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`), `--std-path` of develop `030d63040`.

Yo's `Eq(Rhs)` and `Ord(Rhs)` are parametric and there is no `PartialEq`/`PartialOrd` split (D3.3); the diagnostics have a Rust-name hint table (`rust_std_name_hint`, `src/diagnostics.yo`) that these five paths do not reach.

## 1. `derive(P, PartialEq, …)`: uncoded, ignores the hint table

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

P :: struct(x : i32);
derive(P, PartialEq, Eq, PartialOrd, Ord, Hash, Clone);

main :: (fn() -> unit)({
  a := P(x : i32(1));
  println(`${(a == a)}`);
});
export(main);
```

```text
error: derive: trait 'PartialEq' does not have a derive rule. Use derive_rule() to register one.
  --> ./d4-derive-rust-list.yo:4:11
  |
4 | derive(P, PartialEq, Eq, PartialOrd, Ord, Hash, Clone);
  |           ^^^^^^^^^
yo: error: check: 1 file(s) failed evaluator coverage
```

No error code, and the advice ("register a derive rule") is for a library author. `src/evaluator/builtins/derive.yo` ~495 builds this message without consulting `rust_std_name_hint`, which already maps `PartialEq` to `Eq(T)` elsewhere.

## 2. `derive(P, Eq, Ord, …)`: E0603 pointing into the prelude

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

P :: struct(x : i32);
derive(P, Eq, Ord, Hash, Clone);

main :: (fn() -> unit)({
  a := P(x : i32(1));
  b := P(x : i32(2));
  println(`${(a == b)} ${(a < b)}`);
});
export(main);
```

```text
error[E0603]: derive on "P" failed: Argument count mismatch: expected 1, got 0
     --> /home/yiyiwang/Workspace/Yo-wt/v87-file/std/prelude.yo:8711:11
     |
8711 |           Eq(unquote_splicing(trait_params))(
     |           ^^
help: run `yo explain E0603` for more information
  --> ./d1-derive-bare-eq.yo:4:11
  |
4 | derive(P, Eq, Ord, Hash, Clone);
  |           ^^
help: run `yo explain E0603` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

The first location is the prelude's derive rule; the user's span is the second. `derive(P, Eq(P))` (the working spelling, probe `d2`) is never named.

## 3. `where(T <: Ord)`: uncoded

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

bigger :: (fn(generic(T : Type), a : T, b : T, where(T <: Ord)) -> bool)(a > b);

main :: (fn() -> unit)({
  println(`${bigger(i32(2), i32(1))}`);
});
export(main);
```

```text
error: Expected trait type for right-hand side of where clause constraint.
  --> ./d3-bound-bare-ord.yo:3:59
  |
3 | bigger :: (fn(generic(T : Type), a : T, b : T, where(T <: Ord)) -> bool)(a > b);
  |                                                           ^^^
yo: error: check: 1 file(s) failed evaluator coverage
```

`Ord` is a function from a type to a trait here; the message says neither that nor `Ord(T)`.

## 4. `flags & !mask`: E0610 with no mention of `~`

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  flags := u32(255);
  mask := u32(15);
  cleared := (flags & !mask);
  println(`${cleared}`);
});
export(main);
```

```text
error[E0610]: No matching call found with arguments:
!(mask)
  --> ./r3-not-mask.yo:6:23
  |
6 |   cleared := (flags & !mask);
  |                       ^
help: run `yo explain E0610` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

Rust's `!` on an integer is `~` in Yo (`BitNot`); `!` yields `bool` (`LogicalNot`) and is defined only on `bool`-like operands. The error should name `~`. (If `issues/fixed/2026-11-26-should-bang-on-a-number-be-deleted.md` is accepted, `!` at any numeric slot lands here.)

## 5. Unary `-` on a moved value: E0610 instead of E0901

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

V :: struct(x : i32);
take :: (fn(v : V) -> i32)(v.x);
impl(V, Negate(Output : V, neg : (fn(self : Self) -> Self.Output)(V(x : (i32(0) - self.x)))));

main :: (fn() -> unit)({
  b := V(x : i32(3));
  k := take(b);
  n := -b;
  println(`${n.x} ${k}`);
});
export(main);
```

```text
error[E0610]: No matching call found with arguments:
-(b)
  --> ./u2-neg-moved.yo:9:8
  |
9 |   n := -b;
  |        ^

yo: error: check: 1 file(s) failed evaluator coverage
```

`b` was moved into `take`; the binary operators and a method call report the use of a moved value (E0901). The unary dispatcher's failed candidate match hides it behind "no matching call".

## Fix

VERDICTS-87 PR C (`plans/backlog/STD_RUST_ALIGNMENT.md` §9): `derive` consults the Rust-name table (`PartialEq` says `Eq(P)`, `PartialOrd` says `Ord(P)`); a bare `Eq`/`Ord` in a derive or a bound says "write `Eq(P)` / `Ord(T)`"; `!` at an integer slot names `~`; a moved operand of a unary operator reports E0901.

## Tests to add with the fix

Cli-case goldens (`tests/cli-cases/`, one per spelling, recorded with `scripts/cli-diff-test.sh --record` after reading each GOLDEN-DIFF) pinning the new messages, and `tests/internal/diagnostics-registry.test.yo` if a code is added. Each fails before the fix: the current output is the one quoted above.
