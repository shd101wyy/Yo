# Mimalloc Integration
> **ARCHIVED 2026-09-04 — SUPERSEDED** by
> [`WINDOWS_ALLOCATOR_DECISION.md`](../reference/WINDOWS_ALLOCATOR_DECISION.md)
> (the allocator A/B that settled the Windows allocator; mimalloc has since been
> upgraded v3.3.2 → v3.5.1). The submodule paths and integration steps below are
> TS-era.

The Yo programming language uses [mimalloc](https://github.com/microsoft/mimalloc) for high-performance memory allocation. Mimalloc is a fast, general-purpose allocator that provides better performance than the standard system malloc.

## How It Works

### Bundled Approach

Yo includes mimalloc as a git submodule in `vendor/mimalloc/`. The Yo compiler automatically:

1. **Includes mimalloc source**: Compiles `vendor/mimalloc/src/static.c` alongside generated C code
2. **Adds include path**: Uses `-Ivendor/mimalloc/include` for mimalloc headers
3. **Smart fallback**: Generated C code uses conditional compilation to fallback gracefully

### Generated C Code Structure

```c
// Mimalloc compatibility layer - try mimalloc first, fallback to stdlib
#ifdef __has_include
  #if __has_include(<mimalloc.h>)
    #include <mimalloc.h>
    #define __yo_malloc mi_malloc
    #define __yo_calloc mi_calloc
    #define __yo_realloc mi_realloc
    #define __yo_free mi_free
    #define __yo_aligned_alloc mi_aligned_alloc
  #else
    #define __yo_malloc malloc
    #define __yo_calloc calloc
    #define __yo_realloc realloc
    #define __yo_free free
    #define __yo_aligned_alloc aligned_alloc
  #endif
#else
  // Fallback for older compilers without __has_include
  #define __yo_malloc malloc
  #define __yo_calloc calloc
  #define __yo_realloc realloc
  #define __yo_free free
  #define __yo_aligned_alloc aligned_alloc
#endif
```

All generated C code uses the `yo_*` memory functions, which automatically resolve to either:

- `mi_*` functions (when mimalloc is available)
- Standard C library functions (fallback for compatibility)

## Cross-Platform Support

### Automatic Detection

The system works across all platforms:

- **Windows**: Works with MSVC, MinGW, and Clang
- **macOS**: Works with Clang and GCC
- **Linux**: Works with GCC, Clang, and other compilers
- **Other Unix systems**: Automatic fallback to system malloc

### No Installation Required

Since mimalloc is bundled as a git submodule, users don't need to install mimalloc separately. The Yo compiler handles everything automatically.

## Building from Source

When cloning the Yo repository:

```bash
git clone --recursive https://github.com/your-org/yo-lang.git
# or if already cloned:
git submodule update --init --recursive
```

The `--recursive` flag ensures the mimalloc submodule is also downloaded.

## Performance Benefits

Mimalloc provides:

- **2-3x faster allocation/deallocation** compared to system malloc
- **Better memory locality** for improved cache performance
- **Thread-safe** with excellent multi-threaded performance
- **Low memory overhead** with efficient metadata storage
- **Security features** like guard pages and free list encoding

## Compatibility

The fallback mechanism ensures Yo programs compile and run correctly even when:

- Mimalloc headers are not found
- Older compilers don't support `__has_include`
- Cross-compilation environments lack mimalloc
- Embedded or constrained environments

## Build Process

The Yo compiler (`yo-cli`) automatically:

1. Generates C code with `__yo_malloc`/`__yo_free` calls
2. Checks if `vendor/mimalloc/src/static.c` exists
3. If found: includes mimalloc source and headers in compilation
4. If not found: warns but continues with fallback to system malloc

Example compilation output:

```
Generated C code written to program.c
Using bundled mimalloc
Compiling with: clang -std=c11 -Wall -Wextra program.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -o program
Successfully compiled to program
```
