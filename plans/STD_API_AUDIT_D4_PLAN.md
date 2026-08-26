# D4 — String indexing model: the executable migration plan

> **Status:** **PRs 1-3 LANDED 2026-08-26** (PR 2 got a skeptical review pass on
> the same branch that added §5.2 **S11**; **PR 3 got one too — it found one
> live regression the flip introduced, `_capitalize_last_segment`, §5.1's last
> row, and one contract hole, the empty needle, §1.4. Both are fixed on the
> same branch; the review's full method and measurements are §6.1.2**);
> **PR 6 LANDED 2026-08-26** (regex — `RegexMatch.index()` is a byte index,
> all six basis-conversion walks deleted; §4 row 6 and §5.3 carry the
> corrections to the plan's counts); **PRs 4-5 (the ImmString flip + rename),
> 7 (comptime basis) and 8 (docs sweep) LANDED 2026-08-26** — see their §4
> rows; PR 9 still PLAN.
> **PR 3 was the flip.** `String` is byte-indexed from here on; the numbers in
> §0/§2/§3 below are the pre-flip survey and are kept as the historical record
> of what the migration measured, not as a description of the tree today.
> (Survey complete 2026-08-25.)
> **Parent decision:** `plans/STD_API_AUDIT.md` §3 **D4** + §8 **O1** —
> `String` goes byte-indexed like Rust/Go. Scope extended (user, 2026-08-25)
> to `std/imm/string` and the `imm.String` → `ImmString` rename.
> **This document does not re-open the decision.** It measures the blast
> radius, names the silent failure modes, and sequences the landing.

Every number below is `grep`-derived from the tree at `develop`
(`3870d24d2`); the exact patterns are given so they can be re-run. Anything
that could not be measured is marked **UNMEASURED**, not estimated silently.

---

## 0. Executive numbers

| | |
| --- | --- |
| Public methods whose meaning changes **silently** (same signature) | **13** on `String`, **1** on `imm.String`, **5** on the `Pattern` trait, **1** on `RegexMatch` |
| Methods that change with a **compile error** (safe) | **0** — this is the whole problem |
| `substring` call sites (std/src/tests/vendor) | 24 / 147 / 21 / 2 = **194** |
| `index_of` + `last_index_of` call sites | 13 / 29 / 39 / 0 = **81** |
| `String`-typed `.len()` call sites (heuristic lower bound) | 83 / 508 / 352 / 19 = **962** (see §2.2 for the method and its error bars) |
| Call sites that pass the optional `position`/`from_index` argument | **20 repo-wide** — the positional parameters are nearly dead |
| Sites classified ASCII-invariant in the `src/` sample | **~84 %** of `substring` sites |
| **Latent bugs D4 FIXES for free** | **7 confirmed** (§5.1) |
| **Sites D4 BREAKS that must be migrated first** | **~35 confirmed** (§5.2) |
| Tests repo-wide that combine multibyte content with an index-basis API | **~30** — the entire safety net (§6.2) |

---

## 1. The current contract, per method

### 1.1 `std/string/string.yo` — `String`

Basis legend: **B** = byte, **C** = character/rune, **—** = no index in the
contract.

| Method | line | basis TODAY | basis after D4 | change class |
| --- | --- | --- | --- | --- |
| ~~`len()`~~ | 126 | **C**, O(n) | **B**, O(1) | ✅ **LANDED PR 3** |
| ~~`at(index) -> Option(rune)`~~ | 311 | **C** | **B** — O1a option (i), `.None` at a continuation byte | ✅ **LANDED PR 3** |
| ~~`substring(start, end)`~~ | 497 | **C** | **B** | ✅ **LANDED PR 3** |
| ~~`slice_copy(Range)`~~ — the `s(a..b)` sugar | 485 | **C** (delegates to `substring`) | **B** | ✅ **LANDED PR 3** |
| ~~`slice_copy_inclusive(RangeInclusive)`~~ | 489 | **C** | **B** | ✅ **LANDED PR 3** |
| ~~`index_of(p, from_index?) -> Option(usize)`~~ | 1690 → `_index_of_impl` 555 | **C** in *and* out | **B** in and out | ✅ **LANDED PR 3** |
| ~~`last_index_of(p, from_index?)`~~ | 1693 → 769 | **C** | **B** | ✅ **LANDED PR 3** |
| ~~`contains(p, from_index?)`~~ | 1687 → 651 | **C** (`from_index` only) | **B** | ✅ **LANDED PR 3** |
| ~~`starts_with(p, position?)`~~ | 1681 → `_has_prefix` 883 | **C** — *and buggy*, see §1.3 | **B** | ✅ **LANDED PR 3** — §1.3(a) fixed by construction |
| ~~`ends_with(p, end_position?)`~~ | 1684 → `_ends_with_impl` 966 | **C** (`self.len()` char length) | **B** | ✅ **LANDED PR 3** |
| ~~`Pattern.is_prefix_of / is_suffix_of / is_contained_in / index_in / last_index_in`~~ | 1621-1625 | **C** | **B** | ✅ **LANDED PR 3** — all 5 documented as bytes |
| ~~`bytes_len()`~~ | 464 | **B** | **B** — now `self.len()` | ✅ **LANDED PR 3** as a deprecated alias |
| `byte_at(index) -> u8` | 470 | **B** | **B** | ✅ unchanged |
| `Index(usize) -> u8` | 2402 | **B** | **B** | ✅ unchanged |
| `chars() -> StringChars` | 1812 | — | — | ✅ unchanged |
| `bytes() -> StringBytes` | 1818 | — | — | ✅ unchanged |
| `into_iter()` | 1824 | — | — | ✅ unchanged |
| `lines() -> StringLines` | 1910 | — (byte-internal) | — | ✅ unchanged |
| `split(p)` | 1696 → `_split_impl` 662 | — (byte-internal; empty-separator arm uses `substring` per char) | — (empty-separator arm must keep **C**) | 🟡 one arm needs pinning, §5.2-S5 |
| `replace` / `replace_all` | 1056 / 1162 | — | — | ✅ unchanged |
| `trim` / `trim_start` / `trim_end` | 1318 / 1360 / 1405 | — (byte-internal, ASCII whitespace) | — | ✅ unchanged |
| `to_uppercase` / `to_lowercase` / `concat` / `repeat` / `join` | | — | — | ✅ unchanged |
| ~~`char_len()`~~ | 1840 | — | **C**, O(n) | ✅ **LANDED PR 1** |
| ~~`char_indices()`~~ | 1872 | — | yields `IterPair(byte_offset, rune)` | ✅ **LANDED PR 1** |
| ~~`is_char_boundary(i)`~~ | 1879 | — | **B** | ✅ **LANDED PR 1** |
| ~~`floor_char_boundary(i)`~~ | 1903 | — | **B** | ✅ **LANDED PR 1** |
| ~~`ceil_char_boundary(i)`~~ | 1930 | — | **B** | ✅ **LANDED PR 1** |
| ~~`try_substring(a, b)`~~ | 1961 | — | **B**, `Option(String)` | ✅ **LANDED PR 1** |
| ~~`char_substring(start, end)`~~ | 497 | — | **C** — holds `substring`'s CURRENT body verbatim; `substring` is now a one-line delegation to it, which is PR 3's insertion point | ✅ **LANDED PR 2** |
| ~~`truncate_chars(max_runes)`~~ | 2013 | — | **C**, `char_substring(0, n)` | ✅ **LANDED PR 2** |

**Was verified absent before PR 1:** `grep -rn "char_indices\|char_len" std/`
returned only unrelated locals in `std/regex/index.yo` and
`std/string/string.yo:978`. PR 1 added all six names on `String` and on
`imm.String` (plus `imm.String.chars()`); the `std/regex/index.yo` hits are
still unrelated locals.

**PR 1's yield type is `IterPair(usize, rune)`** (the prelude's positional pair,
`std/prelude.yo:8368`), not a bare tuple — Yo has no tuple literal, and
`IterPair` is what `enumerate`/`zip` already yield. Destructure it as
`p._0` / `p._1`.

### 1.2 `std/imm/string.yo` — `imm.String`

| Method | line | basis TODAY | after D4 | change class |
| --- | --- | --- | --- | --- |
| ~~`len()`~~ | 83 | **C**, O(n) | **B**, O(1) (`self._len`) | ✅ **LANDED PR 4** |
| ~~`bytes_len()`~~ | 79 | **B** | ~~fold into `len()`; keep as deprecated alias~~ **DELETED in PR 4** — re-measured: zero consumers outside `std/imm/string.yo` itself + `tests/imm_string.test.yo`, so the alias would have shipped dead (see the §4 row) | ✅ **LANDED PR 4** |
| `slice(start, end)` | 199 | **B** | **B** | ✅ already right |
| `index_of(needle, from_index)` | 255 | **B** | **B** | ✅ already right |
| `byte_at(index)` | 116 | **B** | **B** | ✅ |
| ~~`at(index) -> Option(rune)`~~ | 577 | **C** | **B** (mirror `String.at`) | ✅ **LANDED PR 4** |
| `starts_with` / `ends_with` / `contains` | 217/235/286 | no position arg | — | ✅ |
| `split` / `trim*` / `replace*` / `repeat` | | — | — | ✅ |
| ~~`chars()` / `char_indices()` / `char_len()`~~ | 672/676/683 | — | new | ✅ **LANDED PR 1** |
| ~~`is_char_boundary` / `floor_char_boundary` / `ceil_char_boundary` / `try_substring`~~ | 707/723/747/773 | — | **B** | ✅ **LANDED PR 1** |

The audit's claim that "applying D4 to `imm.String` is SMALL" is **confirmed**:
one silent flip (`len()`), one alias fold, one `at()` alignment, three additions.

### 1.3 Two contract defects found while tabling (report these, don't inherit them)

**(a) `starts_with(prefix, position)` was broken for multibyte haystacks.**
**FIXED BY CONSTRUCTION in PR 3** — byte indexing deletes the walk below rather
than repairing it, and `tests/string/string_byte_index.test.yo`'s
"starts_with position is a byte offset — the 1.3(a) fix" pins it. The
description that follows is the pre-flip state.
`_has_prefix` (`std/string/string.yo:883`) advances with

```rust
while((byte_index < self_bytes) && (char_index < position), byte_index = (byte_index + usize(1)), {
  ... is_start => char_index = (char_index + usize(1));
});
```

The counter increments when it *sees* a lead byte, then the loop steps one
byte. For `"你好"` and `position = 1` it exits at `byte_index = 1` — the middle
of `你`, not byte 3. So `position` is neither a clean char index nor a byte
index; it is a **broken char walk**. `_index_of_impl`'s `from_index` skip loop
(line 572) has the identical shape and the identical defect.
`STD_API_AUDIT.md` D4 describes this as "`starts_with(position)` is
byte-indexed" — **that row is misstated**; see §7.

**(b) A third string type already disagrees, and the audit's table omits it.**

| | `len()` | slice | element access |
| --- | --- | --- | --- |
| `str` (`std/prelude.yo:5756, 5772`) | **BYTES** | `slice_copy` **BYTES** | `bytes(i)` → `u8` |
| `String` (`std/string`) | CHARS | `substring` CHARS | `Index` → `u8` (**bytes**) |
| `imm.String` | CHARS | `slice` **BYTES** | `byte_at` **BYTES** |
| `StringBuilder` (`std/string/string_builder.yo:45`) | **BYTES** | — | — |

`str` and `StringBuilder` are *already* byte-based. D4 does not introduce a new
convention — it makes `String` agree with the two types it interoperates with
most. That is a stronger argument for the change than the one in the audit.

### 1.4 Sub-decisions this plan needs and the audit does not settle

> **SETTLED IN PR 3 (2026-08-26):** O1a took option (i) — `at(byte_index)`
> decodes the rune STARTING at that byte and answers `.None` at a continuation
> byte, past the end, or on bytes that do not decode (its body is now just
> `self._decode_rune_at(index)`). O1b took the recommendation as written:
> out-of-range CLAMPS, a NON-BOUNDARY index panics in `substring`,
> `try_substring` is the non-panicking form, and `floor_char_boundary` /
> `ceil_char_boundary` are the arithmetic helpers — all four stated in
> `substring`'s own doc comment. **The search methods are NOT boundary-checked
> and deliberately so:** UTF-8 is self-synchronizing, so a valid-UTF-8 needle
> can never match starting at a continuation byte, which means a mid-rune
> `from_index` / `position` / `end_position` cannot invent a hit and simply
> answers `false` / `.None`. **That argument has exactly one hole, found in the
> skeptical review (2026-08-26) and now documented on the two methods it
> affects: the EMPTY needle matches everywhere.** `index_of(``, i)` answers
> `.Some(i)` verbatim, so it is the one search result that can be a
> continuation byte or past `len()` — feed THAT to `substring` and it panics.
> `last_index_of(``, i)` answers `len()` regardless of `i`, exceeding the cap
> the caller asked for. Both are pre-D4 behaviours carried over unchanged (only
> the unit moved, rune→byte); what was new in PR 3 was the doc comments'
> universally-quantified claim that "every index this returns is a rune
> boundary", which was false. Docs corrected, behaviour untouched, and
> `tests/string/string_byte_index.test.yo` pins it. ~~O1c is unchanged: comptime stays pinned to
> `char_len`/`char_substring` (S10) and is PR 7's to align.~~ **O1c SETTLED IN
> PR 7 (2026-08-26): comptime is byte-based** — indices are byte offsets
> everywhere; `s[i]` yields the rune starting at byte `i` as a 1-rune `StrLit`
> (the result-TYPE split against runtime's `u8` is kept deliberately); a
> mid-rune offset is a compile error where the runtime `substring` panics.
> See the §4 PR 7 row.

- **O1a — what does `at()` mean after the flip?** Options: (i) `at(byte_index)`
  decodes the rune starting at that byte (Rust's `s[i..].chars().next()`),
  panic/`.None` on a non-boundary; (ii) keep char semantics and rename to
  `char_at()`. **Recommendation: (i)**, with `char_indices()` as the ergonomic
  replacement for `at()`-in-a-loop. `char_at` was measured to have **0 call
  sites repo-wide** (`grep -rc "\.char_at("` → 0 everywhere), so the name is free
  either way.
- **O1b — non-boundary index policy.** Rust panics. Yo's `substring` currently
  *clamps* out-of-range. **Recommendation:** keep clamping for out-of-range,
  add `__yo_panic` for a **non-boundary** index (that is a programmer error,
  not a range condition), and ship `floor_char_boundary` / `ceil_char_boundary`
  + a non-panicking `try_substring -> Option(String)` in the same PR.
- **O1c — comptime string basis.** `comptime_str` `len()`/`slice`/`s[i]` are
  implemented in the compiler (`src/evaluator/builtins/comptime_string_fns.yo`,
  `comptime_index_fns.yo`, `src/evaluator/calls/index_trait.yo`) **on top of
  `String.substring`**, so they flip *automatically* unless deliberately
  pinned. Note the era split that already exists: comptime `s[i]` yields a
  **1-char `StrLit`** while runtime `s[i]` yields a **`u8` byte**. D4 forces a
  decision. **Recommendation:** pin comptime to char semantics in PR 2 so the
  flip is not silent, then align it in its own PR (§4, PR 7).

---

## 2. The blast radius, counted

### 2.1 Exact counts — unambiguous method names

Pattern used (run from the repo root):

```bash
for d in std src tests docs/en-US docs/zh-CN .github vendor/markdown_yo; do
  for m in substring index_of last_index_of char_at byte_at bytes_len slice_copy; do
    echo "$d .$m( $(grep -rn "\.$m(" "$d" | wc -l)"
  done
done
```

| method | `std` | `src` | `tests` | `docs/en-US` | `docs/zh-CN` | `.github` | `vendor/markdown_yo` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `.substring(` | 24 | **147** | 21 | 0 | 0 | 0 | 2 |
| `.index_of(` | 11 | 22 | 31 | 0 | 0 | 1 | 0 |
| `.last_index_of(` | 2 | 7 | 8 | 0 | 0 | 0 | 0 |
| `.char_at(` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `.byte_at(` | 39 | 47 | 13 | 0 | 0 | 4 | 0 |
| `.bytes_len(` | 14 | 10 | 27 | 0 | 0 | 0 | 0 |
| `.slice_copy(` (incl. defs/comments) | 2 | 12 | 0 | 0 | 0 | 0 | 0 |
| `.starts_with(` | 5 | **194** | 56 | 0 | 0 | 0 | 0 |
| `.ends_with(` | 3 | 82 | 59 | 0 | 0 | 0 | 0 |
| `.contains(` | 20 | 143 | 344 | 2 | 0 | 0 | 0 |
| `.at(` | 11 | 2 | 88 | 0 | 0 | 0 | 0 |
| `.as_bytes()` | 55 | 126 | 17 | 0 | 0 | 3 | 23 |

`.contains(` / `.starts_with(` / `.ends_with(` counts include `HashSet` /
`ArrayList` / `Path` receivers and **do not** all change: those three only
change when the optional position argument is supplied. Measured:

```bash
grep -rn "\.index_of(" "$d" | grep -E "\.index_of\([^)]*,[^)]*\)"   # etc.
```

| positional form | `std` | `src` | `tests` | `vendor` |
| --- | ---: | ---: | ---: | ---: |
| `starts_with(p, position)` | 0 | 0 | 1 | 0 |
| `ends_with(p, end_position)` | 0 | 0 | 0 | 0 |
| `contains(p, from_index)` | 0 | 0 | 6 | 0 |
| `index_of(p, from_index)` | 4 | 7 | 2 | 0 |
| `last_index_of(p, from_index)` | 0 | 0 | 0 | 0 |

**Total 20 sites repo-wide.** The `position` parameters carry almost no
traffic — which is why defect §1.3(a) went unnoticed. The blast radius of
`index_of` is in its **return value**, not its argument.

`.slice_copy(` — call sites only, `String` receivers only (the rest are
`ArrayList` / `str`): `src/evaluator/memory_safety.yo:139,145,168,197` and
`src/lexer.yo:158,163,180` = **7**. Range sugar (` .. ` spaced form) totals
std 15 / src 18 / tests 69 / vendor 1, of which the `String` receivers are the
7 above plus `tests/index.test.yo:320,321` (a comptime string).

### 2.2 `.len()` — the big one, and how it was bounded

`grep -rn "\.len()"` returns matching **lines**: std 418 / src 4055 /
tests 996 / docs 24+20 / .github 17 / vendor 113. Counting `X.len()`
**occurrences** with an identifier receiver (the basis for the table below)
gives std 432 / src 4108 / tests 990 / docs 21+17 / .github 16 / vendor 90.
Either way `ArrayList`, `HashMap`, `str`, `StringBuilder`,
`Vec`, `Deque` … all define `len()`. Two independent narrowings were run:

**(i) Receiver-typing heuristic** (throwaway script, not committed — the
recipe below is the spec): for each file, seed a set of
identifiers that appear with a `String`-only method
(`substring|starts_with|ends_with|to_lowercase|to_uppercase|trim*|push_str|push_string|concat|last_index_of|bytes_len|byte_at|chars|parse_*|replace_all`),
plus identifiers declared `name : String` in the file, plus any field name
declared `name : String` **anywhere in the tree**; then count `X.len()` whose
receiver (or last dotted segment) is in that set.

| dir | total `.len()` | `String`-typed | share |
| --- | ---: | ---: | ---: |
| `std` | 432 | **83** | 19.2 % |
| `src` | 4108 | **508** | 12.4 % |
| `tests` | 990 | **352** | 35.6 % |
| `docs/en-US` | 21 | 5 | 23.8 % |
| `docs/zh-CN` | 17 | 5 | 29.4 % |
| `.github` | 16 | 2 | 12.5 % |
| `vendor/markdown_yo` | 90 | 19 | 21.1 % |

**(ii) Manual sample.** Every 68th `.len()` line in `src` (60 lines) was hand
classified: ~10 `String` receivers → **16.7 %**, 95 % CI ≈ [8 %, 26 %].

The heuristic is a **lower bound** (it misses receivers that never appear with
a `String`-only method in the same file, e.g. `head.len()`, `en_name.len()`)
and has false positives in `tests/imm_*` (generic field names). Take **508 as
the floor for `src` and ~680 as the point estimate**; the honest statement is
`src` has **500–1050** `String.len()` sites. This is the single largest
mechanical surface in the migration and the reason PR 2 (§4) exists.

### 2.3 Highest-density files — where the bugs will be

`substring` (`grep -rc "\.substring(" <dir> | grep -v ":0$" | sort -t: -k2 -rn`):

| `src` | | `std` | | `tests` | |
| --- | ---: | --- | ---: | --- | ---: |
| `src/main.yo` | 28 | `std/encoding/html.yo` | 6 | `tests/string/string.test.yo` | 18 |
| `src/install_command.yo` | 16 | `std/http/http.yo` | 5 | `tests/internal/gc_runtime_atomics.test.yo` | 2 |
| `src/doc/builder.yo` | 12 | `std/encoding/toml.yo` | 4 | `tests/internal/formatter.test.yo` | 1 |
| `src/lsp/completion.yo` | 7 | `std/string/string.yo` | 3 | | |
| `src/doc/extractor.yo` | 7 | `std/path.yo` | 2 | | |
| `src/doc_command.yo` | 6 | `std/http/client.yo` | 2 | | |

`String`-typed `.len()` density (heuristic): `src/main.yo` 50/153,
`src/doc/builder.yo` 28/101, `src/lsp/completion.yo` 24/66,
`src/codegen/exprs/async.yo` 18/95, `src/install_command.yo` 15/22,
`std/string/string.yo` 21/60, `std/http/client.yo` 6/7, `std/fmt/spec.yo` 5/6,
`std/encoding/html.yo` 3/3, `tests/string/string.test.yo` 83/87.

**The four files to review line-by-line:** `std/encoding/html.yo`,
`std/fmt/spec.yo`, `src/lsp/completion.yo`, `src/parser.yo` (`_peel_spec`).
They are where char semantics is *load-bearing on non-ASCII input*.

### 2.4 `imm.String` and the `ImmString` rename — measured tiny

```bash
grep -rn "imm/string" std src tests docs .github vendor
```

- **Zero** `std/` modules import `std/imm/string` (only `std/imm/string.yo`
  itself imports `../string`).
- **Zero** `src/` consumers.
- ~~Three~~ **FOUR** test files (re-measured in PR 4, 2026-08-26 — this row had
  missed one): `tests/imm_string.test.yo`, `tests/imm_vec.test.yo`,
  `tests/imm_map.test.yo` (line 4, the one this plan missed) and
  `tests/imm_threading.test.yo` — the last already writes
  `{ String : ImmString } :: import("std/imm/string")` (line 19), i.e. the
  rename is what consumers already do by hand.
- Docs: `docs/{en-US,zh-CN}/IMMUTABLE_COLLECTIONS.md` lines 24, 57, 109, 155.

The rename is a **~15-line PR**. Do it standalone.

### 2.5 Docs / instructions surface

Only three places state the current contract in prose:

| file | line | disposition |
| --- | ---: | --- |
| `.github/skills/yo-syntax/syntax-cheatsheet.md` | 1456-1475 | **Whole section inverts.** Currently: "`len()`/`substring`/`index_of` are RUNE-based … never mix". After D4 the rule becomes "everything is bytes; use `chars()`/`char_indices()`/`char_len()` for runes". **DONE — PR 3 inverted it, PR 8 (2026-08-26) reworked the rune vocabulary onto the iterator idioms (`chars().count()`, `char_indices().nth`) per the newer no-char-indexed-slicing decision.** |
| `.github/skills/yo-syntax/syntax-cheatsheet.md` | 995 | "Width counts CHARACTERS" — **stays true** only if `std/fmt/spec.yo` is pinned to `char_len()` (§5.2-S2). |
| `docs/{en-US,zh-CN}/INDEX_TRAIT.md` | 236 | already says `Index` returns a byte — **stays correct**. |
| `docs/{en-US,zh-CN}/DESIGN.md` | 1397 / 1389 | "`chars()` (rune iteration) / `bytes()` (byte iteration)" — **stays correct**, extend with `char_indices()`. **DONE in PR 8 (2026-08-26)**, plus the byte contract, `chars().count()` and a STRINGS.md link; `INDEX_TRAIT.md` also gained the link, and `docs/{en-US,zh-CN}/STRINGS.md` are the new full-contract pages. |

No `docs/**` file calls `substring`/`index_of`/`len` on a `String` in an
example (`grep -rn "\.substring(\|\.index_of(" docs/` → 0). The doc cost is
**one rewritten cheatsheet section plus two DESIGN.md paragraphs in both
languages**, not a sweep.

---

## 3. Which call sites are actually ASCII-only

**Method.** All 147 `src/` `substring` sites were dumped
(`grep -rn "\.substring(" src`) and classified by what the receiver holds.
Verdicts: **INVARIANT** = byte and char indices coincide, or both ends of the
slice move together so the result is unchanged; **RISK** = an index from a
different basis, or a fixed cut into arbitrary text.

The dominant idiom is `x.substring(K, x.len())` with `K` the length of an
**ASCII literal prefix** — that is INVARIANT under the flip because `K` and
`x.len()` are both re-based together.

### 3.1 Sample — 50 real sites, classified

**INVARIANT — compiler-internal ASCII (identifiers, keywords, C text, flags):**

| site | code | why |
| --- | --- | --- |
| `src/lexer.yo:158` | `op_str.slice_copy(k .. (k + usize(2)))` | operator run; the closed operator set is ASCII (the comment at `:152` says so) |
| `src/lexer.yo:163` | `op_str.slice_copy(k .. (k + usize(1)))` | ditto |
| `src/lexer.yo:180` | `op_str.slice_copy(k .. (k + tok_len))` | ditto |
| `src/codegen/exprs/match.yo:852` | `variant_name.substring(usize(1), …)` | strip leading `.` from a Yo variant name |
| `src/codegen/types/generation.yo:253` | same shape | ditto |
| `src/codegen/utils/index.yo:1295` | same shape | ditto |
| `src/codegen/exprs/other_fn_call.yo:733` | same shape | ditto |
| `src/codegen/exprs/comptime_value.yo:272` | same shape | ditto |
| `src/evaluator/builtins/build.yo:867` | same shape | ditto |
| `src/evaluator/calls/numeric_type.yo:97` | `variant.substring(usize(1), …)` | ditto |
| `src/codegen/exprs/async.yo:366` | `last.substring(usize(0), usize(1)).to_uppercase()` | capitalize a C identifier segment |
| `src/codegen/exprs/async.yo:367` | `last.substring(usize(1), last.len())` | ditto |
| `src/codegen/exprs/cond.yo:787` | `current_indent.substring(0, len-2)` | indentation spaces |
| `src/codegen/async/state_code_gen.yo:2581` | `current_indent.substring(0, new_len)` | ditto |
| `src/emitter.yo:86` | `line.substring(ns, eq)` | `ns`/`eq` from `index_of` on a generated C decl — both ends re-base together |
| `src/emitter.yo:140` | same | ditto |
| `src/evaluator/values/impl.yo:637` | `name.substring(usize(0), pidx)` | `pidx` from `index_of` on a type name |
| `src/evaluator/builtins/comptime_numeric_fns.yo:380` | `fn_name.substring(prefix_len, …)` | builtin function name |
| `src/evaluator/exprs/import.yo:86` | `module_path_to_import.substring(usize(4), …)` | strips `"std/"`; tail moves with it |
| `src/target.yo:239` | `triple.substring(usize(5), …)` | target triple |
| `src/fetch.yo:401` | `commit.substring(usize(0), usize(12))` | hex sha |
| `src/version.yo:70,89,97,98,99` | semver splits | digits + `.` |
| `src/pkg_config.yo:92,117,120` | `flag.substring(usize(2), flag.len())` | strips `-I`/`-L`/`-l`; tail moves with it even if the path is non-ASCII |
| `src/main.yo:1385,1389,1393,1397,1401` | `a.substring(usize(2), a.len())` | CLI short flags |
| `src/main.yo:2992,3038,3141` | `arg.substring(usize(13), arg.len())` | `--build-file=` prefix |
| `src/main.yo:1712,1715,1718,1721` | `c_base.substring(0, len-N)` | strip `.test`/`.yo`/`.c` extensions |
| `src/main.yo:109,112` | `raw.substring(usize(1), n - usize(1))` | strip the ASCII `"` delimiters of a `StrLit` |
| `src/install_command.yo:194,507` | `X.substring(prefix.len(), X.len())` | both ends re-base together |
| `src/doc/extractor.yo:95,96,101,118,119,124,148` | strip `///`, `//!`, `/**`, `*/`, `* ` | ASCII prefix, `.len()` tail |
| `src/doc/builder.yo:811,813,816,817,830,833,843,846,849` | same doc-comment prefix strips | ditto |
| `src/lock_file.yo:53,118,119` | quote strip + `key = value` split on `index_of` | ditto |

**RISK — must be migrated (see §5.2 for the fix):**

| site | code | verdict |
| --- | --- | --- |
| `src/parser.yo:545` | `text.substring(usize(0), k - usize(1))` | `k` is a **rune** index into an `ArrayList(rune)` built at `:517-519` from `text.chars()` — **BREAKS** on any non-ASCII template string |
| `src/parser.yo:546` | `text.substring(k, tn)` | same |
| `src/doc/builder.yo:235` | `end_tok.input.substring(start, end)` with `start = start_tok.character` | `Token.character` is a **rune** index (`src/lexer.yo:100`) — **BREAKS** |
| `src/doc/render_html.yo:406` | `result.substring(usize(0), usize(120))` | fixed cut into arbitrary doc text → **splits a codepoint**, emits invalid UTF-8 |
| `src/lsp/completion.yo:875` | `line_text.substring(usize(0), cur)` where `cur` = LSP `character` | already mixed (clamped against `bytes.len()`); after the flip the substring is bytes and `cur` is not — **STILL BROKEN** |
| `src/lsp/completion.yo:1010` | `line_text.substring(ws, cur)` | same |
| `src/lsp/completion.yo:762,771,772,780,840` | offsets derived from `up_to_cursor` | downstream of the above |
| `src/error.yo:43` | `caret_col := token.column + (token.value.len() / usize(2))` | mixes a **rune** column with a token-value length; after the flip the length is bytes → caret drifts |
| `src/evaluator/builtins/comptime_index_fns.yo:781,862` | comptime `s[i]` / `s(a..b)` | comptime language semantics ride on `substring` (O1c) |
| `src/evaluator/calls/index_trait.yo:804,865` | same, other path | ditto |
| ~~`src/doc_command.yo:223,231,235,242,253`~~ **RESOLVED INVARIANT (PR 2)** | `content.substring(j, j + usize(1))` char-at-a-time scan of `build.yo` text | **Reviewed 2026-08-26: single-basis and self-consistent, so it is INVARIANT, not RISK.** Every index in `_scan_quoted_value_after` comes from `content.index_of(...)` or `marker.len()`, both in the SAME basis as the `substring` that consumes them, and `content.len()` bounds the same walk. The only comparisons are 1-unit slices against ASCII delimiters (space, tab, CR, LF, `:`/`=`, `"`), which simply fail to match on any interior byte of a multibyte rune — and the loops those comparisons drive only SKIP whitespace, so advancing by a byte instead of a rune reaches the same place. Not migrated. |
| `src/pkg_config.yo:57,65` | `s.substring(start, k)` with `k` walking `bytes.len()` | **LIVE BUG TODAY** (§5.1) |
| `src/install_command.yo:60,66` | `substring(…, s.bytes_len())` | **LIVE BUG TODAY** (§5.1) |
| `src/main.yo:802` | `p.substring(usize(0), usize(last_sep))` | `last_sep` is a **byte** index from the `byte_at` loop at `:792` — **LIVE BUG TODAY** |

### 3.2 The fraction, stated honestly

Of the **147** `src/` `substring` sites: **~124 INVARIANT**, **~18 RISK**,
**~5 REVIEW** → **≈ 84 % ASCII-invariant**. The `src/` risk is therefore
concentrated in **~23 sites in 9 files**, all named above.

`std/`'s ratio is *worse*, not better: of 24 sites, `std/encoding/html.yo` (6
sites plus 11 `at()` calls) and `std/fmt/spec.yo` (1 site, plus the width
computation) are precisely the code whose input is arbitrary human text.
**`std/` is 24 sites but carries more than half the real risk.**

**UNMEASURED:** `std/http/http.yo` (5), `std/http/client.yo` (2),
`std/encoding/toml.yo` (4), `std/fs/dir.yo` (1), `std/path.yo` (2) were not
individually classified. Header/TOML/path values can be non-ASCII; assume RISK
until reviewed.

---

## 4. The ordering — landable PRs, green in between

The key move is **PR 2**: rewrite every char-semantics-dependent site to a new
`char_*` API *while the old basis still holds*, so that PR 2 is a provable
no-op and PR 3 only has to change definitions.

| PR | content | gate |
| --- | --- | --- |
| ~~**0**~~ **LANDED** (#286) | `std/encoding/utf8.yo`. Primitives: `seq_len(lead: u8) -> usize`, `decode(bytes, i) -> Option((rune, usize))`, `encode(r, out)`, `is_char_boundary(bytes, i)`, `validate`. **Dependency:** PR 1 and PR 6 both consume it; PR 2 does not. | `yo check ./std`; new `tests/encoding/utf8.test.yo` |
| ~~**1**~~ **LANDED 2026-08-26** | **Additive only.** `String.char_len()`, `String.char_indices()`, `String.is_char_boundary()`, `floor_char_boundary`, `ceil_char_boundary`, `try_substring`. Same six on `imm.String`, plus `imm.String.chars()`. Built on `std/encoding/utf8` (PR 0), no second decoder. New `tests/string/string_char_api.test.yo` (17 tests) + 6 tests appended to `tests/imm_string.test.yo`, all multibyte. | achieved: `yo check ./std` 153/153; `tests/string/string_char_api` 17/17, `tests/imm_string` 34/34, `tests/string/string` 253/253, `imm_map`/`imm_vec`/`imm_threading` green; 0 `Failed to transpile` in both kept batches; emitted-C **equivalence** measured as below (literal byte-identity is unattainable — see the correction under §6.1) |
| ~~**2**~~ **LANDED 2026-08-26** | **Pin char semantics, no basis change.** Done: `std/encoding/html.yo` onto a `char_indices()` rune table (S1); `std/fmt/spec.yo` width/precision/numeric-total onto `char_len()` + the new `truncate_chars` (S2); `std/string/string.yo` `_split_impl`'s empty-separator arm onto `char_len`/`char_substring` (S5); `src/parser.yo:_peel_spec` onto `char_indices()` + `try_substring` (S4); `src/doc/render_html.yo` onto `char_len`/`truncate_chars` (S6); `src/error.yo:43` onto `char_len()` (S7); all 10 comptime-string-builtin sites onto `char_len`/`char_substring` (S10, O1c). Two additive helpers were needed and added: `char_substring` (the rune-indexed slice, holding `substring`'s CURRENT body verbatim — `substring` is now a one-line delegation to it) and `truncate_chars`. **NOT done here, and why:** S8 (`src/doc/builder.yo`) needs `Token.byte_offset`, S9 (`src/lsp/completion.yo`) needs the UTF-16 work — both are PR 3 by §5.4; S3 (regex) is PR 6. | achieved: `yo check ./std --std-path <tree>/std` 153/153; every touched `src/` file `check`s clean; `tests/encoding/html` 12/12 (was 8), `tests/format_specs` 13/13 (was 7; 12 as PR 2 committed it), `tests/string/string_char_api` 21/21 (was 17), `tests/string/string` 253/253, `tests/template_string_specs` 6/6, `tests/imm_string` 34/34, `string_builder` 21/21, `rune` 36/36. Behavioural gate: a 862-line multibyte probe over `decode_html` / `FormatSpec.pad` / `pad_numeric` / `split("")` / the rune vocabulary hashes **`828549f0f0a9bdf747692bc872f018499a53435f518741fe055742d8561105e3` before AND after** the migration. Emitted C is NOT identical and cannot be — see the §6.1 correction extension below. **Review pass 2026-08-26 (same branch) added §5.2 S11** — 11 more rune-column sites in `formatter`/`lsp`/`doc` that PR 2 as first committed had missed — plus a real `pad_numeric` multibyte test (the one it shipped was vacuous), and recorded a 9th live mixed-basis bug in `unsafe_report.yo`/`public_safe_report.yo`. Independently re-verified there: a 1481-line multibyte behavioural probe hashes `b7a76ec66909fbab41940268b645d950fc56f5788a45ed17e9fe8be87b2233c1` on the base `std` and on the migrated `std`; `char_len ≡ len` and `char_substring ≡ substring` over 39,488 exhaustive comparisons, 0 mismatches; `_peel_spec` old-vs-new 35 inputs (20 multibyte), 0 mismatches; `substring`'s new one-line delegation costs 0 measurable time at `-O2`. |
| ~~**3**~~ **LANDED 2026-08-26** | **The flip.** `String.len()` → bytes O(1); `at`/`substring`/`slice_copy*`/`index_of`/`last_index_of`/`contains(from)`/`starts_with(pos)`/`ends_with(pos)`/`Pattern`'s five methods → bytes. `bytes_len()` is now `self.len()`. §1.3(a) fixed by construction. `src/` migrated in the same commit. `Token.byte_offset` added (a `?= usize(0)` defaulted field, so only the ~20 synthetic construction sites that COPY a source token's position needed touching) and `_byte_offset_of_char_index` retired. S8 (`src/doc/builder.yo`) done via `byte_offset`; S9 (`src/lsp/completion.yo`) and `src/lsp/diagnostics.yo:_ident_len_at` done via a new `rune_col_to_byte_offset` / `byte_offset_to_rune_col` pair in `src/lsp/protocol.yo` — **the UTF-16 half of §5.4 was NOT done, see the note under §5.4.** One site needed a rewrite the plan had classified INVARIANT: `src/doc_command.yo:_scan_quoted_value_after` peeked one unit at a time with `substring(j, j+1)`, which under the new panic policy would abort on a lead byte; it now reads bytes. | achieved: `yo build` green; `fixpoint_only.sh` **FIXPOINT_HOLDS**, stage-2 hollow=0; `gates_fast.sh` all 7 gates (battery 23/23 files hollow=0, corpus **155/155 with goldens unchanged** (**156** after the review pass added `effect_label_non_ascii.yo`), `check ./std` 154/154, `check ./src` 262/262, cli-diff 52 PASS / 0 GOLDEN-DIFF, fmt idempotent); new `tests/string/string_byte_index.test.yo` 19/19 of which **15 FAIL against the pre-flip `std`** (**21/21 and 17 failing** after the review pass added the empty-needle and floor/ceil rows; both figures re-measured independently, §6.1.2); `tests/string/string.test.yo` 253/253 after rewriting the **36** (not 20) multibyte+index tests; `string_char_api` 21/21, `encoding/utf8` 35/35, `encoding/html` 12/12, `format_specs` 13/13, `imm_string` 34/34, `regex` 156/156, `index` 49/49, `json` 53/53, `utf16` 13/13, `template_string_specs` 6/6, `string_multibyte_literal` 2/2, and `tests/internal/{lexer 45,parser 52,formatter 8,doc_extractor 39,doc_sections 23,doc_render_markdown 25,pkg_config 11,lock_file 15,build_runner 10,install_command 43,version 21,fetch 10,cache 6,init 13,target 22,error 16,env 11,type_key 5,…}` all green |
| ~~**4**~~ **LANDED 2026-08-26** | `imm.String`: `len()` → bytes O(1) (`self._len`), `at()` aligned with `String.at` (body is now `_decode_rune_at(index)` — `.None` at/past `len()`, at a continuation byte, and on bytes that do not decode). **Deviation from this row: `bytes_len()` was DELETED, not aliased.** Measured first (the task's rule was "nothing dead ships"): its only consumers were 2 internal sites in `std/imm/string.yo` itself (the two iterators' bounds checks, moved to `len()`) and 5 sites in `tests/imm_string.test.yo` (rewritten); `std`/`src`/`docs`/`vendor` had ZERO — every other `.bytes_len(` hit in the tree is a `std/string` `String` receiver, including `from_string`'s own `s.bytes_len()` (a std-String call, switched to `s.len()` in passing since it read the deprecated alias). `chars()`/`char_indices()`/`char_len()` needed no wiring — PR 1 had already built them byte-correct; what PR 4 did was fix the doc contracts that described the pre-flip basis (`char_len` "identical to len() today", `is_char_boundary`/`floor`/`ceil`/`try_substring` phrased against `bytes_len()`, the vocabulary-block header's "until `len()` becomes a byte count"). | achieved: `yo check ./std` 154/154; `tests/imm_string.test.yo` **44/44** (was 34: the two rune-basis tests rewritten to byte offsets, the PR-1 golden restated as two halves, plus a 10-test §6.2 byte battery, all multibyte with hand-computed offsets) of which **8 FAIL against a std tree with only `imm/string.yo` reverted to the parent commit** — exactly the basis-sensitive ones; `imm_vec` 47/47, `imm_map` 21/21 (a 4th imm consumer §2.4 missed), `imm_threading` 30/30; 0 `Failed to transpile` |
| ~~**5**~~ **LANDED 2026-08-26** | `imm.String` → `ImmString` rename. The "~15 lines" estimate was for the binding+export+imports+docs and held for those, but the honest diff is larger: renaming the binding renames every `String` reference INSIDE `std/imm/string.yo` (8 `impl` heads, `Eq(String)`/`Ord(String)`, `imm_list.List(String)`, the iterator structs' `_string` fields, the panic message) and every use in the four consumer test files — not just their import lines ("~15 lines" undercounted the same way §2.4 undercounted the test files, 3 vs 4). **Two deliberate extensions:** (1) the iterators went `StringChars`/`StringCharIndices` → `ImmStringChars`/`ImmStringCharIndices` — measured zero consumers outside the module, and leaving them would have kept the exact same-name-as-`std/string`-exports collision the rename exists to remove (the collision that caused `issues/fixed/generic-impl-method-cache-key-collision.md`); (2) `tests/imm_vec.test.yo`'s regression-test comment now records that its "same-named types from different modules" premise was retired by this rename. Docs: 4 lines × 2 languages in `IMMUTABLE_COLLECTIONS.md` as measured, plus a SUPERSEDED banner on `plans/IMMUTABLE_COLLECTIONS.md`'s naming note and its Resolved Decisions 2-3 (they prescribed the bare-`String` name). | achieved: `yo check ./std` 154/154; `imm_string` 44/44, `imm_vec` 47/47, `imm_map` 21/21, `imm_threading` 30/30 (all `YO_STD=<tree>/std`); `grep -rn 'imm\.String' std src tests docs .github` → 0; both doc languages updated |
| ~~**6**~~ **LANDED 2026-08-26** | **Regex.** ~~Delete `_byte_to_char_index` (`std/regex/index.yo:70`) and the three char→byte re-walks at `:535-545`, `:582-592`, `:634-644`.~~ Done, with two corrections to the row as written: (a) the deleted function was at `:104` (D8 had drifted the line numbers), and (b) there were **five** char→byte re-walks, not three — the row missed the two in `_apply_replacement`'s `` $` `` (pre-match, `:406-414`) and `$'` (post-match, `:425-436`) arms, and §5.3 misnamed the third listed site `replace_all_fn` (does not exist; it is `split`). Six conversion walks deleted in all (1 byte→char at `_build_match`, 5 char→byte), 66 lines removed net −52. `RegexMatch.index()` is now a **byte** index (doc comment carries the basis change prominently; `Regex.search` documented to match) — **public API change, release-note item**. "Adopt `std/encoding/utf8.yo`" turned out to be a no-op: the deletion removes walks rather than leaving raw ones, and the module's surviving rune-stepping (`exec`/`match_all` empty-match advance) already went through `utf8.step_len` in D8. Consumer audit: zero `RegexMatch.index()`/`search` consumers outside `std/regex` + the regex tests (`src/main.yo` uses only `Regex.new`/`.test()`; vendor: none). | achieved: `yo check ./std` 154/154; `tests/regex/regex.test.yo` **166/166** (was 156) — 10 new multibyte index tests (byte offsets after CJK/emoji prefixes, `search`, `match_all` offsets, match index fed straight into `String.substring`, `replace`/`replace_all`/split/`` $` ``/`$'` over multibyte subjects), of which **5 fail against the pre-PR6 std** (index-basis tests; the other 5 pin behaviour that the conversion walks used to preserve). No `find_iter` exists to test — that is future polish per the audit's regex row; `match_all` covered instead. |
| ~~**7**~~ **LANDED 2026-08-26** | **Comptime basis** (O1c): aligned to BYTES. All 14 `char_len`/`char_substring` occurrences across S10's 10 pinned sites (`comptime_string_fns.yo` 6, `comptime_index_fns.yo` 4, `index_trait.yo` 4) flipped to `len`/`substring`. `s[i]` takes a byte offset and yields the rune STARTING there (`substring(i, ceil_char_boundary(i+1))`) — the result stays a 1-rune `StrLit`, i.e. the comptime-vs-runtime result-TYPE split (`StrLit` vs `u8`) is kept DELIBERATELY and documented (`docs/*/STRINGS.md`): a `comptime_str` is text, not a byte buffer. A mid-rune offset is a **compile error** (new checks in all three files) where the runtime `substring` panics; out-of-range keeps its existing behaviour (`slice` clamps, `s[i]`/`s(a..b)` error). Prelude `comptime_str.len`/`slice` gained basis doc comments. **The seed-safety claim was re-measured and is STRONGER than stated:** there are ZERO comptime string `len`/`slice`/`[i]`/`(a..b)` call sites in `std/` + `src/` + `build.yo` at all (`.slice(` grep = 0 outside tests; every `:: "..."`-bound constant checked against `.len()`/`.slice(`/`[` = 0 hits; `std/build.yo` only DECLARES `comptime_str` params) — the only traffic is `tests/comptime.test.yo` + `tests/index.test.yo`, all ASCII, run under tree-built compilers in CI. Gates run: `yo check ./src` 262/262; full-tree `compile src/main.yo --skip-c-compiler` emits 169.9 MB with 0 transpile markers; a `tmp/fixme.yo` probe under the SEED engine prints the old split (comptime `len`=4 / `slice(1,3)`="é中" vs runtime 10 / "é") — the new engine cannot be run locally without `yo build`, so the new-basis demonstration is the discriminating tests: `tests/comptime.test.yo` 30/31 under the seed with the ONE new byte-basis test the only failure, and `tests/index.test.yo`'s three new tests abort the seed's batch compile by construction (comptime errors), both green under a tree-built compiler. | fixpoint (`s2 == s3`) is the real gate here — runs centrally at integration |
| ~~**8**~~ **LANDED 2026-08-26** | Docs + skills sweep, done to a NEWER design decision than this row recorded (user, 2026-08-26): **the rune-count idiom is `s.chars().count()`**, not `char_len()` — `char_len`/`char_substring`/`truncate_chars` are deprecated pending removal in a follow-up (the final API is Rust-shaped: byte slicing + `chars()`/`char_indices()` composed with iterator methods; no char-indexed slicing). What landed: `docs/{en-US,zh-CN}/STRINGS.md` NEW (the full byte contract: len()=bytes O(1), boundary policy, the pinned `index_of("")`/`last_index_of("")` exception, rune idioms — count / `char_indices().nth(n)` truncation / `chars().next()`, all three verified with a compiled multibyte probe — `s(i)`→u8, the comptime basis incl. the deliberate `s[i]` result-type split, str/StringBuilder already-bytes); the cheatsheet's string-indexing region reworked onto the iterator idioms + a comptime-basis paragraph; `DESIGN.md` 1397/1389 extended with `char_indices()` + the byte contract + STRINGS.md links; `INDEX_TRAIT.md:236` (both languages) gained a STRINGS.md cross-link; `yo-design.instructions.md` gained the byte-contract bullet + byte-based comptime_str indexing section (and its stale `std/data/rune.yo` path fixed to `std/string/rune.yo`); `yo-syntax.instructions.md` gained the byte-basis bullet. `IMMUTABLE_COLLECTIONS.md` deliberately NOT touched and imm.String's basis NOT documented — PR 4/5 owns it; STRINGS.md mentions the imm string only generically. Stale-claim grep ("character index", "rune count", "rune-based", zh equivalents) over `docs/` + `.github/`: clean; `core-patterns-cheatsheet.md` has no string-indexing claims. | both language versions present (no `.yo` touched, so no fmt gate) |
| **9** | Dedup the 10 hand-rolled UTF-8 sequence-length decoders onto `std/encoding/utf8.yo`: `std/imm/string.yo`, `std/regex/{parser,index,vm}.yo`, `std/string/string.yo`, `src/formatter.yo`, `vendor/markdown_yo/src/{inline/link,common/normalize_link,block/reference,common/utils}.yo`. Vendor needs **companion upstream commits** + a pointer bump. | suite; vendor's 3 pre-existing failures stay pre-existing |

**Ordering constraints, explicitly:**

- PR 1 **must** precede PR 2 (`char_indices()` is what PR 2 migrates onto). ✅ done.
- ~~**PR 1 did NOT ship `truncate_chars`.**~~ **PR 2 added it**, together with
  `char_substring`. Not as the `floor_char_boundary` composition PR 1 guessed at:
  `truncate_chars(n)` is `char_substring(0, n)`, and `char_substring` holds
  `substring`'s CURRENT body byte-for-byte (mechanically verified against
  `git show HEAD:std/string/string.yo`), with `substring` reduced to
  `self.char_substring(start, end)`. That is what makes every
  `substring → char_substring` rewrite in PR 2 provably inert, and it is also
  **PR 3's insertion point**: PR 3 gives `substring` a byte-slice body and leaves
  `char_substring` alone.
- **`try_substring` is BYTE-based from day one**, while `substring` is still
  character-based until PR 3. That is intentional: a NEW name can carry the final
  contract, and a new name that flipped basis under its callers in PR 3 would be
  exactly the silent hazard this plan exists to avoid. PR 2 must not reach for
  `try_substring` as a drop-in for `substring`; its migration targets are
  `char_len()` and `char_indices()`.
- PR 2 **must** precede PR 3. ✅ done. This is the whole safety argument: after
  PR 2,
  every site that *needs* char semantics says so in its own source, so PR 3's
  review question collapses to "does this site want bytes?" — and the answer
  is yes everywhere left.
  **That claim was only true after the review pass of 2026-08-26 added §5.2
  S11.** PR 2 as committed migrated the ONE instance of the rune-column pattern
  that §5.2 happened to name (`src/error.yo`, S7) and left **11 more in 6 files**
  the plan never listed. The lesson for PR 3: `grep` the *pattern*, not the
  plan's site list. The two detectors that found them are

  ```bash
  grep -rnE '\.column\s*\+|\.character\s*\+' src/     # rune column + a width
  grep -rn  '\.value\.len()' src/                        # token width in an unstated basis
  ```

  Both must come back with `char_len()` (or a `Token.byte_offset`) at every hit
  before PR 3 lands. ~~**Still open by design after S11: S8 and S9**~~ — **both
  closed in PR 3** (S8 with `Token.byte_offset`, S9 with a rune⟷byte conversion
  pair; the UTF-16 half of §5.4 was deliberately left, see the note there).
  **PR 3 re-ran both detectors and they came back clean**: after PR 3,
  `grep -rnE '\.column\s*\+|\.character\s*\+' src/` hits only `char_len()`
  sites, `to_string()` formatting and `Token.byte_offset`, and
  `grep -rn '\.value\.len()' src/` hits only three genuinely byte-wanting
  sites (`src/main.yo:276` strips ASCII `"` delimiters, `ptr_fns.yo:183` is an
  emptiness test, `_expr.yo:508` is an ASCII-keyword-length perf gate) plus
  `src/doc/builder.yo:234`, which is now correctly paired with `byte_offset`.
  **The verdict on PR 2's central claim: it held, with one exception nobody had
  reason to anticipate** — `src/doc_command.yo`, which does not want RUNES, but
  whose one-unit slices become an ABORT rather than a wrong answer once
  `substring` panics on a non-boundary. See the panic-policy bullet below.
- PR 3 is the only PR that cannot be split across `std` and `src`.
- **`impl` blocks do not see FORWARD across each other** — measured twice in
  PR 2, both times as `No matching call found with arguments: (self.X)()` from
  `yo check ./std`. A method defined in a LATER `impl(String, …)` block is not
  callable from an earlier one (within a single block, forward references are
  fine — `slice_copy_inclusive` already calls `substring` defined below it).
  PR 1 put the whole rune vocabulary in a new trailing block; PR 2 had to move
  `char_len` up beside `len()` so `_split_impl` (line ~660) could call it.
  **PR 3 will hit this again:** the byte-basis `at()` wants
  `is_char_boundary`, which still lives in the trailing block, so
  `is_char_boundary` has to move up beside `at()` (or `at()` has to inline
  `utf8.is_boundary`, which is what PR 2's throwaway flip experiment did).
- ~~**PR 3's insertion point is now one function.**~~ **CONFIRMED, and it held.**
  `substring` got a byte-slice body, `char_substring` was untouched, and
  `slice_copy` / `slice_copy_inclusive` followed for free. **The forward-reference
  prediction above also held exactly:** the byte-basis `substring` needs
  `is_char_boundary` for its panic check, and `is_char_boundary` lived in the
  trailing block, so it was MOVED up beside `at`. Moving it backwards is safe —
  a LATER block can call an earlier one, which is how `try_substring` still
  reaches it.
- **One thing the plan did not predict, and it is the panic policy's cost.**
  Making a non-boundary index panic turns every one-unit `substring(j, j+1)`
  peek into an abort on a lead byte. `src/doc_command.yo`'s
  `_scan_quoted_value_after` does exactly that, and §3.1 had reclassified it
  INVARIANT in PR 2 on the reasoning that a one-unit slice "simply fails to
  match on any interior byte" — true under clamping, fatal under panicking. It
  was rewritten onto `byte_at` / `starts_with(connector, j)`. A repo-wide grep
  for `substring(x, x + usize(1))` found no other site (the two comptime
  builtins and `_split_impl` use `char_substring`). **The general rule for
  anyone extending this: a panic policy makes the `substring` call sites that
  were merely WRONG before into sites that ABORT, so re-audit any site that
  slices at an index it did not get from `index_of` or a boundary function.**
- PR 6 can land before or after PR 3 **only if** it lands after — regex's
  `index()` is consumed by its own `replace*` which re-walks; splitting them
  leaves a half-converted state. Keep 6 after 3.
- PR 0 is not on the critical path for PR 2 or PR 3; it is on the critical path
  for PR 1's `is_char_boundary` and for PR 6 and PR 9.

---

## 5. The trap list

### 5.1 (a) `len()` bound mixed with a byte loop — **9 confirmed live bugs D4 FIXES**

Detector (25-line window, receiver-matched):

```bash
# every `while(i < X.len(), ...)` whose following lines also touch
# X.byte_at / X.as_bytes / X.substring -- the mixed-basis loop shape
grep -rn -A40 'while(.* < [A-Za-z_][A-Za-z_0-9.]*\.len()' std src tests vendor
# then filter by hand: the receiver in the bound must match the receiver
# in the body. A 25-line receiver-matched window over the same corpus
# reports 41 hits.
```

Repo-wide the detector reports **41 co-occurrence windows**. Confirmed by
reading (7 at survey time; an 8th, `std/fs/dir.yo`, was found in PR 2; a 9th,
the duplicated report walker, was found in the PR-1/PR-2 review pass):

| site | shape | verdict |
| --- | --- | --- |
| `src/main.yo:789-802` `_win_dirname` | `while(di < p.len())` + `p.byte_at(di)`, then `p.substring(0, last_sep)` with a **byte** `last_sep` | **LIVE BUG**: any non-ASCII path component under-walks and returns the wrong dirname. D4 fixes it. |
| `src/main.yo:852-866` `_path_has_extension` | identical shape | **LIVE BUG**. D4 fixes it. |
| `src/install_command.yo:60` | `s.substring(usize(0), s.bytes_len() - usize(4))` | **LIVE BUG**: char slice, byte end. D4 fixes it. |
| `src/install_command.yo:66` | `s2.substring(idx + usize(1), s2.bytes_len())` — `idx` from char `last_index_of` | **LIVE BUG** (two bases in one call). D4 fixes it. |
| `src/pkg_config.yo:34-66` `_split_whitespace` | `n := bytes.len()`, walks `k` over bytes, then `s.substring(start, k)` | **LIVE BUG**. D4 fixes it. |
| `src/lsp/diagnostics.yo:72-89` `_ident_len_at` | rune `col` indexed into `line.as_bytes()` | **LIVE BUG**, **not fixed by the flip itself** — `col` stays a rune column. **FIXED IN PR 3** by converting it with the new `rune_col_to_byte_offset`. The returned length needs no conversion back: `_is_ident_byte` matches only ASCII, so every byte counted is one rune. |
| `std/fmt/writer.yo:42` | `while(i < s.len())` + `s.bytes(i)` | **false positive** — `s : str`, whose `len()` is already bytes. Clean. |
| `std/fs/dir.yo:93-121` `mkdir_all` | `bytes := path_s.as_bytes()`, `i` walks `bytes`, then `path_s.substring(usize(0), i)` | **LIVE BUG, FOUND IN PR 2 (2026-08-26) — an 8th, and the first in `std/` rather than `src/`; written up in `issues/fixed/mkdir-all-uses-a-byte-index-as-a-rune-index.md`.** `i` is a byte index into `as_bytes()`; `substring` reads it as a rune index, so `mkdir_all` on a path with a non-ASCII component creates the WRONG parent directory (a short prefix) and then fails or silently makes the wrong tree. Exactly the `_win_dirname` / `_split_whitespace` shape. **FIXED by D4 PR 3 (2026-08-26) with no edit to the file**, and witnessed by a new multibyte `create_dir_all` test in `tests/fs/dir.test.yo` that fails against a pre-flip `std`. |
| `src/unsafe_report.yo:511,521` + `src/public_safe_report.yo:517,525` `_walk_yo_files` | `root_prefix_len := walk_root.as_bytes().len()` (**bytes**), then `p.substring(root_prefix_len + 1, p.len())` (**runes**) | **LIVE BUG, FOUND IN THE PR-1/PR-2 REVIEW (2026-08-26) — a 9th, and it is DUPLICATED across two files**; written up in `issues/fixed/unsafe-report-relative-path-uses-a-byte-prefix-length.md`. The relative path is cut `bytes(root) - runes(root)` positions too far in, so the directory-skip filter runs on the wrong segments and the printed label is mangled. Measured on a standalone reproducer: root `/tmp/名` gives `"yo"` where `"a.yo"` is wanted; root `/tmp/café` gives `"rc/a.yo"` where `"src/a.yo"` is wanted. Reachable from `yo unsafe-report` and `yo public-safe-report` (`src/main.yo:3245`). **FIXED by D4 PR 3 (2026-08-26) with no edit to either file**; the same standalone reproducer now answers `a.yo` / `src/a.yo`. Not covered by a repo test — `_walk_yo_files` is private and neither subcommand has a harness. |

| `std/http/client.yo:325` `fetch` | `req.set_header(\`Content-Length\`, \`${opts.body.len()}\`)` with `opts.body : String` | **LIVE BUG, FOUND IN PR 3 (2026-08-26) — a 10th, and the first that is wrong ON THE WIRE rather than internally.** `Content-Length` is defined in bytes; a rune count under-reports any non-ASCII request body, so the server reads a truncated body (or blocks waiting for one). The survey missed it because the detector looked for `len()` mixed with a byte LOOP, and this one mixes it with a protocol. **D4 PR 3 fixes it for free** — the site is unchanged and now correct. |

| `src/codegen/exprs/async.yo:366` `_capitalize_last_segment` | `last.substring(usize(0), usize(1)).to_uppercase()` on a user-written effect LABEL | **A site the flip BREAKS, not one it fixes — the ONLY one found in the skeptical review (2026-08-26), and it broke a program that WORKED.** `generate_future_effect_setter` calls this on every injectable effect label so the emitted `strcmp(field, …)` chain also accepts the capitalized alias. Yo identifiers may start with a non-ASCII rune (`src/token.yo` `is_identifier_start`: `c.char >= 0xA0`), so the label can be multibyte — and `substring(0, 1)` then lands INSIDE the first rune, which post-flip **aborts the compiler** (`String.substring: end is not on a UTF-8 character boundary`, rc=134, no source location, nothing emitted). Pre-flip the same expression was a rune slice and simply worked. **FIXED in the review pass** by cutting with `char_substring` — the rune vocabulary, which is what the function always meant; ASCII output is byte-identical (`io.async` → `Async`, `errors.raise` → `Raise`, `x` → `X`). Ratchet: `tests/codegen-bootstrap/effect_label_non_ascii.yo` (+ golden), a program that compiles and runs `r=7` on the seed and would abort the flipped compiler without the fix. |

**All nine of the pre-existing rows above are fixed by PR 3**, seven of them
without touching the site (`_win_dirname`, `_path_has_extension`,
`install_command`'s two, `_split_whitespace`, `mkdir_all`, the duplicated
report walker) plus `src/main.yo:1294-1295` — an ELEVENTH found in PR 3's own
sweep, where `-Dname=value` splits on an `eq_at` produced by a `byte_at` walk
and fed to a then-rune-indexed `substring`. `_ident_len_at` needed the explicit
conversion described in its row.

**Precedent, already paid for once:**
`issues/fixed/yo-self-formatter-corrupts-files-with-non-ascii.md` — a
`Token.character` rune index used as a byte offset made `yo fmt` **silently
destroy source at rc=0**; 23 of 40 sampled `std/` files with a backtick became
non-parseable. That issue's *Fix direction* section explicitly leaves open:
*"any other consumer of `Token.character` that indexes bytes has the same
latent bug … widening it to a `Token.byte_offset` field is the follow-up.
**Audit every `t.character` use for byte-indexing before choosing.**"*
**D4 PR 3 is that follow-up.** `src/doc/builder.yo:235` is one such consumer,
still latent today.

Two more in-tree comments already document this exact hazard:
`src/utils.yo:99-105` (`str_lit_unquote_bytes`, "the em-dash template-segment
corruption in the stage-2 binary") and
`src/evaluator/builtins/comptime_string_fns.yo:54`.

### 5.2 Sites that BREAK on the flip — the migration list for PR 2

| id | site | why | fix |
| --- | --- | --- | --- |
| ~~**S1**~~ **DONE (PR 2)** | `std/encoding/html.yo:34, 52, 80, 92, 99, 106, 117, 140, 151, 175, 185` | `while(i < s.len())` + `s.at(i).unwrap()` over **arbitrary HTML text**. After the flip `at()` at a continuation byte is `.None` → `.unwrap()` **panics**. Highest-risk file in the tree. | done, but NOT as "three loops onto `chars()`" — `decode_html` is a **backtracking** scanner (`try_end` walks back one rune at a time, `substring(start, i)` re-slices between two scanner positions), which a forward-only iterator cannot express. It now materializes one `char_indices()` table of `(byte_offset, rune)` and indexes that by rune; `_parse_hex`/`_parse_dec` — which really are plain forward loops — did go onto `chars()`. The O(n²) is gone either way. |
| ~~**S2**~~ **DONE (PR 2)** | `std/fmt/spec.yo:36, 69, 206-207` **plus 219-220, which this plan missed** | `width` is documented "Minimum width in **CHARACTERS**"; `_apply_width` uses `text.len()`, `pad` truncates with `substring(0, p)`. After the flip padding counts bytes and precision can split a codepoint. Rust counts chars here. **`pad_numeric`'s `sign.len() + prefix.len() + digits.len()` was not on the list but is compared against the same `self.width`**, so it had to move to the same basis or the two paths would disagree. | `char_len()` + the new `truncate_chars`; `pad_numeric`'s three lengths too |
| ~~**S3**~~ **DONE (PR 6, 2026-08-26)** | `std/regex/index.yo:70, 144` + `:535-545, 582-592, 634-644` | `RegexMatch.index()` is a **char** index produced by an O(n) `_byte_to_char_index` per match, then converted **back** to bytes by three more O(n) walks in `replace`/`replace_all`. `replace_all` is O(n·m) purely from basis conversion. | delete all four walks; `index()` becomes a byte index (public API change — release note). **MEASURED IN PR 3: `std/regex/` is basis-INDEPENDENT and came through the flip untouched and green (156/156).** Every regex internal works on `ArrayList(u8)` from `as_bytes()`; the only `String.len()` in the package is on `literal_prefix`, which is itself an `ArrayList(u8)`. So PR 6 is a performance/API cleanup, not a repair, and nothing forced it into PR 3. **Landed with corrected counts — it was SIX walks, not four; see §5.3 and §4 row 6.** |
| ~~**S4**~~ **DONE (PR 2)** | `src/parser.yo:517-546` `_peel_spec` | rune indices from an `ArrayList(rune)` fed to `text.substring` | `char_indices()` fills a parallel `ArrayList(usize)` of byte offsets; the two cuts go through `try_substring`. Verified by a differential driver holding BOTH implementations (`tmp/d4pr2_peel.yo` shape): 29 inputs, 15 multibyte, **0 mismatches**. |
| ~~**S5**~~ **DONE (PR 2)** | `std/string/string.yo:662-676` `_split_impl`, empty-separator arm | `self.substring(i, i+1)` per char, bounded by `self.len()` — "split into characters". Must stay **char**-based or `split("")` returns invalid-UTF-8 fragments. | pinned to `char_len()` + `char_substring()` rather than rewritten onto `char_indices()`: a `char_indices` walk needs lookahead for each rune's end offset, so it would add code and a new failure mode for no behaviour change, in a PR whose contract is exactly "no behaviour change". The O(n²) here is pre-existing and left; unlike html.yo the inputs are short. |
| ~~**S6**~~ **DONE (PR 2)** | `src/doc/render_html.yo:404-406` | fixed 120-unit cut of arbitrary doc text | `char_len() > 120` + `truncate_chars(120)`. The `> 120` guard is KEPT: `.trim()` is chained onto the cut and only runs when the cut happens, so dropping the guard would change the result for short summaries. |
| ~~**S7**~~ **DONE (PR 2)** | `src/error.yo:43` | rune column + token-value length | `char_len()` |
| ~~**S8**~~ **DONE (PR 3)** | `src/doc/builder.yo:233-235` | `Token.character` (rune) into `substring` | `Token.byte_offset`, a new `(byte_offset : usize) ?= usize(0)` field on `Token`. The lexer fills it from a `char_indices()` pass that builds `chars` and a parallel `char_byte_offsets` in one walk; the operator-run splitter adds the same `k` to `column`/`character`/`byte_offset`, which is sound only because every operator char is one ASCII byte. The default is what kept this to ~20 edited construction sites (the ones that COPY a source token's position) instead of all 98. |
| ~~**S9**~~ **DONE (PR 3), minus the UTF-16 half** | `src/lsp/completion.yo:875, 1010` (the `762-780` sites are downstream of them and needed no change — they pair an `index_of` with a `substring` in one basis) | LSP `character` into `substring` | `rune_col_to_byte_offset` / `byte_offset_to_rune_col` in `src/lsp/protocol.yo`. `handle_completion` converts the incoming rune column to a byte offset ONCE and works in bytes from there; `dot_col` converts back before it is compared against `Token.column`. The same pair fixed `src/lsp/diagnostics.yo:_ident_len_at`, §5.1's 6th live bug, which the plan said D4 would NOT fix. **The UTF-16 correction of §5.4 was deliberately NOT done** — see the note there. |
| ~~**S10**~~ **DONE (PR 2)** | comptime string builtins — **10 sites, not 4**: `comptime_string_fns.yo` (1 `len` + 4 `len` defaults + 1 `substring`), `comptime_index_fns.yo` (2 `len` + 2 `substring`), `index_trait.yo` (2 `len` + 2 `substring`) | semantics ride on `substring` | pinned to `char_len`/`char_substring`, each with a `COMPTIME BASIS PIN` comment naming O1c. ~~PR 7 now changes the comptime basis only by editing these names.~~ **PR 7 did exactly that (2026-08-26)** — every `char_len`/`char_substring` call in these three files is gone (the comptime-builtin consumers; 15 `char_len`/`char_substring` calls remain elsewhere in `src/` — the S7/S11/S6/S4-family sites plus `async.yo` and `render_html.yo` — for the follow-up rune-vocabulary sweep). |
| ~~**S11**~~ **DONE (review pass, 2026-08-26)** | `src/formatter.yo:1246`; `src/lsp/hover.yo:50,292`; `src/lsp/symbols.yo:98`; `src/lsp/definition.yo:104`; `src/lsp/references.yo:34,98`; `src/lsp/rename.yo:35`; `src/lsp/completion.yo:926,930`; `src/doc/builder.yo:379` — **11 sites in 6 files this plan never named** | Exactly S7's shape: a RUNE column (`Token.column` / `Token.character`, both produced by the lexer's `ArrayList(rune)` walk at `src/lexer.yo:97-99`) added to `tok.value.len()`. After PR 3 the width becomes BYTES, so every one of them overruns on a multibyte token: hover matches the wrong token, `definition`/`references`/`symbols`/`rename` emit ranges longer than the identifier (**rename would replace past the end of the name**), completion's `ends_at_dot`/`before_dot` stop finding the receiver, `fmt`'s tight-call adjacency test changes formatting, and doc-comment adjacency inserts a stray space. | `char_len()` at all 11. Inert by the same construction as S7 (`char_len`'s body IS `len`'s body). **PR 2's original claim that "every site that needs char semantics now says so" was FALSE until this row landed** — §5.2 had listed only the `src/error.yo` instance of the pattern. |

### 5.3 (b) regex `_byte_to_char_index` — see S3

It costs **two** conversions, not one: byte→char at match construction
(`:144`), and char→byte again in each of `replace`, `replace_all` and
`replace_all_fn` (`:535`, `:582`, `:634`). D4 deletes all of them. The
observable change is `RegexMatch.index()`: `Regex.find("héllo", "llo").index()`
goes from `3` to `4`. Coverage today: `tests/regex/regex.test.yo` has 140
tests, 22 with multibyte content, but **only 2** that combine multibyte with an
index-basis API — so this flip is nearly unguarded (§6.2).

**LANDED 2026-08-26 (PR 6), with three corrections to the paragraph above —
re-measured before executing:**

1. **It was six walks, not four.** The third char→byte site is `split`
   (`replace_all_fn` does not exist), and there were **two more** the count
   missed, in `_apply_replacement`'s `` $` `` (pre-match) and `$'` (post-match)
   arms — every one of the five consumers of `index()` inside the package
   re-walked. All six deleted; `_build_match` now passes the VM's byte slot
   straight through.
2. **The example is wrong twice.** There is no `Regex.find` (`search`/`exec`
   is the API), and `llo` in `héllo` starts at char **2** / byte **3** — the
   observable flip is `2 → 3`, not `3 → 4`. The landed test asserts exactly
   that: `Regex.new(`llo`).search(`héllo`)` returns `.Some(usize(3))`.
3. **The counts had drifted** (D8 touched the file): the function sat at
   `:104`, its one call at `:173`, and the test file had 156 tests, not 140.

The safety net now exists: 10 new multibyte index tests (166 total), 5 of
which fail against the pre-PR6 std.

### 5.4 (c) LSP offsets vs UTF-16 — a pre-existing gap D4 makes visible

**Finding: `src/lsp/` performs no UTF-16 conversion at all.** The lexer
(`src/lexer.yo:76-100`) materializes an `ArrayList(rune)` and indexes it, so
`Token.row`/`column`/`character` are **codepoint (UTF-32) offsets**. The LSP
serves those directly as `character` (`src/lsp/protocol.yo:40`,
`src/lsp/server.yo:275-295` and 5 more handlers). The LSP spec's default
`positionEncoding` is **UTF-16**, so today Yo's LSP is already wrong for any
line containing an astral-plane character (emoji, some CJK extensions) and
merely *happens* to agree for BMP text.

Interaction with D4:

- **No regression from the lexer side.** The lexer never depends on `String`'s
  index basis for columns; `op_str.slice_copy(k .. k+2)` (`:158`) is ASCII by
  the closed operator set. `run_len := op_str.len()` (`:154`) flips
  chars→bytes but the run is ASCII. **Update the comment at `:152`.**
- **Regression from the consumer side.** `src/lsp/completion.yo:875` currently
  clamps a rune `character` against `bytes.len()` and then char-slices —
  already two bases. After the flip it is a byte slice with a rune index.
- **Recommendation:** land the UTF-16 correction *with* PR 3, not after.
  Add `Token.byte_offset` (issue's option 1) and a
  `utf16_offset ⟷ byte_offset` pair in `src/lsp/protocol.yo`, and declare
  `positionEncoding` in the server capabilities. Doing it later means two
  passes over the same 9 handler sites.
- **WHAT PR 3 ACTUALLY DID, and why it is less than that recommendation.**
  `Token.byte_offset` landed, and `src/lsp/protocol.yo` gained
  `rune_col_to_byte_offset` / `byte_offset_to_rune_col` — a **rune**⟷byte pair,
  not a **UTF-16**⟷byte pair. That is exactly enough to keep the flip from
  regressing anything: the three handler sites that SLICE a line
  (`completion.yo`'s `up_to` and `prefix`, `diagnostics.yo`'s `_ident_len_at`)
  now convert instead of mixing bases, and every other handler only ever
  COMPARES columns, which is basis-independent as long as both sides are runes.
  The UTF-16 correction was left out on purpose: it is a **protocol-visible**
  change (it moves the positions this server emits and accepts, and wants a
  `positionEncoding` capability declaration), it is a pre-existing defect
  unrelated to `String`'s index basis, and folding it in would have made the
  flip's diff unreviewable. It remains open, and the conversion pair added here
  is the seam it should be built on — `rune_col_to_byte_offset` /
  `byte_offset_to_rune_col` gain a UTF-16 sibling rather than being rewritten.

### 5.5 (d) An index from one String type fed into the other's slice

**Measured: ZERO such sites in the tree today.**
`grep -rn "from_string(\|ImmString\|imm_str" std src tests` shows `imm.String`
has **no production consumer at all** — it appears only in
`std/imm/string.yo` itself and three test files. The audit's framing ("code
moved between them … is silently wrong") describes a **real but currently
unrealized** hazard. Correct framing: unifying the two bases is *cheap
insurance*, not *bug removal* — and the cheapness (§2.4) is the argument.

### 5.6 Bootstrap-specific traps

- **The seed compiles `src/` against the *repo's* `std`.** So PR 3 cannot flip
  `std` without flipping `src` in the same commit. There is no two-step.
- **Comptime string semantics are evaluated by the *seed* while stage 1 is
  built.** Measured safe (§4 PR 7): all `comptime_str` traffic in `std/` +
  `src/` is ASCII. **Re-measured in PR 7 (2026-08-26) and found STRONGER:
  there is NO comptime string `len`/`slice`/index traffic in `std/` + `src/` +
  `build.yo` at all** — zero call sites, so the seed never evaluates the
  flipped builtins over anything while building stage 1.
- **`--release` only.** Per the standing directive, validate under `-O2`; an
  `-O0` `rc=139` here is the known stack ceiling, not a string bug.
- **Fixpoint before/after.** A basis flip changes nothing structural, so
  `s2 == s3` must still hold *and* the stage-2 C should differ from the
  pre-flip stage-2 C only where a migrated site sits. Diff it.

---

## 6. Verification strategy

### 6.1 What actually catches a silent basis error

A basis error is invisible to ASCII input **by construction**. Only three
things catch it:

1. **A fixed multibyte corpus with hand-computed byte offsets.** New file
   `tests/string/string_byte_index.test.yo`, one canonical subject string
   covering all four UTF-8 widths:

   ```rust
   //  a    é       中          𝄞
   //  1B   2B      3B          4B         total 10 bytes, 4 runes
   s := String.from("aé中𝄞");
   assert(s.len() == usize(10));            // BYTES after D4
   assert(s.char_len() == usize(4));        // runes
   assert(s.index_of(String.from("中")) == Option(usize).Some(usize(3)));
   assert(s.substring(usize(3), usize(6)) == String.from("中"));
   assert(s.is_char_boundary(usize(3)));
   assert(!(s.is_char_boundary(usize(4))));
   ```

   Every method in the §1.1 table gets a row against this one string. Because
   the offsets are hand-computed, a wrong basis cannot pass.

2. **A boundary-invariant property test.** For `i` in `0 .. s.len()`:
   `s.is_char_boundary(i)` ⟺ `i` appears as a key in `s.char_indices()`.
   And `s.substring(a, b)` for boundary `a,b` must round-trip through
   `char_indices()`. This catches an off-by-one in the new primitives that a
   fixed table would miss.

3. **A cross-PR invariant.** `char_len()` must return the **same value before
   and after PR 3** for every string in the corpus. Record a golden in PR 1,
   re-run it in PR 3. This is the single cheapest regression gate: it isolates
   "did the rune count change?" (must be no) from "did `len()` change?" (must
   be yes).

Plus, for PR 2 specifically: ~~**byte-identity of the emitted-C corpus**~~ —
see the SECOND CORRECTION below. PR 2 claims to change no behaviour, but it
does so by rewriting bodies, so the artefact to hash is the **program's
output**, not its C.

**CORRECTION (measured in PR 1, 2026-08-26): literal byte-identity of emitted C
is unattainable for ANY `std` edit, additive or not.** The C backend embeds two
families of generated number into its identifiers — anonymous type ids
(`__yo_tN`) and a global declaration/expression counter (`yo_id_N`,
`struct_decl_N`, `enum_decl_N`, `loop_yo_id_N`). Adding declarations to
`std/string/string.yo` shifted every counter ordered after the insertion point
by a constant (+1004 here) and permuted the `__yo_tN` numbering, so a
String-heavy probe's `.c` changed `sha256` while the *program* did not change at
all. Do not write "byte-identity" as a gate for PR 2; it will fail vacuously and
hide whether anything real moved.

**What to measure instead** (this is what PR 1 ran, and it is decisive):

```bash
# 1. before editing: emit the probe's C
yo compile tmp/probe.yo --skip-c-compiler --release -o tmp/probe.bin   # writes tmp/probe.bin.c
# 2. after editing: emit again, then compare modulo the generated-id families
norm() { sed -E 's/__yo_t[0-9]+/__yo_tT/g; s/__YO_T[0-9]+/__YO_TT/g;
                 s/yo_id_[0-9]+/yo_id_N/g; s/(struct_decl|enum_decl|decl)_[0-9]+/\1_N/g;
                 s/_temp_[0-9]+/_temp_N/g' "$1"; }
diff <(norm before.c | sort) <(norm after.c | sort)      # must be EMPTY
# 3. and the emitted function-symbol sets must be identical
grep -oE '__yo_[A-Za-z0-9_]+\(' before.c | sort -u > b.syms   # same for after.c
```

PR 1's result on a probe exercising `String.len/substring/index_of/chars/split`
and `imm.String.len/slice/at`: **5016 lines both sides, sorted normalized diff
= 0 lines, 196 emitted symbols both sides with an empty diff, and zero
occurrences of the new API in the C.** The only in-order differences were the
renumbering above plus a reordering of a handful of type declarations. That is
the strongest inertness statement available, and it is stronger than a `sha256`
would have been even if one had matched.

**SECOND CORRECTION (measured in PR 2, 2026-08-26): emitted-C comparison is the
wrong gate for PR 2 ALTOGETHER — not merely "not byte-identity".** PR 1 was
purely additive, so its emitted C could differ only by renumbering. PR 2 is a
*rewrite*: `decode_html`'s scanner, `_parse_hex`/`_parse_dec`, `_apply_width`,
`pad`, `pad_numeric`, `_split_impl` and `_peel_spec` all get different bodies on
purpose. Measured on the same probe: **13567 → 14139 lines, `sha256`
`a53f0a58…` → `76cb77fb…`, and the emitted-symbol set genuinely gains a
`ArrayList(IterPair(usize, rune))` family.** Requiring the C to match would
either fail vacuously or force the migration not to happen. Do not write
"byte-identity" or "emitted-C equivalence" as PR 2's gate.

**What IS decisive for PR 2 — three things, all run:**

1. **Output-identity of a behavioural probe.** A standalone driver over a
   deliberately multibyte corpus (40 `decode_html` inputs, 11 text bodies × 21
   specs through `pad`/`pad_numeric`, `split("")`, and the whole rune
   vocabulary) printing every result with its rune and byte length: 862 lines,
   `sha256` **`828549f0f0a9bdf747692bc872f018499a53435f518741fe055742d8561105e3`
   before AND after**. That is what "no behaviour change" actually means, and
   unlike a C hash it cannot be satisfied vacuously.
2. **Body-identity where a rename is claimed.** `char_substring`'s body is
   byte-for-byte `substring`'s body at the parent commit (checked mechanically
   against `git show HEAD:std/string/string.yo`), and `char_len`'s algorithm is
   `len`'s. So every `substring → char_substring` and `len → char_len` rewrite
   — including all ten comptime-builtin sites, which no runtime test can reach
   until the compiler is rebuilt — is inert by construction, not by testing.
3. **A simulated flip, run both ways.** `len`/`at`/`substring` were temporarily
   made byte-based in a throwaway edit and the two migrated files were run
   against it:

   | | ASCII-only tests (pre-existing) | multibyte tests (added in PR 2) |
   | --- | --- | --- |
   | migrated `html.yo` + flipped std | 8/8 pass | **4/4 pass** |
   | HEAD `html.yo` + flipped std | 8/8 pass | **0/4 pass** |
   | migrated `spec.yo` + flipped std | 7/7 pass | **5/5 pass** |
   | HEAD `spec.yo` + flipped std | 7/7 pass | **0/5 pass** |

   This is the whole D4 safety argument reduced to one table. The pre-existing
   ASCII tests are *invariant to the bug*, exactly as §6.2 warns; the new tests
   fail without the migration and pass with it; and both pass under today's
   char basis, which is why PR 2 is a no-op. The flip was reverted and the
   probe re-hashed to `828549f0…` to prove the tree came back clean.

### 6.1.1 What PR 3 actually ran, and what it proved (2026-08-26)

**The battery §6.1 asks for exists as `tests/string/string_byte_index.test.yo`**
— 19 tests over the four-width subject `aé中𝄞` (a@0, é@1, 中@3, 𝄞@6; 10 bytes,
4 runes), with the pre-flip answer written in a comment beside every assertion
that has one. It covers `len`, `bytes_len`, `at`, `substring` (both the
byte-range cases and the clamping policy), `try_substring`, the `s(a..b)` /
`s(a..=b)` sugar, `index_of` (result AND `from_index`), `last_index_of` (result
AND `from_index`), `contains(from_index)`, `starts_with(position)` — including
the §1.3(a) case that could not be expressed at all before —
`ends_with(end_position)`, the `Pattern` trait through a `str` literal,
`byte_at`/`Index` (which must NOT have changed), `split("")` (which must stay
rune-based), and the two §6.1 property tests: `is_char_boundary(i)` ⟺ `i` is a
`char_indices()` key, and `substring(a, b)` round-tripping against
`char_substring` over every pair of boundaries.

**The discrimination table** — the same file, same compiler, against two `std`
trees differing ONLY in `std/string/string.yo`:

| | pre-flip `std` (parent commit) | flipped `std` |
| --- | ---: | ---: |
| `tests/string/string_byte_index.test.yo` | **4 pass / 15 fail** | **19 pass / 0 fail** |
| `tests/fs/dir.test.yo` (§5.1's `mkdir_all` bug) | **13 pass / 1 fail** | **14 pass / 0 fail** |

The 4 that pass on both are the ones that MUST: `substring`'s clamping policy
(unchanged), `try_substring` (byte-based since PR 1), `byte_at`/`Index`
(always bytes), and `split("")` (pinned to runes in PR 2).

**The §6.1 item-3 cross-PR invariant is now written as two halves rather than
an equality.** `tests/string/string_char_api.test.yo`'s golden test used to
assert `char_len() == len()`; it now asserts the recorded pre-flip `char_len()`
values literally (4/4/5/2/3/0, unchanged) AND the new `len()` values
(10/12/6/8/3/0), so it discriminates in both directions instead of going
vacuous the moment the two stop agreeing.

**Panic policy, verified out-of-band.** A panic aborts the process and would
take every other test in its batch with it, so `substring`'s non-boundary panic
cannot be asserted from inside the runner. Two standalone `--release` drivers
were compiled and run instead: `s.substring(1, 2)` on the subject exits 134 with
`String.substring: end is not on a UTF-8 character boundary`, and
`s.substring(2, 3)` exits 134 with the `start` message. What the test file
asserts in their place is `try_substring` answering `.None` at exactly those
indices.

**METHOD TRAP, cost one full re-run:** `yo test --std-path ./std` **silently
ignores the flag** — the batch compile is a child process.
`tests/string/string.test.yo` scored a clean 253/253 that way against the
flipped tree, because it had actually scored the INSTALLED std.
`YO_STD=$PWD/std yo test ...` is the working lever, and it reported the 36 real
failures (re-measured in the review pass: **exactly 36**, and `tests/fs/dir`
exactly 13/1). Any std-facing measurement in this campaign must use `YO_STD`.

**CORRECTION to that trap (review pass, 2026-08-26): the flag is NOT broken in
this tree — it is broken in the SEED.** `src/main.yo`'s per-batch child-compile
block already forwards `get_std_path_override()` as `--std-path`, landed in
#286 with `tests/cli-cases/test-std-path-forwarded` as its gate
(`issues/fixed/yo-test-does-not-forward-std-path-to-batch-compile.md`). The
issue PR 3 cited was a duplicate filed AFTER that fix and has been retired
(`issues/retired/yo-test-std-path-not-forwarded-to-the-batch-compile.md`). The
`yo` on `PATH` is v0.2.17, built before #286, which is why the symptom is real
today — but nothing needs implementing, and a future agent must not re-derive
the "fix sketch" that file carried.

### 6.1.2 What the SKEPTICAL REVIEW re-ran, and what it found (2026-08-26)

A second pass over the landed flip, attacking the five things that could still
be wrong. Everything below was run with `YO_STD=$PWD/std` against the seed
`yo 0.2.17`, one command at a time.

**1. Re-ran the detectors on the POST-flip tree, and added new ones.**
`.at(` repo-wide outside `string.yo` (the `.unwrap()`-panic shape S1 was
about): 2 sites, both in `src/install_command.yo`, both correct in either
basis. `Token.column`/`character` + `.len()` (the S11 shape): **zero** — all
11 sites carry `char_len()`. Every `Token(` construction that copies a real
`character` also sets `byte_offset` (11 constructions set `character :
usize(0)`, matching `byte_offset`'s default of 0; **no** construction sets a
non-zero `character` without a `byte_offset`) — checked mechanically with a
balanced-paren scan of all 46 sites, which is the invariant `_slice_token_text`
and `read_raw_template_string` depend on. New detector: every
`substring`/`try_substring`/`slice_copy` site in `src` (135) and `std` (17),
classified by whether both endpoints are provably rune boundaries. Exactly TWO
have a literal end offset (`src/fetch.yo:401` `commit.substring(0, 12)` on a
git SHA; `src/codegen/exprs/async.yo:366`); every other endpoint is `0`,
`X.len()`, an `index_of` result, a byte-walk cursor, or a literal guarded by an
ASCII `starts_with`/`ends_with`. Only `async.yo:366` was live and wrong — §5.1's
new row. Two now-FALSE comments were corrected in passing
(`src/version_cache.yo:476` "String indices are rune-based",
`src/codegen/utils/index.yo:1402` "the rune-indexed substring"), and
`src/main.yo`'s `extract_bare_import_path` / `extract_import_path` /
`collect_import_paths_recursive` / `collect_module_deps` were found to be
**dead code with no caller in the tree** — which is the only reason their
unguarded `raw.substring(1, n - 1)` on an arbitrary Atom token is not a
reachable abort. Left in place; flagged, not deleted.

**2. Boundary policy, measured on every method rather than argued.** A new
exhaustive driver sweeps `0 ..= len+2` (and every `(a, b)` pair) over seven
strings — `aé中𝄞`, `你好世界你好`, `abc`, empty, `a`, `𝄞`, `aa中bb` — and asserts:
`is_char_boundary` equals the raw byte classification; `floor`/`ceil` land on
boundaries and bracket the input; `at` is `.Some` exactly at an in-range
boundary; `try_substring` is `.Some` exactly on a legal range and agrees with
`substring` there; every non-empty search result is an in-range boundary; a
mid-rune `position`/`end_position` never yields `true`; and `char_substring`
stays rune-exact. **Result: clean on all seven, with exactly one exception —
the empty needle (§1.4).** The panic arms were re-verified out-of-band and
EXTENDED beyond what PR 3 checked: `substring(1,2)`, `substring(2,3)`,
`substring(0,9)`, **`s(1 .. 2)`** and **`s(1 ..= 1)`** all exit 134 with a named
message, and `char_substring(1,2)` does not.

**3. `_has_prefix` / `_index_of_impl`: the "fixed by construction" claim
holds.** The pre-flip `_index_of_impl` was read at the parent commit and has
exactly the shape §1.3(a) describes (a `char_index` incremented on seeing a
lead byte inside a loop that also steps one byte, and a `char_index` returned).
The behavioural proof is the discrimination table below.

**4. The discrimination table was re-derived independently, not taken on
trust.** A pre-flip `std` was rebuilt by restoring ONLY
`std/string/string.yo` from the parent commit (confirmed: it is the one and only
`std/` file the flip touched) and every claim re-scored against it:

| | pre-flip `std` | flipped `std` |
| --- | ---: | ---: |
| `tests/string/string_byte_index.test.yo` | 4 / 15 | 19 / 0 |
| the same file, +2 tests added in this review | 4 / 17 | **21 / 0** |
| `tests/string/string.test.yo` | 217 / **36** | 253 / 0 |
| `tests/fs/dir.test.yo` | 13 / 1 | 14 / 0 |

So "36, not 20" and "13/1 → 14/0" are both exactly right. The `src/` half was
checked the same way: reverting `raw_token_value` to `t.character` scores
`tests/internal/formatter.test.yo` at **7 / 1**, and `t.byte_offset` at 8 / 0 —
the new formatter test is genuinely red-first, and it is the only in-tree gate
on the whole `Token.byte_offset` mechanism.

**5. LSP: the flip made it BETTER, and nothing worse.** Checked by hand, since
the cli-cases cannot see it. Every handler that only COMPARES columns
(`hover`, `definition`, `references`, `rename`, `symbols`, `doc/builder`,
`formatter`'s adjacency test) moved `len()` → `char_len()`, whose body IS
`len()`'s pre-flip body — inert. The three handlers that SLICE went through
`rune_col_to_byte_offset`, which returns a `char_indices` key or `line.len()`
and therefore **always a boundary**, so `line_text.substring(0, cur)` cannot
panic. `completion.yo`'s `ws` walk backs up over `_is_word_byte`, which is
ASCII-only, so it cannot land mid-rune either. And the pre-flip shape was
already mixed-basis — `cur` was a rune column clamped by a BYTE length and then
used as a byte index into `bytes` — so `ws`/`dot_before`/`prefix` were wrong on
any multibyte line before this PR and are right after it. `_ident_len_at` is
§5.1's 6th live bug and is likewise fixed. The UTF-16 gap of §5.4 is untouched
in either direction.

**6. Vacuous-green audit.** Every rewritten assertion in
`tests/string/string.test.yo` was read against the byte layout in its own
comment: the multibyte content sits BEFORE the asserted offsets in every case
(`at(2)`→`at(4)`, `at(1)`→`at(3)`, `substring(2,4)`→`substring(6,12)`, …), the
rune assertion is kept alongside under `char_len`/`char_substring`, and the
whole file scores 36 failures against the pre-flip `std` — which is the
mechanical proof that none of it is basis-invariant. Same for the new
`string_byte_index` file: 4 of its 21 tests pass on both bases, and those 4 are
exactly the ones that MUST (clamping, `try_substring`, `byte_at`/`Index`,
`split("")`).

**What this review changed:** the `async.yo` rune-cut fix + its corpus ratchet
(now **156** files, was 155); the two empty-needle doc corrections in
`std/string/string.yo` and two tests pinning them; two stale comments; one new
issue (`issues/async-effect-setter-emits-a-raw-non-ascii-identifier-as-a-c-member-name.md`,
pre-existing and unrelated to D4); one duplicate issue retired.

### 6.2 Which existing tests cannot catch this class

Per-test measurement (a test counts only if the **same test body** contains
both a non-ASCII literal and an index-basis call):

| file | tests | with multibyte | **multibyte + index API** |
| --- | ---: | ---: | ---: |
| `tests/string/string.test.yo` | 253 | 55 | **20** |
| `tests/regex/regex.test.yo` | 140 | 22 | **2** |
| `tests/encoding/utf16.test.yo` | 12 | 5 | **4** |
| `tests/encoding/json.test.yo` | 53 | 2 | **2** |
| `tests/internal/lexer.test.yo` | 43 | 3 | **2** |
| `tests/imm_string.test.yo` | 28 | 1 | **1** |
| `tests/index.test.yo` | 49 | 2 | **1** |
| `tests/string_multibyte_literal.test.yo` | 2 | 2 | **1** |
| `tests/string/string_char_api.test.yo` **(new, PR 1)** | 17 | 17 | **17** |
| `tests/imm_string.test.yo` **(PR 1 section)** | +6 | +6 | **+6** |
| `tests/string/rune.test.yo` | 36 | 0 | **0** |
| `tests/string/string_builder.test.yo` | 21 | 0 | **0** |
| `tests/string/string_parse.test.yo` | 28 | 0 | **0** |
| `tests/string/repeat_join_lines.test.yo` | 12 | 1 | **0** |
| `tests/format_specs.test.yo` | 7 | 1 | **0** |
| `tests/template_string_specs.test.yo` | 6 | 0 | **0** |

**≈ 33 tests repo-wide were the entire net** before PR 1; PR 1 added 23 more
that are multibyte-plus-index by construction, all of them on the NEW names, so
they guard the vocabulary and not yet the flipping methods. Consequences:

- ~~The `std/fmt/spec.yo` width regression (S2) has **zero** coverage —
  `tests/format_specs.test.yo` never pads a multibyte body. **Add it in PR 2.**~~
  **DONE 2026-08-26:** `tests/format_specs.test.yo` 7 → 13 tests, all six new
  ones multibyte (width, multibyte FILL runes, precision, width+precision
  composed, numeric padding, and `pad_numeric` called directly). Under a
  simulated byte flip they fail without the S2 migration and pass with it.
  **One of the six was vacuous as first written and was replaced in the review
  pass:** the "numeric padding measures … in characters" test asserted only
  through `Format::format`, and `String.format` routes a String body to
  `FormatSpec.pad`, **never** to `pad_numeric` — while the radix formatters only
  ever hand `pad_numeric` ASCII. So `pad_numeric`'s three `char_len()` calls
  (S2's un-listed lines 219-220) had **no** coverage at all. The replacement
  calls `FormatSpec.parse(...).pad_numeric(sign, prefix, digits)` directly with
  multibyte parts; every expected value differs under a byte basis, and the
  differing byte-basis value is written in a comment beside each assertion.
- **Also with zero coverage, and not on this list: `std/encoding/html.yo`.**
  `tests/encoding/html.test.yo`'s 8 tests put multibyte content only in the
  decoder's OUTPUT — every INPUT was ASCII, so the scanner's rune arithmetic
  was never exercised at all. For the file §5.2 calls the highest-risk in the
  tree, that is worse than the `spec.yo` gap. **DONE 2026-08-26:** 8 → 12
  tests, the four new ones running multibyte text through the scanner on both
  sides of every entity form and through the legacy-backtracking and
  invalid-code-point arms.
- **`src/parser.yo`'s `_peel_spec` (S4) had NO from-source coverage at all** —
  `tests/template_string_specs.test.yo` runs through the *installed* compiler,
  and `tests/internal/parser.test.yo` had no template-string test whatsoever.
  **DONE 2026-08-26 (review pass):** 49 → 52 tests there, the three new ones
  parsing `${名前:>8}`-shaped template strings from source and asserting the
  peeled rendering (`(名前.format)(">8")`). Measured discrimination: a
  differential driver holding the migrated peel, the pre-PR-2 peel, and the
  pre-PR-2 peel **under a byte-based slice** reports 35 cases, **0** mismatches
  between the first two (PR 2 is inert) and **12** cases where the third
  differs — i.e. the migration is load-bearing on 12 of 35 inputs once PR 3
  lands, and these tests are what will notice.
- The regex `index()` flip (S3) has 2 tests. **Add byte-offset assertions.**
- ~~`imm.String.len()` → bytes is guarded by **one** test
  (`tests/imm_string.test.yo:129`, "Unicode rune count"). **Add a byte battery
  in PR 4.**~~ **DONE 2026-08-26 (PR 4):** that one test is rewritten to assert
  both bases (`len()` bytes, `char_len()` runes) and a 10-test byte battery was
  added — `len` across all four UTF-8 widths, `len` agreeing with the std
  `String` byte count through `from_string`, `index_of` results AND
  `from_index` as byte offsets (including the verbatim empty-needle contract),
  `slice` byte offsets, `slice`+`index_of` composing in one basis, `at()` at
  every failure class, `byte_at` unchanged, `starts_with`/`ends_with`,
  `split` and `replace` with multibyte separators. 8 of the file's 44 tests
  fail against a pre-PR-4 `std/imm/string.yo`.
- ~~`tests/string/string.test.yo`'s **20** multibyte+index tests are the ones
  that must be *rewritten* (not deleted) in PR 3~~ — **DONE 2026-08-26, and the
  count was 36, not 20.** Running the file against the flipped `std` reported
  36 failures; every one was rewritten to byte offsets with the byte layout in
  a comment, and the rune assertion each one used to make was KEPT under
  `char_len()` / `char_substring()` rather than deleted, so the file now pins
  both bases. Three more files outside the survey's list also asserted rune
  lengths on multibyte content and were rewritten the same way:
  `tests/encoding/utf8.test.yo` (2 tests), `tests/string_multibyte_literal.test.yo`
  (1), and `tests/string/string_char_api.test.yo`'s cross-PR golden, which had
  been written as `char_len() == len()` and is now the two halves stated
  separately (rune values unchanged, byte values asserted). A repo-wide
  re-detection (every test block holding both a non-ASCII literal and an
  index-basis call on that same variable) found **nothing else** — the rest of
  the corpus is genuinely basis-invariant. The original list of 20 was:
  `String substring UTF-8 characters`, `… mixed ASCII and UTF-8`,
  `… with emojis`, `String index_of UTF-8 characters`, `… mixed …`,
  `… with emojis`, `String index_of with from_index UTF-8`,
  `String last_index_of UTF-8`, `String split UTF-8 …` (×5), and the
  `String.from` / `concat` / `+` UTF-8 tests that assert `len()`.
- Files listed as **ASCII-ONLY** while using ≥5 index-basis calls —
  `tests/collections/linked_list.test.yo` (49), `hash_set` (43),
  `internal/pkg_config` (23), `imm_map` (22), `imm_set` (17),
  `imm_sorted_set` (16), `imm_sorted_map` (15), `array` (12), `btree_map` (11),
  `net/dns` (10), `imm_list` (9), `ordered_map` (9), `variadic_comptime` (8),
  `priority_queue` (7), `internal/fetch` (6), `effect_analysis_types` (6),
  `array_list_convenience` (6), `os/env` (5), `encoding/base64` (5) — **will
  stay green through a completely wrong migration.** Do not read their
  greenness as evidence.

**Which test files can and cannot witness a `src/` migration.** `yo test` loads
`std/` from source but runs `src/` **through the installed compiler binary**. So
`tests/encoding/html`, `tests/format_specs`, `tests/string/*` and
`tests/imm_string` DO exercise PR 2's `std/` half, while `tests/comptime`,
`tests/index` and `tests/template_string_specs` exercise the **installed**
comptime builtins and parser — not the migrated ones. Their greenness is a
no-regression signal for the `std/` half and **nothing at all** for S4/S7/S10.
The only gates that witness the `src/` half are a rebuild (`yo build` /
`gates_fast.sh` / fixpoint) and, short of that, source-level body identity
(§6.1 item 2) plus a differential driver holding both implementations (what S4
got).

### 6.3 Gate battery per PR

Every PR: `yo fmt --check` on touched `.yo`, `yo check ./std && yo check ./src`.
PRs 1-2: full language suite + byte-identity corpus.
PR 3: full language suite + `tests/internal` for `lexer`/`parser`/`formatter`/
`doc_extractor`/`pkg_config`/`lock_file`/`build_runner` + `gates_fast.sh` +
`fixpoint_only.sh` + `hollow_sweep69.sh` ratchet + the §6.1 battery.
PR 6: regex suite + `vendor/markdown_yo` (its 3 failures are pre-existing).
PR 9: vendor companion commits pushed upstream **before** the pointer bump.

---

## 7. Corrections to `plans/STD_API_AUDIT.md` §D4

Three rows in the D4 section are wrong or incomplete; fix them when this plan
is adopted.

1. **"`starts_with(position)` is byte-indexed" — WRONG.** It is a char walk,
   and a broken one: `_has_prefix` (`std/string/string.yo:883`) stops one byte
   past the lead byte of char `position-1`. `_index_of_impl`'s `from_index`
   skip has the same defect. Evidence in §1.3(a). D4 fixes it by construction,
   but the audit should not claim the current behaviour is byte-indexed.

2. **The two-type comparison table omits `str` and `StringBuilder`, which are
   already byte-based.** `str.len()` = bytes (`std/prelude.yo:5756`),
   `str.slice_copy` = byte range (`:5772`), `StringBuilder.len()` = bytes
   (`std/string/string_builder.yo:45`). The disagreement is **2-vs-2**, not
   1-vs-1, and D4 puts `String` on the majority side. This is a better
   argument than the one the audit makes.

3. **"Code moved between them — or an offset from one fed into the other's
   slice — is silently wrong" — describes an UNREALIZED hazard.** Measured:
   zero cross-type index feeds, and `imm.String` has zero production
   consumers. The imm half of D4 is cheap insurance, not a bug fix. Say so —
   it changes how the work should be prioritized (PRs 4-5 are low-urgency and
   can land after PR 3 rather than blocking it).

**Scope judgement:** the audit's scope is **right in extent but understated in
depth**. It names the right methods, but it does not mention: the `Pattern`
trait's five index-carrying signatures, `slice_copy`/`slice_copy_inclusive`
(the `s(a..b)` sugar), the comptime string builtins that ride on `substring`,
`Token.character`'s open byte-indexing audit, or `RegexMatch.index()`'s public
basis change. Those five are added here.

---

## 8. UNMEASURED

Stated so nothing here reads as more certain than it is.

- **Exact `String.len()` call-site count.** Bounded to 500-1050 in `src/`
  (§2.2); not exact. A `yo check`-driven type-directed count would settle it
  and is worth building once as a throwaway.
- ~~**`std/http/http.yo`, `std/http/client.yo`, `std/encoding/toml.yo`,
  `std/fs/dir.yo`, `std/path.yo`** — 14 `substring` sites not individually
  classified. Assume RISK.~~ **CLASSIFIED in PR 2 (2026-08-26).** 13 of the 14
  are INVARIANT: `http.yo:156,165,166,190,191` and `client.yo:157,161` pair an
  `index_of` result with a `substring` in the same basis, or slice to
  `X.len()`; `toml.yo:120,165` strip ASCII `"`/`[`/`]` delimiters with
  `substring(1, len-1)`, where both endpoints are one ASCII byte in from an end
  and so name the same cut in either basis; `toml.yo:178,179` and
  `path.yo:251,278` are `index_of`/`last_index_of` results fed straight back.
  **The 14th, `std/fs/dir.yo:121`, is not INVARIANT — it is a LIVE BUG**, now
  listed in §5.1.
- **`src/doc_command.yo:223-253`** — the char-at-a-time `build.yo` scanner;
  classified REVIEW, not proven.
- **`vendor/markdown_yo`** — 2 `substring`, 19 heuristic `String.len()`, 4
  hand-rolled UTF-8 decoders. Not classified. Needs upstream companion
  commits, so it is scheduled last (PR 9) regardless.
- **Runtime cost of the flip.** `len()` goes O(n) → O(1), which should be a net
  win in the compiler (it is called ~500-1000 times in `src/`), and regex loses
  four O(n) walks per match. **STILL NOT MEASURED after PR 3** — no before/after
  A/B was run, deliberately, because the machine was shared with a verification
  battery and a footprint A/B is worthless under contention (see the metric-trap
  note: measure in tracked live bytes, not RSS). The one datum PR 3 does have is
  that a stage-2 emit took 2:24 and the full seed→stage-1 build 3:43, both
  unremarkable. Note the flip also ADDS 8 bytes per `Token` (`byte_offset`) —
  `Token` is an Rc object embedded in every `AstExpr`, so this is a real if
  small footprint cost that an A/B would net against `len()`'s savings.
- ~~**`tests/cli-cases` goldens.** Not checked for embedded lengths or offsets
  that would move.~~ **CHECKED IN PR 3: nothing moved.** `gates_fast.sh` GATE 7
  scored `PASS 52  GOLDEN-DIFF 0  NO-GOLDEN 0  SKIP 1 (total 53)` against the
  flipped compiler, so no re-record was needed. The codegen corpus (GATE 2) did
  report one GOLDEN-DIFF — `tests/codegen-bootstrap/template_multibyte.yo`,
  whose whole purpose is to print a rune count and a byte count. It was fixed by
  changing the SOURCE to say `char_len()` for the rune figure and `len()` for
  the byte figure, which leaves the recorded golden (`chars=15 bytes=17`)
  **byte-identical** — the file still discriminates, and no golden in the tree
  was re-recorded for this PR.
