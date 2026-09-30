# An `io.async` body never releases a closure parameter bound by a type variable

**Severity:** S2. A task that captures a closure passed through a generic `F <: Fn(...)` parameter, such as `Stream.for_each`'s body, leaks every RC value that closure captured.

**Status: FIXED (2026-10-01).** This is the long-standing leak behind `tests/async/combinators.test.yo`'s "Test Stream for_each …" cases, which fail under leak verdicts on the v0.2.46 seed and on develop `29bf728b4`.

## Symptom

`Countdown(_n : i32(4)).for_each(x => { seen.push(x); }, io)`, awaited or spawned. Valgrind: `48 (32 direct, 16 indirect) bytes definitely lost`, the captured `seen` list.

## Cause

The task's constructor dups the closure's captures into its capture struct, `.f = …` with `.seen = __yo_incr_rc(…)`. But neither dispose drops the field: the state machine's (`async.yo`) nor the sync future's. The field's type is the type variable `F : (Fn(i32) -> unit)`, whose resolution chain ends at the closure's capture struct, which is what `get_type_string` renders it as. `_closure_value_type` (`src/codegen/exprs/drop_dup.yo`) resolved only an `Impl`-named closure identity, so `generate_drop_code_for_value` saw an unresolved SomeT and returned no drop.

## Fix

`_closure_value_type` also resolves a type whose resolution chain ends at a closure capture struct (`is_closure_capture_struct`). The same helper feeds the dup path, so dup and drop stay symmetric.

Test in `tests/async/combinators.test.yo`: "Stream.for_each releases what its body closure captures".
