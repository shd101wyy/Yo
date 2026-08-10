# `yo build` wrote to `/yo-out` — empty project dir from `Path.parent()`

**Status: FIXED** 2026-08-09 (`yo-self/build_runner.yo`). Self-hosted compiler
only. Found by `tests/cli-cases/build-run` the first time `build` was dispatched.

```
$ cd <project> && yo-self build run
yo-self: error: read-only filesystem
```

EROFS, with nothing naming the path. `yo build` could not build ANYTHING from a
relative build file, which is the default.

## Root cause

```rust
project_dir := match(build_file_path.parent(), .Some(p) => p.to_string(), .None => String.from("."));
```

`Path.parent()` follows **Rust**, where `Path::new("foo").parent()` is
`Some("")` — not `None`, and not `"."`. The default build file is `./build.yo`,
so `project_dir` came out EMPTY, and every path derived from it became absolute:

```
_get_target_output_dir("") -> "/yo-out/aarch64-macos/bin"
```

Creating that directory hits macOS's read-only root volume. (On Linux it would be
EACCES instead — equally broken, differently spelled.)

`src/build-runner.ts` uses node's `path.dirname`, which returns `"."` for both
`build.yo` and `./build.yo`. The `.None` arm was already written to fall back to
`"."`; it just never fires, because the empty case comes back as `.Some("")`.

## Fix

Map the empty parent to `"."`, i.e. give `path.dirname` semantics at the call
site rather than changing `Path.parent()` (whose Rust-shaped contract is correct
and relied on elsewhere):

```rust
.Some(p) => {
  ps := p.to_string();
  if(ps.len() == usize(0), String.from("."), ps)
},
```

## Worth remembering

`Path.parent()` is Rust-shaped, `path.dirname` is node-shaped, and they differ
exactly on the relative single-component case that CLI defaults hit. Any port of
a `path.dirname` call needs this mapping.

The two sibling commands were audited and are safe, but for a different reason
than luck: both resolve the build file to an ABSOLUTE path first —
`fetch_command.yo` via `_resolve_from_cwd`, `install_command.yo` by joining
`YO_ORIGINAL_CWD` — so `parent()` always has a real directory to return.
`build_runner.yo` was the one that passed the raw relative option value straight
to `parent()`.
