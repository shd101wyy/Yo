# `ArgParser.parse` reports `--help` as an error, and every error is a bare `String`

Found during the `std/` `///` doc sweep while documenting
`std/cli/arg_parser.yo`. **Not fixed** — it changes `parse`'s signature.

## Behaviour (verbatim)

`issues/repros/stddoc-io-arg-parser-help-and-string-errors.yo`, built with
`yo compile … --std-path ./std --optimize 2`:

```
--help  -> Err, 95 bytes (the help screen)
--nope  -> Err, 24 bytes: Unknown argument: --nope
both arms are .Err(String) — no variant distinguishes them
```

## What the code does

`std/cli/arg_parser.yo`, `parse : (fn(self : Self, args : ArrayList(String)) -> Result(ParsedArgs, String))`:

```rust
((current_arg == `--help`) || (current_arg == `-h`)) => {
  err_msg = .Some(self.help_text());
},
```

A help request produces the same `.Err(String)` shape as a usage mistake, with
the rendered help screen as the payload. The other two failure payloads are
`Unknown argument: <token>` and `Missing value for option: <long_name>`.

## Why it matters

1. **A caller cannot pick the right exit status.** `--help` is a successful
   invocation and conventionally exits 0; an unknown flag exits 2. Both arrive
   as `.Err`, so the only way to tell them apart is to string-compare the
   payload against `parser.help_text()` — comparing a whole rendered screen to
   recover a boolean the parser already knew.
2. **It is a D1 violation** (`plans/STD_API_STABILIZATION.md` §1 counts
   `Result(_, String)` in five exported APIs; this is a sixth site that is not
   on that list, so it has never been scheduled). The two listed pairs —
   `env.cwd`/`current_exe`/`chdir` and `http.parse_request`/`parse_response` —
   were both migrated to typed errors in the D-batch; `arg_parser` was missed.
3. It blocks the module's `## Stability` marker: freezing `arg_parser` freezes
   the error channel, and this is the channel.

## Root cause

`parse` has one `err_msg : Option(String)` accumulator used for three
unrelated outcomes, and `--help` was routed through it because it is the
cheapest way to stop the scan. Nothing distinguishes the outcomes at the type
level, so the distinction cannot survive the return.

## Suggested fix

A typed error enum, following the D12/D13 pattern used for `ParseIntError` and
`UrlError`, with `derive(Error(...))` for the messages (D15):

```rust
ArgError :: enum(
  HelpRequested(text : String),
  UnknownArgument(token : String),
  MissingValue(option : String)
);
```

`parse -> Result(ParsedArgs, ArgError)`. `HelpRequested` is still an `.Err`
(the scan did not produce arguments) but is now matchable, so a caller writes
`.Err(.HelpRequested(t)) => { print(t); exit(0) }`. Breaking; it belongs in a
breaking window with a deprecated `parse_str_err` alias if any caller needs
one. In-tree callers: `tests/cli/arg_parser.test.yo` only — `src/main.yo` does
its own argv handling and does not use this module.

## Related

Two neighbouring gaps in the same function, filed separately:
`issues/stddoc-io-arg-parser-positionals-are-never-required.md`.
