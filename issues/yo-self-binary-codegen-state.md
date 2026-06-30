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

## Update (2026-06-30): String `_bytes` dup bug FIXED; GC-tracer `switch()` bug localized

**FIXED (commit 2f686f3e7):** the `no member named '_bytes'` errors. yo-self
lowers value-struct dup INLINE (`temp.field = dup(temp.field)`) instead of
calling a `___dup` method like TS. A newtype (String) is modeled as a 1-field
struct, so it took that branch and emitted `temp._bytes = ...` — invalid
because a newtype is a C-transparent typedef. Fix: dup a newtype by recursing
on the underlying field's value with the SAME `value_code` (no member access).

**REMAINING — GC-tracer `((void(*)(void*)) switch ())` (cycle-GC, deeper):**
The auto-generated `GcTracer.visit`/traverse for `Bucket(String,i32)` emits a
malformed function-pointer cast where the callee (`visit_expr`) is the text
`  switch (` instead of `self`. Instrumentation (`_traverse_value`) showed
`visit_expr` starts as `'self'` (correct, from `tracer_code =
_call_generate_expr(self)`) but is **corrupted to the emitted switch-line text**
by the time the enum branch recurses — i.e. emitting `switch (${access}.tag){`
overwrites `visit_expr`. This is a **String-buffer aliasing bug** in the
codegen string flow (the tracer-callback string shares storage with the
emitter's line buffer). Localized to `_traverse_value`'s enum branch
(`constructors.yo`) + `generate_yo_gc_trace_child` (`gc.yo`); the exact
ownership share is not yet pinned. Only affects programs that use a
cycle-GC-traced container of a newtype-over-enum (e.g. `HashMap(String, _)`).

## Update 2 (2026-06-30): GC-tracer `switch()` is a binary HEAP-CORRUPTION bug

Deeper investigation of the `((void(*)(void*)) switch ())` bug (task #54):

**Mechanism (confirmed by instrumentation):** inside ONE `_traverse_value`
call, `em.emit_string_line(\` switch (${access}.tag) {\`)`**overwrites the`visit_expr`String parameter** — it reads`'self'`immediately before the
emit and`' switch ('`immediately after. So`visit_expr`'s heap buffer is
freed earlier and the switch-literal allocation (`to_string(" switch (")`)
reuses the same address.

**Not a yo-self logic bug.** The compiled `_traverse_value` C has NO explicit
`___drop(visit_expr)`, and the `.yo` code faithfully mirrors TS's
`emitTraverseValue` (TS is immune — JS strings are immutable). So it's a
binary-level RC-lifetime / shared-buffer bug in the TS-compiled yo-self: a
String shallow-copy path (`to_string`/`+`/scope-end drop in the nested
`cond`/`match`/`while`) frees a buffer still referenced by `visit_expr`. Same
class as the known `continue-in-while heap corruption` / match-arm
double-free TS-codegen bugs.

**Workaround attempts that did NOT fix it (confirming heap corruption, not a
reorderable alias):**

- Defensive `String.new().push_string(tracer_code)` copy at the call site → still `switch ()`.
- Capturing `safe_visit := visit_expr.clone()` before the switch emit and
  recursing with it → the corruption just MOVED to `safe_visit` (became empty
  `((void(*)(void*)))`).

**Next step:** pin the premature free with ASan on the yo-self binary
(`clang -fsanitize=address` on the emitted `.c`, run `binary compile
/tmp/correct_hm.yo`), or audit the TS codegen RC-lifetime for the
nested-`cond`/`while`/`String`-param pattern. Only affects cycle-GC traversal
of a container holding a newtype-over-enum-over-RC (e.g. `HashMap(String, _)`).
