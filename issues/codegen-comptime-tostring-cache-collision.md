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

## Update (2026-06-17) — split into TWO sub-bugs; (A) FIXED, (B) open
Root-caused by inspecting the emitted C — it is NOT a CTFE *result* memo. Two distinct bugs:

### (A) Same-type, different-value baking — ✅ FIXED (helper.yo)
`println(i32(7)); println(i32(9))` both printed `7`. The specialized `println<i32>`
body had the FIRST call's constant baked in: `to_string(&(int32_t){7})` instead of
referencing its parameter `v`. Cause: `create_specialized_function_inline` evaluates
the body in `callee_env` where `try_to_call` had bound `v` to the call's ARG VALUE —
fine for a one-shot call, but a specialized function is reused across calls, and a
comptime-constant arg (IntLit 7) got folded into the body. (`comptime_str` args coerce
to a runtime `str` UnknownVal, which is why `str` never baked.) FIX: before the spec
body eval, re-bind each regular param whose current binding is a FOLDED COMPTIME
CONSTANT (value Some and NOT UnknownVal) to a runtime `UnknownVal` of its specialized
type. GUARD is essential: an unconditional rebind perturbed the specialization identity
of `str` params and regressed a str `println` to an undeclared specialized callee — only
folded-constant params may be rebound; already-runtime (UnknownVal) params are left
untouched. Result: `c_ii` → `7/9` ✓, str multi-call stable 5/5.

### (B) Cross-type collision (str + int in one unit) — OPEN
`println("cd"); println(i32(7))` → self `<garbage>/7` (TS `cd/7`). When BOTH a `str`
and an `i32` specialization of the same generic `println` exist in one compilation
unit, the `str` call mis-dispatches (emits the generic `void*` callee, or an int
specialization, producing garbage). This is a specialization-CACHE-KEY collision
(`compute_compile_time_signature` / `specialized_fn_caches`): `println<str>` and
`println<i32>` hash/compare equal, so the second-type call reuses or clobbers the
first. Mirrors the prior HashMap.new cache-collision (`_ctfe_args_equal` /
name-only struct comparison being unsound for cache identity). NEXT: inspect
`compute_compile_time_signature` (helper.yo:~642) and `_find_cached_specialization`
(helper.yo:~759) — ensure the signature/key includes the concrete runtime param TYPES
distinctly (str vs i32). Add a `println("cd"); println(i32(7))` fixture once fixed.

## Update 2 (2026-06-17) — §B partially addressed; nested method dispatch is the residual
Fixed the `println` FUNCTION-call signature to include concrete runtime param types
(compute_compile_time_signature: was gated on `type_contains_some_type`, now includes
every non-unit runtime param type — mirrors TS's `paramType.id || typeContainsSomeType`,
since yo-self TypeValue has no numeric `.id`). This disambiguates `println<str>` /
`println<i32>` / `println<usize>` so MULTI-INT and int-vs-usize calls print correctly
(mix: `7`/`42` now correct, previously all-collided). RESIDUAL: a `str` println FOLLOWED
by an `i32` println still prints a garbage number for the str (`println("cd");
println(i32(7))` → `<ptr-as-int>/7`). The garbage = the str's byte pointer fed to
`snprintf("%d")`, i.e. the str println's nested `v.to_string()` dispatched to
`to_string<i32>` instead of `to_string<str>`. So the residual is in the METHOD-dispatch
specialization/caching for `to_string` (the `g_method_callee_values` side-table /
method specialization key), NOT the function-call signature. NEXT: the to_string method
dispatch must key by the receiver's concrete type so `to_string<str>` and `to_string<i32>`
don't collide when both exist. (Note: the same-type value-baking fix's param-rebind
changed this case from `7`/`7` to `<garbage>`/`7` — both wrong; the cross-type method
dispatch was never correct.)
