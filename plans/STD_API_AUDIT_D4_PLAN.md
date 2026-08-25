# D4 — String indexing model: the executable migration plan

> **Status:** **PR 1 LANDED 2026-08-26**; PRs 2-9 still PLAN.
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
| `len()` | 126 | **C**, O(n) | **B**, O(1) | 🔴 **SILENT** |
| `at(index) -> Option(rune)` | 311 | **C** | **B** (decode at byte offset) — see §1.4 O1a | 🔴 **SILENT** |
| `substring(start, end)` | 497 | **C** | **B** | 🔴 **SILENT** |
| `slice_copy(Range)` — the `s(a..b)` sugar | 485 | **C** (delegates to `substring`) | **B** | 🔴 **SILENT** |
| `slice_copy_inclusive(RangeInclusive)` | 489 | **C** | **B** | 🔴 **SILENT** |
| `index_of(p, from_index?) -> Option(usize)` | 1690 → `_index_of_impl` 555 | **C** in *and* out | **B** in and out | 🔴 **SILENT** |
| `last_index_of(p, from_index?)` | 1693 → 769 | **C** | **B** | 🔴 **SILENT** |
| `contains(p, from_index?)` | 1687 → 651 | **C** (`from_index` only) | **B** | 🔴 **SILENT** (only when the 2nd arg is passed) |
| `starts_with(p, position?)` | 1681 → `_has_prefix` 883 | **C** — *and buggy*, see §1.3 | **B** | 🔴 **SILENT** |
| `ends_with(p, end_position?)` | 1684 → `_ends_with_impl` 966 | **C** (`self.len()` char length) | **B** | 🔴 **SILENT** |
| `Pattern.is_prefix_of / is_suffix_of / is_contained_in / index_in / last_index_in` | 1621-1625 | **C** | **B** | 🔴 **SILENT** — public trait, 5 signatures |
| `bytes_len()` | 464 | **B** | **B** (becomes an alias of `len()`) | 🟡 redundant; keep as deprecated alias |
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
| `len()` | 83 | **C**, O(n) | **B**, O(1) (`self._len`) | 🔴 **SILENT** |
| `bytes_len()` | 79 | **B** | fold into `len()`; keep as deprecated alias | 🟡 |
| `slice(start, end)` | 199 | **B** | **B** | ✅ already right |
| `index_of(needle, from_index)` | 255 | **B** | **B** | ✅ already right |
| `byte_at(index)` | 116 | **B** | **B** | ✅ |
| `at(index) -> Option(rune)` | 577 | **C** | **B** (mirror `String.at`) | 🔴 **SILENT** |
| `starts_with` / `ends_with` / `contains` | 217/235/286 | no position arg | — | ✅ |
| `split` / `trim*` / `replace*` / `repeat` | | — | — | ✅ |
| ~~`chars()` / `char_indices()` / `char_len()`~~ | 672/676/683 | — | new | ✅ **LANDED PR 1** |
| ~~`is_char_boundary` / `floor_char_boundary` / `ceil_char_boundary` / `try_substring`~~ | 707/723/747/773 | — | **B** | ✅ **LANDED PR 1** |

The audit's claim that "applying D4 to `imm.String` is SMALL" is **confirmed**:
one silent flip (`len()`), one alias fold, one `at()` alignment, three additions.

### 1.3 Two contract defects found while tabling (report these, don't inherit them)

**(a) `starts_with(prefix, position)` is broken for multibyte haystacks today.**
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
- Three test files: `tests/imm_string.test.yo`, `tests/imm_vec.test.yo`,
  `tests/imm_threading.test.yo` — the last already writes
  `{ String : ImmString } :: import("std/imm/string")` (line 19), i.e. the
  rename is what consumers already do by hand.
- Docs: `docs/{en-US,zh-CN}/IMMUTABLE_COLLECTIONS.md` lines 24, 57, 109, 155.

The rename is a **~15-line PR**. Do it standalone.

### 2.5 Docs / instructions surface

Only three places state the current contract in prose:

| file | line | disposition |
| --- | ---: | --- |
| `.github/skills/yo-syntax/syntax-cheatsheet.md` | 1456-1475 | **Whole section inverts.** Currently: "`len()`/`substring`/`index_of` are RUNE-based … never mix". After D4 the rule becomes "everything is bytes; use `chars()`/`char_indices()`/`char_len()` for runes". |
| `.github/skills/yo-syntax/syntax-cheatsheet.md` | 995 | "Width counts CHARACTERS" — **stays true** only if `std/fmt/spec.yo` is pinned to `char_len()` (§5.2-S2). |
| `docs/{en-US,zh-CN}/INDEX_TRAIT.md` | 236 | already says `Index` returns a byte — **stays correct**. |
| `docs/{en-US,zh-CN}/DESIGN.md` | 1397 / 1389 | "`chars()` (rune iteration) / `bytes()` (byte iteration)" — **stays correct**, extend with `char_indices()`. |

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
| `src/doc_command.yo:223,231,235,242,253` | `content.substring(j, j + usize(1))` char-at-a-time scan of `build.yo` text | a 1-**byte** slice compared against `` ` ` `` etc. — works only because the delimiters are ASCII, but the *cursor* `j` advances by 1 per byte, so multibyte values inside a build.yo string are mis-scanned. **REVIEW** — likely fine, prove it |
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
| **2** | **Pin char semantics, no basis change.** Rewrite the §3.1-RISK and §5.2 sites to the new char APIs: `std/encoding/html.yo` `at()` loops → `chars()`; `std/fmt/spec.yo` width/precision → `char_len()` + `truncate_chars`; `src/error.yo:43` → `char_len()`; `src/doc/render_html.yo:406` → `truncate_chars`; `src/parser.yo:_peel_spec` → `char_indices()`; comptime string builtins pinned to explicit char helpers (O1c). **Because `char_len() == len()` today, this PR must not change one byte of behaviour.** | full language suite; **emitted-C equivalence of the corpus** — NOT literal byte-identity, which PR 1 measured to be unattainable for any `std` edit; use the normalized comparison in the §6.1 correction |
| **3** | **The flip.** `String.len()` → bytes O(1); `at`/`substring`/`slice_copy*`/`index_of`/`last_index_of`/`contains(from)`/`starts_with(pos)`/`ends_with(pos)`/`Pattern`'s five methods → bytes. `bytes_len()` becomes a deprecated alias. Fix §1.3(a) by construction. `src/` migrates **in the same PR** — the repo build compiles `src/` against the *repo's* `std` (`--std-path > YO_STD > exe-walk-up > ./std`), so it cannot lag. Add `Token.byte_offset` and retire `_byte_offset_of_char_index` (`src/formatter.yo:1496`). | `yo check ./std && yo check ./src`; full language suite; `tests/internal`; `gates_fast.sh` + fixpoint; new §6 multibyte battery |
| **4** | `imm.String`: `len()` → bytes, `at()` aligned, `bytes_len()` aliased, `chars()`/`char_indices()`/`char_len()` wired. | `tests/imm_string.test.yo` (rewritten per §6.2), `imm_vec`, `imm_threading` |
| **5** | `imm.String` → `ImmString` rename. ~15 lines: the `String ::` binding + `export`, 3 test imports, 4 doc lines × 2 languages. | suite + docs both languages |
| **6** | **Regex.** Delete `_byte_to_char_index` (`std/regex/index.yo:70`) and the three char→byte re-walks at `:535-545`, `:582-592`, `:634-644`. `RegexMatch.index()` becomes a **byte** index — a silent public API change that needs its own release note. Adopt `std/encoding/utf8.yo`. | `tests/regex/regex.test.yo` + new multibyte index assertions |
| **7** | **Comptime basis** (O1c): align `comptime_str.len()`/`slice`/`s[i]` with the runtime basis, or document the split deliberately. **Seed note:** the seed binary evaluates the *new* tree's comptime code with the *old* engine while building stage 1. Measured safe: every `comptime_str` use in `std/` + `src/` is ASCII (`std/build.yo` option names; `tests/comptime.test.yo` `len()` assertions are ASCII), so the flip is not seed-gated. | fixpoint (`s2 == s3`) is the real gate here |
| **8** | Docs + skills sweep: rewrite `.github/skills/yo-syntax/syntax-cheatsheet.md:1456-1475`, extend `docs/{en-US,zh-CN}/DESIGN.md:1397/1389`, update `IMMUTABLE_COLLECTIONS.md`, add a `docs/*/STRINGS.md` stating the byte contract + boundary policy in both languages. | `yo fmt --check`; both language versions present |
| **9** | Dedup the 10 hand-rolled UTF-8 sequence-length decoders onto `std/encoding/utf8.yo`: `std/imm/string.yo`, `std/regex/{parser,index,vm}.yo`, `std/string/string.yo`, `src/formatter.yo`, `vendor/markdown_yo/src/{inline/link,common/normalize_link,block/reference,common/utils}.yo`. Vendor needs **companion upstream commits** + a pointer bump. | suite; vendor's 3 pre-existing failures stay pre-existing |

**Ordering constraints, explicitly:**

- PR 1 **must** precede PR 2 (`char_indices()` is what PR 2 migrates onto). ✅ done.
- **PR 1 did NOT ship `truncate_chars`.** §4 PR 2 names it for S2/S6 but §4 PR 1
  does not list it, so it was deliberately left out. PR 2 either adds it (as a
  `char_len` + `floor_char_boundary` + `try_substring` composition — the shape is
  covered by `tests/string/string_char_api.test.yo`'s last test) or migrates
  those two sites without it.
- **`try_substring` is BYTE-based from day one**, while `substring` is still
  character-based until PR 3. That is intentional: a NEW name can carry the final
  contract, and a new name that flipped basis under its callers in PR 3 would be
  exactly the silent hazard this plan exists to avoid. PR 2 must not reach for
  `try_substring` as a drop-in for `substring`; its migration targets are
  `char_len()` and `char_indices()`.
- PR 2 **must** precede PR 3. This is the whole safety argument: after PR 2,
  every site that *needs* char semantics says so in its own source, so PR 3's
  review question collapses to "does this site want bytes?" — and the answer
  is yes everywhere left.
- PR 3 is the only PR that cannot be split across `std` and `src`.
- PR 6 can land before or after PR 3 **only if** it lands after — regex's
  `index()` is consumed by its own `replace*` which re-walks; splitting them
  leaves a half-converted state. Keep 6 after 3.
- PR 0 is not on the critical path for PR 2 or PR 3; it is on the critical path
  for PR 1's `is_char_boundary` and for PR 6 and PR 9.

---

## 5. The trap list

### 5.1 (a) `len()` bound mixed with a byte loop — **7 confirmed live bugs D4 FIXES**

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
reading:

| site | shape | verdict |
| --- | --- | --- |
| `src/main.yo:789-802` `_win_dirname` | `while(di < p.len())` + `p.byte_at(di)`, then `p.substring(0, last_sep)` with a **byte** `last_sep` | **LIVE BUG**: any non-ASCII path component under-walks and returns the wrong dirname. D4 fixes it. |
| `src/main.yo:852-866` `_path_has_extension` | identical shape | **LIVE BUG**. D4 fixes it. |
| `src/install_command.yo:60` | `s.substring(usize(0), s.bytes_len() - usize(4))` | **LIVE BUG**: char slice, byte end. D4 fixes it. |
| `src/install_command.yo:66` | `s2.substring(idx + usize(1), s2.bytes_len())` — `idx` from char `last_index_of` | **LIVE BUG** (two bases in one call). D4 fixes it. |
| `src/pkg_config.yo:34-66` `_split_whitespace` | `n := bytes.len()`, walks `k` over bytes, then `s.substring(start, k)` | **LIVE BUG**. D4 fixes it. |
| `src/lsp/diagnostics.yo:72-89` `_ident_len_at` | rune `col` indexed into `line.as_bytes()` | **LIVE BUG**, **NOT fixed by D4** — `col` stays a rune column. Needs the `Token.byte_offset` work (PR 3). |
| `std/fmt/writer.yo:42` | `while(i < s.len())` + `s.bytes(i)` | **false positive** — `s : str`, whose `len()` is already bytes. Clean. |

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
| **S1** | `std/encoding/html.yo:34, 52, 80, 92, 99, 106, 117, 140, 151, 175, 185` | `while(i < s.len())` + `s.at(i).unwrap()` over **arbitrary HTML text**. After the flip `at()` at a continuation byte is `.None` → `.unwrap()` **panics**. Highest-risk file in the tree. | rewrite the three loops onto `char_indices()`; also removes today's O(n²) |
| **S2** | `std/fmt/spec.yo:36, 69, 206-207` | `width` is documented "Minimum width in **CHARACTERS**"; `_apply_width` uses `text.len()`, `pad` truncates with `substring(0, p)`. After the flip padding counts bytes and precision can split a codepoint. Rust counts chars here. | `char_len()` + boundary-safe `truncate_chars` |
| **S3** | `std/regex/index.yo:70, 144` + `:535-545, 582-592, 634-644` | `RegexMatch.index()` is a **char** index produced by an O(n) `_byte_to_char_index` per match, then converted **back** to bytes by three more O(n) walks in `replace`/`replace_all`. `replace_all` is O(n·m) purely from basis conversion. | delete all four walks; `index()` becomes a byte index (public API change — release note) |
| **S4** | `src/parser.yo:517-546` `_peel_spec` | rune indices from an `ArrayList(rune)` fed to `text.substring` | `char_indices()` |
| **S5** | `std/string/string.yo:662-676` `_split_impl`, empty-separator arm | `self.substring(i, i+1)` per char, bounded by `self.len()` — "split into characters". Must stay **char**-based or `split("")` returns invalid-UTF-8 fragments. | pin to `char_indices()` |
| **S6** | `src/doc/render_html.yo:404-406` | fixed 120-unit cut of arbitrary doc text | `truncate_chars(120)` |
| **S7** | `src/error.yo:43` | rune column + token-value length | `char_len()` |
| **S8** | `src/doc/builder.yo:233-235` | `Token.character` (rune) into `substring` | `Token.byte_offset` |
| **S9** | `src/lsp/completion.yo:762-780, 875, 1010` | LSP `character` into `substring` | see (c) below |
| **S10** | comptime string builtins (4 sites, §1.4 O1c) | semantics ride on `substring` | pin, then decide in PR 7 |

### 5.3 (b) regex `_byte_to_char_index` — see S3

It costs **two** conversions, not one: byte→char at match construction
(`:144`), and char→byte again in each of `replace`, `replace_all` and
`replace_all_fn` (`:535`, `:582`, `:634`). D4 deletes all of them. The
observable change is `RegexMatch.index()`: `Regex.find("héllo", "llo").index()`
goes from `3` to `4`. Coverage today: `tests/regex/regex.test.yo` has 140
tests, 22 with multibyte content, but **only 2** that combine multibyte with an
index-basis API — so this flip is nearly unguarded (§6.2).

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
  `src/` is ASCII.
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

Plus, for PR 2 specifically: **byte-identity of the emitted-C corpus**. PR 2
claims to change no behaviour; record `sha256` of every `.c` before editing and
require `same=N diff=0`. That is the repo's standing acceptance test for an
"additive" codegen change and it makes the PR-2 review free.

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

- The `std/fmt/spec.yo` width regression (S2) has **zero** coverage —
  `tests/format_specs.test.yo` never pads a multibyte body. **Add it in PR 2.**
- The regex `index()` flip (S3) has 2 tests. **Add byte-offset assertions.**
- `imm.String.len()` → bytes is guarded by **one** test
  (`tests/imm_string.test.yo:129`, "Unicode rune count"). **Add a byte battery
  in PR 4.**
- `tests/string/string.test.yo`'s **20** multibyte+index tests are the ones
  that must be *rewritten* (not deleted) in PR 3 — they are the strongest
  existing signal and their expected values all change. Named in the survey:
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
- **`std/http/http.yo`, `std/http/client.yo`, `std/encoding/toml.yo`,
  `std/fs/dir.yo`, `std/path.yo`** — 14 `substring` sites not individually
  classified. Assume RISK.
- **`src/doc_command.yo:223-253`** — the char-at-a-time `build.yo` scanner;
  classified REVIEW, not proven.
- **`vendor/markdown_yo`** — 2 `substring`, 19 heuristic `String.len()`, 4
  hand-rolled UTF-8 decoders. Not classified. Needs upstream companion
  commits, so it is scheduled last (PR 9) regardless.
- **Runtime cost of the flip.** `len()` goes O(n) → O(1), which should be a net
  win in the compiler (it is called ~500-1000 times in `src/`), and regex loses
  four O(n) walks per match. **Not measured.** Worth an A/B on
  `compile src/main.yo --skip-c-compiler` before and after PR 3 — but measure
  in tracked **live bytes / peak footprint**, not RSS.
- **`tests/cli-cases` goldens.** Not checked for embedded lengths or offsets
  that would move. Re-record and re-run the **full** scorecard if any case
  shifts; a NO-GOLDEN vacuous match is a real bug, not a pass.
