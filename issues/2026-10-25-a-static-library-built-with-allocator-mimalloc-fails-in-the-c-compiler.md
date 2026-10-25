# A `--static-library` built with `--allocator mimalloc` fails in the C compiler

**Severity:** S2 — `yo compile <lib>.yo --static-library --allocator mimalloc` never
produces an archive: the C compiler is handed two sources and one `-o`, and
refuses. The workaround is `--allocator system`.

**Status:** open. Found 2026-10-25 by the review of the mimalloc hard-error change
(`issues/retired/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`).
The seed (0.2.69) fails the same way, so the hard-error change did not cause it.

## Reproducer

```yo
add :: (fn(a : i32, b : i32) -> i32)(a + b);
export(add);
```

```sh
yo compile lib.yo --static-library --allocator mimalloc -o libadd.a
```

```text
Using bundled mimalloc
clang: error: cannot specify -o when generating multiple output files
yo: error: compile: C compiler failed (exit 1) on libadd.a.c
```

`--allocator system` builds the archive.

## Root cause

The C-compile step in `src/main.yo` appends the bundled mimalloc's
`vendor/mimalloc/src/static.c` (with `-I…/include -DMI_BUILD_RELEASE`) to the
shared `cmd` argv before it branches on the output kind. The executable branch
compiles and links every source in one invocation, which is fine. The
`--static-library` branch then adds `-c -fPIC <program>.c -o <out>.o` to the same
argv and archives that one object, so the C compiler sees two sources with
`-c` and a single `-o`.

## What a fix has to decide

- Compile each source to its own object (the program's C and `static.c`) and
  archive both, so the `.a` carries the allocator its `__yo_malloc` calls name.
- Or treat the allocator as the final link's choice: an archive whose C names
  `mi_malloc` but carries no mimalloc leaves the consumer to link one. That is
  the `plans/backlog/ALLOCATOR_PLACEMENT.md` question (the global allocator is
  declared by the root module), and a library is not a root.

Either way, the result must be a hard error or a working archive, never a
silent switch to the system allocator.

## Test

A fix adds a cli-case that builds a static library with `--allocator mimalloc`
and checks the archive exists (`tests/cli-cases/`), failing on the code above.
