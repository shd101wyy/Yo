> **RESOLVED 2026-08-11 — MEASURED, with the check itself controlled.** The
> self-hosted formatter now agrees with the TS-formatted committed tree on
> **all 865 `.yo` files** in `std/ tests/ yo-self/`: `fmt --check` over the three
> trees exits 0 with no output (stage-1 built from `p2/retire-prep`). Because a
> vacuous `--check` would look identical, two negative controls were run: a
> deliberately misformatted standalone file reports `would format:` and rc=1,
> and a misformatted file PLANTED inside `tests/` is found by the tree walk
> (proving the walker visits files rather than skipping them).
>
> So the specific fear recorded below — "once `src/` is retired the self-hosted
> formatter becomes canonical and the first `yo fmt` would silently restyle
> hundreds of files" — is no longer true, and GATE 6 can become `yo fmt --check`
> plus an idempotence check without a permanently-red gate. The remaining
> residuals for a STABLE cli-case are unrelated to output: `formatter.yo`'s
> `FormatYoFilesOptions.cwd` is dead, and the walked file list is neither sorted
> nor deduped — see plans/P2_5_RETIRE_EXECUTION.md step 14.
>
> Kept for its reproduction recipe and its "why this was never caught" lesson,
> which still applies to every self-referential gate.

# yo-self's formatter diverges from the TS reference on ~315 files

**Found 2026-08-08** by the first-ever `fmt` differential between the two
compilers. **One bug fixed here; the rest is open and owned by P1.**

## How to reproduce

The tree is kept formatted by the TS formatter (CI runs
`node ./out/cjs/yo-cli.cjs fmt --check ./std ./tests ./yo-self` and it is green),
so pointing the self-hosted formatter at the same trees surfaces every
disagreement:

```bash
# Leftover test-batch artifacts are gitignored but NOT excluded from fmt, and
# are never formatted — they fail BOTH formatters and mask the real signal.
find tests \( -name ".yo_selftest_batch_*" -o -name ".yo_test_batch_*" \) -delete
YO_MAIN_STACK_MB=4096 <bin> fmt --check ./std ./tests ./yo-self
```

To see an individual divergence without dirtying the tree, copy the file to
`/tmp`, format the copy, and `diff` against the original.

## Fixed here: a line-leading `.` was written before the indent

Every match arm whose pattern started a line came out with the dot ahead of the
indentation:

```rust
// TS (correct)          // yo-self (before this fix)
    .Some(v) => ...      .    Some(v) => ...
```

`src/formatter.ts` routes **every** emit through one helper, so the indent can
never be skipped:

```ts
  const write = (text: string): void => {
    if (text.length === 0) return;
    writeIndentIfNeeded();     // emits the pending indent, clears atLineStart
    result += text;
  };
  case TokenType.Dot: { trimTrailingHorizontalWhitespace(); write("."); break; }
```

`yo-self/formatter.yo` has no `write` helper — it **inlines** that block at each
of its call sites, and the `TokenKind.Dot` arm was the one site that got
neither half: a bare `result.push_str(".")`, so the dot went out first and
`at_line_start` stayed set, leaving the _next_ token to write the indent after
it. Fixed by mirroring TS at that site (`_trim_trailing_h_ws`, already present
at `formatter.yo:186`, then the inlined write-indent block, then the dot).

Effect: the `fmt --check` divergence count drops **417 → 315 files**.

## Still open: two dominant rule classes

Harvested by formatting 60 of the diverging files into `/tmp` and classifying
every changed line pair (`<` = TS, `>` = yo-self):

| count | class                      | example                                                                                                               |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 560   | space added before `)`     | TS `(==) : (fn(...))` vs self `(== ) : (fn(...))`; TS `(fn(fd : int, cmd : int, ...) -> int)` vs self `... ) -> int)` |
| 310   | space added before `.`     | TS `match(l.get(i),.Some(__e) => __e,...)` vs self `match(l.get(i), .Some(__e) => ...)`                               |
| 337   | line-breaking, not spacing | see the caveat below                                                                                                  |

## Caveat that shapes the fix — TS's formatter is not canonical

The naive framing ("the self-hosted formatter must agree the tree is formatted")
is **not** a clean differential, and the third row above is why. On a minimal
input the two disagree about line structure, not spacing:

```rust
// input
  match(x, .Some(v) => v, .None => 0)
// TS      — keeps one line, and writes `, .Some` WITH a space
  match(x, .Some(v) => v, .None => 0)
// yo-self — breaks across lines
  match(x,
  .Some(v) => v,
  .None => 0)
```

Note TS produces `, .Some` here while _preserving_ `,.Some` where it already
appears in the repo. So the TS formatter **preserves existing line structure**
rather than canonicalizing it, and a raw `fmt --check` disagreement mixes real
spacing bugs with benign line-breaking differences. Any gate must account for
that — comparing `fmt` output of an already-TS-formatted file is fine, but
treating every "would format" as a bug is not.

## Why this was never caught

CI has only ever run `fmt --check` through the **TypeScript** CLI
(`.github/workflows/test.yml:83`). The self-hosted `fmt` is at flag parity and
its output had never been compared to the reference. This matters for
`plans/SELF_HOSTING_COMPLETION.md` **P2**: once `src/` is retired the
self-hosted formatter becomes canonical, `fmt --check` becomes self-referential,
and the first `yo fmt` would silently restyle hundreds of files with no gate
able to notice.

**A `fmt` differential gate is therefore P1 work, and must land with the fix**
— `scripts/bootstrap/gates_fast.sh` carries a note where it would go. It was
deliberately not wired in now: a permanently-red gate trains everyone to ignore
CI, which is the same failure this pass was fixing elsewhere.
