# An `Fn` closure that reassigns a by-value capture releases the old value twice

**Severity:** S1 — memory unsafety in accepted safe code: the capture's old `Rc` is released by the closure and again by the caller (ASan heap-use-after-free), and the new value leaks.

**Status:** OPEN — found 2026-10-23 while triaging
`issues/fixed/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.md`
(it confounded that issue's probes whose closure writes the receiver's root). Not fixed there.

## Reproducer

`issues/repros/2026-10-23-an-fn-closure-that-reassigns-a-capture-releases-the-old-value-twice.yo`
(develop tree binary at 30069d837, `--std-path ./std --optimize 2 --sanitize address --allocator system`):

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
W :: struct(s : String);
call_it :: (fn(act : &Impl(Fn() -> unit)) -> unit)({
  act();
});
main :: (fn() -> unit)({
  mut(r) := rc(W(s : String.from("hello")));
  call_it(() => {
    r = rc(W(s : String.from("bye")));
  });
  println(&r.s);
});
export(main);
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free on address … READ of size 4
```

The program is accepted. Expected: either a compile-time rejection (an `Fn`
closure writing its capture, which Rust makes `FnMut` and borrows the
variable for) or a well-defined program; never a double release.

## Cause

The emitted C (abridged):

```c
T* __yo_v_r = <rc(W("hello"))>;                         // rc 1
Cap tmp = (Cap){ .__yo_v_r = __yo_incr_rc(__yo_v_r) };  // rc 2, the capture's share
call_it(tmp);                                           // capture struct passed BY VALUE
...
__yo_decr_rc(tmp.__yo_v_r);                             // rc 0: freed
__yo_decr_rc(__yo_v_r);                                 // use after free

void call_it(Cap act) { closure(&act); }                // writes the callee's COPY
void closure(void* ctx) {
  old = ctx->__yo_v_r;
  ctx->__yo_v_r = <rc(W("bye"))>;
  __yo_decr_rc(old);                                    // rc 1: the old value's capture share
}
```

`&Impl(Fn() -> unit)` is lowered as the capture struct by value. The
closure's assignment releases the old value through the callee's copy and
stores the new value into that copy, which nobody drops, while the caller's
capture struct still holds the old pointer and releases it again at scope
end. The write never reaches `r` either: `println(&r.s)` prints the old
`hello` before the double release.

## Fix directions

1. Reject an assignment to a by-value capture inside an `Fn` closure (a
   capture is a copy; writing it is invisible to the caller), pointing at
   `{ r : &mut r }` capture lists or an `Rc(RefCell(T))`.
2. Or pass a borrowed `&Impl(Fn)` closure by pointer, so a capture write
   lands in the caller's capture struct and the caller's release sees it.

A fix adds the reproducer as a test (a negative test under 1, an ASan-clean
run under 2).
