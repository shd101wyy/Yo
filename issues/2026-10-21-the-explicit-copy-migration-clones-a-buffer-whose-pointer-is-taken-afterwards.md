# The explicit-copy migration clones a buffer whose raw pointer is taken afterwards, so the cached pointer dangles

**Severity:** S2: `yo fix --migrate explicit-copy` rewrites a valid `AllowUnsafe` module into a heap-use-after-free without listing the site. The workaround is to review every field-store site in an unsafe module by hand. markdown_yo's `BlockState` needed this for 12 sites.

**Status:** OPEN.
**Found:** 2026-10-21, during VALUES_BY_DEFAULT V2b B2's sweep of
`markdown_yo` (`src/block/state.yo`). The binary was the explicit-copy
guards build (`feat/explicit-copy-guards` at 8954cb9b6), which is develop
plus the dying-temporary and `--hot-path` guards.

## Reproducer

`issues/repros/2026-10-21-explicit-copy-clones-a-buffer-whose-pointer-is-taken-afterwards.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Marks :: struct(marks : ArrayList(i32), _m : *i32);
make :: (fn() -> Marks)({
  marks := ArrayList(i32).new();
  marks.push(i32(7));
  Marks(marks : marks, _m : marks.ptr().unwrap())
});
main :: (fn() -> unit)({
  m := make();
  println(`${m.marks(usize(0))} ${m._m.*}`);
});
export(main);
```

```text
$ yo fix repro.yo --migrate explicit-copy
fix: repro.yo:8:17: field-store: `marks` would become `marks.clone()`
```

The rewritten line is
`Marks(marks : marks.clone(), _m : marks.ptr().unwrap())`. Built with
`--sanitize address --allocator system`, the original prints `7 7`. The
migrated program fails with `AddressSanitizer: heap-use-after-free`, because
`_m` points into the local `marks` buffer, and that buffer is freed when
`make` returns.

## Root cause

The migration reasons as follows: the source `marks` is used again after
the field store, so the copy would become an independent value under the
flip, so it spells `.clone()`. Here the only later use derives a raw pointer
to the buffer, and the program depends on that pointer aliasing the stored
field. A `.clone()` breaks the aliasing. The correct spelling is a move with
the pointer taken first:

```yo ignore
m_ptr := marks.ptr().unwrap();
Marks(marks : marks, _m : m_ptr)
```

Moving an `ArrayList` does not move its heap buffer, so `m_ptr` stays valid.

## Fix direction

When the "used again" read of the source is a pointer derivation (`.ptr()`,
`addr_of`, any method returning a raw pointer into the value), the migration
should list the site the way it lists a written-afterwards copy ("the two
may share a buffer on purpose"), not rewrite it.

The regression test is a cli-case beside
`tests/cli-cases/fix-migrate-explicit-copy-*`. Its fixture is the
reproducer, and its golden expects the site to be listed, with no
`.clone()` inserted. It lands with the fix: until then the golden would
record the wrong rewrite.

## B2's handling

In the `markdown_yo` sweep (branch `feat/explicit-copy-sweep`), the 12
`BlockState` sites (`src/block/state.yo`, the two constructors) are hand
edits: each pointer is taken before the struct literal, and the field store
stays a move. The B2 dry runs found no site of this shape in `tests/`,
`build.yo` or `scripts/build_site.yo`.
