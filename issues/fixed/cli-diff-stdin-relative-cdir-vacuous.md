# cli-diff-test: case `stdin` silently replaced by /dev/null (relative $cdir vs the sandbox cd)

**Found:** 2026-08-22, investigating why `tests/cli-cases/lsp-handshake`'s
recorded golden was 14 bytes (`$ yo lsp` + `rc=0`) with zero server output —
while running the identical command by hand produced 3.4 KB of framed LSP
responses.

## Symptom

Every harness run — record AND score — fed `yo lsp` an EMPTY stdin. The
server saw immediate EOF, exited 0 cleanly, and the case recorded a golden
that asserted nothing. It then "passed" on every battery and on CI: a
textbook hollow-green gate. Nothing the LSP server answers (capabilities,
diagnostics, hover, definition, symbols, references, folding, rename,
formatting) was being compared at all.

## Root cause

`run_case()` attached the stdin redirect to the command INSIDE the sandbox
subshell, with the existence check inline in the redirect word:

```bash
( cd "$proj" && ... "$YO_SELF_BIN" "${argv[@]}" 2>&1 \
    < "$( [[ -f "$cdir/stdin" ]] && echo "$cdir/stdin" || echo /dev/null )" )
```

The command substitution is evaluated AFTER `cd "$proj"`. `$cdir` is
relative (`CASES_DIR="tests/cli-cases"`), so from inside the sandbox the
path no longer exists, `[[ -f ]]` fails, and the fallback `/dev/null` wins
— silently, on every run, on every machine.

The manual reproduction "worked" because it used an absolute case path,
which is exactly why the bug survived: the feature was verified by hand
with absolute paths, then exercised by the harness with relative ones.

## Fix

Resolve the stdin path to an absolute one in `run_case()` BEFORE the
subshell, and redirect from the variable:

```bash
local stdin_file=/dev/null
[[ -f "$cdir/stdin" ]] && stdin_file="$(cd "$cdir" && pwd)/stdin"
...
    < "$stdin_file" )
```

Also `.gitattributes` gained `tests/cli-cases/*/expected_stdout -text`: the
re-recorded golden embeds the server's framed responses (CRLF headers), and
the repo-wide `* text=auto eol=lf` would have rewritten those bytes on
commit, breaking the strict comparison.

## Verification

- Re-recorded `lsp-handshake`: golden went 14 → 3442 bytes, 16
  Content-Length-framed responses (capabilities, 4 diagnostics publishes,
  hover, definition, symbols, references, folding, rename WorkspaceEdit,
  formatting edits, signatureHelp with `add_one(x : i32) -> i32`).
- Scoring run passes strictly against the new golden; any response drift
  is now a GOLDEN-DIFF.

## Lesson

A golden whose body is just the command header and `rc=0` is a red flag —
the harness should probably refuse to record an empty-output case for a
command that was given a `stdin` file. Worth adding if a second stdin case
ever appears.
