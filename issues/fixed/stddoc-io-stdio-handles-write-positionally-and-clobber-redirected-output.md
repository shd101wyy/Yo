# `std/io/stdio` handles write POSITIONALLY, so redirected stdout is silently overwritten

**Severity:** S1 — per-handle `pwrite` offsets on stdout silently overwrite, truncate and reorder redirected output — no error, no short write

**Found:** 2026-09-11, during the `std/` `///` doc sweep (agent A4, net/http/io group).
**Status:** FIXED 2026-10-15 (fix option 2, in two generations).
Generation A (#1376, shipped in v0.2.63): the runtime's read and write entry
points treat offset `u64.MAX` as the descriptor's own position on every
platform (`read(2)`/`write(2)` on POSIX and wasm; on Windows
`__yo_win_resolve_offset` starts the transfer at the handle's file pointer and
`__yo_win_settle_position` advances it, #1393); pinned by
`tests/sys/seek.test.yo`. Generation B (fix/stdio-current-position, on the
v0.2.63 seed): `std/io/stdio.yo`'s `Stdin`/`Stdout`/`Stderr` dropped their
`_offset` field and pass `u64.MAX`, so every handle, a `stderr` redirected onto
the same file, and libc's flushed `stdout` share the kernel's one position.
Test: `tests/io/stdio_redirect.test.yo`, which redirects the test process's own
fd 0/1/2 onto a temp file with `dup2` (Command's `Stdio` has no "to this file"
mode; a dup'd descriptor shares one open file description, which is what a
shell's `> out 2>&1` sets up). All four of its cases fail on the old std (two
handles: `BBBBCC`; stdout + stderr: `err:end`; a handle after flushed `print`:
`+handleint`; two `stdin()` handles re-read the first bytes) and pass with the
fix.

What remains is symptom 2's ORDER, not its loss: `std/fmt` writes through
libc's buffered `stdout`, which flushes on its own schedule, so text printed
before a handle write can land after it. `std/io/stdio.yo`'s module doc says
so and names `fflush` as the way to order the two; joining the writers is
option 3 below, not part of this fix.

Two symptoms, one cause.

## Symptom 1 — two `stdout()` handles clobber each other

`issues/repros/stddoc-io-stdout-handle-offset-clobbers-redirected-output.yo`
writes `AAAA` through one handle and `BBBB` through a second, in that order:

```
$ /tmp/p | cat          # stdout is a PIPE
AAAABBBB
$ /tmp/p > /tmp/p.txt   # stdout is a FILE
$ cat /tmp/p.txt
BBBB
```

Four bytes are gone, with no error and no short-write return.

## Symptom 2 — mixing `println` with a handle reorders, then loses, output

`issues/repros/stddoc-io-stdout-handle-and-println-lose-output.yo` calls
`println` FIRST, then writes through a handle:

```
$ /tmp/p2 | cat          # stdout is a PIPE
from handlefrom println
$ /tmp/p2 > /tmp/p2.txt  # stdout is a FILE
$ cat /tmp/p2.txt
from println
```

On a pipe the output is REORDERED against the source order; on a file the
handle's bytes are lost entirely.

## Root cause

`std/io/stdio.yo:22-32` — each handle owns a byte offset, and each accessor
mints a FRESH handle starting at zero:

```rust
Stdout :: ref(struct(_offset : u64));
stdout :: (fn() -> Stdout)(Stdout(_offset : u64(0)));
```

`std/io/stdio.yo:70-77` — `Writer.write` passes that offset to the runtime:

```rust
result := e.io.await(IO_file.write(i32(1), buf, u32(size), self._offset), e.io);
n := IoError.check(result, e.exn);
self._offset = (self._offset + u64(n));
```

and the runtime's write is POSITIONAL
(`src/codegen/async/runtime_io_macos.yo:60-64`, same shape on linux/windows/wasm):

```c
static int32_t __yo_sync_write(int32_t fd, const void* buf, uint32_t count, uint64_t offset) {
  ssize_t n = pwrite(fd, buf, (size_t)count, (off_t)offset);
  if (n < 0 && errno == ESPIPE) n = write(fd, buf, (size_t)count);
  return (n < 0) ? -errno : (int32_t)n;
}
```

So the behaviour splits on what fd 1 IS:

- **pipe / terminal** — `pwrite` fails with `ESPIPE`, the fallback `write`
  appends, and the per-handle offset is dead weight. Everything looks fine,
  which is why this does not show up in interactive use.
- **regular file** (`> out.txt`, a CI log, the test runner's capture) —
  `pwrite` writes AT the handle's own offset. Two handles both believe they
  own byte 0.

Symptom 2 has the same cause with a third writer involved: `std/fmt`'s
`println` goes through libc's buffered stdio, which keeps its own FILE\*
buffer and the kernel's shared file offset, and flushes at exit. So a program
mixing the two has two independent notions of "where stdout is", plus a
deferred flush — hence the reordering on a pipe and the loss on a file.

The module doc already knew half of this ("required when a standard stream is
REDIRECTED to a regular file (the async runtime writes positionally there)");
what it did not say is that the offset is PER HANDLE and therefore per
`stdout()` CALL, which is what makes it a data-loss bug rather than an
implementation detail.

## Why it matters

Redirected stdout is the normal case for anything non-interactive: `>`, a CI
log, a pipeline, `yo test`'s own capture. The failure is silent — no error,
no short count — and the amount lost depends on write sizes and ordering, so
it looks like a flaky truncation rather than a bug with a rule.

## Fix sketch (option 2 applied)

The offsets must not be per-handle. Options, in increasing order of ambition:

1. **Make the handles singletons.** One process-wide `_offset` per stream,
   shared by every `stdout()`. Fixes symptom 1; does nothing for symptom 2.
2. **Stop tracking an offset for the standard streams** and let the runtime
   use the kernel's file offset — i.e. plain `write(2)`, not `pwrite` — for
   fds 0/1/2. That is what the fd MEANS for a standard stream: the shell set
   up the offset, the process appends. It also fixes symptom 2's loss,
   because libc and the handle would then share the kernel offset. This needs
   a runtime change: `__yo_sync_write`/the async write path would need a
   "use the current offset" spelling (offset `(uint64_t)-1`, or a separate
   entry point) rather than always passing a position.
3. **Route `std/fmt` through `std/io/stdio`** so there is ONE writer to fd 1
   in the whole process. That removes the interleaving question entirely, and
   is the shape Rust has (`println!` and `io::stdout()` share a locked
   handle), but it is a much bigger change and would give `println` an `io`
   dependency it does not have today.

(2) is the smallest change that fixes both symptoms. Whatever lands, the test
must assert on a REDIRECTED stdout — both repros pass when stdout is a pipe.

Test coverage to add: a cli-case (or a test that spawns itself with
`Stdio.Piped` to a temp FILE) asserting the exact bytes of a redirected run
for both repros above.
