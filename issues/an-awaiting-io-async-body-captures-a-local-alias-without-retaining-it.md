# An awaiting `io.async` body captures a local alias without retaining it

**Severity:** S1: use-after-free in safe code. A future whose body awaits and reads `b`, where `b := a` aliases an RC-holding local of the enclosing function, reads `a`'s payload after the function has released it. An `ArrayList` alias crashes (SIGSEGV, exit code 11). A `String` alias reads as empty, so `s.ptr().unwrap()` panics with "Called unwrap on a None value".

**Status: OPEN.** Found 2026-10-05 while gating String S3a: its migration had turned `sb := s.as_bytes()` (a call result) into `sb := s` (an alias) in `TlsStream.write_str`, and the live TLS test started failing. S3a drops those aliases (the `write_str` / `write_string` methods of `std/crypto/tls.yo`, `std/net/tcp.yo` and `std/net/unix.yo` capture the string itself), which sidesteps this bug but does not fix it. **Measured on:** yo 0.2.52, a stage-1 of develop `41477231a`, `--std-path ./std`.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
{ assert, panic } :: import("std/assert");
{ String } :: import("std/string");
{ IoExn, Exception } :: import("std/error");
give :: (fn(p : *u8, n : usize, io : Io) -> Impl(Future(usize, IoExn)))(
  io.async(e => n)
);
cap_str :: (fn(data : str, io : Io) -> Impl(Future(usize, IoExn)))({
  s := String.from(data);
  sb := s; // an alias of the local
  io.async(e => {
    n := e.io.await(give(sb.ptr().unwrap(), sb.len(), e.io), e);
    return(n);
  })
});
test("an io.async body that awaits reads a String copied from a local", {
  exn := Exception(throw : (err -> panic("x")));
  e := IoExn(io : io, exn : exn);
  n := io.await(cap_str("hello", io), e);
  assert(n == usize(5), `got ${n.to_string()}`);
});
```

Result: `Called unwrap on a None value`.

| Shape inside `cap_str` | Result |
| --- | --- |
| `s := String.from(data); sb := s;` then capture `sb` | fails (None) |
| `sb := String.from(data);` then capture `sb` | passes |
| `sb := s.clone();` then capture `sb` | passes |
| `sb := data;` where `data : String` is a parameter | passes |
| `s := ArrayList(u8).new(); …; sb := s;` then capture `sb` | SIGSEGV (exit code 11) |

## Likely cause (not confirmed)

`sb := s` between two locals is an alias, and the dup/drop pass cancels the pair (AGENTS.md, "Cancelling a dup/drop pair is only sound when the container outlives the local"). The future's state machine then holds `sb` with no reference of its own, while `s` is released when `cap_str` returns the future, before the body runs. The capture into the state machine needs its own retain, or the cancellation must not fire when the alias escapes into an `io.async` body. That is the same class as `issues/fixed/spawn-closure-captures-never-dropped-leak.md` and `issues/fixed/a-local-stored-in-a-struct-field-is-dangling-after-the-container-dies.md`, where closure definitions with deferred dups are skipped.

## Fix needs

- A codegen or optimizer fix, with the table above as tests (all five shapes pass).
- The tests go into `tests/` with the fix.
