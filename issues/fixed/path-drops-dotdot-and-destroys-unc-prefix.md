# `std/path` silently dropped `..` and destroyed the UNC prefix — three wrong-value defects, one root cause

**Found**: 2026-09-05, measured on v0.2.24 — `Path.new("../foo")` was `foo`,
`Path.new("a/b").join("../c")` was `a/b/c`, and `Path.new("\\server\share")`
was `/server/share`. **Fixed**: same day. The three are one root cause: `Path`
treated `..` as something it could resolve on its own, and had no notion of a
root that is not a bare `/`.

## Symptom

All three returned a path naming a **different file** from the one written, and
none of them reported anything:

```rust
main :: (fn() -> unit)({
  show("new(../foo)              ", Path.new(`../foo`));
  show("new(a/b).join(../c)      ", Path.new(`a/b`).join(`../c`));
  show("new(\\\\server\\share\\dir)  ", Path.new(`\\\\server\\share\\dir`));
  show("new(/a/../../b)          ", Path.new(`/a/../../b`));
  p := Path.new(`a/b`);
  p.push(`../c`);
  show("push(../c)               ", p);
});
```

```
$ ./pathrepro                       # BEFORE (v0.2.24)
new(../foo)               = foo
new(a/b).join(../c)       = a/b/c
new(\\server\share\dir)   = /server/share/dir
new(/a/../../b)           = /b
push(../c)                = a/b/c
```

```
$ ./pathrepro                       # AFTER
new(../foo)               = ../foo
new(a/b).join(../c)       = a/b/../c
new(\\server\share\dir)   = \\server\share\dir
new(/a/../../b)           = /a/../../b
push(../c)                = a/b/../c
```

Each line is its own hazard:

- **`../foo` → `foo`** — a relative path that escapes its directory quietly
  became one that does not. Every `Path.new` on user-supplied text (a build
  file's `root`, a CLI argument, a dependency's `path`) silently re-pointed at
  the current directory instead.
- **`join`/`push` dropped the argument's `..` entirely** rather than popping the
  receiver's last segment. `new` folded and `join` did not, so the two
  **disagreed** — `Path.new("a/b/../c")` was `a/c` while
  `Path.new("a/b").join("../c")` was `a/b/c`, two different answers for the
  same path. Both compilers' module resolvers work around this in comments
  (`src/evaluator/exprs/import.yo`, `src/main.yo`), building a combined string
  and re-`Path.new`-ing it because `join` could not be trusted.
- **`\\server\share` → `/server/share`** — a network share turned into a local
  absolute path. Silently, on every platform.

## Mechanism

`std/path.yo:131-146` (pre-fix) — `new`'s component loop resolved `..` itself:

```rust
is_dotdot => {
  // Pop the last segment if exists
  cond(
    (segments.len() > usize(0)) => {
      segments.pop();
    },
    true => ()          // ← nothing to pop: the `..` is DISCARDED
  );
},
```

The `true => ()` arm is the whole first defect: with no segment to pop, `..` was
thrown away instead of kept. On a relative path that is not a fold, it is a
deletion — `../foo` and `foo` name different files.

`std/path.yo:177-212` (pre-fix) — `_join_path` simply concatenated the two
segment lists. `Path.new("../c")` had already deleted the `..` on the way in, so
`join` could not have popped anything even in principle: the second defect is
the first one, observed one call later.

`std/path.yo:42` (pre-fix) — `new` folded `\` to `/` and then classified by the
first byte:

```rust
normalized := path_str.replace_all(String.from("\\"), String.from("/"));
...
(b == u8(47)) => { is_abs = true; }
```

`\\server\share` became `//server/share`, whose leading empty components were
dropped as ordinary separator noise; `server` and `share` were left as two
ordinary segments of a `/`-rooted path. There was nowhere in the representation
for a root that is not a bare `/`, so the share could not survive. (The Windows
drive letter escaped only because `to_string` re-detected `C:` in segment 0 —
`std/path.yo:571-602` — which is also why `with_extension` on `C:` would have
rewritten the drive.)

## The design question this forced

`plans/STD_API_AUDIT.md`'s path row had "revisit eager `..` normalization
(symlink semantics)" open. It is load-bearing here, so it is decided:

**`new`, `join` and `push` record components as written; `..` is folded only by
an explicit `normalize()`.** This is Rust's model (`Path`/`PathBuf` +
`components()`), and Python `pathlib`, Java NIO and .NET agree; the folding
APIs (Go `filepath.Join`, Node `path.join`) are string helpers, not path types.

Why this over "normalize consistently everywhere, but keep a leading `..`":

1. **Lexical folding is unsound.** `a/b/../c` and `a/c` name different files
   whenever `b` is a symlink — `..` is resolved by the kernel *after* the
   symlink, not before. A library that folds on construction silently hands
   back a path to a different file, which is the same wrong-value class as the
   three defects above.
2. **`Path` is lexical; resolving `..` is a filesystem question.** The answer
   that consults the filesystem already exists (`fs.canonicalize`,
   `std/sys/path.realpath`). Folding belongs in a separately named operation
   that says what it is.
3. **It makes the three functions agree by construction.** None of them folds,
   so there is no rule to keep in sync — which is exactly how `new` and `join`
   drifted apart in the first place.

Empty and `.` components are still dropped on construction: unlike `..`,
removing them can never change which file a path names.

## Fix

`std/path.yo`:

- **`Path` gains `_prefix : String`** — a root marker that is not a bare `/`:
  a Windows drive (`C:`) or a UNC share (`\\server\share`). A prefix implies
  absolute, is never popped by `normalize()`, and is never rewritten by
  `with_file_name` / `with_extension`. The drive letter moved out of segment 0
  into it, which is what makes `Path.new("C:/../x").normalize()` yield `C:/x`
  instead of eating the drive. `_prefix` is threaded through `parent`,
  `with_extension`, `with_file_name`, `strip_prefix`, `starts_with`,
  `ends_with`, `components`, `Eq`, `Hash`, `Clone`, `join` and `push`.
- **`new` records `..`**, drops empty and `.` components, and detects a UNC
  share by its **two leading backslashes** — the Windows spelling, which means
  nothing else on any platform. `//a/b` is deliberately NOT a UNC path: on
  POSIX that is an ordinary root with a redundant separator.
- **`normalize()` is new**: each `..` pops the component before it; a leading
  `..` on a *relative* path is preserved (there is nothing to pop — dropping it
  is the original defect); on an absolute path it folds away, because `/..` is
  `/`. Its doc comment states that it is lexical and wrong over symlinks.
- **`to_string` renders the prefix as the root.** A UNC path renders in the
  Windows spelling throughout (`\\server\share\dir`) because its root has no
  forward-slash spelling; every other path keeps the module's `/` rendering, so
  the audit row's separate "Windows separator in `to_string`" item is
  untouched. The old `has_drive_letter` re-detection block is gone — the
  representation now carries what it was re-deriving.

Compiler consumers that were relying on `new`'s eager fold now ask for it:

- `src/evaluator/exprs/import.yo` — `resolve_module_path` folds explicitly.
  This one is **required, not cosmetic**: the string is the module cache key, so
  `/std/imm/../allocator.yo` and `/std/allocator.yo` must not be two keys for
  one file, or the module is evaluated twice.
- `src/main.yo` — the preload walker computes the same key and folds the same way.
- `src/doc_command.yo` — `_resolve_path` is documented as node's
  `path.resolve`, which folds; it now calls `normalize()` to keep that contract.

Stale comments in `src/expr_info.yo` (`_mg_canon`) that justified themselves
with "`Path.new` collapses `.`/`..` on construction" now point at the loader's
explicit `normalize()`.

Three more consumers were silently wrong *because* of the fold and are fixed by
the model change alone, with no edit:

- `src/install_command.yo:643` probed `exists(Path.new("../foo"))` as
  `exists("foo")` — the wrong file, and therefore the wrong verdict.
- `src/init.yo:158` created `yo init ../foo` at `cwd/foo`.
- `src/lsp/completion.yo:795` listed the CURRENT directory when completing
  `import("../` — `Path.new("..")` had zero segments, so the join appended
  nothing — and now lists the parent.

## Tests

`tests/path.test.yo` — 86 pass, was 71.

Verified RED first against the unmodified `std/path.yo` (the five measured
behaviours, written without `normalize()` so they fail on assertions rather
than on a missing method):

```
  ✗ RED 1: Path.new keeps a leading ..
  ✗ RED 2: Path.join keeps .. from the argument
  ✗ RED 3: Path.push keeps .. from the argument
  ✗ RED 4: Path.new preserves a UNC prefix
  ✗ RED 5: a UNC share is not the local path of the same name
5 failed / 5 total
```

New tests:

- `Path.new keeps a leading .. on a relative path (measured defect)`
- `Path.join keeps .. coming from the ARGUMENT (measured defect)` — and asserts
  `join` agrees with `new`
- `Path.push keeps .. coming from the ARGUMENT (measured defect)` — and asserts
  `push` agrees with `join`
- `Path new/join/push agree on a path with no ..` — the over-rejection baseline
- `Path.normalize is documented as LEXICAL, so it is idempotent`
- `Path.new collapses repeated separators and a trailing slash` — including
  `//a/b` → `/a/b` (NOT a UNC share)
- `Path.new handles . in every position` — leading / interior / trailing, bare
  `.`, and `..` ≠ `.`
- `Path.new preserves a UNC prefix as a unit (measured defect)`
- `Path UNC root is a root, not a segment` — `file_name`/`parent` of the share
  are `None`, `with_file_name` cannot rewrite it
- `Path UNC survives join, push, components and normalize` — including
  `\\server\share\..\..\x` → `\\server\share\x`
- `Path drive letter is a root too` — `C:/../x` normalizes to `C:/x`,
  `C:/a` ≠ `D:/a`

Rewritten (they encoded the defect): `Path.new normalizes .. in paths`,
`Path.new handles complex normalization`, `Path normalization removes multiple
..`, and `Path .. beyond root is ignored for relative paths` — the last one
asserted `Path.new("../../../etc") == "etc"`, i.e. the bug, as intended
behaviour.

## Not fixed here

- **Windows separator in `to_string`** (the audit row's other open item) is
  untouched: only a UNC path renders with backslashes, and only because its
  root has no other spelling. A drive-rooted path still renders `C:/dir/f.txt`.
- **`Path.new(".")` still renders `"."` via the empty-segment representation.**
  Rust preserves a *leading* `.` as a real component (so `./a` and `a` differ,
  which matters to `exec`); Yo drops it, because dropping `.` is sound and
  because `Path.new("")`/`Path.new(".")` rendering `"."` is depended on
  (`src/version_cache.yo:277`, `src/main.yo:3520`). Worth revisiting with the
  separator item, not here.
- `src/unsafe_report.yo` / `src/public_safe_report.yo` still special-case a `.`
  root by walking the CWD absolutely. That workaround is still correct; it is
  simply no longer necessary for the reason its comment gives.
- **Windows drive-RELATIVE paths (`C:foo`) are still not modelled.** `Path` has
  no "relative to the drive's own cwd" concept, so `C:foo` is read as a drive
  root plus one segment and renders `C:/foo` (it rendered `/C:foo` before —
  also wrong, and additionally not a drive path at all). Deliberately NOT pinned
  by a test: blessing either rendering would bless a semantics `Path` does not
  have. It belongs with the separator item.
