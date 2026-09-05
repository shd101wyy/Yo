# `Path.join` / `Path.push` never re-fold `..`, so `"a/b".join("../c")` is `a/b/c`

**Found**: 2026-09-04, during the std-API audit re-measurement of the path row.
**Status**: OPEN. **Severity**: wrong-value. The compiler already works around
this rather than relying on it (`src/main.yo:363-367`), which is the strongest
evidence that the behaviour is not intended.

## Symptom

```rust
{ String } :: import("std/string");
{ Path } :: import("std/path");
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println(`join("../c") = "${Path.new(String.from("a/b")).join(String.from("../c")).to_string()}"`);
  println(`join("..")   = "${Path.new(String.from("a/b")).join(String.from("..")).to_string()}"`);
  p := Path.new(String.from("a/b"));
  p.push(String.from("../c"));
  println(`push("../c") = "${p.to_string()}"`);
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`, `--optimize 2`):

```
join("../c") = "a/b/c"
join("..")   = "a/b"
push("../c") = "a/b/c"
```

Expected `a/c` and `a` respectively, under Yo's eager (Go/Node) convention —
`filepath.Join("a/b", "../c") == "a/c"`, `path.join("a/b", "..") == "a"`. Under
Rust's lazy convention the answer would be the un-folded `a/b/../c`. `a/b/c` is
a THIRD answer, and it is a different file under both conventions.

`join("..")` is the more alarming of the two: the argument vanishes entirely, so
"go up one level" silently becomes "stay here".

## Root cause

`join` normalizes its argument **in isolation** and then concatenates segment
lists with no second folding pass.

```rust
// std/path.yo:174-176
join : (fn(generic(P : Type), self : Self, other : P, where(P <: ToString)) -> Self)(
  self._join_path(Path.new(other.to_string()))
),
```

`Path.new(other.to_string())` folds `../c` on its own, where the leading `..`
has nothing to pop — and is therefore discarded outright
(`std/path.yo:133-145`; see
`path-new-drops-a-leading-parent-segment.md`), yielding the single segment `c`.
`Path.new("..")` similarly yields the empty path, which is why `join("..")` is a
no-op.

`_join_path` (`std/path.yo:177-212`) then copies `self`'s segments and `other`'s
segments into a fresh list and returns. There is no `..` handling anywhere in
it — the two `while` loops are pure `push`:

```rust
new_segments := ArrayList(String).with_capacity(self._segments.len() + other._segments.len());
… while(…) { new_segments.push(s); }   // self
… while(…) { new_segments.push(s); }   // other
return(Self(_segments : new_segments, _is_absolute : self._is_absolute));
```

`push` (`std/path.yo:761-766`) has the identical body, so it inherits the same
behaviour.

## The compiler routes around it

`src/main.yo:363-367` resolves relative imports by string-concatenating and
re-running `Path.new` over the whole result, and says why:

```rust
// Resolve absolute path by normalizing base_dir/norm_path as one string.
// Path.new normalizes ".." segments, which is needed for relative imports like "../types/tags.yo".
// (Path.join does NOT re-normalize ".." in the second argument.)
abs_path_raw := Path.new(`${effective_base}/${norm_path}`).to_string();
```

A comment in the compiler telling readers not to use the std API for the job the
std API exists to do is the defect, stated by its own author.

## Fix

Make `_join_path` fold the CONCATENATION rather than trusting two independently
folded halves:

1. Fix `Path.new` first so a leading `..` survives — see
   `path-new-drops-a-leading-parent-segment.md`. Without it `join`'s argument
   arrives with its `..` already destroyed and there is nothing left to re-fold.
   The two changes must ship together.
2. In `_join_path` (`std/path.yo:177-212`), after appending `other`'s segments,
   run one left-to-right pass over the combined list: a `..` segment pops the
   preceding segment unless that segment is itself `..`; a `..` with nothing to
   pop is kept on a relative result and dropped on an absolute one (Go's rule,
   the same rule `Path.new` will then be using). Factor that pass into a private
   `_fold_parents(segments, is_absolute)` helper and call it from BOTH
   `Path.new`'s loop tail and `_join_path`, so the two can never drift.
3. `push` (`std/path.yo:761-766`) already delegates to `_join_path` and needs no
   change once (2) lands.
4. Once this lands, simplify `src/main.yo:363-367` to a real `join` and delete
   the comment; also consider retiring the hand-rolled duplicate of the same
   algorithm at `src/main.yo:463-498` (`_resolve_for_match`).

Do NOT "fix" this by making `join` call `Path.new` on the concatenated rendered
string — that would re-parse separators and drive letters, and it is exactly the
workaround the compiler is stuck with today.

## Regression test

`tests/path.test.yo`, beside the existing join tests. RED before the fix:

- `Path.new("a/b").join("../c").to_string() == "a/c"`
- `Path.new("a/b").join("..").to_string() == "a"`
- `Path.new("a/b").join("../../c").to_string() == "c"`
- `Path.new("a").join("../../c").to_string() == "../c"` (pops past the base, so
  the surviving `..` must be kept on a relative result)
- `Path.new("/a").join("../../c").to_string() == "/c"` (absolute: extra `..`
  discarded at the root)
- `push` mirrors of the first two, since `push` is a separate public entry point
- `Path.new("a/b").join("/abs").to_string() == "/abs"` — the absolute-argument
  short circuit at `std/path.yo:179-184` must be unaffected.

## Breaking change

Yes: any `join`/`push` whose argument contains `..` changes value. It ships in
an ordinary v0.2.x patch but must be called out in the release notes, together
with the `Path.new` change it depends on.
