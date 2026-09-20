# `--emit-chunks` on the compiler itself fails to compile: the probed OpenSSL include flags are link-only, and the runtime's `extern char** environ;` sits in chunk 0 while `_exec_argv` reads it from chunk 7

**Status: FIXED 2026-09-21 (branch `feat/incr-p5-module-chunks`).** Found by the
Phase 5 edit-loop measurement (`plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md`
§8): `yo compile src/main.yo --emit-chunks auto` (10 units on this machine)
died in clang twice over.

## Symptoms

```
/tmp/p5_name_chunk000.c:5354:10: fatal error: 'openssl/ssl.h' file not found
/tmp/p5_name_chunk007.c:206516:108: error: use of undeclared identifier 'environ'
```

## Causes

1. **Include flags.** `run_compile` probes OpenSSL (`_probe_openssl`, Homebrew
   keg fallback) and appends `-I…`, `-L…`, `-lssl -lcrypto` to the cc command —
   AFTER the chunk compiles, which replay `cmd.recorded` as it stood before.
   The single-file path never noticed because its one cc invocation compiles
   and links together. Fixed by probing once, adding the `-I` flags before the
   chunk cond and the `-L`/`-l` half with the link flags.
2. **`environ`.** The process runtime block (`runtime_io_common.yo`) declared
   `extern char** environ;` inside its CODE literal, and the Yo-level extern
   member (`std/libc/unistd`'s `environ : *?*char`) emits no declaration of
   its own — `c_include` globals rely on their header, and Darwin's
   `<unistd.h>` does not declare `environ`. Single-file, the runtime's line
   preceded every use; chunked, the block is chunk 0's residue and
   `_exec_argv` (`execve(prog, argv, environ)`, the RSS-valve restart) hashed
   into chunk 7. Fixed by emitting the declaration into the DECLARATIONS
   buffer (shared header). CI's `chunked-gate` (N=4) passed only because the
   reader hashed into the same unit there.

## Open note

The general form of (2) — a `c_include` VARIABLE member whose header does not
declare it — is still a latent single-file bug for any program without the
process runtime. `_register_extern_global_header` adds the header; it cannot
know the header lacks the symbol. Tracked in the same doc for now.
