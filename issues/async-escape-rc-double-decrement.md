# Async Escape RC Double-Decrement (Use-After-Free)

**Status:** 🔴 OPEN  
**Date:** March 20, 2026  
**Severity:** High (use-after-free, crashes with ASan)

## Problem

When a function receives an async future as a parameter, awaits it, and the future's
effect handler calls `escape`, the future's reference count is decremented twice:

1. Once by the await abort path (the "event loop reference" drop)
2. Once by the function's escape cleanup (dropping the parameter `fut`)

If the caller also holds a reference to the same future, accessing it after the
escaped function returns causes a use-after-free.

## Reproducer

```yo
test "escape UAF", using(io : IO), {
  Raise :: (fn(forall(T : Type), msg : String) -> T);

  task := io.async((using(io : IO, raise : Raise)) => {
    io.await(yield());
    raise(`abort now`);
    return i32(999);
  });

  test_escape :: (fn(fut : Impl(Future(i32, IO, Raise)), using(io : IO)) -> i32) {
    (given(raise) : Raise) =
      (msg) -> {
        escape i32(77);
      };
    io.await(fut, using(io, raise));
    i32(0)
  };

  escape_result := test_escape(task);
  // At this point, `task` points to freed memory because test_escape's
  // escape path decremented RC twice (once in await abort, once in param cleanup)
  st := io.state(task);   // ← USE-AFTER-FREE here
};
```

## ASan Output

```
==93960==ERROR: AddressSanitizer: heap-use-after-free on address 0x60d000000070
READ of size 4 at 0x60d000000070 thread T0
    #0 in __yo_user_main
freed by thread T0 here:
    #0 in free
    #1 in __yo_decr_rc
    #2 in fn_..._test_escape_...  (the escape cleanup path)
```

## Root Cause

RC lifecycle of the future:

1. `task` created → RC = 1
2. `test_escape(task)` called → `fut` param duped → RC = 2
3. `io.await(fut, ...)` — future runs, handler calls `escape`
4. Await abort path: drops event loop reference → RC = 1
5. `test_escape` escape cleanup: drops `fut` parameter → RC = 0, FREED
6. Back in caller: `task` still holds a dangling pointer → UAF on any access

The issue is that the await abort path and the function escape cleanup both drop
the same object reference. The await should NOT drop the parameter's RC on escape,
because the function's escape cleanup will handle that.

## Workaround

Create the future inside the escaping function so the caller never holds a reference:

```yo
test_escape :: (fn(using(io : IO)) -> i32) {
  task := io.async((using(io : IO, raise : Raise)) => { ... });
  (given(raise) : Raise) = (msg) -> { escape i32(77); };
  io.await(task, using(io, raise));
  i32(0)
};
escape_result := test_escape();
// task was created and destroyed entirely within test_escape — no UAF
```

## Affected Code

- `src/codegen/exprs/await.ts` — escape detection and RC drop after `io.await`
- `src/codegen/exprs/async.ts` — SM resume function escape path RC handling
- Related: `src/codegen/exprs/other-fn-call.ts` — escape propagation and local drops
