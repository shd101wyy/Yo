# An assignment's old-value save reads uninitialized memory for POD types

Found while running the tier-1 battery locally under `zig cc` (the deck box
has no clang; a `cc` shim wrapping `zig cc` stands in): `tests/rand.test.yo`
died with

    thread N panic: load of value 128, which is not valid for type 'bool'
    ./tests/.yo_selftest_batch_1_0.bin.c:5651:55:
          bool _t = (*target_ptr); // Save old value for later use

inside `ArrayList(bool).push` — the C written by `consume(target_ptr.* =
value)` in std's push (array_list.yo:264).

## Root cause

`src/codegen/exprs/assignment.yo` emitted the save-old-value-into-result-temp
for EVERY non-unit LHS. The temp's only consumer is the deferred drop of the
old value, and the drop generator (`generate_drop_code_for_value`) has always
emitted NOTHING for a type that contains no RC value. So for POD element
types the save was a dead read of the assigned place — and through push that
place is the freshly-malloc'd, uninitialized slot at `_length`. Any byte
value other than 0/1 in that memory is an invalid `bool` encoding: UB that
clang silently tolerates (the CI legs never saw it) but a bool-checking
sanitizer traps on.

Pre-existing (the v0.2.39 seed emits the identical load — verified with a
seed `--emit-c` of an `ArrayList(bool).push` program); exposed by running the
battery under zig's safety checks, which the new local stage-1 build recipe
made possible for the first time.

## Fix

Both save sites in `assignment.yo` (the plain local-temp save and the `sm->`
slot variant) now carry the same `type_contains_rc_type(lhs_type)` gate the
drop side has always had: no possible drop, no save. RC-bearing types keep
their saves; their emitted C is unchanged (the corpus goldens + rc/arc/gc
batteries pin that).
