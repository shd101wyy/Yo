# `add_positional` marks an argument required and `parse` never checks; and there is no `--` separator

Found during the `std/` `///` doc sweep while documenting
`std/cli/arg_parser.yo`. **Not fixed.** Two defects in the same scan loop, both
about which argument shapes `parse` accepts.

## Behaviour (verbatim)

`issues/repros/stddoc-io-arg-parser-positional-never-required.yo`, built with
`yo compile … --std-path ./std --optimize 2`:

```
missing arg -> Ok, input = .None  <-- BUG: parse succeeded
"-5"        -> Err: Unknown argument: -5  <-- BUG: no -- separator
```

## 1. `_required` is written and never read

`std/cli/arg_parser.yo`:

```rust
add_positional : (fn(self : Self, name : String, description : String) -> unit)({
  self._args.push(
    ArgDef(
      …
      _required : true          // <- the only site that sets it true
    )
  );
}),
```

`grep -n "_required" std/cli/arg_parser.yo` gives four hits: the field
declaration (`:44`), `false` in `add_flag` (`:180`) and `add_option` (`:192`),
and `true` here (`:204`). **There is no reader.** `parse` completes its scan,
applies option defaults and returns `.Ok` with the slot empty, so
`get_positional(`input`)` answers `.None` and the program discovers the
missing argument — if it checks at all — long after the parser could have
reported it with a usage message.

The field name is the problem: it promises enforcement that does not exist,
and a reader of `ArgDef` reasonably assumes the parser honours it.

### Suggested fix

After the scan and before applying defaults, walk `_args` for
`.Positional` entries with `_required : true` whose slot was not filled, and
fail with the missing name. That needs a variant to fail *with* — see the
error-type issue below, so the two are best done together. Until then,
`add_positional`'s doc comment now says the flag is inert (done in the doc
sweep).

## 2. No `--` end-of-options separator

The scan classifies by first byte:

```rust
current_arg.starts_with(`-`) => { … _find_arg_index … .None => err_msg = .Some(`Unknown argument: ${current_arg}`) }
```

Any token beginning with `-` that matches no registered name is rejected, and
there is no way to say "everything after this point is a value". So a
positional cannot be a negative number (`-5`), the conventional bare `-` for
stdin, or a filename that happens to start with a dash. Every mainstream
parser — POSIX `getopt`, Rust's `clap`, Python's `argparse` — handles this
with `--`.

### Suggested fix

Treat a bare `--` as a mode switch: consume it and route every later token to
the positional path without the dash test. Additive and non-breaking, since
`--` is currently rejected as an unknown argument and so cannot appear in any
working call today.

## Related

`issues/stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md` — the
typed `ArgError` that item 1 needs a variant from.
