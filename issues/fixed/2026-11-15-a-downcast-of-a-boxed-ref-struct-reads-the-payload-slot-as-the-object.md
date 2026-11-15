# A downcast of a boxed `ref struct` payload reads the box's payload slot as the object

**Severity:** S1 (wrong memory read from safe code: `downcast(err, R)` of an `AnyError` whose payload
is a `ref struct` `R` returns a pointer to the slot holding the handle, typed as the handle; the
flip's stage 2 crashes on its first `YoError` downcast — `malloc returned None`, then a SEGV in a
`String` clone of a garbage diagnostic)

## Symptom

```yo
_DrsObj :: ref(struct(n : i32));
(e : AnyError) = dyn(_DrsObj(n : i32(7)));
match(downcast(&e, _DrsObj), .Some(o) => o.n, .None => i32(0)) // garbage
```

Found by stage 2 of the flip (`check ./std` aborts in `primary_diagnostic_code`, whose
`downcast(err, YoError)` reads the boxed `YoError`, a `ref struct`).

## Root cause

A `ref`-object downcast target keeps the owned form `Option(V)` (`src/evaluator/builtins/downcast.yo`:
"the Dyn's data word IS the object"), and codegen (`src/codegen/exprs/downcast.yo`) cast the data word
to the handle and retained it through the vtable. Since the alias boxes a `ref struct` value
(`issues/fixed/2026-11-15-the-dyn-alias-over-a-ref-struct-lowers-to-the-legacy-cell-under-a-box-type.md`),
the data word of such an instance is the box's payload slot, which holds the handle.

## Fix

The `ref`-target arm loads the handle through the vtable's `payload_of` when the instance has one (a
payload-convention vtable) and retains it with `__yo_incr_rc`/`__yo_incr_rc_atomic`; a legacy cell
(no `payload_of`) keeps the data-word path.

## Test

`tests/dyn.test.yo` "a downcast of a boxed ref-struct payload reads the object". Fails before (garbage
read under ASan), passes after; the flip's stage 2 `check ./std`.
