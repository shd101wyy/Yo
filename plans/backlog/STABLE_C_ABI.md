# A stable C ABI for exported Yo code (and no stable native ABI)

**Status:** BACKLOG (maintainer asked for it, 2026-11-26). Not started.
Position: Yo should promise a **narrow, opt-in stable C ABI** for what a
program exports, and should **not** promise a stable native Yo-to-Yo ABI. The
position is the coordinator's recommendation; confirm it through a Fable
consultation when this plan is scheduled (`plans/README.md`, lane F).

## What exists today

- **Calling C from Yo** uses the platform C ABI: Yo emits C11, so
  `extern("c", ...)` and `c_include(...)` declarations are ordinary C
  declarations, and a Yo type adopted from a C header takes the header's layout
  (`docs/en-US/FFI.md`).
- **Calling Yo from C** works informally. An `export(...)`ed function keeps its
  own name in the generated C (`docs/en-US/WASM.md`, "Exported functions"), and
  scalar and raw-pointer parameters map to the obvious C types (`i32` to
  `int32_t`, `usize` to `size_t`, `*u8` to `uint8_t*`, `?*u8` to a nullable
  `uint8_t*`). `std/build.yo` builds `StaticLibrary` and `SharedLibrary`
  artifacts.
- **Nothing is promised.** No document says that these names and mappings hold
  across releases. The layout of a Yo `struct`, `enum`, closure, `Dyn`,
  `Rc`/`Arc` cell or future is the compiler's choice, and it changes: `Io`
  became a `{ ctx, vtable }` interface (IO-1a/IO-1b), and the allocator
  interface's version 1 was retired in v0.2.80 (#2056). Nothing tests the
  export surface across releases.

## Why no stable native ABI

A stable native ABI would let separately compiled Yo libraries link against
each other across compiler versions, as Swift's library evolution does. Yo
should not promise one:

1. **Nothing needs it.** Yo compiles the whole program from source into C, and
   dependencies are fetched as source (`yo.toml`, the content-addressed store).
   No binary Yo library is distributed or linked.
2. **It would freeze what is still changing.** Generics are monomorphized and
   specialized per call shape; drop glue and RC layout are being reworked
   (VERDICTS-70, the one-block `Rc`/`Arc(Dyn)` cell); async state machines and
   the executor ABI are being redesigned (`IO_INTERFACE_AND_STD_RUNTIME.md`
   §3, `ALLOCATION_FREE_ASYNC.md`). A promise would turn every one of these into
   a compatibility break.
3. **It blocks optimization.** Layout, niche-filling, field reordering, calling
   conventions for `&T` parameters (passed by value or by pointer depending on
   the site, `docs/en-US/TRAITS.md`) and inlining across modules all assume
   the compiler sees the whole program.
4. **The cost is known to be large.** Swift spent years on resilience
   (witness tables, opaque layouts, `@frozen`) for an OS vendor's need. Rust,
   Zig, Go and Odin ship without a stable native ABI and expose a C ABI for
   interop. Yo follows them.

## Why a stable C ABI for exports

Users want to ship a Yo library to other languages: C, Python (ctypes, cffi),
Node and JavaScript through WebAssembly (`docs/en-US/WASM.md`), Swift and Go via
cgo, and plugin hosts that `dlopen` a shared library. Those consumers compile
once and link against a `.so`, `.a`, `.dll` or `.wasm` built by some later Yo
release. They need the export surface to hold, and today it holds only by
accident.

The C ABI is the one boundary every language speaks, and Yo emits C, so the
guarantee is cheap: it is a promise about the C the compiler emits at a small,
explicit surface.

## Proposed design (to settle when scheduled)

1. **An exported function has a C ABI.** An `export(...)`ed function whose
   parameter and result types are all C-ABI types keeps its exact name and its
   C signature in every release. A function that is exported but has a
   non-C-ABI type in its signature (for example `String`, `ArrayList(T)`, `&T`
   or a closure) gets a coded diagnostic when it is built for a library
   artifact, naming the type and the C-ABI spelling to use.
   - Open question: whether to keep `export(...)` for both meanings (module
     visibility and C symbol) or to split out a separate `extern`-style export
     form. Today `export(...)` does both.
2. **C-ABI types:**
   - the fixed-width integers, `usize`/`isize`, `f32`/`f64`, `bool`;
   - raw pointers `*T` and nullable `?*T` (`.None` is `NULL`), with `T` a C-ABI
     type or opaque;
   - a struct marked as C layout (an attribute to be designed, for example
     `derive(..., CLayout)` or a `pragma`): fields in declaration order with C's
     alignment and padding, no reordering, every field a C-ABI type;
   - an enum marked as C layout: a fieldless enum with an explicit integer
     representation;
   - C function pointers built from C-ABI types.
3. **Opaque handles.** A Yo type that is not C layout crosses the boundary only
   behind an opaque pointer (`*Handle`), with exported `*_new`/`*_free`
   functions. This is the pattern WASM.md's memory-ownership rules already
   describe.
4. **A generated header.** `yo build` writes a C header for a library artifact
   (the exported functions, C-layout structs and enums, opaque typedefs), so
   consumers do not hand-write declarations.
5. **Allocation at the boundary.** The rules in WASM.md ("the module owns the
   allocator", input and result buffers) become the documented C-ABI rules for
   every target, not only WebAssembly.
6. **The test that holds the promise.** A cli-case and a CI job compile a fixed
   C consumer against a library built by the tree compiler and compare the
   generated header with a golden, so any change to the export surface is a
   visible diff. A breaking change to the promised surface then needs a
   deliberate decision and a release-note entry.

## Out of scope

- Stable layout for `String`, `ArrayList`, `Option` of a non-pointer, `Dyn`,
  closures, futures or RC cells.
- Yo-to-Yo binary compatibility between compiler versions.
- Name mangling stability for anything not exported.
- C++ ABI interop.

## When to schedule

When the first external user ships a Yo library to another language, or when
`SharedLibrary` becomes a documented use case. Then:

1. A Fable consultation to confirm the position and settle the open questions:
   the export spelling, the C-layout marker and the diagnostic code.
2. The C-layout marker, and the check on exported signatures.
3. Header generation.
4. The golden C-consumer test and the docs (`FFI.md`, `WASM.md`, en and zh-CN).
