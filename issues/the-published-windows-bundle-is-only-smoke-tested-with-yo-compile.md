# The published Windows bundle is only smoke-tested with `yo compile`

**Status: OPEN (filed 2026-09-13).** `install-scripts.yml`'s `windows`
job is the only place a PUBLISHED Windows bundle is exercised, and the
whole exercise is:

```powershell
yo compile hello.yo -o hello.exe
$out = (& .\hello.exe | Out-String).Trim()
if ($out -ne 'installed ok') { throw "unexpected output: $out" }
```

where `hello.yo` is

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println(`installed ok`);
});
export(main);
```

**`main` takes no `io`.** The async I/O runtime is emitted into
`hello.exe` and linked, and then never executed — no event loop, no
socket, no subprocess, no timer. So the Windows bundle ships with an
async runtime that nothing on Windows has RUN.

## Why this is not covered elsewhere

`test-native` is the only other Windows job, and it never runs a bundle:
it downloads cross-emitted C from `suite-cross-emit`, compiles it
natively, and runs the suite. That gates the emitted C — which is real
coverage of the runtime's behaviour — but it gates a natively
recompiled test binary, not the artifact a user downloads.

**There is no one-generation lag protecting this.** A CODEGEN change
reaches users only after the next seed bump, so a regression has a
release to be caught in. A change to the emitted async RUNTIME
(`src/codegen/async/runtime_io_*.yo`) is carried by every binary the
new compiler emits, immediately — including the bundle's own `yo`.

## The failure shape this is the gap for

Measured precedent: green codegen suites and a holding bootstrap
fixpoint said nothing about the v0.2.30 gen-1 binary crashing in
`fetch_package`, because the suites exercise the COMPILER's behaviour
while the crash was in the compiler's own compiled-in runtime, on a path
no suite drove (`issues/fixed/` — the gen-1 runtime gate). `yo compile
hello.yo` drives almost none of the async runtime; `yo build` drives the
event loop and subprocesses, and `yo install` adds the network and a git
subprocess.

This became worth writing down with the Windows IOCP audit (#638), which
rewrote `connect`, `sendto`, `recvfrom`, the socket-fd close registry and
the fs-watch rearm. Every one of those is in the class described above.

## Fix

Add one step to `install-scripts.yml`'s `windows` job, after the existing
compile check: `yo init` a trivial project and `yo build` it with the
INSTALLED bundle. That drives the event loop and a subprocess through the
bundle's own runtime, which is the part currently unexercised. An
`install` smoke test would additionally cover the network and git paths,
but needs a fixture repository, so it is the larger follow-up.

Cheap, permanent, and it gates every future release rather than being a
thing someone remembers to do by hand.
