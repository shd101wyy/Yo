# Should `!` on a number be deleted, so `!` is `bool`'s alone?

**Kind:** design question — an open decision, not a defect.

**Decided 2026-11-26: option 1** (VERDICTS-87 adoption; the maintainer approved Fable's recommendations in advance), with the secondary asymmetry resolved by deletion. Implemented in VERDICTS-87 PR D (`wip/v0281-v87d`, its last commit, droppable on a veto). See "Resolution" below.

**Status:** decided. Filed 2026-11-26 from VERDICTS-87 (the operator-trait naming consult, Fable 5.2), item 6 of its "To file" list. Evidence measured on `yo 0.2.79` built from develop (`~/Workspace/Yo-wt/v0280-p12/yo-out/x86_64-unknown-linux-gnu/bin/yo`) with `--std-path` of develop `030d63040`; the seed checks are VERDICTS-87's, run with the released v0.2.79 `yo`.

## The question

`!` applied to a number is C truthiness: `LogicalNot` has an impl on every integer and float type, and the result is a `bool`. Should those impls be deleted, so `!` works on `bool` only and `x == 0` is the spelling of "is zero"?

## What holds today

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  x := i32(5);
  a := !x;
  b := ~x;
  c := !f64(0.0);
  d := !true;
  println(`!i32(5) = ${a}; ~i32(5) = ${b}; !f64(0.0) = ${c}; !true = ${d}`);
  if(!x, {
    println("taken");
  }, {
    println("not taken: !5 is false");
  });
});
export(main);
```

```text
!i32(5) = false; ~i32(5) = -6; !f64(0.0) = true; !true = false
not taken: !5 is false
```

- **22 prelude impls.** `std/prelude.yo` has one `impl(T, LogicalNot((!) : (self -> __yo_op_not(self))))` for each of `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `isize`, `usize`, `char`, `int`, `uint`, `short`, `ushort`, `long`, `ulong`, `longlong`, `ulonglong`, `f32`, `f64` and `longdouble` (plus `bool`'s own, which stays).
- **Rust's `!` on an integer is bitwise complement**, which in Yo is `~` (`BitNot`). A model that writes `flags & !mask` gets E0610 with no mention of `~` (`issues/fixed/2026-11-26-rust-shaped-trait-spellings-get-no-useful-help.md`), and a model that writes `!n` meaning "n is zero" gets C's answer. Both readings of `!x` for an integer `x` exist in the wild; the language implements the one that is neither Rust's nor type-safe.
- **The tree does not use them.** Evidence: the released v0.2.79 `yo check ./std --std-path <a std with the 22 numeric impls deleted>` exits 0, and `yo check ./src` passes 267 of 273 files; the same six files (`main.yo` and five modules it imports) stop at the scratch tree's uninstalled `markdown-yo` dependency before their bodies are read, exactly as with the full std. With `yo.lock` and `yo install`, `yo check ./src/main.yo` exits 0. Not checked: `!` on a number in `tests/`, in `docs/` examples, in those six `src/` files, and in generic bodies no check instantiates.
- **Related asymmetry (same question, secondary).** Unary `-` exists on the C-named unsigned types (`uint`, `ulong`, `ushort`, `ulonglong`, `char`) and not on `u8`–`u64`/`usize`:

  ```text
  -uint(1)  =>  4294967295
  -u32(1)   =>  error[E0610]: No matching call found with arguments: -(u32(1))
  ```

  Rust has `Neg` on neither (unsigned negation does not compile).

## Options

1. **Delete the 22 numeric `LogicalNot` impls** in VERDICTS-87 PR D. `!` is then `bool`'s; `!x` at a numeric slot is E0610, and PR C's help names `x == 0` and `~`.
   - For: explicit over implicit (`x == 0` says what is tested); no C-truthiness; the one remaining `!` has one meaning; `Not` stays unbound with a one-line reason ("`!` is `LogicalNot` and yields `bool`; Rust's `!` on an integer is `~`"); the tree already checks without them.
   - Against: a program that relies on `!n` stops compiling (none found in std or `src/`; the unchecked places above remain).
2. **Keep them** and document that `!` on a number is truthiness.
   - For: no churn.
   - Against: two readings of `!x` stay, the wrong one for a Rust-trained author; every float and integer carries an operator whose result type is not its own.
3. **Make `!` on an integer the bitwise complement** (Rust's meaning) and drop `BitNot`'s `~`.
   - Against: rejected in VERDICTS-87 Q1: Yo has two operators where Rust has one, `!` always yields `bool`, and binding Rust's `Not` to either trait is half right.

## Recommendation

Option 1 (VERDICTS-87 item 6): delete the 22 numeric `LogicalNot` impls in the v0.2.81 PR D (`plans/backlog/STD_RUST_ALIGNMENT.md` §9), so `!` is `bool`'s and `x == 0` is the spelling. The tree's own evidence is the seed check above. Decide the secondary asymmetry (`-` on the C-named unsigned types) with it: either delete those `Negate` impls too or add them to `u8`–`u64`, preferably the former (Rust has it on neither).

## Resolution

VERDICTS-87 PR D, last commit:

- The 22 numeric `LogicalNot` impls are deleted (`i8` … `u64`, `isize`, `usize`, `char`, `int`, `uint`, `short`, `ushort`, `long`, `ulong`, `longlong`, `ulonglong`, `f32`, `f64`, `longdouble`). `bool`'s `LogicalNot` and `ComptimeLogicalNot` stay; no comptime number had a `ComptimeLogicalNot`. `!x` at a numeric operand is E0610; the help naming `x == 0` and `~` is VERDICTS-87 PR C (`issues/fixed/2026-11-26-rust-shaped-trait-spellings-get-no-useful-help.md`).
- The secondary asymmetry: the `Neg` impls of `uint`, `ushort`, `ulong` and `ulonglong` are deleted, as `u8` … `usize` lost theirs. `char` keeps `Neg`: its signedness is C's, implementation-defined, and the type exists for FFI.
- The class-D rows (`docs/*/DATA_TYPES.md`, `yo-design`) say `!` is on `bool` only and `x == 0` tests a number.
- Tests: `tests/prelude.test.yo`, "! on a number is a compile error" and four rows added to "unsigned integer negation is a compile error".
- Nothing in `std/` or `src/` used either: `check ./std` and `check ./src` pass without them (the PR body lists the `tests/` coverage).
