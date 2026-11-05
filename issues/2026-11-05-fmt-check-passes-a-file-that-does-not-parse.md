# `yo fmt --check` passes a file that does not parse, as long as it is already formatted

**Severity:** S3: a check is too lenient. `yo fmt --check` exits 0 on a `.yo` file (or a Markdown ```` ```yo ```` block) the parser rejects whenever the formatter's rendering equals the input. CI's fmt gate therefore cannot catch invalid Yo in `docs/`, `plans/`, `issues/` and `.github/`, although AGENTS.md says a ```` ```yo ```` block there "must parse".

Found 2026-11-05 while sweeping the tree for `issues/fixed/2026-11-05-a-call-missing-its-closing-paren-before-a-semicolon-parses.md`.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println("a");
};
export(main);
```

With a compiler that rejects the missing `)` (E0002), `yo check` fails on this file, while `yo fmt --check` exits 0 and `yo fmt` leaves the file as it is. If the file gains a trailing blank line, so that the formatter would change it, `yo fmt --check` reports the E0002.

## Root cause

`format_yo_source` (`src/formatter.yo`) ends in `_fmt_parse_gate`. That gate parses the input only when the rendering differs from it (`if(formatted != input, …)`). Its purpose is to never hand back a rewrite of source the parser rejects. Unchanged source is never parsed. The token-level renderer does not need a valid parse.

## Recommendation

In `--check` mode, parse every file and every ```` ```yo ```` block (not `yo ignore`), and report a parse error as a failure. Write mode can keep its current gate. Before landing, mark the blocks that do not parse today as `yo ignore` (or repair them). A sweep on 2026-11-05 found 18 such Markdown files under `plans/` and `issues/`. The cli-case fixtures that are invalid by design are `.yo.fixture` files, or live in `repros/`, which the walker skips; check each of the 5 cli-case `fixture/` files that parse-fail as `.yo` (for example `tests/cli-cases/build-file-duplicate-artifact/fixture/src/main.yo`) before turning the check on.
