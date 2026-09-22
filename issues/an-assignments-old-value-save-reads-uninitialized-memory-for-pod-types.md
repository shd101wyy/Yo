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

## Fix attempt REFUTED (2026-09-23), to not repeat it

Gating the save on `type_contains_rc_type(lhs_type)` (mirroring the drop
side's condition) compiles the whole tree and passes every local gate under
clang x86_64 — but BREAKS COMPILATION of assignment-as-expression for
non-RC types on the wasm leg: `y := (x = array(2, 3, 4))` in
tests/basic.test.yo dies with `use of undeclared identifier '_file_…_temp_…'`.
The save line serves TWO roles — (a) feeding the deferred drop, and (b) the
DECLARATION of the assignment expression's value temp that a consuming
parent (`y := (x = …)`) reads — and the drop's RC condition does not
distinguish them. The correct fix needs the parent's consumption context
(read when consumed OR when the drop can fire), which the shared assignment
emitter does not currently have. The gate was reverted; the UB stands
unobserved under clang (CI) and observable under zig safety (local).

## Where the fix belongs

The save must be emitted whenever the temp serves EITHER role: the deferred
drop can fire (RC-bearing types) OR a parent consumes the assignment
expression's value (the `y := (x = …)` shape — on wasm and anywhere the
consumption survives). That consumption context lives in the begin-block
emitter (which knows whether a statement's value is the block's tail) and
must be threaded to the assignment emitter, or the value temp must be
declared independently of the old-value save.
