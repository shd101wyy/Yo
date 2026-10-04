# The LSP's stdin `poll` declaration breaks the compiler build on macOS

**Severity:** S1. `develop` did not build on macOS: stage 1 failed in clang, so no compiler could be produced from the tree there.

**Status: FIXED 2026-10-04.** Introduced by #1171, which merged with its CI battery cancelled.

## Symptom

`yo build --std-path ./std` with the v0.2.50 seed, on `develop` 0de7786b8, Apple SDK 14.4 clang:

```text
yo-out/aarch64-apple-darwin/bin/yo.c: error: incompatible pointer types passing 'uint8_t *' (aka 'unsigned char *') to parameter of type 'struct pollfd *' [-Werror,-Wincompatible-pointer-types]
  int ... = poll(((uint8_t*)(__yo_v_p)), 1U, ((int)(0)));
```

## Cause

`_stdin_has_input_posix` in `src/lsp/transport.yo` (the didChange debounce) declares `poll` through `c_include("<poll.h>", ...)` with `fds : *u8`. Since `c_include` uses the header's real prototype, `struct pollfd *`, the emitted call passes a `uint8_t *` to it. Clang rejects that conversion with `-Werror`.

## Fix

`fds : *void`. C converts a `void *` argument to `struct pollfd *` implicitly, and the call casts the hand-laid `pollfd` slot to `*void`.

Test: stage 1 itself. `yo build --std-path ./std` compiles the compiler on macOS again, and the LSP CLI cases (including `lsp-debounced-didchange`, which exercises this path) pass.
