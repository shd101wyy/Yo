# `Path.new` destroys the Windows UNC `\\server\share` prefix, turning a network share into a local absolute path

**Found**: 2026-09-04, during the std-API audit re-measurement of the path row
(the row asks "should `to_string` render `\` on Windows targets?"; the answer to
that is no, but looking at it surfaced this). **Status**: OPEN.
**Severity**: wrong-value.

## Symptom

A UNC path survives `Path.new` as a LOCAL absolute path — the `\\server\share`
prefix collapses to a single `/`:

```rust
{ String } :: import("std/string");
{ Path } :: import("std/path");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

// Build the input byte-wise (92 == '\', 63 == '?') so no string-literal
// escape rule can contaminate the test.
mk :: (fn(tmpl : str) -> String)({
  b := ArrayList(u8).new();
  t := String.from(tmpl).as_bytes();
  i := usize(0);
  while(i < t.len(), i = (i + usize(1)), {
    match(
      t.get(i),
      .Some(c) => {
        _p := b.push(cond((c == u8(63)) => u8(92), (c == u8(37)) => u8(63), true => c));
      },
      .None => ()
    );
  });
  String.from_bytes(b)
});

show :: (fn(tmpl : str) -> unit)({
  raw := mk(tmpl);
  p := Path.new(raw);
  println(`  "${raw}"  ->  "${p.to_string()}"   (absolute=${p.is_absolute()})`);
});

main :: (fn() -> unit)({
  show("??srv?share?file.txt");     // \\srv\share\file.txt
  show("??%?C:?x?y");               // \\?\C:\x\y
  show("??%?UNC?srv?share");        // \\?\UNC\srv\share
  show("C:?Windows?system32");      // C:\Windows\system32  (the case that WORKS)
  println(`  "//srv/share/file.txt"  ->  "${Path.new(String.from("//srv/share/file.txt")).to_string()}"`);
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`, `--optimize 2`):

```
  "\\srv\share\file.txt"  ->  "/srv/share/file.txt"   (absolute=true)
  "\\?\C:\x\y"  ->  "/?/C:/x/y"   (absolute=true)
  "\\?\UNC\srv\share"  ->  "/?/UNC/srv/share"   (absolute=true)
  "C:\Windows\system32"  ->  "C:/Windows/system32"   (absolute=true)
  "//srv/share/file.txt"  ->  "/srv/share/file.txt"
```

Expected: the prefix survives the round trip.
`\\srv\share\file.txt` must not become `/srv/share/file.txt` — those are two
different filesystem locations (a share on the host `srv`, versus a directory
named `srv` at the local root), and nothing in the API tells the caller the
meaning changed. `\\?\C:\x\y` — the Win32 verbatim/long-path prefix — must not
turn into a path whose first component is a literal `?`. The POSIX
double-slash form `//srv/share` is the same collapse arriving without any
backslash at all.

The drive-letter form is the counter-example that shows the omission is
specific, not systemic: `C:\Windows\system32` is recognized and rendered
correctly.

## Root cause

Three steps in `Path.new` compose:

1. **`std/path.yo:42`** rewrites every backslash to a forward slash,
   unconditionally and before anything else looks at the string:

   ```rust
   normalized := path_str.replace_all(String.from("\\"), String.from("/"));
   ```

   `\\srv\share` becomes `//srv/share`.

2. **`std/path.yo:44-89`** classifies the path. A leading `/` sets
   `_is_absolute = true`; a drive letter (`[A-Za-z]:`) also sets it
   (`:57-77`). There is no UNC arm — the comment at `:43-45` even says
   *"Windows: starts with drive letter like 'C:' or UNC path '\\'"*, but only
   the drive letter is implemented.

3. **`std/path.yo:95-101`** splits on `/` and skips empty segments. The two
   empties produced by `//` are dropped, so `srv` and `share` become ordinary
   segments indistinguishable from any other.

`to_string` (`std/path.yo:556-631`) then emits a single leading `/` for an
absolute path (`:605-610`), suppressing it only for the drive-letter case
(`:570-604`). `Path` has nowhere to record the prefix: its fields are
`_segments : ArrayList(String)` and `_is_absolute : bool`
(`std/path.yo:22-27`).

## Fix

Give `Path` the prefix Rust's `Path` calls a `Prefix` component:

1. Add `_prefix : Option(String)` to the `Path` struct (`std/path.yo:22-27`).
2. In `Path.new`, BEFORE the backslash rewrite at `:42`, detect a leading `\\`
   or `//`:
   - `\\?\UNC\<server>\<share>` and `\\<server>\<share>` → prefix
     `\\<server>\<share>`, `_is_absolute = true`, remaining segments parsed as
     usual;
   - `\\?\C:` (verbatim disk) → prefix `\\?\`, drive letter handled by the
     existing arm;
   - `\\.\<device>` (device namespace) → prefix `\\.\<device>`.
   A bare `//` on a POSIX target is *implementation-defined* in POSIX and is
   NOT a UNC path; keep collapsing it there, and gate the `//` spelling on
   `__yo_process_platform() == "windows"` — that builtin answers for the
   TARGET, not the host (`src/evaluator/builtins/process.yo:42-44`,
   `src/target.yo:288-290`), so a comptime cond arm is correct by construction
   and cross-compilation is not a problem.
3. Preserve `_prefix` through `_join_path` (`:177-212`), `clone` (`:687-707`),
   `parent`, `with_file_name` and friends, and emit it from `to_string`
   (`:556-631`) ahead of the leading separator.
4. **Sweep the derived impls — this is where a partial fix goes wrong.**
   `Eq` (`std/path.yo:634-687`) compares only `_is_absolute` and the segments, so a
   forgotten `_prefix` makes `\\a\b` compare EQUAL to `/a/b`. `Hash` (`:712-738`)
   and `Ord` (`:739-754`) have the same exposure. All three must include the
   prefix.

Do NOT fix this by making `to_string` render `\` on Windows targets. That
option was considered and rejected: `src/evaluator/memory_safety.yo:174` does
`_lex_abs_path(mp).starts_with(`${_lex_abs_path(sp)}/`)` — a `/`-literal string
comparison on a rendered path, and it is the std pragma exemption, i.e. exactly
the mechanism `issues/windows-lex-abs-path-voids-std-exemption.md` describes
breaking the whole Windows build. There are ~250 separator-literal string
operations in `src/` in the same class. Win32 file APIs accept `/` anyway; the
UNC prefix is the one Windows path form that genuinely changes meaning today.

**Separate but adjacent (do it in the same PR):** `PATH_SEPARATOR`
(`std/path.yo:7-11`) is exported and consumed by NOTHING — `to_string`
hard-codes `sep := String.from("/")` at `:559`, and the only reference to the
constant in the tree is the name-check in
`tests/std_export_coverage.test.yo:14,:97`. Either add the
`to_native_string()` renderer that consumes it (comptime-gated on
`__yo_process_platform()`, for display and for argv handed to native tools) or
delete it. Shipping an inert exported constant that a name-grep scores as
"covered" is the failure mode the audit's coverage section warns about.

## Regression test

`tests/path.test.yo`. The inputs must be built byte-wise (as in the reproducer
above) so the assertions cannot pass or fail for string-literal-escape reasons.
RED before the fix:

- `\\srv\share\file.txt` round-trips through `Path.new(...).to_string()`
- `\\?\C:\x\y` round-trips
- `\\?\UNC\srv\share` round-trips
- `Path.new(\\a\b) != Path.new(/a/b)` — the `Eq` assertion that catches a
  half-done fix
- `Path.new(\\srv\share).join("x").to_string()` keeps the prefix
- `C:\Windows\system32` → `C:/Windows/system32` (unchanged — the pin that the
  working case did not regress)
- on a POSIX target, `//srv/share` still collapses to `/srv/share`

## Breaking change

Yes, twice over. `Path.new` on a `\\`-prefixed input changes its rendered value,
and `Path`'s `Eq`/`Hash`/`Ord` stop treating `\\a\b` and `/a/b` as the same
path. Both belong in the release notes of the v0.2.x patch that carries them.
