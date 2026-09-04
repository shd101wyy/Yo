# A nested backtick template inside `${…}` interpolates the auto-injected `import("std/fmt/to_string")` — reported as `E0403 Module field "to_string" not found in module type` at line 1, col 1

**Status:** OPEN — valid source is rejected, and the diagnostic names the wrong
thing at the wrong place. Found 2026-09-04 while writing probes for the
std-API-audit re-measurement of the encoding/TOML row; the shape cost three
debugging cycles because the caret points at an unrelated import.

The limitation is currently recorded as authoring advice — *"No nested backtick
templates inside `${…}` … Precompute the inner template into a local first"*
(`.github/skills/yo-syntax/syntax-cheatsheet.md:1676`, and the same lesson in
`issues/fixed/yo-self-value-generic-stamp-return-chain.md:73`) — but nothing
about the construct is unsupportable; the parser drops the expression on the
floor.

## Symptom

```rust
open(import("std/string"));
open(import("std/fmt"));

main :: (fn() -> unit)({
  println(`C: ${`inner`}`);
});
export(main);
```

```
$ yo compile vc.yo --std-path ./std --optimize 2 -o vc.out
error[E0403]: Module field "to_string" not found in module type
  --> vc.yo:1:1
  |
1 | open(import("std/string"));
  | ^^^^^^^^^
help: run `yo explain E0403` for more information
```

Expected: `C: inner`. Two things are wrong — the code is rejected at all, and
the report blames `open(import("std/string"))` on line 1, which has nothing to
do with it. The caret is 9 characters long because that is the length of
`to_string`, not because it spans anything on that line.

Hoisting the inner template into a local compiles and runs:

```rust
  m := `inner`;
  println(`hoisted: ${m}`);   // prints: hoisted: inner
```

Three probes pin the mechanism:

| source | error |
| --- | --- |
| `` println(`C: ${`inner`}`); `` | `Module field "to_string" not found in module type` |
| `` println(`CAT: ${`a` + `b`}`); `` | `Module field "to_string" not found in module type` |
| `` println(`SPEC: ${`a`:>8}`); `` | `Module field "format" not found in module type` (caret 6 long) |
| `` println(`IMP: ${import("std/string")}`); `` | `Module field "to_string" not found in module type` |

The last row is the tell: an interpolation whose expression is *explicitly* a
module produces the identical message. In the nested-template rows, the
receiver really has become a module value.

Interpolating a `match` — the shape this was first blamed on — works fine
(`println(`A: ${match(o, .Some(v) => v.to_string(), .None => String.from("none"))}`)`
prints `A: 7`); the trigger is purely the nested backtick.

## Root cause

`Parser.get_program` **prepends** an `import("std/fmt/to_string")` expression to
the program whenever the parsed source contained a template string:

```rust
// src/parser.yo:1579-1627
get_program : (fn(inout(self) : Self, exn : Exception) -> ArrayList(AstExpr))({
  self.do_parse(exn);
  if(self.has_template_string, {
    …
    result := ArrayList(AstExpr).new();
    result.push(import_expr);      // ← index 0
    …
```

and `parse_template_string` parses each interpolation by running a **fresh
parser over the interpolation text** and taking expression **0**:

```rust
// src/parser.yo:546-556
(inner_prog : ArrayList(AstExpr)) = Parser.new(sp.expr_text, self.module_path, exn).get_program(exn);
…
inner_expr := match(inner_prog.get(usize(0)), .Some(e) => e, …);
```

When the interpolation text is itself a template (`` `inner` ``), that inner
parser sets `has_template_string` (`src/parser.yo:304`) and therefore injects
its own import at index 0 — so `inner_expr` is the **import**, and the real
expression at index 1 is discarded. `make_ts_call` then builds
`import("std/fmt/to_string").to_string()`, i.e. a property access on a module
value, which `evaluate_property_access` rejects at
`src/evaluator/exprs/property_access.yo:1577`.

The bogus location is the second half: the `to_string` token is synthetic, and
`make_syn_tok` (`src/parser.yo:131-140`) stamps `row : usize(0), column :
usize(0)`, which the error formatter renders as `1:1` and underlines with
whatever happens to be on the file's first line.

It is luck that this is an error and not a silent miscompile: both injectable
modules export only their trait name (`export(ToString)`,
`std/fmt/to_string.yo:12`; `export(Format)`, `std/fmt/format.yo:232`), so the
field lookup always fails. Had either exported a member called `to_string` or
`format`, the nested template would have compiled and printed the wrong value.

## Fix

`parse_template_string` must parse the interpolation **without** the auto-import
injection, and must fold the inner parser's flags into the outer one:

```rust
inner := Parser.new(sp.expr_text, self.module_path, exn);
inner.do_parse(exn);                       // src/parser.yo:1532 — no injection
(inner_prog : ArrayList(AstExpr)) = inner.program;
self.has_template_string = (self.has_template_string || inner.has_template_string);
self.has_template_spec = (self.has_template_spec || inner.has_template_spec);
```

The flag fold matters on its own: today a spec that appears ONLY inside a nested
template (`` `${`${x:>8}`}` ``) leaves the outer `has_template_spec` false
(`src/parser.yo:559` sets it on the inner parser, which is then thrown away), so
the file would auto-import `std/fmt/to_string` instead of `std/fmt/format` and
`.format` would be unresolved in a file that does not import `std/fmt` itself.

Do **not** "fix" this by skipping a leading import in `inner_prog` — that
special-cases the symptom and still breaks if the interpolation legitimately
begins with an import.

Independently, `make_syn_tok` should carry the position of the template token
that produced it (`tok.row` / `tok.column` / `tok.byte_offset` are all in hand
at `src/parser.yo:303`), so any future failure inside a desugared template
points at the template instead of at line 1. That alone would have turned this
into a five-minute diagnosis.

## Regression test

- `tests/` — a language test that a nested template evaluates correctly:
  `` `C: ${`inner`}` `` == `"C: inner"`, `` `${`a` + `b`}` `` == `"ab"`, and a
  nested template with an interpolation of its own
  (`` `${`x=${n}`}` ``). These must be verified RED first: today they do not
  compile.
- The spec case `` `${`a`:>8}` `` in a file that does NOT import `std/fmt`,
  which pins the `has_template_spec` fold.
- `.github/skills/yo-syntax/syntax-cheatsheet.md:1676` — delete the "No nested
  backtick templates" section in the fixing commit (keep the `push_str` half of
  that section, which is a separate note).

## Breaking change

No — it makes source compile that is rejected today.

## Related

`issues/template-string-backslash-before-interpolation-eats-both.md` is the
other open defect in this desugaring path (a `\\` immediately before `${…}`
silently disables the interpolation). They are independent: that one is in the
lexer's escape handling, this one is in the interpolation's sub-parse.
