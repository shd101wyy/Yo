# A newtype built from a field projection is not retained

**Severity:** S1 — use-after-free in safe code: a newtype constructed from another value's RC field shares the field without a retain, so both owners release it. String S3's O(1) `String.clone()` has exactly this shape, so every `s.clone()` on the copy-on-write branch is a use-after-free.

**Status: OPEN** — found 2026-10-04 while verifying the String S4 doc examples under ASan (`feat/string-cow` tree std, yo 0.2.50 and a stage-1 with the own-argument retain fix, `3f0ff255b`; both fail).

## Symptom

```rust
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
V :: newtype(_b : ArrayList(u8));
S :: struct(_b : ArrayList(u8));
main :: (fn() -> unit)({
  l := ArrayList(u8).new();
  l.push(u8(1));
  s := S(_b : l);
  v := V(_b : s._b); // a newtype built from a field projection
  println(`${v._b.len()} ${s._b.len()}`);
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` then running it: `ERROR: AddressSanitizer: heap-use-after-free`. The same program with `S(_b : s._b)` in place of `V(_b : s._b)` prints `1 1`, and a newtype built from a plain local (`V(_b : l)`) is fine.

Every position of the projection fails the same way: `Self(_b : self._b)` in an `inout(self)` method, a `self : Self` method, a free function with an `inout` or a by-value parameter, and a local `V(_b : v._b)`. A newtype over `Option(ArrayList(u8))` (the `String` shape) fails too.

On the copy-on-write branch, `String`'s `Clone` is `Self(_bytes : self._bytes)`:

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("abc");
  t := s.clone();
  println(`${s} ${t}`); // heap-use-after-free under ASan
});
export(main);
```

The emitted clone is `return ((String)(*self));`, with no `__yo_incr_rc`, while the caller releases both `s` and `t`.

## Cause

Likely cause, read from the source and not yet confirmed by a fix: the value-struct / newtype constructor emitter in `src/codegen/exprs/other_fn_call.yo` (the "Value-struct / newtype constructor call with RUNTIME field args" block) has two branches. The compound-literal branch emits each field argument through `emit_deferred_dup_or_code(a, _call_generate_expr(a, ...), ...)`, which honors the deferred `___dup` the evaluator attaches to a borrowed argument. The newtype zero-cost-cast branch calls `_call_generate_expr(a, ...)` alone, so the dup is dropped. This is the rule in `.github/instructions/c-codegen.instructions.md`, "A call emitter must emit its arguments' deferred dups".

## Expected

The newtype branch wraps its argument the way the compound-literal branch does, so `V(_b : s._b)` retains the field, and `String.clone()` returns a second counted handle (`rc == 2` until a write). The fix needs a test in `tests/` that runs the repro above under `--sanitize address` (the newtype shapes and `String.clone()`), and the dup/drop emit-diff gate, because the cast branch's output changes for every newtype constructor.
