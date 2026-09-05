# 194 documentation examples show `:: import "path"` without parentheses — a form the parser rejects outright

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row
(`std/cli/arg_parser.yo:9-10` is one instance of a tree-wide pattern).
**Severity**: LOW (papercut), but wide — 69 of the offending lines are `//!` /
`///` doc comments, so `yo doc` renders them into the published HTML/JSON/
Markdown and hands every reader of a std module a first line that will not
compile. **Status**: OPEN.

## Reproducer

Copy the first two lines of `std/rand.yo`'s module doc (`:12`) into a file:

```rust
{ Rng } :: import "std/rand";
main :: (fn() -> unit)({
  r := Rng.new_seeded(u64(1));
});
export(main);
```

Observed (`yo` 0.2.24):

```
$ yo check repro_parenless.yo
error[E0008]: paren-less function and operator calls are not supported; use parentheses
  --> repro_parenless.yo:1:19
  |
1 | { Rng } :: import "std/rand";
  |                   ^^^^^^^^^^
help: run `yo explain E0008` for more information
yo: error: check: 1 file(s) failed evaluator coverage
```

Expected: the module's own documented first line parses. The working spelling
— the only one the tree actually uses — is `{ Rng } :: import("std/rand");`.

That the parenless form is rendered to users, not just left in source, is
directly checkable in the published site output:

```
$ grep -o '{ ArgParser } :: import &quot;[^&]*&quot;' site/std/module/cli__arg_parser.html
{ ArgParser } :: import &quot;std/cli/arg_parser&quot;
```

## Scope

```
$ grep -rn ':: import "' std/ --include='*.yo' | wc -l
105                       # across 71 files
$ grep -rn '^\s*//[!/].*import "' std/ --include='*.yo' | wc -l
69                        # across 55 files — the //! and /// subset, which yo doc renders
$ grep -rn ':: import "' docs/ | wc -l
89                        # across 11 files, both language trees
```

194 lines in total. The 36 std lines outside `//!` / `///` are ordinary `//`
comments (e.g. `std/net/tcp.yo:8-10`, `std/http/index.yo:6-7`) — invisible to
`yo doc` but equally wrong for a reader of the source. The `docs/` half is
concentrated in `BUILD_SYSTEM.md` (20 lines per language), `ASYNC_AWAIT.md` and
`PARALLELISM.md` (8 each per language), `STD_SYS_MODULE.md` and
`IMMUTABLE_COLLECTIONS.md` (4 each per language), plus `docs/zh-CN/ARC.md:70`.
That last one is instructive: its English twin, `docs/en-US/ARC.md:74`, already
writes `import("std/thread")`, so the two language trees have drifted apart on
the same example and a sweep must not assume they match.

Nothing in the tree writes the parenless form as live code:

```
$ grep -rn '::[[:space:]]*import[[:space:]]*"' std/ src/ tests/ --include='*.yo' | grep -v '//'
$                         # empty
```

## Root cause

Two separate causes, and both need addressing.

**The syntax.** `src/parser.yo:1409-1411` is the postfix loop's fallthrough arm:
a primary expression followed by anything that is not a call, an index or an
operator is a hard parse error.

```rust
      true => {
        exn.throw(dyn(make_parse_error(tok, `paren-less function and operator calls are not supported; use parentheses`)));
```

`import` is an ordinary call in Yo, so `import "path"` is a paren-less call and
is rejected exactly like `println "x"` would be. There is no import-specific
handling and no legacy acceptance path. The error code is `E_CALL_SYNTAX`
(`src/diagnostics.yo:59`).

**Why it rots.** Nothing checks doc examples. There is no doctest facility —
`yo doc` extracts fenced blocks and renders them verbatim
(`.github/instructions/documentation.instructions.md` describes extraction and
formatting only), and no CI job compiles them. So the wrong idiom propagates by
copy-paste into brand-new modules: `std/rand.yo` was added 2026-08-27
(`c33d97062`) and `std/http/server.yo:9` on 2026-08-29 (`5455b5f71`) — both
after the retired TypeScript compiler was deleted on 2026-08-20 — and both were
written with the parenless form.

This is the same class as the `export main;` pitfall already recorded in
`AGENTS.md` ("the bare `export main;` form older docs show does not parse"), and
the same class as
`issues/fixed/doc-sections-require-double-hash-but-std-writes-single-hash.md`,
where 70 std doc headings were written in a spelling the doc pipeline did not
accept.

## Fix

Two parts. Do them together, as one mechanical sweep PR — this is not a
`cli`-row change.

1. **Rewrite all 194 lines** to `import("...")`. The edit is a regex over
   `:: import "<path>"` → `:: import("<path>")` across `std/**.yo`, `docs/en-US/**.md`
   and `docs/zh-CN/**.md`. Both language trees must be updated together
   (`.github/instructions/documentation.instructions.md`, "Bilingual
   documentation"). Run `yo fmt` on every touched `.yo` file and `yo fmt --check`
   afterwards. Verify the sweep landed by re-running the three greps above and
   getting zero.

2. **Add a gate, or the sweep will be re-done in six months.** Two options:

   - **(a) A CI grep gate**: fail the build when
     `grep -rn ':: import "' std/ docs/ src/` matches. Cheap, exact for this one
     idiom, catches nothing else.
   - **(b) Compile the doc examples**: teach the `yo doc` pipeline (or a test
     under `tests/internal/`) to extract every ` ```rust ` fence from `//!` / `///`
     comments in `std/` and run each through the parser, failing on a parse
     error. Catches this bug *and* every future syntax rot in a std example.

   **Recommend (b), with (a) as the immediate stopgap in the same PR.** (b) is
   the fix that makes the class impossible rather than this one instance, and
   the hard part already exists: `src/doc/sections.yo:153-167` already tracks
   fenced blocks while scanning doc comments, so locating the snippets is not
   new work. Parse-only (not type-check, not compile) keeps
   it fast and avoids demanding that every snippet be a complete program; the
   defect here is a *parse* error, so parse-only catches it. Snippets that are
   deliberately incomplete can opt out with a fence attribute
   (` ```rust,ignore `, Rust's convention).

## Breaking change

No. Comment and Markdown text only; no `.yo` code path changes.

## Regression test

If option (b) is taken, the gate is its own test: add a case under
`tests/internal/` that feeds a fixture doc comment containing
`{ X } :: import "y"` to the extractor and asserts the check reports a parse
error, plus a companion fixture with `import("y")` that passes. If only option
(a) is taken, the gate belongs beside the existing `yo fmt --check` step in CI,
and the sweep is verified by the three grep counts above returning zero.
