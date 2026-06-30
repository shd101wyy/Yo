# yo-self binary codegen state (P1 re-scoping, 2026-06-30)

Investigation of "binary compile emits Failed-to-transpile markers" (task #52).

## Conclusion: the binary's codegen WORKS for correct programs

A correct program compiles cleanly, produces **0 markers**, and runs correctly:

```rust
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
open(import("std/fmt"));
main :: (fn() -> unit)({
  v := ArrayList(i32).new();
  v.push(10); v.push(20);
  (sum : i32) = 0;
  (i : usize) = usize(0);
  while(i < v.len(), {
    match(v.get(i), .Some(x) => { sum = (sum + x); }, .None => ());
    i = (i + usize(1));
  });
  println(`sum=${sum.to_string()}`);
});
export(main);
```

→ `/tmp/correct` prints `sum=30`. ArrayList, while, match, arithmetic, println, template strings all transpile and run.

## The "10 markers" were a FALSE ALARM

`p1probe.yo` used `HashMap(String, i32)` WITHOUT `{ String } :: import`. That
fails with `Variable "String" not found` — and **TS rejects the same program
identically** (`String` is NOT auto-available from the prelude; it must be
imported). The markers were the binary's (mis)handling of an invalid program.

Mechanism: in a begin-block body, the first failing statement's def-time eval
throws; `_trial_eval_fn_body` swallows it; evaluation of the begin aborts, so
EVERY following statement loses its ExprInfo → codegen emits
`// Failed to transpile` for all of them. Hence 10 markers from 1 root error.

## Real remaining work (genuine, narrower than "drain markers")

1. **String-codegen bug (HIGH):** a CORRECT `HashMap(String, i32)` program
   (with `String` imported) produces 0 markers but BROKEN C:
   - `error: expected expression` (malformed emit)
   - `no member named '_bytes' in struct ...gs_yo_id_3843_u8` — String's
     internal u8-buffer struct access. Repro: `/tmp/correct_hm.yo`.
2. **Error-propagation divergence (LOW):** during `compile`, the binary
   SWALLOWS def-time body-eval errors for the entry `main` (producing a broken
   binary + markers), whereas TS PROPAGATES them as a hard compile failure. The
   binary should reject invalid programs, not silently emit broken output.

## How to drive P1 from here

Compile CORRECT programs that exercise more features (HashMap/String, enums,
structs, generics, closures, effects) with the binary; fix the C-compile
errors that surface (like the String `_bytes` bug). The marker count for
correct programs is already ~0 — the tail is specific codegen correctness bugs,
not broad unported constructs.
