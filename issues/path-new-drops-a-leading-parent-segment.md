# `Path.new` silently drops a leading `..`, turning a sibling of the cwd into a child of it

**Found**: 2026-09-04, during the std-API audit re-measurement of the path row.
The plan (`plans/STD_API_AUDIT.md`, path row) frames the item as "revisit eager
`..` normalization (symlink semantics)" — an eager-vs-lazy design question. The
symlink question is real but secondary: this value is wrong under BOTH
conventions. **Status**: OPEN. **Severity**: wrong-value.

## Symptom

```rust
{ String } :: import("std/string");
{ Path } :: import("std/path");
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println(`Path.new("../foo")     = "${Path.new(String.from("../foo")).to_string()}"`);
  println(`Path.new("../../etc")  = "${Path.new(String.from("../../etc")).to_string()}"`);
  println(`Path.new("a/../../b")  = "${Path.new(String.from("a/../../b")).to_string()}"`);
  println(`Path.new("./..")       = "${Path.new(String.from("./..")).to_string()}"`);
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`, `--optimize 2`):

```
Path.new("../foo")     = "foo"
Path.new("../../etc")  = "etc"
Path.new("a/../../b")  = "b"
Path.new("./..")       = "."
```

Expected, matching Go's `filepath.Clean` and Node's `path.normalize` — the two
languages that, like Yo, normalize eagerly at construction:

```
Path.new("../foo")     = "../foo"
Path.new("../../etc")  = "../../etc"
Path.new("a/../../b")  = "../b"
Path.new("./..")       = ".."
```

`../foo` names a SIBLING of the current directory. Yo turns it into `foo`, a
CHILD of the current directory — a different file, silently. Rust (lazy, keeps
`..` verbatim) also preserves it. Yo matches neither convention.

## Root cause

`Path.new`'s `..` handling pops unconditionally and does nothing when there is
nothing left to pop (`std/path.yo:133-145`):

```rust
cond(
  is_dot => (),
  // Skip "."
  is_dotdot => {
    // Pop the last segment if exists
    cond(
      (segments.len() > usize(0)) => {
        segments.pop();
      },
      true => ()
    );
  },
  true => {
    segments.push(part);
  }
);
```

The `true => ()` arm is the bug. Go's rule is *"eliminate each inner `..` along
with the non-`..` element that precedes it; eliminate `..` elements that begin a
**rooted** path"* — the "begin a rooted path" qualifier is missing here, so a
leading `..` is discarded on relative paths too, where it is meaningful.
`Path` carries `_is_absolute` (`std/path.yo:22-27`), so the distinction is
available at exactly this point; it is simply not consulted.

Note the representation is capable of holding the fix: `..` is a two-byte
segment like any other, `to_string` (`std/path.yo:556-631`) joins segments with
`/` and needs no change, and the empty-relative-path render rule at
`std/path.yo:567-569` is untouched by it.

## The wrong value is pinned by a test

`tests/path.test.yo:374-378`:

```rust
test("Path .. beyond root is ignored for relative paths", {
  path := Path.new(`../../../etc`);
  s := path.to_string();
  assert(s == `etc`);
});
```

That test asserts the defect. It must be replaced, not merely extended.

## Fix

In `std/path.yo:133-145`, keep a leading `..` when there is nothing to pop AND
the path is relative; keep discarding it when the path is absolute:

```rust
is_dotdot => {
  cond(
    (segments.len() > usize(0)) => {
      // Only pop a segment that is not itself "..", otherwise "../.." folds
      // into the empty path.
      …pop when the last segment is not ".."…
    },
    is_abs => (),                     // Go: "/.." is "/"
    true => { segments.push(part); }  // relative: "../" is meaningful
  );
}
```

Two details the implementation must get right, both of which Go's `Clean`
handles and a naive patch does not:

1. **Do not pop a `..`.** `Path.new("../..")` must keep both segments. The pop
   arm has to check that the last segment is not itself `..` before popping,
   otherwise the second `..` cancels the first.
2. **`/..` collapses to `/`.** For `_is_absolute` paths the existing
   discard-on-empty behaviour is correct and must stay
   (`Path.new("/../../etc") == "/etc"`).

`is_abs` is the local `Path.new` computes before the segment loop
(`std/path.yo:33`, assigned in the classification block at `:44-89`), so the
flag is already in scope at `:133` — no restructuring is needed.

**Sequencing: this must land before `Path.join`/`Path.push` can be fixed, and
the two should ship together** — see
`path-join-and-push-never-refold-parent-segments.md`. `join` needs to re-fold
`..` across a concatenation, which is impossible while `..` cannot be
represented in a `Path` at all. The reverse dependency also holds, and it is
sharper than it looks: `src/evaluator/memory_safety.yo:141-155`
(`_lex_abs_path`, which decides the std pragma exemptions) absolutizes a
relative module path with `cwd().join(path)`. Today `path` can never begin with
`..` because `Path.new` has already destroyed it; after this fix it can, and
`join` would concatenate it un-folded (`/a/b/../foo`), changing the lexical
prefix comparisons at :174 and :205. Landing this fix WITHOUT the `join` fix
therefore moves the breakage rather than removing it.

**Design decision.** Eager (Go/Node) vs lazy (Rust). Recommend staying EAGER and
making the rule exactly Go's: (a) the symlink objection (`a/b/../c != a/c` when
`b` is a symlink) is a lexical-vs-system distinction that Go documents and Yo
already answers with `canonicalize` (`std/fs/file.yo:528`, realpath); (b) going
lazy would break `src/main.yo:363-367`, the compiler's relative-import
resolution, which relies on `Path.new` folding `..` for imports like
`"../types/tags.yo"`, and its `visited` dedup keys (`src/main.yo:393-405`) would
stop matching across spellings of the same file — duplicate module evaluation,
a failure mode this project has hit before; (c) lazy means auditing 196
`Path.new(` sites in `src/` and 60 in `std/` for meaning changes. The two
measured defects are wrong under EITHER policy, so fixing them is unconditional
work that also makes the eager choice defensible.

Also document `Path` as a LEXICAL path in its doc comment
(`std/path.yo:20-21`, currently just "Paths are normalized on construction"),
pointing at `canonicalize` for the symlink-aware answer — the same disclaimer
Go's `Clean` carries — and mirror it into `docs/en-US/` and `docs/zh-CN/`.

## Regression test

`tests/path.test.yo`. Delete "Path .. beyond root is ignored for relative paths"
(:374-378) and replace it with Go/Node-parity assertions:

- `Path.new("../foo").to_string() == "../foo"`
- `Path.new("../../etc").to_string() == "../../etc"`
- `Path.new("a/../../b").to_string() == "../b"`
- `Path.new("./..").to_string() == ".."`
- `Path.new("/../../etc").to_string() == "/etc"` (the absolute case that must
  NOT change)
- `Path.new("a/b/../c").to_string() == "a/c"` (inner fold still works)
- and the components/parent/starts_with behaviour of a path whose first segment
  is `..`, since `..` becomes an ordinary segment for
  `components`/`ancestors`/`strip_prefix`/`starts_with`/`ends_with`
  (`std/path.yo:371`, `:415`, `:473`, `:512`, `:773`).

## Breaking change

Yes. Every `Path.new` input beginning with `..` (after `.` stripping) changes
value. The blast radius inside the tree is bounded — `src/main.yo:365` joins
`base + "/" + rel` and calls `Path.new` on the whole string, so its leading
segment is the base, not `..`, and `src/evaluator/memory_safety.yo:141-155`
absolutizes before folding — but the change must be called out in the release
notes of the v0.2.x patch that carries it. Gate on `yo check ./src`, the fast
suite, `gates_fast.sh` + `fixpoint_only.sh` (import resolution is what those
exercise hardest), and the Windows cross-emit smoke.
