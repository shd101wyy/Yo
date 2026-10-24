# An `FnOnce` closure whose body is a bare capture leaks its environment

**Severity:** S1 — an unbounded leak in accepted safe code: every call of such a closure leaks the closure environment, and the returned value's heap buffer stays reachable only from that leaked block.

**Status:** open. Found while gating
`issues/fixed/2026-10-24-calling-an-fnonce-closure-is-a-false-e0910-after-the-receiver-exclusivity-extension.md`.
It is not a regression: seed v0.2.69 and develop `7b8b04d86` both leak.

## Reproducer

`issues/repros/2026-10-24-an-fnonce-closure-whose-body-is-a-bare-capture-leaks-its-environment.yo`, built with
`--std-path ./std --sanitize address --allocator system`:

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  s := String.from("hello");
  (cb : Impl(FnOnce(x : i32) -> String)) = ({ s }(x : i32) => s);
  r := cb(i32(1));
  assert(r.len() == usize(5), "bound first");
  ()
});
export(main);
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 32 byte(s) in 1 object(s) allocated from:
Indirect leak of 5 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 37 byte(s) leaked in 2 allocation(s).
```

The 32-byte block is the closure environment, which holds the captured `String`. The 5 bytes are
`"hello"`, reachable only through that block.

## Shape

| Closure | Body | Result |
| ------- | ---- | ------ |
| `Impl(FnOnce(x : i32) -> String)` | `=> s` | leaks |
| `Impl(FnOnce() -> String)` | `=> s` | leaks |
| `Dyn(FnOnce() -> String)` | `=> s` | leaks |
| `Impl(FnOnce(x : i32) -> String)` | `=> _id(s)` (a `sink` identity fn) | clean |

The leak also happens when the call result is used directly as a receiver, as in `cb(i32(1)).len()`.
A body that moves the capture into a call is released correctly; a body that IS the capture's name is
not. The consumed closure's post-call release seems to treat the moved-out capture as already dropped
and skips freeing the environment too. Alternatively, the tail move of a capture never marks the
capture moved, so the environment's release is never emitted. This is not yet confirmed: start from
`mark_fnonce_post_call_release` and the FnOnce body's tail-move handling.

## Test to add with the fix

Add a runtime test to `tests/fn_once.test.yo`: an `FnOnce` local whose body is a bare capture, called
once (bound and as a receiver), under the test runner's leak verdict.
