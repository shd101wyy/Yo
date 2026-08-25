# `mkdir_all` feeds a BYTE index to the rune-indexed `substring`

**Status:** OPEN. Found 2026-08-26 while migrating call sites for
`plans/STD_API_AUDIT_D4_PLAN.md` PR 2. **Deliberately not fixed there** — PR 2's
contract is that it changes no behaviour. **D4 PR 3 fixes it for free** by
making `substring` byte-indexed, which is the basis `i` already has.

## Where

`std/fs/dir.yo`, `mkdir_all`'s ENOENT recovery path (lines ~93-121):

```rust
bytes := path_s.as_bytes();      // BYTE array
i := usize(1);
...
while(runtime(i < bytes.len()), {
  b := bytes(i);
  cond(
    ((b == u8(47)) || (b == u8(92))) => {
      // '/' found - try to create this prefix
      prefix := path_s.substring(usize(0), i);   // <-- `substring` is RUNE-indexed
      ...
```

`i` is a byte offset into `path_s.as_bytes()`. `String.substring(start, end)` is
**character**-indexed today (`std/string/string.yo`), so `substring(0, i)` cuts
after `i` RUNES, not after `i` bytes.

## Consequence

For an all-ASCII path the two coincide and the code is correct — which is why
this has never been noticed. For a path with any non-ASCII component ahead of a
separator, `i` overshoots the rune count and the prefix handed to `mkdir` is
**longer than intended**, or (when the rune count runs out) the clamped whole
string. `mkdir_all("/tmp/日本語/a/b")` therefore creates the wrong parent
directories, and the subsequent `mkdir` of the real leaf either fails with
`ENOENT` again or leaves a tree the caller did not ask for. rc can be 0 with the
wrong filesystem state.

## Reproducer sketch

```rust
{ mkdir_all } :: import("std/fs/dir");
// under an effect handler providing io/exn:
mkdir_all(Path.from(`/tmp/yo-d4/日本語/deep/leaf`));
// expected: /tmp/yo-d4/日本語/deep/leaf exists
// actual:   the intermediate prefixes are cut at the wrong offsets
```

## Family

This is the same shape as the six already recorded in
`plans/STD_API_AUDIT_D4_PLAN.md` §5.1 — `src/main.yo:789-802` `_win_dirname`,
`src/main.yo:852-866` `_path_has_extension`, `src/install_command.yo:60,66`,
`src/pkg_config.yo:34-66` `_split_whitespace` — a `len()`/`as_bytes()` byte walk
whose index is then handed to a rune-indexed slice. It is the **eighth**
confirmed instance and the **first in `std/`** rather than `src/`.

## Fix

Do nothing here; land D4 PR 3. When `String.substring` becomes byte-indexed,
`substring(0, i)` means exactly what the loop already intends and the bug
disappears without an edit. If D4 PR 3 is ever abandoned, the standalone fix is
`path_s.try_substring(usize(0), i).unwrap_or(path_s.clone())` — `i` always sits
on a separator byte, which is a rune boundary, so `try_substring` cannot refuse.

**A test must come with PR 3** (`tests/fs/` has no non-ASCII path coverage):
create a directory tree with a multibyte component and assert every level
exists.
