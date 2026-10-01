# `--emit-chunks` with `--allocator mimalloc` fails in clang: every chunk's `cc -c` also gets mimalloc's `static.c`

**Severity:** S2 — `yo compile --emit-chunks … --allocator mimalloc` never
produces a binary; the chunked build can only be used with the system
allocator.

**Status: FIXED 2026-10-01 (branch `fix/emit-chunks-mimalloc`).** Found while
building the compiler chunked for the scope-release memory work
(`plans/CODEGEN_MEMORY_REDUCTION.md` §6).

## Symptom

```
$ yo compile src/main.yo --std-path ./std --optimize 2 --allocator mimalloc --emit-chunks auto --jobs 8 -o yo-chunked
clang: error: cannot specify -o when generating multiple output files
yo: error: compile: C compiler failed (exit 1) compiling chunks — see yo-chunked_chunks_compile.sh
```

Every line of the generated `<out>_chunks_compile.sh` reads:

```
clang … -I…/vendor/mimalloc/include …/vendor/mimalloc/src/static.c … -c <out>_chunk007.c -o <out>_chunk007.o
```

## Cause

`run_compile` (`src/main.yo`) builds one cc command. For the bundled mimalloc
it appends `-I…/mimalloc/include` and the SOURCE file `static.c` to it. With
chunked emission, the chunk compiles replay a snapshot of that command's
recorded arguments (`chunk_compile_flags`) as the compile-flag prefix of one
`cc -c <chunk>.c -o <chunk>.o` per unit. The snapshot carried `static.c`, so
each chunk compile had two inputs and one `-o`. The single-file path never
noticed, because its one invocation compiles and links together.

## Fix

`run_compile` keeps a `link_only_sources` list (today: mimalloc's `static.c`),
and the chunk-flag snapshot leaves those out. The link invocation still lists
`static.c` and compiles it once beside the chunk objects, so the allocator is
still linked (`nm <bin> | grep ' mi_malloc$'`).

## Test

`tests/cli-cases/compile-emit-chunks`: a fifth command,
`compile main.yo --emit-chunks 3 --allocator mimalloc -o app4`, whose golden is
`Using bundled mimalloc` plus the three-unit compile summary. It fails before
the fix (rc 1, the clang error above) and passes after.
