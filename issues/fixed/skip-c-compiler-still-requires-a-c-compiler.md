# `yo compile --emit-c --skip-c-compiler` still requires a C compiler to be FOUND

**Status: FIXED** (found and fixed 2026-09-04 in the P1–P3 close-out): the
discovery-and-throw in `run_compile` is now guarded by `skip_cc` (a skipped
C-compile step never needs a compiler — the skip path returns before any
`cc` use), and `-cc` is an accepted spelling alongside `--c-compiler` /
`--cc` (the flag parser previously rejected the exact spelling the error
message recommended).

## Reproducer

On a machine with no `cc`/`clang`/`gcc`/`zig` on PATH (this Steam Deck
outside `nix-shell` — the toolchain lives only in `shell.nix`):

```bash
~/.local/bin/yo compile src/main.yo --emit-c --skip-c-compiler --optimize 2 -o /tmp/yo
# yo: error: Error: No C compiler found. Please install a C compiler
#      (cc, gcc, clang, or zig) or specify one using the -cc/--c-compiler flag.
```

Inside `nix-shell` (clang on PATH) the same command succeeds — the C
compiler is never invoked, it is only DISCOVERED.

## Root cause

`src/main.yo` `run_compile`'s compiler-resolution block (~line 1645):

```rust
if(cc == "", {
  match(
    _find_available_compiler(io),
    .Some(found_cc) => { cc = found_cc; },
    .None => { exn.throw(dyn(String.from("Error: No C compiler found. ..."))); }
  );
});
```

The probe-and-throw runs unconditionally when `-cc` was not passed — it is
not guarded by `skip_c_compiler`, even though a skipped C-compile step never
needs `cc` (and `--emit-c` only PRINTS the C text). Note `-cc` itself is
also rejected by this build's flag parser (`compile: unknown option '-cc'`)
even though the error text advertises it — worth checking the same
fix (`--c-compiler` presumably parses; `-cc` does not).

## Fix direction

Skip the discovery block when `skip_c_compiler` is set (defaulting `cc`
harmlessly), and make `-cc` an accepted spelling if the error message is
going to keep recommending it. Tiny change; the affected UX is
emit-C-only workflows on toolchain-less machines (CI containers, minimal
dev boxes) — exactly where `--skip-c-compiler` is meant to be used.
