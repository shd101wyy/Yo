# How token text stays shared once `String` is a value

**Kind:** design question. **Decided 2026-10-30: option 2, `Token.value : Rc(String)`** (Fable
consultation #1, verdict "TokenText", high confidence), and implemented on branch
`vbd/token-value-rc` (v0.2.74 window, after V2c and before B8). See "Verdict" and "Resolution"
below.

*Filed 2026-10-28 by the B8-prerequisites piece (VBD v0.2.73 window, PLAN §5a).*

## What was observed

The lexer shares token text in two ways, and both rely on a `String` copy being a handle copy:

- **The eight punctuation globals.** `src/lexer.yo`'s `g_tv_lparen` … `g_tv_semicolon` hold one
  `String` each, and every `(`, `)`, `[`, `]`, `{`, `}`, `,` and `;` token stores a copy of it
  (`value : g_tv_lparen`). This was added by `plans/EVALUATOR_MEMORY_REDUCTION.md` §0.23.
- **The intern table.** `src/token.yo`'s `intern_token_str` returns the table's canonical `String`
  (`.Some(canonical) => canonical`, a copy out of `HashMap.get`). Every identifier, keyword, dot and
  number token then shares one buffer, and `String ==` takes its pointer-and-length fast path.

B8 makes `String` a value (`String :: newtype(_bytes : ArrayList(u8))`), so neither copy can share
any more:

- The B8 flip probe (`~/Workspace/Yo-wt/vbd-logs/b8-frontier/FRONTIER.md` §3) reports the eight
  `value : g_tv_*` stores as E0901 records. Its unmask round wrote `.clone()` at each one.
- The probe reports nothing for `intern_token_str`, because its `HashMap.get` stand-in clones a
  `Clone` value. With B6's accessors the read becomes `get_cloned`, and that read deep-copies the
  key on every token. The interning stops working without any diagnostic.

The `.clone()` spelling has been measured. `plans/VALUES_BY_DEFAULT.md` (the B1 regression record,
diagnostic (e)) took `.clone()` at the eight lexer sites plus two `env.yo` key clones. Those ten
sites cost about 92 MB of max RSS on `check src/main.yo` (1.105x against 1.018x) and about 75 MB on
`check std/rand.yo`. Losing the intern table is not measured. §0.23's interning PR saved 44.7 MB on
its own, and it also supplies the pointer fast path that identifier compares depend on
(`issues/yo-self-compile-performance-rc-string-eq.md`).

The PLAN §5a piece did not change the `g_tv_*` sites. No spelling that is valid before the flip
keeps them shared after it, so only a change of `Token.value`'s type fixes them.

## Options

1. **`.clone()` at each site, and `get_cloned` in `intern_token_str`.** This needs no design work,
   but it brings back the measured regression and drops interning entirely.
2. **`Token.value : Rc(String)`**, following the `Token.input` and `Token.module_path` change in
   #1561. The intern table maps `String` to `Rc(String)`, and the `g_tv_*` globals become
   `Rc(String)`. A token copies a handle. After V2c that copy is `.clone()`, which only bumps the
   count. The token stays the same size, since both fields are one pointer. Readers spell
   `tok.value.*`, or rely on auto-deref once `SEED_VERSION` carries it; there are about 460
   `….value` token reads in `src/`. `String ==` on `.*` still takes the buffer-pointer fast path.
3. **An interned symbol id** (`u32` into one global table). This saves the most memory and is the
   largest change: every reader goes through the table, including diagnostics rendering
   (`EVALUATOR_MEMORY_REDUCTION.md` mentions this for identifier tokens).

## Recommendation

Take option 2 as a separate PR that lands before B8 and changes only the tree. It follows #1561's
pattern, which already shares `input` and `module_path`, and it needs nothing from a seed. Gate it
the way #1561 was gated:

- emit-diff;
- an ABBA run of `check src/main.yo` (instructions, cycles and RSS within the B-piece bars);
- the internal lexer and parser tests.

Option 1 is not acceptable for B8, because it would turn the flip into a memory regression of about
10% that nothing reports. Option 3 should wait until after VBD, if the RSS ratchet asks for it.

## Verdict

Option 2, as its own tree-only `src/` PR patterned on #1561 (which made `Token.input` and
`Token.module_path` `Rc(String)` cells):

- `Token.value` is an `Rc(String)`. The intern table is `RefCell(HashMap(String, Rc(String)))` and
  `intern_token_str` returns the canonical cell; a miss inserts one cell per DISTINCT text.
- The eight `g_tv_*` globals are `Rc(String)` cells and stay separate from the table: they exist to
  skip the per-punctuation-token hash (§0.23), so folding them into the table would re-pay it.
- `placeholder_token`/`raii_token` reuse their `g_placeholder_token_text`/`g_raii_token_text` cells
  for `value` too.
- `ast_expr_text` returns `Rc(String)` (one count bump). A borrow returned through the `Token` waits
  for decision 43 steps 2 and 3 to define origins for returned references.
- Readers spell `tok.value.*` and `&tok.value.*`, the rule the `Token` doc comment already states for
  `input`/`module_path`, rather than relying on auto-deref. `Eq(Rc(T))` takes an `Rc` right-hand
  side, so a compare against text is `tok.value.* == "x"`.
- A handle copy is `Rc.clone(tok.value)`; an owned copy is `tok.value.*.clone()`. `tok.value.clone()`
  is E0616 (decision 32: `clone` is a method of both `Rc(String)` and its payload), and a bare
  `tok.value` copy is E0901 since V2c, so each former `tok.value.clone()` site says which one it means.
- `Variable.name` and the other id `String` fields are NOT widened here (follow-up F7, with its own
  measurement).

Rejected: option 1 (the measured ~92 MB regression, and interning silently lost with the `String ==`
pointer fast path); a span/borrowed representation (string, char and template tokens hold DECODED
text, synthesized tokens have no source, a `value` borrowing the token's own `input` is
self-referential, and Yo has no borrowed string-slice type); a `Symbol` id now (the largest change;
it needs an LSP/`--watch` purge story first, and is the post-VBD end state built on this table).

## Resolution

Implemented on `vbd/token-value-rc`. `tests/internal/parser.test.yo` "same-text tokens share one
interned value cell" makes a silent loss of interning loud: same-text identifier, operator and
number tokens from one `tokenize` and from two separate `tokenize` calls hold the same `value` cell
(`__yo_ptr_eq`), and so do two `(` tokens. The measurements are in the PR body.
