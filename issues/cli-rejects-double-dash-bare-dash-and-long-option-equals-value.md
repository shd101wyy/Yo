# `std/cli` rejects `--`, a bare `-`, any `-`-leading positional and `--opt=value` as "Unknown argument"

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: MEDIUM (api-lie) — four POSIX/GNU baseline argv forms are refused
by one branch, so the module cannot be used by anything that forwards arguments
to a child process, cannot accept a negative number or the `-` stdin
convention, and does not understand the `--opt=value` spelling every GNU tool
accepts. **Status**: OPEN.

## Reproducer

```rust
{ ArgParser } :: import("std/cli/arg_parser");
{ println } :: import("std/fmt");
open(import("std/collections/array_list"));
open(import("std/string"));
try_argv :: (fn(label : String, extra : ArrayList(String)) -> unit)({
  parser := ArgParser.new(`myapp`, `A sample CLI tool`);
  parser.add_flag(`--verbose`, `-v`, `Enable verbose output`);
  parser.add_option(`--output`, `-o`, `Output file`, `out.txt`);
  parser.add_positional(`input`, `Input file`);
  args := ArrayList(String).new();
  args.push(`myapp`);
  i := usize(0);
  while(i < extra.len(), i = (i + usize(1)), {
    match(extra.get(i), .Some(a) => { args.push(a); }, .None => ());
  });
  match(
    parser.parse(args),
    .Ok(p) => {
      match(
        p.get_positional(`input`),
        .Some(v) => { println(`${label} -> Ok, input = ${v}`); },
        .None => { println(`${label} -> Ok, input = <none>`); }
      );
    },
    .Err(e) => { println(`${label} -> Err: ${e}`); }
  );
});
one :: (fn(a : String) -> ArrayList(String))({
  l := ArrayList(String).new();
  l.push(a);
  return(l);
});
two :: (fn(a : String, b : String) -> ArrayList(String))({
  l := ArrayList(String).new();
  l.push(a);
  l.push(b);
  return(l);
});
main :: (fn() -> unit)({
  try_argv(`[myapp -- file.txt]      `, two(`--`, `file.txt`));
  try_argv(`[myapp -- --help]        `, two(`--`, `--help`));
  try_argv(`[myapp -]                `, one(`-`));
  try_argv(`[myapp -5]               `, one(`-5`));
  try_argv(`[myapp --output=file.txt]`, one(`--output=file.txt`));
  try_argv(`[myapp file.txt]         `, one(`file.txt`));
});
export(main);
```

Observed (`yo` 0.2.24, `--optimize 2`):

```
[myapp -- file.txt]       -> Err: Unknown argument: --
[myapp -- --help]         -> Err: Unknown argument: --
[myapp -]                 -> Err: Unknown argument: -
[myapp -5]                -> Err: Unknown argument: -5
[myapp --output=file.txt] -> Err: Unknown argument: --output=file.txt
[myapp file.txt]          -> Ok, input = file.txt
```

The last line is the control: only a positional with no leading `-` works
today. Expected instead:

```
[myapp -- file.txt]       -> Ok, input = file.txt
[myapp -- --help]         -> Ok, input = --help    (help NOT intercepted)
[myapp -]                 -> Ok, input = -
[myapp -5]                -> Ok, input = -5        (a negative-number positional)
[myapp --output=file.txt] -> Ok, input = <none>    and get_option("--output") == file.txt
```

The module doc (`std/cli/arg_parser.yo:3-4`) advertises "positional arguments"
without qualification, so a `-`-leading positional being inexpressible is a
documentation lie, not just a gap.

## Root cause

All four forms fall into one branch. `parse`'s `cond` chain
(`std/cli/arg_parser.yo:369-503`) reads, in order:

```rust
cond(
  ((current_arg == `--help`) || (current_arg == `-h`)) => { ... },   // :370
  current_arg.starts_with(`-`) => {                                   // :373
    match(
      self._find_arg_index(current_arg),
      .Some(arg_idx) => { ... },
      .None => {
        err_msg = .Some(`Unknown argument: ${current_arg}`);          // :411-412
      }
    );
  },
  true => { /* subcommand or positional */ }                          // :416-502
);
```

`_find_arg_index` (`:208-227`) matches `current_arg` against each `ArgDef`'s
`_long_name` or `_short_name` exactly. So:

- `--` — no def is named `--` → `.None` → `Unknown argument: --`.
- `-` — same.
- `-5` — same; there is no way to route a `-`-leading token to the positional
  arm at `:416`, because `:373` claims it first.
- `--output=file.txt` — the whole token including `=file.txt` is compared
  against `_long_name`, which is `--output`. No split on `=` exists anywhere in
  the 549-line file.

There is no end-of-options latch and no `=` splitting; the only other
`--`-prefixed strings in the file are the `--help` comparison at `:370` and the
literal help line at `:327`.

The compiler's own CLI shows what the correct handling looks like, and
`std/cli` does the opposite. `src/main.yo:4829-4841` scans for a subcommand
`--help` and stops at `--`, with the reason spelled out in the comment at
`:4826-4828`:

> *"The scan stops at `--` so pass-through arguments (e.g. a program's own
> --help after `--`) are never intercepted."*

In `std/cli` the `--help` test is the **first** `cond` arm (`:370`), ahead of
everything, so once `--` is supported a pass-through `--help` would be swallowed
unless the latch is tested first — see the fix.

No test covers any of these: `grep 'push(`--`)' tests/cli/arg_parser.test.yo` is
empty, and no test in the file passes a `-`-leading positional or an `=` form.

## Fix

`std/cli/arg_parser.yo`, inside `parse`'s loop (`:365-508`):

1. **End-of-options latch.** Add `(positional_only : bool) = false` beside the
   `err_msg` accumulator (`:364`) and make the `cond` chain read:

   ```
   positional_only            => <positional branch>
   --help / -h                => <help>
   current_arg == `--`        => { positional_only = true; }
   starts_with(`-`)           => <option/flag branch>
   true                       => <positional branch>
   ```

   The `positional_only` arm must be **first**, so it beats both the `--help`
   interception and the `-`-prefix test. That ordering is exactly what
   `src/main.yo:4829-4841` does and why.

2. **Do not duplicate the positional branch.** It is ~30 lines (`:471-501`,
   inside the subcommand/positional arm at `:416-502`). Factor it into a private
   `_take_positional` helper used by both arms; copying it is a review defect.

3. **`--opt=value`.** In the `starts_with(`-`)` branch, before calling
   `_find_arg_index`, try `current_arg.split_once(`=`)`
   (`std/string/string.yo:1552`, returns `Option((String; String))`). If the
   head resolves to an `.Opt` definition, take the tail as the value without
   consuming the next argv slot. Note this would be `split_once`'s first
   production call site in the tree — access the pair as `p.0` / `p.1` after
   `match(..., .Some(p) => ...)`, the way `tests/string/string.test.yo:2088-2090`
   does; do not attempt `.Some((a, b))` destructuring.

4. A bare `-` and a `-`-leading positional need no extra code once the latch
   exists **after** `--`, but they must also work *without* a preceding `--`
   (that is the `-` stdin convention and the negative-number case). The minimal
   rule that gets both: in the `starts_with(`-`)` branch, when
   `_find_arg_index` returns `.None`, treat the token as a positional instead of
   erroring only if it is exactly `-`; leave `-5` to require a preceding `--`.

   **Design choice on step 4.** The alternative is to make *every* unmatched
   `-`-leading token a positional, which silently turns a typo (`--verbse`) into
   a positional and destroys the one diagnostic the parser has today.
   **Recommend the narrow rule**: a bare `-` is a positional, everything else
   `-`-leading still errors as an unknown argument unless it follows `--`. That
   keeps `Unknown argument:` useful and matches what GNU tools do.

Clustered short flags (`-abc`) and attached short values (`-ovalue`) are the
same class of argv grammar and are equally unsupported today
(`-vv` → `Unknown argument: -vv`), but they need a per-character loop with a
Flag-vs-Opt decision mid-word. Keep them out of this fix and say so in the
module doc.

## Breaking change

No. Every form listed here returns `.Err` today, so no working caller can depend
on the current behaviour, and
`.github/instructions/yo-design.instructions.md:149` counts "wider accepted
inputs" as additive. The one thing to get right is the `cond` ordering in step
1: if the latch is not tested ahead of the `--help` arm, the fix introduces the
pass-through-help swallow that `src/main.yo` deliberately avoids.

## Regression test

`tests/cli/arg_parser.test.yo`, six new tests, each failing before the fix:

- `myapp -- file.txt` → `.Ok`, positional `input` is `file.txt`.
- `myapp -- --help` → `.Ok`, positional `input` is `--help`, and
  `help_requested()` is false (once that accessor exists — see
  `cli-parse-returns-err-for-help-so-the-documented-example-aborts.md`).
- `myapp -- --verbose` → `.Ok`, `get_flag(`--verbose`)` is false.
- `myapp -` → `.Ok`, positional `input` is `-`.
- `myapp -- -5` → `.Ok`, positional `input` is `-5`.
- `myapp --output=file.txt` → `.Ok`, `get_option(`--output`)` is `file.txt`.

Plus a guard that the diagnostic survives: `myapp --verbse` still returns
`.Err` with `Unknown argument: --verbse`.
