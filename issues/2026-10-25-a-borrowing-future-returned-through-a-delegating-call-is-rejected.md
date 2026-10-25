# A borrowing future returned through a delegating call is rejected (E0909)

**Severity:** S2 — a function cannot return another call's borrowing future, even when every place it borrows is rooted at the function's own `&` parameter, so a trait impl cannot delegate to an inherent method whose future borrows `self`.

**Status:** open. Found 2026-10-25 on `feat/v3-std-cell-free-resources` (VBD V3 review round), when every resource I/O future started to borrow its handle: `TcpStream`'s `Reader.read` was `self.read(buf, size, io)` delegating to the inherent `read`, and that became E0909. Reproduces with the v0.2.69 seed.

## Reproducer

`issues/repros/2026-10-25-a-borrowing-future-returned-through-a-delegating-call-is-rejected.yo`:

```yo
{ IoExn } :: import("std/error");
S :: struct(x : Box(i32));
impl(
  S,
  m : (fn(self : &Self, io : Io) -> Impl(Future(i32, IoExn)))(
    io.async({ &self }(e : IoExn) => self.x.*)
  ),
  d : (fn(self : &Self, io : Io) -> Impl(Future(i32, IoExn)))(
    self.m(io)
  )
);
export(S);
```

```text
error[E0909]: This value borrows `self` (the capture `self : &self` at repro.yo:6:17), so it is second-class and cannot be returned: a borrow never outlives the scope that lends it.
```

Expected: accepted. §3.13 A2 (`plans/VALUES_BY_DEFAULT.md`) allows returning a borrowing future "under the same rule: every place it borrows is rooted at the returning function's own `&`/`&mut` parameters", and "at the call site the result then borrows the argument places lent to those parameters". `d`'s result borrows only what `d`'s `self` lends.

## Root cause

`reject_second_class_return` (`src/evaluator/utils.yo`) reads the returned future's borrows with `collect_type_borrows`, which reports them rooted where the CALLEE's `io.async` captured them (`m`'s `self`). The call site never re-roots them at the argument places it lent (`d`'s `self`), so `_find_var_by_id` finds no such binding in `d` and the return is rejected. Awaiting the same call where it is made works, because the lend check at the call (`_check_future_call_lends`) maps the arguments itself.

## Workaround

Define the body where it is needed (std puts `read`/`write` directly in the `Reader`/`Writer` impls of `TcpStream`, `UnixStream`, `TlsStream` and the child pipes), or wrap the call in a future that borrows the parameter itself: `io.async({ &self, io }(e : IoExn) => e.io.await(self.m(io), e))`.

## Fix

At a call whose result is a borrowing future, re-root each borrow whose root is a callee parameter at the place the caller lent to that parameter (the mapping `_check_future_call_lends` already computes), so the caller's return check, freeze and overlap rules see the caller's places. Regression test: the reproducer as an accepted program, plus a `comptime_expect_error` case where the delegated borrow is rooted at a local (still E0909).

**Assessment 2026-10-25, after develop #1602** (the callee lend replaces the
E0910 stopgap): PARTIALLY fixed on this branch's tree binary. A return whose
callee borrows a VALUE place compiles — `(fn(f : File, io : Io) -> Impl(Future(unit, IoExn)))(f.set_len(i64(0), io))`,
and the same shape for `TcpStream.read`, `UdpSocket.recv`,
`UnixStream.write_str`, `TcpListener.accept` and `ChildStdout.read`, all
evaluate clean, and so does a borrowing future returned from a begin block
over a local (verified with probes). The V3 regression rows in
`tests/fs/file.test.yo`, `tests/net/{tcp,udp,unix}.test.yo` and
`tests/process/command.test.yo` were unwrapped from `comptime_expect_error`
to bare definitions accordingly. What still fails is this doc's reproducer:
the callee's future borrows a place that is itself the RETURNING function's
`&` parameter (`d(s : &Self)` → `self.m(io)`, `m` capturing `{ &self }`) — a
borrow-of-a-borrow the re-rooting does not flatten; still E0909 with the same
message (re-verified on the tree binary of head `6813beda2`). The issue stays
open for that shape.
