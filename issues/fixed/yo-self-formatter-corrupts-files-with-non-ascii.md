# The self-hosted formatter DESTROYS any file with non-ASCII + a backtick string

> **FIXED 2026-08-09** — `read_raw_template_string` now converts the character
> index to a byte offset itself (counting UTF-8 lead bytes), so the two index
> spaces can no longer disagree. Verified: the 4-line repro round-trips clean,
> `std/encoding/html.yo` now matches the reference formatter byte-for-byte, and
> full-corpus formatter divergence went **253 → 17 of 808 files**.
>
> **The audit in "Fix direction" is still open** and deliberately not done here:
> any OTHER consumer of `Token.character` that indexes bytes has the same latent
> bug. The fix was kept local so it could ship with its regression guard;
> widening it to a `Token.byte_offset` field is the follow-up.

**Found 2026-08-09** while measuring the `fmt` divergence for
[`plans/PRE_P1_HANDOVER.md`](../plans/PRE_P1_HANDOVER.md) §6. This is not a
spacing disagreement — it is **silent source destruction**, and it is the
dominant remaining `fmt` divergence class.

`yo-self fmt` rewrites the file, **exits 0**, and the result **does not parse**.

## Minimal reproducer — 4 lines

```rust
//! A comment — with an em dash.
open(import("std/string"));
f :: (fn(input : String) -> bool)(input.contains(`&`));
export(f);
```

```bash
cp repro.yo /tmp/a.yo && <yo-self-bin> fmt /tmp/a.yo   # rc=0
```

|                | line 3 after `fmt`                                          |
| -------------- | ----------------------------------------------------------- |
| TS (reference) | `f :: (fn(input : String) -> bool)(input.contains(\`&\`));` |
| **yo-self**    | `f :: (fn(input : String) -> bool)(input.contains(s(\`));`  |

Replace the em dash `—` with an ASCII hyphen `-` and **both formatters agree**.
The trigger is the non-ASCII character, not the comment and not the template.

## Root cause — a character index used as a byte offset

`yo-self/formatter.yo:1460`:

```rust
(t.kind == TokenKind.TemplateString) => read_raw_template_string(input, t.character),
```

`read_raw_template_string` (`yo-self/formatter.yo:1385-1388`) documents its
parameter as a **byte offset** and indexes `input.as_bytes()` with it:

```rust
/// Read a backtick template-string starting at byte offset `start` in `input`,
read_raw_template_string :: (fn(input : String, start : usize) -> String)({
  bytes := input.as_bytes();
  (index : usize) = (start + usize(1));
```

But `Token.character` is a CHARACTER index (`yo-self/lexer.yo:82` `char_idx := i`,
stored at every `tokens.push(Token(... character : char_idx ...))`).

For pure-ASCII input the two coincide, which is why this survived: every test
that would have caught it is ASCII. Once ANY multi-byte character appears
earlier in the file, `character < byte_offset`, so the slice starts EARLY and
the emitted "template" swallows the bytes preceding the backtick — producing the
`contains(` → `s(` / `contains(tains(` / `.Err(r(` shapes seen in the corpus.

## Scale — this is not an edge case

Em dashes are pervasive in this repo's doc comments.

- **23 of 40** sampled `std/` files containing a backtick become
  **non-parseable** after `yo-self fmt`.
- **774 of 922** captured differing lines in a full-corpus TS-vs-yo-self
  formatter comparison involve a backtick.
- Real corpus damage, all `rc=0`:

  ```
  std/encoding/html.yo:74   if(!(input.contains(`&`)), {   ->   if(!(input.contains(tains(`)), {
  std/encoding/html.yo:77   (result : String) = ``;        ->   (result : String) = ng) = `;
  <url>                     hostname.split(`.`)            ->   hostname.split(it(`)
  <toml>                    return(.Err(`Empty value`));   ->   return(.Err(r(`));
  ```

## Why this is a P1 blocker, not debt

`plans/SELF_HOSTING_COMPLETION.md` P2 retires `src/`, at which point the
self-hosted formatter becomes **canonical** and `fmt --check` becomes
self-referential. The first `yo fmt` after that point would silently destroy
every std file with an em dash and a template string, with nothing able to
notice — `rc=0`, and the only signal is that the codebase no longer parses.

It also means the `fmt` differential gate that §6 wants CANNOT be wired until
this is fixed: the gate would be measuring corruption, not style.

## Fix direction

Pass a real byte offset. Either

1. give `Token` a `byte_offset` field alongside `character` and use it at
   `formatter.yo:1460` (the lexer already walks the input, so it can record
   both), or
2. convert character index → byte offset at the call site.

(1) is preferable: any other consumer of `Token.character` that indexes bytes
has the same latent bug, so a correctly-named field makes the misuse visible.
**Audit every `t.character` use for byte-indexing before choosing.**

## Regression guard

An ASCII-only corpus cannot catch this. The test must contain a multi-byte
character:

- a `tests/` file with an em dash in a comment plus a backtick string, formatted
  by BOTH compilers and compared;
- and, once the corpus is clean, the `fmt` differential gate itself
  (`scripts/bootstrap/gates_fast.sh`, currently a placeholder note).
