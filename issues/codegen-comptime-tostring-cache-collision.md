# Multiple `println`/`to_string` of comptime-constant values collide (CTFE cache)

## Status
OPEN — surfaced 2026-06-17 once single-type integer `println` started working
(const-generic Array.fill + variadic-arg + array-index-address-of fixes). Single
calls are correct; MULTIPLE calls in one compilation unit collide.

## Symptom
```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({ println(i32(7)); println(i32(9)); });   // self: 7/9 — TS: 7/9
```
Self-hosted output: `7` then `7` (the FIRST value reused). Other combos:
- `println("cd"); println("ef")`  → `cd/ef` ✓ (str is fine)
- `println("cd"); println(i32(7))` → `7/7`  ✗ (str call printed the int's value)
- `println(i32(7)); println(i32(9))` → `7/7` ✗

So when two `println`/`to_string` calls take **comptime-constant** arguments, the
SECOND (and the str-vs-int mix) reuses the FIRST call's folded result.

## Suspected root
`i32(7)` / `usize(42)` / a string literal are comptime-known, so integer
`to_string` (`std/fmt/to_string.yo`, the `snprintf` buffer path) is CTFE-executed
and its result MEMOIZED. The CTFE memo key (`_ctfe_args_equal` and the
comptime-fn cache, `evaluator/calls/comptime_fn.yo`) does not include the `self`
VALUE (7 vs 9) — only the type — so `to_string(7)` and `to_string(9)` hit the same
cache entry. This mirrors the prior HashMap.new cache-collision
(`yo-self-phase3-hashmap-new-blocker`: lenient `are_types_compatible` made distinct
concrete args compare equal). The str-vs-int cross-talk suggests the cached
ExprInfo/value node is shared across DIFFERENT specializations too.

Note: `to_string` on a runtime (non-constant) integer should NOT be CTFE'd at all
(it allocates / calls snprintf) — so part of the fix may be to NOT comptime-execute
`to_string` over a constant just because the arg is constant, OR to key the memo on
the concrete argument VALUE.

## Minimal repro
`/tmp/c_ii.yo` above. Single-call repros (`/tmp/q2.yo` = `println(i32(7))`) work
and print `7`.

## Next steps
1. Find where the `to_string`/println call result is memoized for a comptime arg
   (comptime_fn.yo CTFE cache / `_ctfe_args_equal`).
2. Either include the concrete arg VALUE in the cache key, or stop CTFE-folding
   `to_string` over a comptime-constant integer (emit the runtime call instead).
3. Add a corpus fixture (`println(i32(7)); println(i32(9))` differential) once fixed.

Validate: `/tmp/c_ii.yo` self output `7`/`9` matching TS, corpus + std sweep + tests.
