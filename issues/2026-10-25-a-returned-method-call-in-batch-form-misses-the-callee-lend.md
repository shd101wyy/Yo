# A returned method call survives `check` but dies E0909 in its test batch: `(s.read)(...)` misses the callee lend

**Severity:** S3 — a definition that returns a borrowing method call (`_f :: (fn(s : TcpStream, buf : *u8, io : Io) -> Impl(Future(usize, IoExn)))(s.read(buf, usize(1), io))`) is accepted by `yo check` but makes its whole test FILE fail under `yo test` ("0 of N tests in this batch ran: the batch failed to compile"). #1602's callee lend re-roots the returned future's borrows only for the method-call form; the test-batch printer re-renders the call in fn-value form (`(s.read)(buf, usize(1), io)`), which the re-rooting does not handle, so the same expression is E0909 in the batch. Found 2026-10-25 on `feat/v3-std-cell-free-resources` (head `b9d544874`, tree binary) when the V3 review rows for `set_len`/`read`/`recv`/`write_str`/`accept` were unwrapped after #1602 legalized the value-parameter shape: `check` was green on all five files while `yo test` failed `tests/fs/file`, `tests/net/{tcp,udp,unix}` and `tests/process/command` with one E0909 each.

**Status:** OPEN.

## Reproducer

`issues/repros/2026-10-25-a-returned-method-call-in-batch-form-misses-the-callee-lend.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ TcpStream } :: import("std/net/tcp");
{ IoExn } :: import("std/error");
_tcp_read_escapes :: (fn(s : TcpStream, buf : *u8, io : Io) -> Impl(Future(usize, IoExn)))(s.read(buf, usize(1), io));
export(main);
main :: (fn() -> unit)(
  ()
);
test("batch form", {
  assert(true, "trivial");
});
```

- `yo check <file> --std-path ./std`: evaluator OK (the method-call form gets the callee lend).
- `yo test <file> --std-path ./std --parallel 1`: the batch's rendering of the same definition is `_tcp_read_escapes :: (fn(...))((s.read)(buf, usize(1), io));` and fails:

```text
error[E0909]: This value borrows `self` (the capture `self : &self` at .../std/net/tcp.yo:646:19), so it is second-class and cannot be returned: a borrow never outlives the scope that lends it.
```

## Root cause

Two halves must agree and do not:

1. The test-batch generator (the self-test harness in `src/main.yo` that writes `.yo_selftest_batch_*`) prints a method call whose result is returned as a parenthesized callee — `(s.read)(args)` — rather than the sugar form `s.read(args)` the source carried.
2. #1602's callee lend (the fix behind `issues/2026-10-25-a-borrowing-future-returned-through-a-delegating-call-is-rejected.md`) re-roots the returned future's borrows at the caller's argument places only when it can see the method-call structure; the fn-value call form carries no receiver mapping, so `reject_second_class_return` still finds the borrow rooted at the callee's `self` and rejects.

The same divergence would bite any test that RETURNS a borrowing method call, not just these rows.

## Fix direction

Either the batch printer keeps the sugar form for method calls (round-trip fidelity), or the callee lend recognizes the fn-value call of a method value `(s.read)(...)` by recovering the receiver from the callee expression. Until then, test files must not return a borrowing method call directly (wrap it in an `io.async` that borrows the parameter, or omit the row) — the V3 test rows were removed for exactly this reason.

