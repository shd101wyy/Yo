# `yo unsafe-report` / `yo public-safe-report` cut the relative path with a BYTE length

**Status: FIXED 2026-08-26 by `plans/STD_API_AUDIT_D4_PLAN.md` D4 PR 3** —
with no edit to either file. `String.substring` is byte-indexed now, which is
the basis `root_prefix_len` always had.

Found 2026-08-26 while reviewing D4 PR 2, and deliberately not fixed there
because PR 2's contract was that it changed no behaviour.

**Re-measured on the same standalone reproducer after the flip** (the exact two
lines, compiled `--release`, 2026-08-26):

```
ascii  root -> "a.yo"        (want "a.yo")     ✓
cjk    root -> "a.yo"        (want "a.yo")     ✓   was "yo"
accent root -> "src/a.yo"    (want "src/a.yo") ✓   was "rc/a.yo"
```

**Not covered by a repo test**, honestly stated: `_walk_yo_files` is private to
each of the two files and neither subcommand has a test harness, so the
reproducer above is the whole evidence. A regression here would be caught only
by the `substring` contract tests in
`tests/string/string_byte_index.test.yo`.

This is an **8th** instance of the §5.1 "mixed-basis" family; the plan's §5.1
table lists 7 and does not name these two files.

## Where

Two files carrying the same copied walker:

- `src/unsafe_report.yo:511` + `:521` (`_walk_yo_files`)
- `src/public_safe_report.yo:517` + `:525` (same function, duplicated)

```rust
root_prefix_len := walk_root.as_bytes().len();   // BYTES
...
rel := p.substring(root_prefix_len + usize(1), p.len());   // substring is RUNE-indexed today
segs := rel.split(`/`);
```

`root_prefix_len` is the **byte** length of the scan root. `String.substring`
is **character**-indexed today (`std/string/string.yo`), so for any root path
containing a non-ASCII byte the cut starts `bytes(root) - runes(root)`
positions too far into `p`.

## Consequence

`rel` is truncated at the front. Its `/`-split then loses leading segments, so

- the directory-skip filter (`node_modules`, `.git`, `dist`, `yo-out`,
  `build`, dot-directories) is applied to the **wrong** segments, and
- when the scan root is `.` (`is_dot`), the mangled `rel` is what gets printed
  as the file label in the report.

Both subcommands are user-facing: `src/main.yo:3245` `run_unsafe_report_cmd`
(`yo unsafe-report [path] [--json]`) and its public-safe twin.

## Measured

Standalone reproducer of the exact two lines (compiled `--release`, run
2026-08-26):

```
ascii  root -> "a.yo"      (want "a.yo")
cjk    root -> "yo"        (want "a.yo")       root = /tmp/名
accent root -> "rc/a.yo"   (want "src/a.yo")   root = /tmp/café
```

## Fix direction

Do **not** patch it in PR 2 — that would be a behaviour change inside a
provably-inert commit. D4 PR 3 rebases `substring` onto bytes, at which point
`root_prefix_len` and the slice agree and both lines become correct with no
edit. Add the CJK-root case above to whatever multibyte battery PR 3 ships so
the fix is witnessed rather than assumed.

If D4 is ever abandoned, the standalone fix is
`p.substring(walk_root.len() + usize(1), p.len())` (rune length on both sides)
— but the two files must be changed together, since the walker is duplicated.
