# `yo fix --migrate explicit-copy` misses a write a loop makes above the copy

**Severity:** S1. The rewrite changes what the program computes: a list copied inside a loop, below a push the loop makes to the same buffer, stops seeing the pushes of later iterations, so a later read of the copy sees a different length.

> Found 2026-10-24 by the review of B4-0a
> (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.1). B4-0a gave every
> parameter its own declaration key, which turned 388 src sites from listed
> into cloned. Many of them sit in `while` loops over a parameter, where
> this guard was blind. Locals had the same gap before B4-0a.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
VEntry :: struct(yes : ArrayList(i32), no : ArrayList(i32));
loop_back :: (fn(entry : &mut VEntry) -> usize)({
  mut(saved) := ArrayList(i32).new();
  mut(i) := usize(0);
  while(i < usize(2), i = (i + usize(1)), {
    entry.yes.push(i32(1));
    if(i == usize(0), {
      saved = entry.yes;
    });
  });
  saved.len()
});
main :: (fn() -> unit)({
  mut(a) := VEntry(yes : ArrayList(i32).new(), no : ArrayList(i32).new());
  println(loop_back(&mut a));
});
export(main);
```

The program prints `2`: `saved` shares `entry.yes`'s buffer, and the second
iteration's push reaches it. `yo fix main.yo --migrate explicit-copy` on the
B4-0a branch (`f03b1b80a`) wrote `saved = entry.yes.clone();`, after which
it prints `1`. With a local `entry`, develop cloned it the same way. A
closure called twice (`{ &mut saved, e : &mut entry }() => { e.yes.push(…);
… saved = e.yes; … }`) and a `for` loop behave like the `while`.

## Root cause

The written-after guard (`_copy_written_after` and `_decl_written_after` in
`src/main.yo`) called a write "after" the copy when its byte offset was
larger, in the same module. A loop runs the code above the copy again after
it, and so does a closure called again or a function called again. The
lexical test never saw those writes.

## Fix

The evaluator records each region that runs more than once while the
migration runs (`record_copy_loop`, `src/evaluator/utils.yo`): a runtime
`while` (`evaluate_while`; a `for` is one after expansion) and every fn
literal, a closure's or a function's (`try_to_implement_function_by_function_type`,
`evaluate_anonymous_function_implementation`). For each copy site the guard
computes which enclosing regions the copy outlives one run of
(`_copy_when`): the destination, or a variable the copy's value flows on
into, is declared outside the region, or the copy has no destination
variable (an argument, a field store, a `return`). In such a region every
write and every flow is after the copy as well (`_copy_after`). A copy whose
destination is declared inside the loop dies with its iteration, and a write
above it is still before it.

A `&mut` capture-list entry now records its flow both ways (the capture and
the captured variable are one place), so a copy stored through the capture
is seen to outlive the closure.

Test: `tests/cli-cases/fix-migrate-explicit-copy-loop-carried`. A parameter in a `while`, a
local in a `while`, a `for` and a closure called twice are listed. A copy
that dies with its iteration is still cloned.
