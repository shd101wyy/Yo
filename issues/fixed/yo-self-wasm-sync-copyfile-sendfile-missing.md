# yo-self's wasm C runtime template omits `__yo_sync_copyfile`/`__yo_sync_sendfile` — "call to undeclared function" on the emcc leg

**Status: FIXED 2026-08-16** (the `test-wasm32_emscripten` leg's second
`--bail` casualty on PR #127: `tests/sys/copy.test.yo`, batch 141).

`runtime_io_common.yo` ported the Linux and macOS arms of the two sync
helpers but not the wasm arms TS has (runtime-io-common.ts:269-296 copyfile
via MEMFS open/fstat + `__yo_sendfile_fallback_copy`; :323-329 sendfile =
the fallback copy directly). The generated code calls both on every target,
so the wasm C failed with implicit-declaration errors. Fixed by porting both
arms verbatim.

Verified: `tests/sys/copy.test.yo` 2/2 under `--c-compiler emcc` (with the
io-future Concrete fix landing alongside —
`issues/yo-self-io-future-return-type-mismatch.md`).
