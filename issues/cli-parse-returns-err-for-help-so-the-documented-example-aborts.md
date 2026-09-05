# `std/cli`'s `parse` returns `.Err(<the whole help text>)` for `--help` — so the module's own documented example aborts the process

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: HIGH — the documented usage of a published `std` module dies with
`rc 134` on the single most common CLI invocation, and the help text it was
asked to print is thrown away. **Status**: OPEN.

`std/cli/arg_parser.yo:370-371` routes `--help` / `-h` through the same
`err_msg` accumulator that carries "Unknown argument" and "Missing value for
option", and `:510-516` turns any `err_msg` into `return(.Err(msg))`. So asking
for help is, to `parse`'s caller, indistinguishable from a malformed command
line — and the module's own copy-pasteable example (`:15`) calls `.unwrap()` on
the result.

## Reproducer

The parser setup below is transcribed verbatim from the module doc
(`std/cli/arg_parser.yo:12-16`), with `args()` replaced by a literal argv so the
run is deterministic:

```rust
{ ArgParser } :: import("std/cli/arg_parser");
{ println } :: import("std/fmt");
open(import("std/collections/array_list"));
open(import("std/string"));
main :: (fn() -> unit)({
  parser := ArgParser.new(`myapp`, `A sample CLI tool`);
  parser.add_flag(`--verbose`, `-v`, `Enable verbose output`);
  parser.add_option(`--output`, `-o`, `Output file`, `out.txt`);
  args := ArrayList(String).new();
  args.push(`myapp`);
  args.push(`--help`);
  result := parser.parse(args);
  cond(
    result.is_err() => { println(`parse(--help) returned .Err`); },
    true => { println(`parse(--help) returned .Ok`); }
  );
  println(`--- now the module doc example's .unwrap() ---`);
  parsed := result.unwrap();
  cond(
    parsed.get_flag(`--verbose`) => { println(`unreachable: verbose`); },
    true => { println(`unreachable: no verbose`); }
  );
});
export(main);
```

Observed (`yo` 0.2.24, `--optimize 2`):

```
$ ./repro_help.out
parse(--help) returned .Err
--- now the module doc example's .unwrap() ---
Called unwrap on an Error value (at /Users/yiyiwang/Workspace/Yo/std/prelude.yo:7333:18)
$ echo $?
134
```

The panic line goes to **stderr**, the two `println`s to stdout, and the help
text appears **nowhere** — `unwrap`'s panic message is the generic
"Called unwrap on an Error value", not the payload. The user typed `--help` and
got an abort with no usage text.

Matching the `.Err` payload instead confirms the help text is what is being
carried on the error channel:

```rust
match(
  parser.parse(args),
  .Ok(p) => { println(`Ok`); },
  .Err(e) => { println(`.Err payload is:`); println(e); }
);
```

```
.Err payload is:
Usage: myapp
A sample CLI tool

Options:
  --verbose, -v	Enable verbose output
  --output, -o <value>	Output file (default: out.txt)
  --help, -h	Show this help message
```

Expected: `parse` returns `.Ok`, and the caller learns that help was requested
so it can print the text to stdout and exit 0.

The `.unwrap()` abort is only the loudest face of it. The *other* natural
caller shape is just as wrong: a program that writes the idiomatic
`.Err(e) => { eprintln(e); exit(1) }` branch prints its usage text to **stderr
with rc 1** for an explicit `--help`, which is exactly the stream/exit-code
combination `src/main.yo` goes out of its way to avoid.

## Root cause

`std/cli/arg_parser.yo:365-508` is one `while` loop over argv guarded by
`err_msg.is_none()`, and the first arm of its `cond` is the help test:

```rust
cond(
  ((current_arg == `--help`) || (current_arg == `-h`)) => {
    err_msg = .Some(self.help_text());      // :370-371
  },
  ...
```

Setting `err_msg` both terminates the scan (the loop's own guard) and, at
`:510-516`, becomes the function's error return:

```rust
match(
  err_msg,
  .Some(msg) => { return(.Err(msg)); },     // :513
  .None => ()
);
```

`err_msg` is therefore doing two unrelated jobs: "stop scanning" and "this
command line is invalid". Help needs the first and must not have the second.
There is no `_help_requested` field on `ParsedArgs` (`:47-60`) and no
`help_requested()` accessor (`:78-127`), so the flag has nowhere else to go and
the author reached for the accumulator.

The in-repo precedent is unambiguous and is the opposite of this. The compiler's
own CLI treats explicit help as a successful outcome and a bare invocation as a
failure, with the reasoning written into the source:

- `src/main.yo:4802-4805` — `yo --help` / `yo -h` → `println(_top_level_help_text()); return(())`, i.e. **stdout + rc 0**.
- `src/main.yo:4842-4849` — per-subcommand `--help` → `println(...)` + `return(())`, same.
- `src/main.yo:4819-4822` — a **bare** `yo` → `eprintln(_top_level_help_text()); unsafe(exit(int(1)))`, with the comment at `:4816-4818`: *"no action was performed, so a script that runs `yo` with no arguments should still see a failure — the same reasoning as `git`. Explicit `--help` remains stdout + rc=0."*

That distinction — same text, two different streams and exit codes depending on
*why* it is being shown — is policy that only the caller can make, which is the
deciding argument for the fix shape below.

Zero test coverage let it ship: `grep -n -- help tests/cli/arg_parser.test.yo`
matches only `tests/cli/arg_parser.test.yo:73-82` and `:196-204`, which call
`help_text()` directly. No test in the file ever passes `--help` or `-h` through
`parse`.

## Fix

Add the "help was requested" signal to `ParsedArgs` and return `.Ok`:

1. `ParsedArgs` (`:47-60`) gains `_help_requested : bool`, initialized `false`
   in `ParsedArgs.new()` (`:80-90`).
2. A `help_requested : (fn(self : Self) -> bool)(self._help_requested)`
   accessor next to the other `ParsedArgs` methods (`:91-127`). Bare-noun
   spelling per `.github/instructions/yo-design.instructions.md:525`.
3. `:370-371` becomes `{ parsed._help_requested = true; idx = args_len; }` —
   set the flag and stop the scan without touching `err_msg`. Stopping matters:
   `myapp --help` on an otherwise incomplete command line must still report the
   help request, not a missing-value error.
4. Rewrite the module doc example (`:8-18`) so it does not `.unwrap()`-then-use.
   It should show the real shape:

   ```rust
   //! parsed := match(parser.parse(args()), .Ok(p) => p, .Err(e) => { eprintln(e.to_string()); exit(1) });
   //! if(parsed.help_requested(), { println(parser.help_text()); return(()); });
   ```

**Design choice.** The alternative is a three-way outcome,
`ParseOutcome :: enum(Parsed(ParsedArgs), Help(String), Error(...))`.
**Recommend the `_help_requested` flag.** It keeps one return shape (so this
change does not fight a later `Result(ParsedArgs, CliError)` migration), it is
clap's model (`ErrorKind::DisplayHelp` is deliberately not the program's
error), and — deciding — it leaves stream and exit-code policy with the caller.
A `Help(String)` variant cannot express the stdout/rc-0 vs stderr/rc-1 split
that `src/main.yo:4802` and `:4819` demonstrate is necessary; the caller would
have to re-derive "was this explicit or a bare invocation?" anyway.

Note the interaction with the missing `--` support
(`cli-rejects-double-dash-bare-dash-and-long-option-equals-value.md`): the help
test is the **first** `cond` arm, so once an end-of-options latch exists it must
be tested *ahead* of the help arm, or a pass-through `--help` after `--` gets
swallowed — the hazard `src/main.yo:4826-4828` names explicitly.

Also note that fixing this on its own leaves `parse`'s error channel a bare
`String`, so `.Err` still cannot be discriminated. That is a separate audit item
(a `CliError` enum modelled on `std/encoding/csv.yo:41-55`); it is not needed to
make `--help` succeed.

## Breaking change

Yes. `parse` currently returns `.Err` for `--help` and would return `.Ok`;
`.github/instructions/yo-design.instructions.md:149` classes a changed outcome
as non-additive. `std/cli/arg_parser.yo` carries no `## Stability` section, so
by `:147` the module counts as **stable** today and this change is illegal until
it gets one. Add the marker in the same wave, using the wording precedent at
`std/http/server.yo:18-19`, and call the behaviour change out in the v0.2.x
release notes. Nothing in the tree breaks: `grep -rn 'std/cli' --include='*.yo' .`
finds only `tests/cli/arg_parser.test.yo:2`, the module's own doc example, and
prose in `std/term.yo` — `src/main.yo` hand-rolls its CLI and does not import
`std/cli`.

## Regression test

`tests/cli/arg_parser.test.yo`, three new tests that must fail before the fix:

- `--help` through `parse` returns `.Ok` and `parsed.help_requested()` is true.
- `-h` through `parse` does the same.
- An argv with **no** help flag leaves `help_requested()` false (so the flag is
  not stuck on).

Once an end-of-options latch lands, add: `--` followed by `--help` yields a
positional `--help` and `help_requested()` stays false.
