# The Windows release allocator assertion counts the compiler's own mimalloc diagnostic

**Severity:** S2 — it blocks every release: both Windows seed-bundle legs fail, so the publish job never runs. No shipped binary was wrong.

**Filed:** 2026-10-27, from v0.2.71's first release run (40462960329). Fixed in the same PR as this doc.

## Symptom

`Seed bundle (windows-x64, cross-emitted)` failed at "Assert the bundle got the allocator it asked for (Windows)". Both Windows rows emit with `bundle_allocator: system`. The step counted `grep -a -c "mimalloc: "` hits in `yo-seed.exe` and treated any hit as a mimalloc link.

## Root cause

#1600 (2026-10-25, the first release to carry it is v0.2.71) made a mimalloc emit without its header a hard `#error`. The compiler embeds that diagnostic's text as a string literal (`src/codegen/c/collection.yo:126`): `#error "--allocator mimalloc: mimalloc.h not found. …"`. So every `yo` binary carries one `mimalloc: ` literal whatever heap it links, and the assertion's marker no longer distinguishes the two.

Measured on the 6ec7f5064 tree's stage-2 C: the system-linked rebuild (`-I scripts/bootstrap/libc_mimalloc`) counts **1** bare `mimalloc: ` hit, and the mimalloc-linked binary counts 3.

## Fix

Match only the prefixes mimalloc's own `options.c` emits, `mimalloc: error: ` and `mimalloc: warning: `. The same two binaries count **0** and **2**. No `src/` or `std/` file contains either prefix.
