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

`--json-summary` (accepted by the test/check drivers) additionally prints the
final `N passed / M failed` style footer as one machine-readable line, so a
harness can parse the outcome without scraping prose.

## Error codes and `yo explain`

Messages that match a known family carry a stable `EXXXX` code in the header
and a `help:` tail pointing at the explainer. The codes are central: the
compiler classifies its own message vocabulary into the families, so the same
underlying mistake always produces the same code regardless of which stage
reports it.

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

## Where diagnostics surface

- `yo check`, `yo compile`, `yo build`, `yo test`, `yo fetch` — every CLI
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
