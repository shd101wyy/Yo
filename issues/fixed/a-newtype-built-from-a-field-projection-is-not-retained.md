# A newtype built from a field projection is not retained

**Severity:** S1 — use-after-free in safe code: a newtype constructed from another value's RC field, or from a local that stays live, shares the payload without a retain, so both owners release it. String S3's O(1) `String.clone()` has exactly this shape, so every `s.clone()` on the copy-on-write branch is a use-after-free.

**Status: FIXED** on `fix/v0251-stack`. Found 2026-10-04 while verifying the String S4 doc examples under ASan (`feat/string-cow` tree std, yo 0.2.50 and a stage-1 with the own-argument retain fix, `3f0ff255b`; both fail).

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

`yo compile repro.yo --sanitize address --allocator system` then running it: `ERROR: AddressSanitizer: heap-use-after-free`. The same program with `S(_b : s._b)` in place of `V(_b : s._b)` prints `1 1`, and a newtype built from a plain local that it takes over (`V(_b : l)`, `l` moved) is fine.

Every position of the projection fails the same way: `Self(_b : self._b)` in an `inout(self)` method, a `self : Self` method, a free function with an `inout` or a by-value parameter, and a local `V(_b : v._b)`. A newtype over `Option(ArrayList(u8))` (the `String` shape) fails too.

A LOCAL that stays live fails the same way, because it is the same missing retain:

```rust
V :: newtype(_b : Option(ArrayList(u8)));
impl(V, dupv : (fn(inout(self) : Self) -> Self)({
  b := self._b; // +1: `b` owns a reference and drops it at scope end
  Self(_b : b)  // the cast takes no reference of its own
}));
```

```c
__yo_t_A* tmp = (*__yo_v_self);
if (tmp != NULL) { __yo_incr_rc((void*)(tmp)); }
__yo_t_A* __yo_v_b = tmp;
V ret = ((V)(__yo_v_b));                                      // no retain
if ((__yo_v_b) != NULL) { __yo_decr_rc((void*)(__yo_v_b)); } // b's own drop
return ret;                                                   // a borrowed payload
```

So do a by-value parameter (`(fn(b : Box) -> V)(V(b : b))`), a parameter's nested field (`V(b : h.v.b)`), and a newtype whose payload is a newtype (`W(v : self.v)`) or a tuple (`P(p : self.p)`).

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

It already breaks a CLI golden on the copy-on-write branch: `tests/cli-cases/compile-allocator-fixed-oom-shapes` loses its `string: died with an allocation diagnostic` line because the PARENT process dies with SIGSEGV (rc 139) in its third loop iteration, at `.arg(shape.clone())`. Under `--allocator fixed` the double release corrupts the TLSF region. Replacing that argument with `(shape + String.new())` (a new string, no clone) restores all three verdict lines. `tests/cli-cases/test-in-file-tests` fails too: all three of its tests stop with an ASan `heap-use-after-free` at `label : c.label.clone()` (`lib/counter.yo`).

## Cause

Confirmed by the fix. The evaluator is right: a constructor argument goes through `set_expr_as_needs_to_call_dup` (`src/evaluator/calls/type.yo`) for a struct and a newtype alike. A borrowed projection, a borrowed parameter or a still-live local carries a deferred `___dup`; an owning temp or a moved local carries none.

Codegen dropped it for newtypes. The value-struct / newtype constructor emitter in `src/codegen/exprs/other_fn_call.yo` (the "Value-struct / newtype constructor call with RUNTIME field args" block) has two arms. The compound-literal arm emits each field argument through `emit_deferred_dup_or_code(a, _call_generate_expr(a, ...), ...)`. The newtype zero-cost-cast arm called `_call_generate_expr(a, ...)` alone, so the dup never reached the C. This is the rule in `.github/instructions/c-codegen.instructions.md`, "A call emitter must emit its arguments' deferred dups", broken in a constructor instead of a call.

## Fix

The newtype arm wraps its argument the way the compound-literal arm does. The field, by-value-self, live-local, parameter, nested-field, `Option`-payload, nested-newtype and tuple-payload shapes now retain the payload. A payload the newtype takes over (a moved fresh local, a call result, a constructor) has no dup, and its C is unchanged:

```c
__yo_t_A* tmp = (*__yo_v_self);
if (tmp != NULL) { __yo_incr_rc((void*)(tmp)); }
V ret = ((V)(tmp));
return ret;
```

Tests: the four `a newtype …` tests in `tests/rc.test.yo`. They check `rc()` after each construction, and a `Dispose` counter proves each box is released exactly once, so the take-over shapes cannot leak. On the base branch's stage-1, three of the four fail with `Test failed with exit code 6`. With the fix all four pass, with the leak verdict on.
