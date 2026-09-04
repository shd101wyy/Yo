# A repeated option in `std/cli` yields its FIRST value — later occurrences are stored but no accessor can reach them

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: MEDIUM (wrong-value) — `--output a --output b` silently returns
`a`, so the wrapper-script idiom that makes CLIs composable (`myapp --output
default "$@"`, where `"$@"` ends in the user's override) is ignored without a
diagnostic. **Status**: OPEN.

## Reproducer

```rust
{ ArgParser } :: import("std/cli/arg_parser");
{ println } :: import("std/fmt");
open(import("std/collections/array_list"));
open(import("std/string"));
main :: (fn() -> unit)({
  parser := ArgParser.new(`myapp`, `A sample CLI tool`);
  parser.add_flag(`--verbose`, `-v`, `Enable verbose output`);
  parser.add_option(`--output`, `-o`, `Output file`, `out.txt`);
  // The wrapper-script idiom: `myapp --output <default> "$@"`, where "$@" ends
  // in the user's own --output override.
  args := ArrayList(String).new();
  args.push(`myapp`);
  args.push(`--output`);
  args.push(`from-wrapper.txt`);
  args.push(`--output`);
  args.push(`user-override.txt`);
  match(
    parser.parse(args),
    .Ok(p) => {
      match(
        p.get_option(`--output`),
        .Some(v) => { println(`--output from-wrapper.txt --output user-override.txt  =>  ${v}`); },
        .None => { println(`.None`); }
      );
    },
    .Err(e) => { println(`Err: ${e}`); }
  );
  args2 := ArrayList(String).new();
  args2.push(`myapp`);
  args2.push(`-vv`);
  match(
    parser.parse(args2),
    .Ok(p) => { println(`-vv => Ok`); },
    .Err(e) => { println(`-vv => Err: ${e}`); }
  );
});
export(main);
```

Observed (`yo` 0.2.24, `--optimize 2`):

```
--output from-wrapper.txt --output user-override.txt  =>  from-wrapper.txt
-vv => Err: Unknown argument: -vv
```

Expected: `user-override.txt` (last-wins, as GNU getopt and clap do), with the
full list reachable through a list accessor.

A second run with a genuinely list-shaped option shows the same first-wins
behaviour, plus the missing flag-count accessor:

```
argv: --include first --include second   =>   get_option("--include") = first
argv: -v -v -v                           =>   get_flag("--verbose") = true  (no count accessor exists)
```

## Root cause

Storage keeps every occurrence; the accessor throws all but the first away.

The `.Opt` branch of `parse` pushes unconditionally, once per occurrence —
`std/cli/arg_parser.yo:392-393`:

```rust
                                  parsed._option_names.push(def._long_name);
                                  parsed._option_values.push(val);
```

`_option_names` / `_option_values` are parallel `ArrayList(String)` fields
(`:51-52`), so after `--output a --output b` they genuinely hold
`[--output, --output]` and `[a, b]`.

But `_lookup` (`:98-118`), the single accessor behind both `get_option` and
`get_positional`, stops at the first hit — `:107-110`:

```rust
          cond(
            (n == name) => {
              result = values.get(i);
              i = len;                    // <- break: the rest is never seen
            },
```

So `get_option` (`:119-121`) returns index 0's value and there is no second
accessor that walks the remainder. This is first-wins **by accident of the
break**, not by decision: nothing in the module's doc comments states a repeat
policy.

The mirror problem on flags. `:383` pushes the long name once per occurrence:

```rust
                          parsed._set_flags.push(def._long_name);
```

while `get_flag` (`:95-97`) is `self._set_flags.contains(name)` — a membership
test. `-v -v -v` is therefore indistinguishable from `-v`, and there is no
count accessor, so `-vv`-style verbosity levels cannot be expressed. (Clustered
short flags are separately unsupported: `-vv` reaches `_find_arg_index` at
`:208`, matches no `_long_name`/`_short_name`, and falls out as
`Unknown argument: -vv` at `:411-412`.)

No test covers repeats — all 15 tests in `tests/cli/arg_parser.test.yo` pass
each option and flag at most once.

## Fix

`std/cli/arg_parser.yo`, three parts:

1. **Decide and document the single-valued repeat policy, and implement it.**
   Change `_lookup` (`:98-118`) to drop the `i = len;` break at `:109` so the
   loop keeps overwriting `result` — that is a one-line change and yields
   last-wins. Then give `get_option` (`:119-121`) a doc comment saying so — it
   has none today, which is how an accidental policy became the contract.
2. **Add a list accessor**: `options(self, name) -> ArrayList(String)` that
   walks the parallel arrays and collects every match in argv order. Purely
   additive.
3. **Add `flag_count(self, name) -> usize`** — count matches in `_set_flags`
   instead of testing membership. `get_flag` keeps its `contains` semantics,
   which is exactly `flag_count(name) > usize(0)`. Purely additive.

**Design choice — what does the single-valued accessor return on a repeat?**
(i) first-wins (today, by accident); (ii) **last-wins** (GNU getopt, clap);
(iii) reject the repeat with a `DuplicateOption` error unless the definition was
declared multi-valued. **Recommend (ii)**: it is what every shell user relies on
when a wrapper script or alias appends an override after `"$@"`, it is what the
two reference implementations do, and it is a one-line change. (iii) is the
strictest but would reject the composition idiom outright.

**Watch the shared accessor.** `_lookup` also backs `get_positional`
(`:122-124`). Positional names are pushed one per slot in declaration order
(`:485`), so with distinct positional names last-wins is a no-op there — but two
`add_positional` calls using the *same* name would now resolve to the later
slot instead of the earlier one. Verify against the existing positional tests
(`tests/cli/arg_parser.test.yo:40-52`, `:169-183`) rather than assuming.

Clustered short flags (`-abc` == `-a -b -c`) and attached short values
(`-ovalue`) are the same class of argv grammar and are equally unsupported, but
they need a per-character loop with a Flag-vs-Opt decision mid-word. Keep them
out of this fix and say so in the module doc.

## Breaking change

Yes, for part 1: `get_option` returns a different value for a repeated option.
`std/cli/arg_parser.yo` carries no `## Stability` section, so by
`.github/instructions/yo-design.instructions.md:147` it counts as **stable** and
a changed return value is non-additive under `:149`. Parts 2 and 3 are additive.
Land part 1 in the same breaking wave as the module's `## Stability` marker and
name it in the release notes. Nothing in the tree depends on the current
behaviour: `std/cli`'s only consumer is `tests/cli/arg_parser.test.yo`.

## Regression test

`tests/cli/arg_parser.test.yo`, four new tests that must fail before the fix:

- `--output a --output b` → `get_option(`--output`)` is `b` (last-wins).
- `--include a --include b` → `options(`--include`)` has length 2 and holds
  `a`, `b` in that order.
- `-v -v` → `flag_count(`--verbose`)` is 2, and `get_flag` is still true.
- A flag never passed → `flag_count` is 0 and `get_flag` is false.
