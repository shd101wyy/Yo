# std/encoding/html is untestable: clang crashes compiling the emitted entity-map builder

**Status: FIXED 2026-08-24 (branch std-s0-correctness).** All three plan steps
landed:

1. `html_entities.yo` rewritten to STATIC DATA — one ASCII blob of
   `name,cp[,cp];` records (27.5 KB) parsed by a ~30-line loop, in place of
   the ~2,125 straight-line `map.set(...)` calls (2,256 → 76 lines). The
   blob is a function-local backtick literal (a module-level `X :: `-string
   is rejected: "Expected compile-time value" — `::` constants must be
   comptime, and a String literal is a runtime RC construction). Emitted C
   is one string literal + a small loop; clang at -O0 is fine with it.
2. The prepared test suite landed as `tests/encoding/html.test.yo`
   (8 tests, extended with static-table spot checks: first/last entries,
   a two-code-point entity, legacy longest-prefix matching) — all green.
3. The `// TODO: proper break` overflow hacks in `decode_html` replaced
   with plain `scanning` flags (three sites: hex scan incl. its
   double-pass "fix digit_end" decoder, decimal scan, named-entity scan).

**Bonus data bug found by re-encoding:** the old table carried
`generic → U+2200 (∀)` where the HTML5 spec has `forall` — an
alphabetical-order violation between `fopf`/`fork` exposed the mangled
rename; `forall` was absent entirely, so `&forall;` never decoded.
Fixed in the regenerated blob; regression test in the new suite.

Found 2026-08-22 while writing the FIRST tests for
`decode_html` (S0 C11 groundwork) — which is why the module had zero tests.

## Symptom

Any `.test.yo` importing `std/encoding/html` produces a batch C file whose
compile first runs for ~15+ minutes and then dies:

```
clang: error: clang frontend command failed due to signal (use -v to see invocation)
yo: error: compile: C compiler failed (exit 1) on tests/encoding/.yo_selftest_batch_1_0.bin.c
```

(macOS arm64, clang 21.1.7 via nix; test batches compile at -O0.)

## Root cause

`std/encoding/html_entities.yo` (2,256 lines, ~2,125 entries) builds its
entity `HashMap` + legacy `HashSet` AT RUNTIME: `_build_entity_map` is one
straight-line function of ~2,125 `map.set(...)` calls. The emitter turns
that into a single colossal C function; at -O0 every temporary gets its own
stack slot, and clang's frontend dies on it (signal — stack/OOM class, the
same giant-frame pathology as AGENTS.md's -O0 deep-recursion pitfall, here
at compile time instead of run time).

The audit already flags the runtime build for replacement
(plans/STD_API_AUDIT.md §4 encoding row): a comptime/static table also
removes the lazy `_state_initialized` module global.

## Plan

1. Rewrite `html_entities.yo` to static data (comptime-built sorted array +
   binary search, or a perfect-hash/static initializer emission) so no
   runtime mega-function exists.
2. Land the prepared `decode_html` test suite — saved verbatim below — as
   `tests/encoding/html.test.yo`.
3. Then do the C11 scan-loop rewrite in `decode_html` (the
   `// TODO: proper break` overflow tricks in `std/encoding/html.yo` —
   contorted but analyzed functionally correct; blocked on having tests).

## Prepared test suite (behavior-locking, verified against a code read)

```rust
{ assert } :: import("std/assert");
open(import("std/string"));
{ decode_html } :: import("std/encoding/html");
test("named entities decode", {
  assert(decode_html(String.from("a &amp; b")) == `a & b`, "amp");
  assert(decode_html(String.from("&lt;p&gt;")) == `<p>`, "lt/gt");
  assert(decode_html(String.from("&quot;x&quot;")) == `"x"`, "quot");
});
test("decimal numeric entities decode", {
  assert(decode_html(String.from("&#65;")) == `A`, "decimal with semicolon");
  assert(decode_html(String.from("&#65&#66;")) == `AB`, "unterminated decimal still decodes");
  assert(decode_html(String.from("x&#65Zy")) == `xAZy`, "decimal terminated by non-digit");
});
test("hex numeric entities decode", {
  assert(decode_html(String.from("&#x41;")) == `A`, "hex with semicolon");
  assert(decode_html(String.from("&#X41;")) == `A`, "capital X form");
  assert(decode_html(String.from("x&#x41Zy")) == `xAZy`, "hex terminated by non-digit");
  assert(decode_html(String.from("&#x1F600;")) == `😀`, "supplementary-plane hex");
});
test("digits running to end of input decode", {
  assert(decode_html(String.from("&#65")) == `A`, "decimal at EOF");
  assert(decode_html(String.from("&#x41")) == `A`, "hex at EOF");
});
test("malformed numeric entities stay literal", {
  assert(decode_html(String.from("&#x;")) == `&#x;`, "hex marker with no digits");
  assert(decode_html(String.from("&#;")) == `&#;`, "no digits at all");
  assert(decode_html(String.from("a & b")) == `a & b`, "bare ampersand passes through");
  assert(decode_html(String.from("&")) == `&`, "trailing ampersand");
  assert(decode_html(String.from("&#")) == `&#`, "trailing numeric marker");
});
test("invalid code points keep the original entity text", {
  assert(decode_html(String.from("&#xD800;")) == `&#xD800;`, "surrogate kept literal");
});
```
