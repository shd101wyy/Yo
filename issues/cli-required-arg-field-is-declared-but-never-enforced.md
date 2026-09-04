# `ArgDef._required` is a dead field — `std/cli` documents required arguments and enforces none

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: MEDIUM (api-lie) — a public type documents a required-argument
concept the parser never implements, so a missing required positional parses as
success and every consumer has to hand-roll the check. **Status**: OPEN.

## Reproducer

```rust
{ ArgParser } :: import("std/cli/arg_parser");
{ println } :: import("std/fmt");
open(import("std/collections/array_list"));
open(import("std/string"));
main :: (fn() -> unit)({
  parser := ArgParser.new(`myapp`, `A sample CLI tool`);
  // add_positional records `_required : true` (std/cli/arg_parser.yo:204).
  parser.add_positional(`input`, `Input file (required)`);
  args := ArrayList(String).new();
  args.push(`myapp`);
  match(
    parser.parse(args),
    .Ok(p) => {
      match(
        p.get_positional(`input`),
        .Some(v) => { println(`Ok, input = ${v}`); },
        .None => { println(`parse([myapp]) => .Ok, and the required positional "input" is .None`); }
      );
      match(
        p.get_positional_at(usize(0)),
        .Some(v) => { println(`positional_at(0) = ${v}`); },
        .None => { println(`positional_at(0) = .None`); }
      );
    },
    .Err(e) => { println(`Err: ${e}`); }
  );
});
export(main);
```

Observed (`yo` 0.2.24, `--optimize 2`):

```
parse([myapp]) => .Ok, and the required positional "input" is .None
positional_at(0) = .None
```

Expected: `parse` returns an error naming the missing argument, e.g.
`Err("missing required argument: input")`.

`.None` from `get_positional` is also indistinguishable from a positional that
was supplied as an empty string, so a caller cannot even recover the check by
hand without also disambiguating that case.

## Root cause

`_required` is written in three places and read in none.

Declaration, with a doc comment that promises enforcement —
`std/cli/arg_parser.yo:43-44`:

```rust
    /// Whether this argument is required.
    _required : bool
```

The three write sites:

- `:180` — `add_flag` sets `_required : false`
- `:192` — `add_option` sets `_required : false`
- `:204` — `add_positional` sets `_required : true`

And no read site anywhere in the tree:

```
$ grep -rn "_required" std/ src/ tests/ --include='*.yo' \
    | grep -v 'n_required\|new_required\|num_required'
std/cli/arg_parser.yo:44:    _required : bool
std/cli/arg_parser.yo:180:        _required : false
std/cli/arg_parser.yo:192:        _required : false
std/cli/arg_parser.yo:204:        _required : true
```

(The `collect_required_functions` / `collect_required_types` hits under
`src/codegen/` are unrelated identifiers.)

`parse` (`:358-542`) has exactly two post-scan passes — the error check
(`:510-516`) and the defaults application (`:517-540`) — and neither looks at
`_required`. `help_text` (`:229-354`) does not read it either, so the help
output does not even mark required arguments; there is no `Usage:` argument
summary at all (`:230` emits only `Usage: ${self._name}\n`).

Two consequences, from one cause:

1. **A missing required positional is accepted.** `add_positional` records
   `true` at `:204`, nothing checks it, and `_lookup` (`:98-118`) just fails to
   find the name.
2. **A required option cannot even be declared.** `add_option`'s signature
   (`:184`) is
   `(fn(self : Self, long_name : String, short_name : String, description : String, default_value : String) -> unit)`
   — there is no `required` parameter, and no second constructor. So the field
   is not merely unenforced for options; it is unreachable.

No test names it: `grep -n required tests/cli/arg_parser.test.yo` is empty
across all 15 tests.

## Fix

Two parts, both in `std/cli/arg_parser.yo`.

**(a) Make `required` declarable for options.** Give `add_option` a trailing
default parameter rather than a second constructor — Yo supports `?=` defaults
on methods, precedent `std/string/string.yo:1522`
(`starts_with(..., (position : usize) ?= 0, where(...))`):

```rust
add_option : (fn(self : Self, long_name : String, short_name : String,
                 description : String, default_value : String,
                 (required : bool) ?= false) -> unit)({ ... _required : required ... })
```

**(b) Add an enforcement pass, immediately AFTER the defaults pass**
(`:517-540`), in the same `while` shape over `self._args`. For each def whose
`_required` is set, check for an entry in `parsed._set_flags` /
`parsed._option_names` / `parsed._positional_names` and return an error naming
`def._long_name` if absent.

The order is load-bearing: it must run **after** defaults so that a required
option carrying a default is satisfied by that default, and it must be skipped
entirely when help was requested (see
`cli-parse-returns-err-for-help-so-the-documented-example-aborts.md`) — `--help`
on an incomplete command line must print help, not complain about a missing
argument.

**Design choice — do positionals stay implicitly required?** `add_positional`
already hardcodes `_required : true` (`:204`), so turning enforcement on
rejects command lines that parse today. Options: (i) keep positionals
implicitly required and enforce, matching clap's default and the field's stated
intent; (ii) make them optional by default and add
`add_required_positional`. **Recommend (i)** — the field says `true`, the doc
calls them "Positional argument" with no optionality, and `std/cli` has zero
in-tree consumers besides its own test file
(`grep -rn 'std/cli' --include='*.yo' .` → `tests/cli/arg_parser.test.yo:2`, the
module's own doc example, and prose in `std/term.yo`), so nothing in the tree
breaks.

The alternative — deleting `_required` and its doc comment — would remove the
only argument-validation concept the module has and leave every caller to
re-implement "was this supplied?" by hand against an `Option` that cannot
distinguish absent from empty. Note that
`.github/instructions/yo-design.instructions.md:156` ("Dead surface is not
'stable': an export with no consumer and no test is deleted BEFORE it is
frozen") does not settle this either way: `_required` is a *private* field, not
an export, and the rule is about not freezing unexercised surface — the fix
here is to exercise it.

## Breaking change

Yes. Command lines that parse today (a registered positional not supplied) will
return an error. `std/cli/arg_parser.yo` carries no `## Stability` section, so
by `.github/instructions/yo-design.instructions.md:147` it counts as **stable**
and this is non-additive under `:149`. Land it inside the same breaking wave as
the module's `## Stability` marker, and call it out in the release notes.

## Regression test

`tests/cli/arg_parser.test.yo`, four new tests, each failing before the fix:

- A registered positional not supplied → `parse` returns `.Err`, and the
  message names `input`.
- `add_option(..., required : true)` with the option absent → `.Err`.
- `add_option(..., default_value : `x`, required : true)` with the option absent
  → `.Ok` (the default satisfies it).
- The existing positional test (`:40-52`) still passes when the positional *is*
  supplied — i.e. enforcement did not break the happy path.
