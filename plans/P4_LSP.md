# P4 — the LSP in Yo

**Status: SCOPED 2026-08-12, not started.** Measured sizing, two feasibility
spikes (one green, one red), and the slice order. Nothing is ported yet.

This also settles one of P2.5's four open questions — _"keep `src/lsp` as an
island, or ship a syntax-only extension"_. Neither: the LSP gets rewritten in
Yo, so `src/` can go without losing language features. Until then, deleting
`src/` means the VS Code extension degrades to syntax highlighting.

## Size

| file                  | lines     | notes                                      |
| --------------------- | --------- | ------------------------------------------ |
| `completion.ts`       | 1541      | by far the largest; the whole tail is here |
| `definition.ts`       | 658       |                                            |
| `hover.ts`            | 515       |                                            |
| `document-manager.ts` | 371       | open/change/close, incremental text sync   |
| `symbols.ts`          | 290       |                                            |
| `signature-help.ts`   | 238       |                                            |
| `utils.ts`            | 237       |                                            |
| `rename.ts`           | 195       |                                            |
| `server.ts`           | 168       | wiring only                                |
| `references.ts`       | 132       |                                            |
| `folding.ts`          | 125       |                                            |
| `inlay-hints.ts`      | 118       |                                            |
| `diagnostics.ts`      | 111       |                                            |
| `formatting.ts`       | 31        | already have `yo fmt`                      |
| **total**             | **4,730** |                                            |

Plus a transport layer that does not appear in that count: TypeScript gets
JSON-RPC framing, the protocol types, and the connection lifecycle free from
`vscode-languageserver/node`. Yo has to write it.

So this is a campaign, not a gap-filler — which is why it is P4 and not a P2
item. It should not block retiring `src/`.

## Spike 1 — stdio transport: GREEN

The hard prerequisite is that a Yo program can read its OWN stdin when stdin is
a **pipe**, which is what an editor gives a language server. `std/sys/file.read`
is positional (`offset`), and positional reads fail on pipes with `ESPIPE`, so
this was the risk that could have sunk the whole idea.

It works. `BufReader.new(i32(0)).read_line(io)` reads LSP framing straight off a
pipe:

```
$ printf 'Content-Length: 17\r\n\r\n{"jsonrpc":"2.0"}\n' | ./stdin_spike
line[0] = Content-Length: 17
line[1] =
line[2] = {"jsonrpc":"2.0"}
```

`std/encoding/json.yo` exists for the payloads. No std change is needed to
speak the protocol.

## Spike 2 — diagnostics: RED, and it is a hard blocker

Diagnostics are the feature users implicitly trust: a quiet editor means "my
code is fine". yo-self cannot currently support that claim.

```
$ cat bad.yo
main :: (fn() -> unit)({ undefined_fn(); });
export(main);

$ yo-self check bad.yo
check: bad.yo — evaluator OK          # <-- silently accepts it

$ yo-cli check bad.yo                 # the TypeScript compiler
Error: Variable "undefined_fn" not found.
  bad.yo:1:26
```

This is the def-eval swallow (`issues/self-hosted-compile-swallows-undefined-call.md`).
An LSP built on this checker would report **no errors on broken code** — worse
than no LSP at all, because silence is read as approval. So:

> **Fixing the def-eval swallow is a prerequisite for LSP diagnostics, not a
> parallel nice-to-have.**

**UPDATE 2026-08-12 — half of this is done, and it is the half that matters
least for an LSP.** `compile` no longer accepts an undefined call: an
untranspilable expression is fatal (220 marker sites in both compilers), and in
yo-self a marker reaching `__yo_user_main` fails the compile. So the silent
no-op binary is gone.

But the diagnostic is a CODEGEN-level report — "Failed to transpile part of
main's body" — with no row/column and no identifier. An LSP needs
`Variable "foo" not found.` anchored at the identifier's token. That is the
def-time re-raise, which was implemented, measured, and REVERTED (it turned 10
corpus files red; the flag is a global and trials nest). Slice 0 below is
therefore still open, but its scope is now narrower and better understood: it is
a DIAGNOSTIC-QUALITY problem, not a "the checker accepts broken code" problem,
and the issue doc records the three corrections a redesign has to make.

Its severity was previously ranked as "rises once `src/` is gone". It rises
again here: it also gates the LSP's most valuable feature.

Second, smaller problem: `check` emits unstructured progress text
(`check: parsing ...`, `check: — evaluator OK`), not diagnostics with ranges.
Scraping that is not viable. The port needs an analysis entry point that
RETURNS structured errors (path, row, column, length, severity, message)
instead of printing them — which the evaluator already carries internally,
since the TS side formats exactly that.

## Slice order

Each slice is independently useful and independently testable. Do not start
slice 4 before slice 0 is done.

| #   | slice                                                                                                                                                                                                                             | gate                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0   | def-time re-raise for a structured diagnostic (the ACCEPTANCE half is done — see the 2026-08-12 update; what is missing is row/column + identifier, and it needs per-trial save/restore so nested trials cannot clobber the flag) | `check` on a file with an undefined call reports it, with row/column     |
| 1   | transport: framing, JSON-RPC dispatch, `initialize`, document sync                                                                                                                                                                | a scripted client completes the handshake and syncs an edit              |
| 2   | diagnostics (publishDiagnostics on open/change)                                                                                                                                                                                   | broken file → squiggle at the right range; fixing it clears the squiggle |
| 3   | hover + go-to-definition + document symbols                                                                                                                                                                                       | fixture-driven request/response tests                                    |
| 4   | completion (1541 lines — the tail)                                                                                                                                                                                                | fixture-driven, per completion kind                                      |
| 5   | references, rename, signature help, folding, inlay hints                                                                                                                                                                          | fixture-driven                                                           |
| 6   | point the VS Code extension at the Yo server; drop `src/lsp`                                                                                                                                                                      | extension works against the native binary with no Node dependency        |

`formatting.ts` (31 lines) is already covered by `yo fmt` and needs only wiring.

## Testing

`lsp.test.ts` (1506 lines) tests the TypeScript implementation and dies with
`src/` — port none of it. The Yo server should be tested the way the CLI is:
drive the real binary with scripted JSON-RPC over a pipe and compare responses,
so the transport is exercised on every run rather than mocked.

## Why not now

The transport spike is cheap and the protocol is well specified, but slice 0 is
a compiler bug fix in the evaluator, and slices 2-5 are 4,700 lines of
position-sensitive logic. Starting it while P2.3 is still open would fork
attention across two campaigns. The sequencing that keeps both honest is:
finish P2 (retire `src/`, accepting a syntax-only extension in the interim),
then run P4 as its own campaign.
