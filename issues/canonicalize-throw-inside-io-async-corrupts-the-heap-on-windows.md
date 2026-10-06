# A `canonicalize` throw handled by an unwinding handler inside an `io.async` fn corrupts the heap (Windows)

**Severity:** S2 — deterministic STATUS_HEAP_CORRUPTION crash of a user program on a primary platform, in the textbook error path of a common fs API

**Found**: 2026-10-03, while reproducing `issues/fixed/s3-fs-wrappers-windows-semantics-audit.md` (the triage repro's phase 3 hit it at the `fs_dir.symlink` permission-denied throw; minimised to `fs_file.canonicalize`).

**Status**: OPEN. Measured on Windows 10 (10.0.26200) with a tree-built `yo`
at develop `5c1d978c1`; not yet checked on macOS/Linux.

## Reproducer (deterministic, 6/6 runs)

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ Path } :: import("std/path");
{ Exception, IoExn } :: import("std/error");
fs_file :: import("std/fs/file");

phase :: (fn(io : Io) -> Impl(Future(unit, IoExn)))(
  io.async(e => {
    exn := Exception(
      throw : (
        err -> {
          println(`phase handler ran, unwinding`);
          unwind(());
        }
      )
    );
    e.io.await(fs_file.canonicalize(Path.new(`/nonexistent/zzz`), e.io), IoExn(io : e.io, exn : exn));
    println(`phase continued (no throw)`);
    ()
  })
);

main :: (fn(io : Io) -> unit)({
  fe := Exception(throw : (_err -> unwind(())));
  println(`main: before`);
  io.await(phase(io), IoExn(io : io, exn : fe));
  println(`main: after`);
});
export(main);
```

```
$ yo compile tmp/fixme.yo -o probe && ./probe ; echo $?
main: before
phase handler ran, unwinding
EXIT=-1073740940        # 0xC0000374 STATUS_HEAP_CORRUPTION (bash reports rc 139/127)
```

Sometimes the crash takes the buffered stdout with it (no output at all,
bash rc 127); the exit status is the same.

## What discriminates

Same program shape, one operand changed at a time (all compiled by the same
tree-built binary):

| variant | result |
| --- | --- |
| `fs_file.canonicalize` on a nonexistent path (THROWS) | STATUS_HEAP_CORRUPTION, 6/6 |
| `fs_file.write_string` to `/nonexistent/zzz/x.txt` (THROWS) | clean, rc 0, `main: after` printed |
| `fs_file.try_exists` on `/nonexistent/zzz/x` (answers false, no throw) | clean, rc 0 |
| `fs_dir.symlink` without privilege (THROWS EPERM) — the triage repro's phase 3 | SIGSEGV, rc 139 |
| `canonicalize` throw + unwind at TOP LEVEL of a test body (`tests/fs/fs_convenience.test.yo` "canonical throws for nonexistent path") | passes |

So the crash needs a THROWING op awaited inside the `io.async` body with a
locally installed unwinding handler — but not every throwing op triggers it:
`canonicalize` and `symlink` do, `write_string` does not. That op dependence
points at the error-path/value transport, not only at the frame shape.

## Relation to the fixed unwind bugs

`issues/fixed/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`
(fixed 2026-09-29, `tests/async/sm_protocol.test.yo`) covered the rc-0 and
SIGSEGV shapes of unwinding inside an `io.async` body: the synchronous
awaiter misidentified itself as the handler's install frame and memcpy'd
another frame's unwind value. This heap-corruption crash is either an escape
of that fix (a path the runtime-time installer identification still
mishandles) or a separate defect in the error path of
`__yo_sync_realpath`/`__yo_sync_symlinkat` on Windows (both go through
`GetFinalPathNameByHandleW` + `__yo_win_utf8_to_wide` frees on failure; a
double free there would corrupt the heap exactly like this). Distinguishing
those two is the first investigation step: run the reproducer with the
handler changed to NOT unwind (resume instead), and separately run
`canonicalize`'s failing path with no `io.async` fn wrapper.

## Repro files

Scratch copies from the session (tmp* is gitignored): `tmp/repro-unwind-main.yo`
(canonicalize), `tmp/repro-unwind-main2.yo` (write_string control),
`tmp/repro-unwind-tryexists.yo` (no-throw control). The inline reproducer
above is the canonical one.
