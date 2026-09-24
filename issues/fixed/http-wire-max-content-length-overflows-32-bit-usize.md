# `std/http/wire.yo`'s `_MAX_CONTENT_LENGTH` does not fit a 32-bit `usize`

**Found:** 2026-09-25 by the develop battery's two wasm legs (`test-wasm32_wasi`,
`test-wasm32_emscripten`), red since #876; reported by the peer session.
**Status:** FIXED 2026-09-25.
**Class:** latent 32-bit bug in std, exposed by a new check.

## Symptom (MEASURED)

`yo test tests/http/wire.test.yo --target wasm32-wasip1` on develop `b03c8b741`:

```
error[E1102]: Integer overflow: the compile-time value 1152921504606846975 does not fit in usize (0..=4294967295)
    --> std/http/wire.yo:178:30
```

Native (64-bit) targets were unaffected.

## Root cause

`_MAX_CONTENT_LENGTH :: usize(0x0FFFFFFFFFFFFFFF);` is a 64-bit constant. Before #876
(`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 1.4, `issues/fixed/context-typed-integer-literal-is-not-range-checked.md`)
a literal was never range-checked against its context type, so the wasm32 build compiled a
value that does not fit. REASONED, not measured: if it reached C as the truncated `0xFFFFFFFF`,
the parser's no-wrap argument (`n <= MAX / 10` before `n * 10 + digit`) no longer holds on 32-bit —
`429496729 * 10 + 9` wraps — so an oversized `Content-Length` could wrap to a small length instead
of being rejected. The new target-aware check turned it into a compile error.

## Fix

`_MAX_CONTENT_LENGTH :: (usize.MAX >> usize(4));` — the same `0x0FFFFFFFFFFFFFFF` on a 64-bit
target, `0x0FFFFFFF` (~268 MB) on a 32-bit one; `(MAX >> 4) + 9 < MAX` at every width, so the
accumulation cannot wrap.

Swept the tree for other `usize`/`isize` literals wider than 32 bits: the only others are the
64-bit arms of the prelude's `usize.MAX` / `isize.MAX` `cond`s, which are not evaluated on a
32-bit target.

## Verification

`yo test tests/http/wire.test.yo --target wasm32-wasip1` (wasmtime): 7 passed; E1102 with the old
constant. Native `wire.test.yo` unchanged. The wasm legs of the fast suite are the regression test.
