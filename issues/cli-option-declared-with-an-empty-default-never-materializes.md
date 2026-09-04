# An option declared with an empty-string default is never materialized — `get_option` returns `.None` for a declared option

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: LOW (papercut) — `add_option(long, short, desc, ``)` produces no
entry, so the empty string is an unrepresentable default and a declared option
is indistinguishable from an undeclared one. **Status**: OPEN.

## Reproducer

```rust
{ ArgParser } :: import("std/cli/arg_parser");
{ println } :: import("std/fmt");
open(import("std/collections/array_list"));
open(import("std/string"));
main :: (fn() -> unit)({
  parser := ArgParser.new(`myapp`, `A sample CLI tool`);
  parser.add_option(`--prefix`, `-p`, `Prefix to prepend`, ``);
  parser.add_option(`--output`, `-o`, `Output file`, `out.txt`);
  args := ArrayList(String).new();
  args.push(`myapp`);
  match(
    parser.parse(args),
    .Ok(p) => {
      match(
        p.get_option(`--prefix`),
        .Some(v) => { println(`--prefix     (declared, empty default)   => .Some("${v}")`); },
        .None => { println(`--prefix     (declared, empty default)   => .None`); }
      );
      match(
        p.get_option(`--output`),
        .Some(v) => { println(`--output     (declared, default out.txt) => .Some("${v}")`); },
        .None => { println(`--output     (declared, default out.txt) => .None`); }
      );
      match(
        p.get_option(`--undeclared`),
        .Some(v) => { println(`--undeclared (never declared)            => .Some("${v}")`); },
        .None => { println(`--undeclared (never declared)            => .None`); }
      );
    },
    .Err(e) => { println(`Err: ${e}`); }
  );
});
export(main);
```

Observed (`yo` 0.2.24, `--optimize 2`):

```
--prefix     (declared, empty default)   => .None
--output     (declared, default out.txt) => .Some("out.txt")
--undeclared (never declared)            => .None
```

Expected: `--prefix` yields `.Some("")`. A declared option must not report the
same thing as one that was never declared at all.

## Root cause

The defaults pass at the end of `parse` guards on two conditions where only one
is needed — `std/cli/arg_parser.yo:525-533`:

```rust
              cond(
                (!parsed._option_names.contains(def._long_name) && !def._default_value.is_empty()) => {
                  parsed._option_names.push(def._long_name);
                  parsed._option_values.push(def._default_value);
                },
                true => ()
              );
```

The `contains` half is the real guard: it stops a default from overwriting a
value the user actually passed. The `!def._default_value.is_empty()` half buys
nothing on top of that — it only excludes the empty string from ever being
materialized, and `_default_value` has no "unset" sentinel to distinguish
"declared with no default" from "declared with the empty default", because
`add_flag` (`:179`) and `add_positional` (`:203`) also write `` into it.

The likely origin is the neighbouring emptiness test in `help_text`, at
`:309-314`, where it *is* correct:

```rust
                  cond(
                    !arg_def._default_value.is_empty() => {
                      line = line.concat(` (default: ${arg_def._default_value})`);
                    },
```

Suppressing `(default: )` in the help line is right; suppressing the default's
materialization in `parse` is not, and the two share a shape.

The shape is already in use in the test suite:
`tests/cli/arg_parser.test.yo:187` declares `sub_build.add_option(`--target`,
`-t`, `Target`, ``)` precisely to reach the missing-value error path, so an
empty default is an idiom callers will write.

## Fix

Drop the `!def._default_value.is_empty()` conjunct at
`std/cli/arg_parser.yo:527`, leaving:

```rust
                (!parsed._option_names.contains(def._long_name)) => {
```

That is the whole change. Options declared with a non-empty default keep
behaving exactly as before; an option declared with `` now materializes as
`.Some("")`.

If a future caller genuinely wants "declared, but absent from the parse result
unless supplied", that is a different concept than "declared with the empty
default" and needs its own representation — an `Option(String)` `_default_value`
field, or a separate `add_option_no_default`. Do not reuse the empty string as
that sentinel; overloading it is what produced this bug.

## Breaking change

Yes, narrowly. `get_option` on an option declared with an empty default changes
from `.None` to `.Some("")`. `std/cli/arg_parser.yo` carries no
`## Stability` section, so by `.github/instructions/yo-design.instructions.md:147`
the module counts as **stable**, and although this is arguably a bug fix that
makes behaviour match the field's documentation ("Default value for options",
`:41-42`), the observable return value changes — call it out in the release
notes. Nothing in the tree relies on it: `std/cli`'s only consumer is
`tests/cli/arg_parser.test.yo`, and the one test using an empty default
(`:184-195`) asserts on the error path, not on `get_option`.

## Regression test

`tests/cli/arg_parser.test.yo`, two new tests that must fail before the fix:

- An option declared `add_option(`--prefix`, `-p`, `Prefix`, ``)` with the
  option absent from argv → `get_option(`--prefix`)` is `.Some` and its value
  is the empty string.
- The same option supplied as `--prefix x` → `get_option` is `x` (the default
  did not overwrite it).

Keep the existing "ArgParser default option value" test (`:53-64`) green, which
pins that a non-empty default is unaffected.
