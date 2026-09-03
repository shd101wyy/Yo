# Error diagnostics overhaul — structured, coded, LLM-first

> **Status: PROPOSED 2026-09-03 — awaiting maintainer review. Nothing here is
> implemented.** This doc is the detailed design for ROADMAP items
> [Phase 2.3](ROADMAP.md) ("Error-message overhaul"), [Phase 4.2](ROADMAP.md)
> ("Errors as few-shot repairs") and [Phase 4.5](ROADMAP.md)
> ("`yo explain <error-id>` / machine-consumable diagnostics"), and it closes
> the "structured-diagnostics return channel" remaining-quality item in
> [P4_LSP.md](P4_LSP.md) header. Sections 1–4 are a verified audit of the
> current `src/` (all numbers re-runnable, commands given); sections 5+ are
> the design and phasing proposed for approval.
>
> **§11 decisions recorded 2026-09-03**: `yo explain` (no alias), numeric
> `E0308`-style codes, a bilingual English + 简体中文 registry from day one,
> exit codes stay 0/1, runtime-panic locations stay in P3 (details §11).
>
> **P2 LANDED 2026-09-03** (PR #400): 25 E-code families with a central
> message classifier, the bilingual (EN + 简体中文) registry with bad/good
> examples, `yo explain` (--list/--format json/--lang zh-CN, did-you-mean),
> `--error-format human|short|json` + `YO_ERROR_FORMAT` (JSON Lines on
> stdout; chatter to stderr under json), registry gates.
>
> **P3 LANDED 2026-09-03** (PR #401) — the repair-oriented slice: the
> `help:` channel (Diagnostic.help, renders + JSON); did-you-mean at
> unresolved names and enum variants (shared edit-distance; the registry
> delegates); the ICE wrapper on codegen_fatal; panic() call-site locations
> + the StrLit-quotes fix (exact for direct calls; the assert-family
> wrappers report std/assert's own line — caller frames are not available
> there); --error-format threaded to the test/build children;
> --json-summary honored.
>
> **P3 REMAINING** (follow-up slice): import-chain collapse (D16), the LSP
> typed channel (P4_LSP's remaining item), and the pre-existing ref-local
> scope-drop leak (issues/ref-local-scope-drop-missing-after-value-call.md —
> filed with repros and the emitted-C mechanism; fixing it unblocks the
> LeakSanitizer-red internal suites).
>
> **P1 LANDED 2026-09-03** (PR #399, merged): structured `Diagnostic` + shared
> renderer in `src/diagnostics.yo`; `YoError` rebased, dead `ErrorKind`/
> `is_assertion_error`/`YoLexerError`/`ParseError`/`LexerError` deleted,
> 1028 call sites trimmed; lexer/parser/evaluator all throw the one
> structured error; single-print edges (D1–D6 dead). Verified:
> `check ./src` 264/264, `compile --skip-c-compiler` rc=0, stage-1 built at
> CI's flag set, internal error 17/17 + lexer 47/47 + parser 50/52 (the 2
> are pre-existing on pristine develop —
> `issues/parser-multibyte-spec-tests-leak-under-linux-asan.md`), CLI corpus
> 54 PASS (3 doc-* diffs are local git-version text only; 1 network skip),
> lsp-handshake golden re-recorded (leak + doubled location gone, LSP frames
> byte-identical).

Yo's positioning is "designed for the LLM era" — and the error channel is the
highest-bandwidth feedback an iterating agent receives. Today that channel is
pre-formatted prose with the location baked into the string, no codes, no
machine format, and several printing bugs (location printed twice per entry,
`check:` prefixes leaking into `compile`/`lsp`/`test`, lexer errors with no
file at all). This plan makes the diagnostic **data** first-class, gives every
error family a stable Rust-style code with an offline explanation (`yo
explain E0308`), and adds `--error-format=human|short|json` so an agent can
consume diagnostics without ever parsing human text.

---

## 1. Audit — the error pipeline as it stands

### 1.1 The core model (`src/error.yo`, 182 lines)

The entire compiler's error model is four small types:

- `ErrorKind` — an enum with **exactly one variant**, `Overflow`. It is set at
  2 sites (`src/evaluator/builtins/comptime_numeric_fns.yo:223,250`) and
  **never read anywhere** — write-only.
- `TokenAndError { token, error_message }` — a `Token` plus a pre-rendered
  string.
- `YoError { token_and_error_list, is_assertion_error, kind }` — thrown as
  `dyn(...)` through `exn.throw`; `to_string` joins entries with `Error: `
  prefixes. `is_assertion_error` is `true` at exactly 5 sites (all
  `comptime_assert.yo`) and is **never read** — also write-only.
- `YoLexerError` — **dead code**: defined and exported but never constructed;
  the live lexer error is a *different* struct (§1.2).

The critical structural defect: `format_error_message`
(`src/error.yo:125-136`) **bakes the location block into the message string**
— `` `${trimmed}\n\n${line}` `` where `line` is `path:row:col:\n<source>\n^` —
and then `YoError.to_string` (`src/error.yo:109-110`) appends
`get_line_at_token` **again**. The rendered string is the only representation
of a diagnostic anywhere in the pipeline; every consumer downstream of the
throw sees only text.

Emission census (rerun with `grep -rn 'format_error_message(' --include='*.yo'
src/ | grep -v format_error_messages`):

| Metric | Count |
| --- | --- |
| `format_error_message(` call sites | **1012 in 111 files** |
| `format_error_messages(` batch sites | 17 (10 in `evaluator/utils.yo`) |
| Delivered via `exn.throw` | ~1024 evaluator sites — fail-fast, single error |

Top files: `evaluator/types/function.yo` 94, `evaluator/exprs/match.yo` 58,
`evaluator/builtins/type_fns.yo` 44, `comptime_list_fns.yo` 33,
`types/trait.yo` 30, `calls/function.yo` 26, `builtins/asm.yo` 26.

Message text quality is actually decent — messages embed rendered types
(`type_to_string`, 192 uses) and expression source (`ast_expr_to_string`, 215
uses), and several carry multi-line guidance (the overloading policy message
even cites `plans/FUNCTION_OVERLOADING_POLICY.md`). What's missing is
everything *around* the text.

### 1.2 Per-stage matrix

| Stage | Type | File path | Row:col | Source line + caret | Multi-error |
| --- | --- | --- | --- | --- | --- |
| Lexer (`src/lexer.yo:48` `LexerError`) | local struct | **no** | raw **0-based** | **no** | fail-fast (6 sites) |
| Parser (`src/parser.yo:44` `ParseError`) | local struct | yes | 1-based | **rustc-style** `-->`, gutter, `^` | fail-fast (33 sites) |
| Evaluator (`YoError`) | token list | yes | 1-based | plain `path:row:col:` + line + `^` at token **middle** | multi-entry (ownership flows) |
| Codegen fatal (`codegen/constants.yo:197`) | thrown string | rare | rare | no | fail-fast (95 `codegen_fatal_expr` + 30 `codegen_fatal`) |
| Codegen hollow (`codegen/exprs/generation.yo:592`) | `// Failed to transpile` C comment | no | no | no | silent; fatal only for `__yo_user_main` |
| C compiler (`main.yo:2279-2307`) | raw inherited stderr | `.c` file only | `.c` lines | raw clang text | n/a |
| Runtime panic (`codegen/exprs/panic.yo`) | `fprintf(stderr, msg); abort()` | **no** | **no** | n/a | n/a |

Notes:

- The parser already renders the way we want everything to render. This plan
  generalizes *it*, not the other way around.
- Lexer `LexerError` prints `lexer error at 4:12: unexpected character` — no
  file (the struct has no `module_path`), no source line, and the row:col is
  **un-incremented 0-based** while every other stage prints +1.
- No `#line` directives are emitted (`grep -c '#line'` on the 1.5M-line
  emitted `yo.c` → 0), so C-compiler diagnostics are untraceable to Yo
  source. That gap is ROADMAP Phase 2.4's own item — cross-referenced in
  §9, not absorbed here.
- Runtime panics carry no location; string-literal panic messages print with
  literal embedded quotes (`"ArrayList: index out of bounds"` — quotes and
  all, verified in emitted `yo.c:53530`); abort is a bare SIGABRT with no
  exit-code distinction.

### 1.3 Output channels

**CLI.** One top-level handler (`src/main.yo:4106-4115`) prints
`yo: error: ${err.to_string()}` and `exit(1)`. That's the only common path;
everything else is per-subcommand special-casing:

- `run_fmt` installs its own handler printing the bare message (no prefix).
- The module loader's handlers (`src/module_manager.yo:420-427, 677-681`)
  print `check: error in: ${err.to_string()}` **and** stash the error. The
  stash is what `run_check` reports per failed file — but the *print* fires on
  every path that loads modules, so a broken `yo compile` emits the full
  evaluator dump under a `check:` prefix, followed by a wrapper line that
  **omits the underlying text** (`compile: failed to evaluate module "<path>"`,
  `main.yo:1771-1773`).
- Parse errors get a doubled prefix: `yo: error: error: expected )` (main
  prepends, `ParseError.to_string` starts with `error: `).
- No ANSI color anywhere in compiler output (`grep -rn $'\x1b' src/ scripts/`
  → 0; the harness even strips it defensively, `scripts/cli-diff-test.sh:169`).
- Exit codes: 0/1 everywhere except version pass-through, `--watch-once`
  (failed-file count), watch prelude-edit (2), and LSP sentinels.

**LSP.** `src/lsp/diagnostics.yo` re-evaluates the buffer, stashes
`err.to_string()` text, and **parses the human string back** — anchor lines
ending in `:` are split from the right (`diagnostics.yo:128-152`), the
`Error:` prefix is stripped, the underline length is *guessed* by scanning
identifier bytes (`_ident_len_at`, `diagnostics.yo:83-103`), the
printed-twice location is deduped (`:163-183`), and unanchorable errors
(lexer) collapse to a 0:0 whole-message diagnostic. The file's own header
says a structured channel is the cleaner design. This is the P4 remaining
item.

**Test runner.** Per-test `✓`/`✗` lines (unicode, not color); on failure the
runner prints `Test failed with exit code N` plus the captured child
stdout+stderr — first line only unless `-v` (`main.yo:2941-2959`). No
expected/actual diff, no test-file line. `--json-summary` is **accepted and
ignored** (`main.yo:2432-2434`). A test file that fails to *compile* streams
the child compiler's raw dump (unfiltered) and then throws
`test: batch compile failed (exit N)`.

**Warnings.** `format_warning_messages` (`error.yo:151-173`) has **zero
production callers** — the compiler emits no evaluator/parser warnings today.
There is no warnings channel in practice, and no `-W` flags.

### 1.4 Defect list

Everything below is verified; the phases in §7 fix them.

| # | Defect | Evidence |
| --- | --- | --- |
| D1 | Location block printed **twice per error entry** | `error.yo:125-136` bakes it; `error.yo:109-110` appends it again; LSP dedups (`diagnostics.yo:163-183`) |
| D2 | `check: error in:` print leaks into `compile`/`lsp`/`test`; wrapper line drops the error text | `module_manager.yo:420-427,677-681`; `main.yo:1771-1773` |
| D3 | Lexer errors: no file, no source line, 0-based row:col | `lexer.yo:48-64,59-61` |
| D4 | `yo: error: error:` doubled prefix on parse errors | `main.yo:4110` + `parser.yo:56-81` |
| D5 | No span: caret is one char at token *middle* (`col + len/2`) | `error.yo:47` |
| D6 | Secondary locations render as `Error: value moved here` — no note severity | `error.yo:110`; e.g. `evaluator/utils.yo:451-457` |
| D7 | `ErrorKind`/`is_assertion_error` are write-only dead weight | §1.1 |
| D8 | No did-you-mean machinery (3 hardcoded hints; `target.yo` is the only good citizen) | `target.yo:338-430` |
| D9 | Four inconsistent layouts for the same expected/actual concept | `assignment.yo` vs `match.yo` vs `trait.yo` (§1.1) |
| D10 | No machine-readable output; LSP parses text back; `--json-summary` ignored | §1.3 |
| D11 | ~125 codegen fatal sites are position-less internal preconditions; 14 `__yo_panic` sites SIGABRT with **no ICE wrapper or bug-report request** | `codegen/constants.yo:197-230` |
| D12 | C-compiler diagnostics unmappable (no `#line`) — ROADMAP 2.4 | §1.2 |
| D13 | Runtime panics: no location; StrLit quotes artifact; no rc distinction | §1.2 |
| D14 | No color, ever | §1.3 |
| D15 | Warnings are dead code; no `-W` flags | §1.3 |
| D16 | Import-chain errors cascade (ROADMAP 2.3: "15-deep"); leaf not isolated | §8.4 |

### 1.5 What is already good (keep)

- The parser's rustc-style renderer — promoted to THE renderer.
- Message text: specific, type-rendered, sometimes multi-line with guidance.
  **The plan deliberately freezes existing message strings verbatim** — only
  the structure around them changes (see §6 for why that keeps 28 CLI goldens
  green).
- `target.yo`'s errors (did-you-mean + supported-list) — the pattern to
  generalize.
- Multi-entry errors for ownership flows ("value moved here" etc.) — the raw
  material for labeled secondary spans.
- Fail-fast single-error evaluation: for an LLM repair loop, one precise error
  per iteration is a feature (§10 keeps it a non-goal to change).

### 1.6 Test-coupling census (what a format change costs)

| Coupling | Count | Breaks if… | Verdict |
| --- | --- | --- | --- |
| `comptime_expect_error(...)` in `tests/*.test.yo` | 280 | — | **Safe**: occurrence-only — it checks the argument *threw* (`comptime_expect_error.yo:51-67`); the optional message string is only wording for the "did not throw" failure. Never matches error text. |
| `tests/internal/error.test.yo` | ~13 tests pin exact/contains format | renderer changes | **Rewrite** in P1 (becomes the golden suite for the new renderer) |
| `tests/internal/lexer.test.yo` | 4 exact `.message ==` + 1 behavioral | lexer message/render changes | **Adjust** in P1 (messages frozen; render assertions updated) |
| `tests/internal/parser.test.yo` | 1 `ParseError.to_string` pin | renderer changes | **Adjust** in P1 |
| `tests/cli-cases/*` `stdout_keep_match=` | 28 cases pin message *substrings* | message text changes | **Survive by design** (text frozen in P1–P2); each verified during P1 |
| `tests/cli-cases/lsp-handshake/expected_stdout` | 1 full golden containing the doubled dump | any render change | **Re-record** in P1 |
| Other `expected_stdout` with "Error" | 1 of 57 (the lsp-handshake one) | — | covered above |

---

## 2. Design principles (why these choices, for an LLM audience)

1. **Data first, text second.** A diagnostic is a value
   (`code, severity, message, path, row, col, span, labels, notes, help`);
   human text and JSON are both *renderings of the value*. No consumer ever
   parses a rendering (the LSP stops doing exactly that).
2. **Stable identifiers.** Codes are `E` + 4 digits (rustc style, e.g.
   `E0308`). Once published in a release, a code is **never renumbered or
   repurposed** — rustc's compat rule. Message text may improve freely; the
   code is the contract an agent's tooling, memories, and retry logic key on.
3. **The corrected form rides in-band.** ROADMAP 2.3: "every error should
   carry the corrected form the way the `unsafe(...)` gate hint does." Where
   the compiler can synthesize a fix (did-you-mean, signature, expected type),
   it goes in `help:` — the agent repairs in one hop instead of researching.
4. **Bounded output.** One primary error (fail-fast is kept), cascade
   collapsed to the leaf + a short chain note, no repetition (D1/D2/D16). An
   agent's context is the scarce resource.
5. **Depth on demand.** The terminal error stays short; the long explanation
   with bad/good examples lives one command away (`yo explain E0308`) and the
   tail line advertises it. This is also the few-shot-repair corpus of ROADMAP
   4.2: `yo explain --format json` over the registry *is* the corpus export.
6. **Determinism.** Same input → byte-identical output; JSON keys in a fixed
   order; 0-based positions in JSON (matches `Token`'s internal basis and
   LSP), 1-based in human text, stated in the schema.

---

## 3. The `Diagnostic` model

New module `src/diagnostics.yo` (types + renderers + code table), new
`src/diagnostics_registry.yo` (explanations data, §5). Flat files, matching
repo style.

```rust
Severity :: enum(Error, Warning, Note, Help);

Span :: struct(
  path : String,       // module path as printed today
  row : usize,         // 0-based (Token basis; +1 is display-only)
  col : usize,         // 0-based, rune column
  len : usize          // rune length of the span (token/expr source length)
);

Label :: struct(       // a secondary location attached to a diagnostic
  severity : Severity, // Note today; Help reserved
  message : String,    // "value moved here", "expected type comes from this parameter"
  span : Span
);

Diagnostic :: struct(
  code : Option(String),      // "E0308"; .None until P2 assigns it (renders without [E…])
  severity : Severity,        // Error for the primary; entries never less than the thrower says
  message : String,           // VERBATIM existing text (frozen in P1/P2)
  span : Span,                // primary location
  labels : ArrayList(Label),  // secondary locations (today's extra TokenAndError entries)
  notes : ArrayList(String),  // plain "note:" prose lines, no location
  help : Option(String)       // "help:" — did-you-mean, corrected form, signature
);
```

Rules:

- **Primary span** = today's `ast_expr_token(...)` choice, unchanged (the
  audit confirms it already points at the erroring sub-expression for
  semantic errors and the enclosing call for shape errors — sensible).
- `len` comes from the token's own source length, fixing D5 (underline spans
  the token instead of a lone caret at its middle).
- In a batch (`format_error_messages`), entry 0 is the primary `Error`; the
  remaining entries become `Note` labels. The ~12 batch push sites
  (`utils.yo`, `assignment.yo`, `begin.yo`, …) all follow first-equals-primary
  today ("use of moved value" + "value moved here"); P1 verifies each site as
  it converts (acceptance item, §7.1).

### One throwable, rendered at the edge

`YoError` is re-based to carry the structure (same thrown type, so ~1024
`exn.throw` sites and every existing catch keep working):

```rust
YoError :: ref(struct(
  diagnostics : ArrayList(Diagnostic),  // replaces token_and_error_list
  is_assertion_error : bool,            // deleted (D7)
  kind : Option(ErrorKind)              // deleted; ErrorKind deleted (D7)
));
```

- `format_error_message(token, message, …)` **keeps its signature** — 1012
  call sites untouched — and internally builds a `Diagnostic` with the
  verbatim message, **without baking any location into the string** (D1's
  root cause removed).
- `YoError.to_string()` renders via the shared human renderer (§4.1) — so
  every existing catch/print site gets the new format for free.
- `LexerError` and `ParseError` are converted to `Diagnostic`s at their
  construction sites (lexer/parser keep their internal structs; what they
  *throw* becomes a `YoError` carrying one diagnostic; lexer's gains
  `module_path` and a source line — D3). Their internal types remain for
  unit tests to inspect.
- `codegen_fatal` / `codegen_fatal_expr` wrap their message in a diagnostic
  of the internal family (`E13xx` once coded), prefixing
  `internal compiler error:` and appending the file:line of the *compiler*
  source plus a report-at prompt (D11) — SIGABRT `__yo_panic` sites move to
  this path where reachable, else stay crashes (honestly labeled ICE).
- Edges that need machine output (`--error-format=json`) read
  `.diagnostics` directly; no dyn-downcasting is required anywhere.

---

## 4. Renderers

### 4.1 `human` (default) — the parser's format, generalized

```
error[E0308]: Incompatible types
  --> src/app.yo:12:7
   |
12 |   x : i32 = compute();
   |       ^^^ expected `i32`, found `String`
   |
note: value moved here
  --> src/app.yo:8:3
8  |   y := consume(z);
   |       ^ move occurs because `z` has type `Own(T)`
   |
help: run `yo explain E0308` for more information
```

- `error[E0308]: <first line of message>`; remaining message lines (the
  multi-line guidance several messages already carry) print under it,
  indented, verbatim.
- Secondary entries render as `note:` blocks with their own `-->` + underline
  (D6 fixed).
- `help:` last; the explain tail line appears only when a code is attached.
- One location per entry, printed exactly once (D1).
- The top-level CLI line stays `yo: error:`-shaped but no longer doubles any
  prefix (D4): the edge prints the wrapper line and the rendering, or just
  the rendering when the wrapper adds nothing.

### 4.2 `short`

```
src/app.yo:12:7: error[E0308]: Incompatible types
```

One line per diagnostic — for CI logs and quick greps. (`warning:` /
`note:` by severity.)

### 4.3 `json` — JSON Lines, one diagnostic per line

Built on `std/encoding/json` (`JsonValue`, `json_stringify` — already a
compiler dependency via the LSP, so no seed-availability risk).

```json
{"code":"E0308","severity":"error","message":"Incompatible types\n- Expected: i32\n- Given: String","span":{"file":"src/app.yo","row":11,"col":6,"end_col":9},"labels":[{"severity":"note","message":"value moved here","span":{"file":"src/app.yo","row":7,"col":2,"end_col":3}}],"notes":[],"help":null,"rendered":"error[E0308]: …full human text…"}
```

- **0-based** `row`/`col`/`end_col` (rune columns) — matches the internal
   `Token` basis and LSP; the schema doc states this loudly because rustc's
   JSON is 1-based-line/0-based-col and borrowing that asymmetry would
   generate off-by-one agent bugs.
- `rendered` carries the §4.1 text verbatim: agents get fields for logic and
  the caret block for reading, without re-deriving either.
- `code` is `null` until P2 assigns it — honest, and ratcheted by a census
  test (§7.2).
- Emitted to **stdout** (data channel), progress chatter to stderr; JSONL so
  `head`/`jq` work per line.

### 4.4 Flag and env plumbing

- `--error-format=human|short|json` on `check`, `compile`, `build`, `test`
  (unknown value → the target.yo-style did-you-mean error, not a bare throw).
- `YO_ERROR_FORMAT` env var, same vocabulary, lower precedence than the flag —
  lets an agent wrapper set it once for every invocation, including `yo
  build` internals that shell out to child compiles.
- The LSP ignores the flag (it consumes the structured channel, §8.3).

---

## 5. Error codes and the registry

- Format (DECIDED, §11.2): `E` + 4 digits. Loose band convention (not enforced, guidance
  only): `E00xx–E02xx` syntax (lexer+parser), `E03xx–E05xx` name/scope/module
  resolution, `E06xx–E08xx` types & traits, `E09xx–E10xx` ownership/moves/
  effects/async, `E11xx–E12xx` comptime/macros/reflection, `E13xx` internal
  codegen (ICE), `E15xx` CLI/build/deps/targets.
- Codes are allocated **per error family**, not per site — the 1012 sites
  collapse into an estimated 100–200 families (e.g. the ~200 "Incompatible
  types" spellings are one family; D9's four layouts unify under it in P2's
  catalog work, text still recognizable).
- Allocation is **incremental and frequency-driven**: P2 assigns codes to the
  families that dominate real emissions (measured by running the corpus and
  tallying), not by sweeping all 111 files at once. Unassigned sites render
  codeless. A census test (count of `format_error_message` sites reachable
  without a code) ratchets downward.
- **Never renumber.** The registry records a one-line history per code if a
  family later splits.

Registry entry (data, in `src/diagnostics_registry.yo`; ships inside the
binary so `yo explain` works offline):

```rust
Example  :: struct(bad : String, good : String, why : String, why_zh : String);
Explain  :: struct(
  code : String,            // "E0308"
  title : String,           // "mismatched types"        (English)
  title_zh : String,        // 简体中文标题
  summary : String,         // one sentence              (English)
  summary_zh : String,
  explanation : String,     // paragraphs; markdown-ish  (English)
  explanation_zh : String,
  examples : ArrayList(Example),  // snippets are language-neutral; `why` prose is bilingual
  related : ArrayList(String)
);
```

**Bilingual by decision (§11.3):** every prose field ships in English AND
Simplified Chinese from day one — there is no English-only pass to retrofit.
The compiler's own message text stays English-only (§10); the registry is
the bilingual surface. `yo explain` prints English by default; `--lang
zh-CN` (or the `YO_LANG` env var) selects the Chinese fields, and
`--format json` carries both languages.

A registry test enforces: every code referenced from the code table has an
entry, titles/summaries/explanations non-empty **in both languages**, ≥1
example per entry, and —
the strong gate, borrowed from rustc's error-index tests — **every `good`
snippet compiles** (checked by a small harness shelling `yo check` on temp
files) and every `bad` snippet errors *with that code* (checked the same
way). The corpus therefore cannot rot.

---

## 6. `yo explain`

Naming (DECIDED, §11.1): **`yo explain <CODE>`** — it matches the repo's
verb-subcommands (`build`, `check`, `doc`, `fetch`, `install`, `version`)
and is the spelling ROADMAP 4.5 already uses. No `yo error` alias.

```
$ yo explain E0308

E0308 — mismatched types

The value's type does not satisfy the expected type at this position.
…(explanation paragraphs)…

Example — this fails:
  …bad snippet…
Example — write this instead:
  …good snippet…
  why: …
Related: E0612 (variable not found), E0061 (argument count mismatch)

$ yo explain E03099
error: unknown error code `E03099`
help: did you mean `E0308`? Run `yo explain --list` for all codes.
```

- `yo explain --list` — code + title per line; `yo explain --list --format
  json` — the full registry dump (this is the ROADMAP 4.2 corpus export).
- `yo explain E0308 --format json` — one entry, for agents pulling depth on
  demand. `--lang zh-CN` prints the Chinese fields (default English; the
  `YO_LANG` env var is equivalent); JSON always carries both languages.
- Exit 0 when found, 1 when not (with did-you-mean over the registry — the
  same edit-distance helper as D8, §8.1).
- No network, no repo presence needed — the registry is compiled in.

---

## 7. Phased implementation

Each phase lands green (`yo check ./src`, full fast suite, gates_fast) and is
a reviewable unit. Message text is **frozen verbatim** in P1–P2 — that choice
is what keeps the 28 `stdout_keep_match` CLI cases and the 280
`comptime_expect_error` uses green (§1.6), confining churn to ~19 internal
tests + 1 golden.

### P1 — structured core + unified human renderer

Scope:
1. `src/diagnostics.yo`: `Severity`, `Span`, `Label`, `Diagnostic`, the
   human + short renderers (generalized from `parser.yo:56-81`).
2. Re-base `YoError` onto `ArrayList(Diagnostic)`; delete
   `ErrorKind`/`is_assertion_error` (D7); `format_error_message(s)` keep
   signatures, stop baking location (D1); entry[0]=Error, rest=Note labels
   (D6), verifying the ~12 batch sites.
3. Lexer throws a diagnostic carrying `module_path` + source line; +1 the
   rendered row:col (D3); delete dead `YoLexerError` (D3).
4. Parser renders through the shared renderer; single `error:` prefix (D4).
5. Single-print edge: module-manager handlers **stash only** (no print);
   `run_check` renders per failed file at its own edge; `run_compile`'s
   wrapper includes the rendered error (D2).
6. Underline spans token length from its start (D5).
7. **LSP adapter**: `parse_error_text` learns the new ` --> path:row:col`
   anchor shape (still text-based; the typed channel is P3). Re-record the
   lsp-handshake golden.
8. Rewrite `tests/internal/error.test.yo` as the golden suite for the new
   renderer; adjust the lexer/parser format pins; run the 28 CLI substring
   cases and fix any that pinned structure rather than message text.

Acceptance: every error prints its location exactly once (grep the suite
output); lexer errors show file+line+caret; suite green; lsp-handshake golden
re-recorded; `yo check ./src` green under the seed-built binary
(two-generation rule respected — no new std API beyond what the seed ships).

### P2 — codes, registry, explain, JSON

Scope:
1. Code table in `src/diagnostics.yo` + registry in
   `src/diagnostics_registry.yo`; assign codes to the top families (target:
   ≥60% of corpus-measured emissions coded, estimated 60–100 codes).
   Registry entries are bilingual (English + 简体中文) from the first entry
   (§5) — no English-only pass to retrofit later.
2. `help: run \`yo explain E0xxx\`` tail on coded diagnostics.
3. `yo explain` subcommand with `--list`, `--format json`, did-you-mean.
4. Registry test incl. good-snippets-compile / bad-snippets-error-with-code.
5. `--error-format=short|json` + `YO_ERROR_FORMAT` on check/compile; JSONL on
   stdout (D10).
6. D9's four expected/actual layouts unify *inside the catalog work* — the
   family's canonical layout becomes part of its catalog entry, applied as
   codes are assigned (text stays recognizable, e.g. keeps "Expected/Given"
   vocabulary).

Acceptance: two runs → byte-identical JSON; `jq` round-trips every field;
explain offline in both languages; registry gates green (incl.
both-language non-empty); suite green.

### P3 — repair-oriented upgrades (the LLM loop)

1. **Did-you-mean** (D8): edit-distance helper + wiring into unresolved
   identifier, enum variant, module field, method/trait lookup, `--error-format`
   value, explain codes. Candidates render in `help:`.
2. **Corrected form in-band** (§2.3) on the top families: type mismatch shows
   the expected/actual + fix hint; arity mismatch shows the callee signature;
   moved-value shows the consuming site (already a label).
3. **Import-chain collapse** (D16): report the leaf diagnostic once + one
   `note: in module imported from <path>` chain note (bounded, no cascade).
4. **ICE wrapper** (D11): `codegen_fatal*` → `internal compiler error:` +
   compiler file:line + report prompt; keep rc=1 (decided, §11.4).
5. **LSP typed channel**: `analyze_document` returns
   `ArrayList(Diagnostic)`; `parse_error_text` and `_ident_len_at` retire —
   the P4 remaining item closes; exact ranges from spans, not identifier
   heuristics.
6. **Runtime panic locations** (D13): `panic()`/`assert()` codegen embeds the
   Yo file:line of the call site (`exprs/panic.yo` has the `Expr`; its token
   is available); fix the StrLit quotes artifact. ⚠ some tests capture
   runtime panic text — audit before landing (acceptance includes it;
   decided in-scope, §11.5).
7. `--error-format` threaded through `build`/`test`; test runner honors
   `--json-summary` (currently ignored) or removes the flag (pick during
   implementation; CLI-compat tests decide).

Acceptance: corpus diff shows did-you-mean on the classic typo classes; LSP
golden re-recorded once more; runtime-panic-touching tests audited and green.

### P4 — deferred, separate decisions (cross-referenced, not scheduled here)

- `#line` directives mapping emitted C to `.yo` (ROADMAP 2.4 owns it; it
  would also let C-compiler stderr be wrapped as diagnostics).
- Color (tty-gated, `NO_COLOR`/`TERM=dumb`) — D14; cosmetic, after data work.
- A live warnings channel (D15) — `Severity.Warning` exists since P1; wiring
  unused-variable/etc. detection is its own small project.
- SARIF output; `yo fix` (ROADMAP 4.5's bigger sibling).

---

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Self-hosting / two-generation rule: `error.yo` is imported by ~everything; every edit is a full rebuild (stage2 ~38 min) | Phases are few, large, atomic edits; P1 keeps helper signatures identical so 1012 sites don't move; gates_fast after each |
| New std dependency in the hot path | None: `std/encoding/json` is already compiled into the tree via the LSP; edit-distance stays compiler-local in P3 |
| 28 CLI substring goldens + lsp-handshake golden churn | Message text frozen in P1–P2 (§1.6 census); only structure around it changes; each case verified in P1 acceptance |
| LSP silently breaks mid-P1 (its parser keys on today's anchors) | P1 ships the `-->` anchor adapter in the same change as the renderer — never lands renderer-without-adapter |
| Registry rots as messages evolve | Registry test compiles every `good` snippet and asserts every `bad` snippet errors with its code (rustc error-index model) |
| Codes churn / renumbering temptation | Never-renumber rule in §5; registry keeps per-code history lines |
| Runtime-panic location change (P3.6) breaks tests that capture panic text | Explicit audit listed as P3 acceptance, before landing |
| Registry EN/zh entries drift apart | Both languages are authored in ONE entry side by side; the registry test fails on any empty `_zh` prose field |

---

## 9. Relationship to other plans

- **ROADMAP 2.3 / 4.2 / 4.5** — this doc is their detailed design.
- **ROADMAP 2.4 (`#line`)** — orthogonal; P4 cross-ref. Landing it would let
  C-compiler stderr be wrapped as code-carrying diagnostics later.
- **P4_LSP.md remaining item** — closed by P3.5 (typed channel).
- **INCREMENTAL_COMPILATION** — unaffected; the structured channel makes
  future incremental diagnostics trivially cacheable.
- **TARGET_TRIPLES.md** — `target.yo`'s hint style is the house pattern this
  plan generalizes; its errors get codes in the `E15xx` band.

---

## 10. Non-goals

- **Multi-error batch output.** Fail-fast single-error stays (§1.5) — no
  parser recovery / evaluator continuation machinery in this plan. Revisit
  only if agent-iteration data shows batching pays for recovery complexity.
- Renumbering or recycling codes; translating the compiler's own message
  text (English remains the machine lingua franca — the bilingual surface is
  the explanations registry, where both languages ship from day one, §11.3).
- A `yo fix` auto-rewriter (ROADMAP mentions it; separate doc when wanted).
- Absorbing the `#line`/debug-info project.

---

## 11. Decisions (maintainer, 2026-09-03)

The former open questions, all decided:

1. **Subcommand name**: `yo explain E0308` — verb-form, matches the ROADMAP
   4.5 spelling. No `yo error` alias.
2. **Code format**: numeric `E0308` (rustc parity, terse, typo-duck-typed by
   did-you-mean). No semantic slugs.
3. **Registry language**: bilingual — every entry carries English AND
   Simplified Chinese prose from day one (`title`/`title_zh`, …; §5). The
   compiler's own message text stays English-only.
4. **Exit codes**: keep 0/1 everywhere (goldens and scripts assume it).
5. **P3.6 runtime panic locations**: stays in Phase 3 scope, with its
   audit-before-landing acceptance item (the runtime-output churn across std
   tests is checked first).

---

## Appendix A — emission-site census (2026-09-03)

Rerun: `grep -rn 'format_error_message(' --include='*.yo' src/ | grep -v
format_error_messages | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head -15`

| Sites | File |
| --- | --- |
| 94 | `src/evaluator/types/function.yo` |
| 58 | `src/evaluator/exprs/match.yo` |
| 44 | `src/evaluator/builtins/type_fns.yo` |
| 33 | `src/evaluator/builtins/comptime_list_fns.yo` |
| 30 | `src/evaluator/types/trait.yo` |
| 26 | `src/evaluator/calls/function.yo` |
| 26 | `src/evaluator/builtins/asm.yo` |
| 24 | `src/evaluator/builtins/comptime_index_fns.yo` |
| 23 | `src/evaluator/builtins/expr_fns.yo` |
| 22 | `src/evaluator/calls/index_trait.yo` |
| 20 | `src/evaluator/exprs/property_access.yo` |
| 20 | `src/evaluator/exprs/destructuring_assignment.yo` |
| 19 | `src/evaluator/types/enum.yo` |
| 18 | `src/evaluator/types/field.yo` |
| 18 | `src/evaluator/exprs/cond.yo` |

Subdirectory totals: `builtins` 304, `exprs` 252, `types` 225, `calls` 144,
`values` 69, evaluator root 7, `src/expr.yo` 6, `src/types/` 5. Batch-form
sites (`format_error_messages`): 17, of which 10 in
`src/evaluator/utils.yo`. Codegen fatals: 95 `codegen_fatal_expr` + 30
`codegen_fatal` + 14 `__yo_panic`. Parser: 33 throw sites. Lexer: 6.
