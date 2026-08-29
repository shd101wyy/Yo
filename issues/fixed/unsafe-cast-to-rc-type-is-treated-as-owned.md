# `unsafe.cast(ptr, RcType)` produced an OWNED +1 result — the callee's scope-end drop freed the caller's object

**Status: FIXED 2026-08-29** (`src/evaluator/calls/function.yo`, the
valueless-callee call branch). **Found:** 2026-08-29 — `std/fs/watch.yo`'s
runtime callback (`w := unsafe.cast(user_data, Watcher)`) SIGSEGV'd in
`tests/fs/watch.test.yo`; the fault address was the watcher's `_queue` field
of a freed object.
**Severity:** HIGH — silent use-after-free; the crash surfaces far from the
cast (in the caller, after the callee returns).

## Reproducer

```rust
W :: ref(struct(q : ArrayList(Ev), active : bool));
cb2 :: (fn(ud : *(u8)) -> unit)({
  w := unsafe.cast(ud, W);          // ← treated as an owned +1
  if(w.active, {
    w.q.push(Ev(name : String.from("x"), kind : i32(2)));
  });
});                                  // scope end: __yo_decr_rc(w) → refcount 0 → freed
main :: (fn() -> unit)({
  w := W(q : ArrayList(Ev).new(), active : true);
  cb2(unsafe.cast(w, *(u8)));
  eprintln(`${w.q.len()}`);         // ❌ reads freed memory (rc=139)
});
```

The same body with `w : W` as a parameter works; the emitted C for the cast
form ends the callee with `__yo_decr_rc((void*)(w));`.

## Mechanism

`__yo_as` (what `unsafe.cast` aliases) is a `"Yo"` extern, so its callee has
NO value — `evaluate_function_call`'s valueless-callee branch handles it, and
that branch attached the call result's temp as OWNING
(`attach_temp_variable_to_expr(expr, true, ctx)`), exactly like a call that
produces a fresh object. A cast produces nothing: the pointer already belongs
to whoever holds the original reference. Binding the result to a local then
made that local owning, and the begin-block drop pass released a reference
that was never acquired.

## Fix

The branch attaches a NON-owning temp when the callee's `FuncMeta.extern_name`
is `__yo_as`; every other valueless callee keeps the owning temp. The cast
result is a borrow — the same treatment `Index` results already get.

## Regression test

`tests/unsafe_cast_rc_borrow.test.yo`: the reproducer shape (caller reads the
object after the casting callee returns), a cast-derived handle stored into a
field and read later, and the round trip `RcType → *(u8) → RcType` keeping the
refcount balanced (the object is still alive after the callee; ASan/GuardMalloc
runs would show the double free).
