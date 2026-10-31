# A downcast to a move-only type drops the payload twice

**Severity:** S1 — memory unsafety in accepted safe code. `downcast(d, T)` of a `Dyn` whose payload is a move-only value (a struct with a `Drop` impl) copied the payload out bitwise, so the `Dyn`'s box and the result both owned it and both dropped it. For a payload that owns heap memory this is a double free.

**Status:** FIXED 2026-10-31 on `fix/closure-capture-mut-receiver-spill`. Found the same day on `vbd/b8-arraylist-string-flip`: once `String` became a value, `tests/error.test.yo`'s "Test String as Error via AnyError" (`downcast(err, String)` of an `AnyError`) reported "attempting double-free" under ASan, and so did every other downcast to `String`. Develop `9c78fdaf0` and the v0.2.73 seed drop a move-only `Drop` payload twice in the same shape.

## Reproducer

The tests "a downcast copies a move-only payload with its clone, each copy dropped once" and "a downcast to a move-only type needs a Dyn that lists Clone" in `tests/dyn.test.yo`:

```yo
_DcFd :: struct(n : i32);
impl(
  _DcFd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_dc_drops = (g_dc_drops + i32(1));
    })
  )
);
// … a counting Clone, ToString and Error …
{
  (err : AnyError) = dyn(_DcFd(n : i32(3)));
  n := match(downcast(err, _DcFd), .Some(f) => f.n, .None => i32(0));
};
// seed: 0 clones, 2 drops of the one value
```

## Cause

A value payload is boxed at `dyn(v)`, and `downcast` reads it out of the box (`generate_downcast`, `src/codegen/exprs/downcast.yo`) while the `Dyn` keeps its own. For a type holding counted handles the read is followed by a structural dup, but a move-only value has none, so `generate_dup_code_for_value` returned the bitwise copy unchanged. Both owners then dropped it.

## Fix

- Codegen copies a move-only payload with the `clone` of the `Dyn`'s `Clone` evidence (the same function the vtable's `__yo_clone` slot calls; the lookup is shared as `dyn_impl_clone_fid`).
- The evaluator rejects a downcast to a move-only type from a `Dyn` that does not list `Clone` (E0901, `src/evaluator/builtins/downcast.yo`), since there is then no `clone` to copy it with. `AnyError` (`Dyn(Error, Clone)`) lists it.
