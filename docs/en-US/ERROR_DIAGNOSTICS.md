# Error diagnostics — codes, `yo explain`, and machine-readable output

Yo's error channel is designed for both humans and the agents that iterate on
compiler feedback. Every error the compiler reports is a structured
diagnostic: a severity, a message, an exact source span, an optional error
code, and an optional help hint — rendered in whichever format the consumer
asks for.

## The render formats

The default (human) format is rustc-shaped — one block per entry, entry 0 is
the primary error, later entries are notes:

```bash
$ yo check ./src
error[E0401]: Variable "undefined_fn_xyz" not found.
 --> src/main.yo:12:5
  |
1 |   undefined_fn_xyz();
  |   ^^^^^^^^^^^^^^^^^^
help: run `yo explain E0401` for more information
```

`--error-format` selects the rendering. It is a **global** flag — it goes
before the subcommand — and the `YO_ERROR_FORMAT` environment variable sets
the same thing at lower precedence:

```bash
yo --error-format short check ./src     # one line per entry
yo --error-format json compile app.yo   # machine-readable
YO_ERROR_FORMAT=json yo build           # same, via the environment
```

- `human` (default) — the block render above.
- `short` — `path:row:col: error[CODE]: message`, grep-friendly.
- `json` — one JSON object per diagnostic, 0-based positions, plus the human
  render under `rendered` so a single consumer can show either:

```json
{
  "severity": "error",
  "code": "E0401",
  "message": "Variable \"undefined_fn_xyz\" not found.",
  "span": { "file": "src/main.yo", "row": 11, "col": 2, "end_col": 19 },
  "rendered": "error[E0401]: ..."
}
```

- `sarif` — the whole diagnostic group as one [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
  2.1.0 log on stdout: codes become driver rules, positions are 1-based per
  the SARIF spec, and a mechanical repair becomes a `fixes` entry — the
  field GitHub code scanning and most CI lint pipelines ingest. Never
  colored, whatever `--color` says.

`--json-summary` (accepted by the test/check drivers) additionally prints the
final `N passed / M failed` style footer as one machine-readable line, so a
harness can parse the outcome without scraping prose.

### Color

The human render colors its output when it is writing to a terminal: the
severity header and its carets carry the severity color (red/yellow/cyan),
the `-->` anchor and gutter carry blue, and `help:` labels magenta. It is a
**global** flag like `--error-format`, with the `YO_COLOR` environment
variable at lower precedence:

```bash
yo --color always check ./src    # force color even into a pipe
yo --color never check ./src     # force plain text
YO_COLOR=always yo build         # same, via the environment
```

`auto` (the default) colors only when stderr is a terminal, `NO_COLOR` is
unset (https://no-color.org), and `TERM` is not `dumb`; an explicit
`--color always` overrides all three. `short` output stays plain — it exists
for grepping — and `json` output never carries ANSI escapes, including the
human text embedded in its `rendered` field, so a machine consumer gets
byte-identical payloads whatever `--color` says. `yo lsp` ignores the flag:
protocol frames are a data channel.

### Repairs and `yo fix`

A diagnostic carries a `repair` when exactly ONE edit fixes it; the compiler
never guesses between alternatives, so a message that names two possible fixes
carries none. In the JSON render the field is
`{ "file", "row", "col", "end_col", "replacement", "description" }` (0-based,
rune columns; `col == end_col` is an insertion) — the same edit `yo fix <path>`
applies, formatting each file it rewrites and re-running until a pass changes
nothing. `yo fix --dry-run` prints the repairs without writing.

The repairs the compiler computes today:

| diagnostic | repair |
| --- | --- |
| E0401 name not found, one close candidate in scope | rename the token (`countr` → `counter`) |
| E0401 name not found, exported by exactly one std module | insert `{ name } :: import("std/…");` above the first non-comment line (the help names the module; two exporting modules, or a rename candidate as well, give help only) |
| E0007 `{ f(x) }` — one expression between braces, no `;` | insert `;` before the `}` (two or more comma-separated items give the message only) |

## Warnings

`check`, `compile` and `build` also carry warning-severity diagnostics for
code that compiles but looks wrong. The first family is **unused variables**:
an initialized local whose value nothing ever reads warns once at the end of
its scope —

```text
warning: unused variable `x`
 --> src/main.yo:3:3
  |
3 |   x := i32(7);
  |   ^
help: prefix the name with `_` to silence this warning
```

Reading a variable marks it used; only assigning it does not (`x := 1; x = 2;`
still warns — the value never influenced anything). A `_` name prefix silences
the warning, parameters and module-level bindings are never warned, and
warnings never change the exit code. In the `json` render they arrive as JSON
Lines with `"severity":"warning"`, in `short` as `warning:` lines.

## Error codes and `yo explain`

Errors of a known family carry a stable `EXXXX` code in the header and a
`help:` tail pointing at the explainer. The code belongs to the mistake, not to
the wording: the place that raises an error names its family, so the same
underlying mistake produces the same code whichever stage reports it (an
argument of the wrong type is E0601 whether it is a function argument or a
variant payload), and rewording a message never moves its code. Errors
without a family render without a code.

```bash
$ yo explain E0401
E0401 — name not found

A name lookup failed: the identifier is not defined in this scope.

...

Example — this fails:
    undefined_fn_xyz();
```

- `yo explain --list` — every registered code with its one-line title.
- `yo explain E0401 --format json` — the full entry as JSON (for tooling).
- `yo explain E0401 --lang zh` — the Chinese version of the entry; the
  `YO_LANG` environment variable selects the language for both `explain` and
  its defaults.

Unknown code? `yo explain` suggests the nearest registered one — the same
edit-distance engine behind the compiler's own "did you mean" hints for
misspelled names and enum variants.

## Where an error is reported

An error points at the code that caused it: the argument that does not fit its
parameter, the field a constructor call is missing. An error raised inside the
standard library, while checking a call you wrote, is reported at that call,
with the standard-library location as a note:

```
error[E0602]: Type P does not implement required trait ToString.
  --> main.yo:5:3
  |
5 |   println(p);
  |   ^^^^^^^
note: raised here, inside the standard library
  --> /…/std/fmt/index.yo:63:50
```

## Where diagnostics surface

- `yo check`, `yo compile`, `yo build`, `yo test`, `yo install` — every CLI
  edge prints each diagnostic exactly once, in the selected format.
- `yo lsp` — the language server receives diagnostics through a structured
  channel (exact ranges, no text re-parsing), so editors get precise squiggles
  even when the error originates in an imported file.
- Runtime panics carry a call-site location suffix:
  `panic: <message> (at file://…/app.yo:3:17)`.

## Exit codes

Errors exit `1`, success exits `0` — both in every format. Machine consumers
should rely on the exit code for the outcome and on the JSON output for the
detail, not on parsing prose.
