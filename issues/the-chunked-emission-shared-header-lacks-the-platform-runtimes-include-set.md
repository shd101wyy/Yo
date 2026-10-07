# The chunked-emission shared header lacks the platform runtime's include set

**Severity:** S3 — `--emit-chunks` on the compiler tree on Windows fails at the C compiler on
whichever libc symbol a Yo function spells from a chunk that is not the platform runtime's
residence chunk; the default single-file build is unaffected

**Status:** OPEN. Found 2026-10-06 while finishing feat/vbd-send-sync; the guarded
POSIX-constant fallbacks were fixed at the same time
(`issues/fixed/chunked-emission-a-posix-constant-fallback-is-visible-in-one-chunk-only.md`),
and the very next chunked compile surfaced this sibling.

## Symptom

With a tree-built compiler on Windows:

```
yo-out/…/yo.exe compile src/main.yo --std-path ./std --emit-chunks auto --jobs 8
…
yo-dbg2/yo_chunk019.c:43857:7: error: call to undeclared function '_rmdir'; ISO C99 and later
do not support implicit function declarations
```

Which symbol errors out depends on where the chunk boundaries fall: adding lines to one
module reshuffles the name-hash distribution and a different function lands outside the
chunk that carries the declaration it needs. Before the `_BlockingOwner`/spawn changes on
this branch the same command died on `FD_CLOEXEC` instead.

## Root cause

The shared header (`yo_shared.h`) compiles into every translation unit, but its include set
is the fixed runtime preamble (`codegen_c.yo`): `windows.h`, `<io.h>`, `<fcntl.h>`,
`<sys/stat.h>`, `<errno.h>`, … — not the PLATFORM runtime's own includes
(`src/codegen/async/runtime_io_windows.yo`'s block: `<direct.h>`, `<signal.h>`,
`<winsock2.h>`, `<ws2tcpip.h>`, `<mswsock.h>`, …), which are emitted into the CODE buffer
and therefore land in exactly ONE chunk's residue. A Yo-level extern (`std/fs`'s `_rmdir`,
a socket call) compiles into whatever chunk its function's name hashes to; every other
chunk cannot see the declaration. The macro-constant half of this class (the guarded
`#define` fallbacks) is fixed; the include lines are not.

## Fix direction (not yet done)

Route the platform runtimes' `#include` lines into the DECLARATIONS buffer beside the
fallback constants — includes are idempotent, and the shared header's preamble already
defines `WIN32_LEAN_AND_MEAN`/`_WINSOCKAPI_` before its first include, which is what makes
`<winsock2.h>` order-safe there. Verify with the tree-driven
`--emit-chunks auto` compile of the compiler on Windows (the failure above is its
reproducer) plus `scripts/bootstrap/chunked_gate.sh`.

## Workaround

Build the tree without `--emit-chunks` (`yo build --std-path ./std`), which emits one C
file and always sees the platform block's declarations.
