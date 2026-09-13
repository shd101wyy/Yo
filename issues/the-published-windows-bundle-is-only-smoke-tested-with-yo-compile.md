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

**There is no one-generation lag protecting this**, and that is a
general rule worth applying beyond this issue:

> A CODEGEN change reaches users only after the next seed bump, so a
> regression has a whole release cycle to be caught in. A change to the
> emitted RUNTIME — anything under `src/codegen/async/runtime_io_*.yo`,
> the allocator emitters, the parallelism runtime — is carried by every
> binary the new compiler emits, the bundle's own `yo` included, from
> the FIRST release that contains it.

That difference decides how much pre-release verification a change
needs, and **it is not visible from the diff**: both look like edits
under `src/`.

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
compile check: `yo init` a trivial project and **`yo build run`** it with
the INSTALLED bundle.

`yo build run` rather than plain `yo build`, because it closes the gap
twice for one extra word. `yo build` already drives the event loop and
spawns a child `yo compile`, which is the subprocess path. `run` then
EXECUTES the produced binary — so the bundle's own runtime spawns a
process, and the FRESHLY EMITTED runtime starts up inside it. Since the
gap is precisely "the runtime is linked but never executed", the second
half is the one that matters. (`yo build test` is a third option and the
wrong one: it compiles a test batch, which is slower and drags the test
runner's machinery into a check meant to be about the runtime.)

**It is hermetic** — verified 2026-09-13 by running it with `YO_CACHE_DIR`
pointed at a scratch directory: rc=0 and that directory was still
completely EMPTY afterwards, without even the `store/`/`git/`/`index/`
skeleton. A scaffolded project never touches the dependency machinery, so
the step needs no network and cannot flake on GitHub being slow. That
holds after the `yo.toml` work too: `yo init` writes a `[dependencies]`
table containing only a comment, so there is nothing to resolve.

The Windows runner image already has clang and git (which is why
`install.ps1 -NoDeps` is safe there) and the bundle is installed to a
prefix and PATHed, so the step needs nothing new.

An `install` smoke test would additionally cover the network and git
paths, but needs a fixture repository, so it is the larger follow-up.

Cheap, permanent, and it gates every future release rather than being a
thing someone remembers to do by hand.
