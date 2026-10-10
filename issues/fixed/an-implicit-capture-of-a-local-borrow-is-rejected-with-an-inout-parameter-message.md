# An implicit capture of a local borrow is rejected with a message about an `inout` parameter

**Severity:** S3: a wrong diagnostic; the rejection itself is correct.

Found 2026-10-10 by the decision 38 A escape-route audit.

## Repro

```rust
{ String } :: import("std/string");
_keep :: (fn(sink(f) : Impl(Fn() -> i32)) -> i32)(f());
main :: (fn() -> unit)({
  s := String.from("ab");
  imm(y) := s;
  _ := _keep(() => i32(y.len()));
});
export(main);
```

`yo check` said:

```
error: Cannot capture inout binding 'y' in a closure. `inout(y) : T` is a second-class reference to the caller's storage; ...
```

`y` is a local `imm` borrow, not an `inout` parameter, and `inout` is no
longer a spelling the user writes (V3b renamed it `mut`). The advice
("restructure to take the closure as a callback parameter") also missed the
fix the language now has: a capture list, `{ imm(y) }() => …`, which keeps
the closure second-class and is accepted.

## Root cause

`src/evaluator/values/anonymous_function.yo` raises one message for every
`is_ref` binding an implicit capture reaches (`mut` parameters, `imm`/`mut`
local borrows, `for`/`with_lock` element bindings), written when only
`inout(x) : T` parameters existed.

## Fix

The message names the binding as a borrow and points at the capture list:
"Cannot capture the borrow 'y' in a closure implicitly: 'y' is an
`imm`/`mut` binding, a second-class borrow of another place, and an implicit
capture would copy the borrow into a closure that may outlive it. Name it in
a capture list (`{ imm(y) }(...) => ...` or `{ mut(y) }(...) => ...`), which
keeps the closure second-class, or read the value into a local first."

Tests: `tests/closure_capture_list.test.yo` "escape: an implicit capture by
an escaping closure" (fails on the old message), and the CLI case
`check-closure-captures-lock-inout-rejected` (its kept line updated).
