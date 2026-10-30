# std I/O helpers `.unwrap()` a failed `GlobalAllocator.malloc`

**Severity:** S3. When the heap is exhausted, about 48 std scratch-buffer allocations die with `Called unwrap on a None value (at std/prelude.yo:…)`, which names neither the allocation nor the caller, instead of an out-of-memory diagnostic. The process dies either way. Only the message is wrong, and it breaks the safe-mode contract that out-of-memory is a diagnosed allocation failure (plans/SAFE_MODE.md §14 R5).

**Status:** OPEN. **Found:** 2026-10-30, while fixing `issues/fixed/2026-10-30-channel-new-oom-panics-as-an-unwrap-on-none.md`, the same pattern on the thread-spawn path.

## Sites

`grep -rnE "(malloc|calloc|realloc|aligned_alloc)\(.*\)\.unwrap\(\)" std` lists them:

- `std/process/command.yo`: `_spawn_with_fds`, `_drain_fd`.
- `std/env.yo`: `cwd`, `current_exe`.
- `std/fs/dir.yo`, `std/fs/file.yo`, `std/fs/metadata.yo`, `std/fs/temp.yo`.
- `std/sys/tcp.yo`, `std/sys/dir.yo`, `std/sys/dns.yo`, `std/sys/unix.yo`, `std/sys/statfs.yo`.
- `std/net/tcp.yo`, `std/net/udp.yo`, `std/net/unix.yo`.

`src/verifier/z3.yo` and `src/main.yo` (`valve_malloc`) hold three more in the compiler itself.

## Proposed fix

Replace each `.unwrap()` with `.expect("<fn>: out of memory")`, as `Channel.new` and `Box.new` already do. A site whose function returns an `IoError` result could return an out-of-memory error instead of panicking. That is an API choice to make per site.

## Test

For each changed site that can be driven under `--allocator fixed`, add a shape to `tests/cli-cases/compile-allocator-fixed-oom-shapes`. For example, `cwd()` after the heap has been filled.
