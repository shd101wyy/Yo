# What else to take from Zig: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-10-10 at the maintainer's
request**, the Zig half of
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md); the two
languages are the ones that shaped Yo most, and this document uses the
same filter (§0 there) and the same discipline: every "Yo today" claim was
checked on the 2026-10-10 tree by grep, and a claim marked *(verify)* was
not run to ground. Nothing here is adopted; each candidate ends with a
verdict and a trigger. Companion:
[`INCREMENTAL_COMPILATION_ZIG_LESSONS.md`](../reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md)
(landed; the compile-speed half of "what Yo takes from Zig").

## 0. Where Yo and Zig already agree

Yo took more from Zig than from any language but Rust, and most of it is
in `plans/reference/`. Listed so nobody proposes it again:

| Zig | Yo today | Where |
| --- | --- | --- |
| `comptime` and types as values; a function is generic iff it has comptime parameters; instantiations memoized | the same model, further: `comptime(T) : Type`, `comptime(Type)` results, CTFE over the whole language | `docs/en-US/CTFE.md`, `plans/backlog/UNIFIED_COMPTIME_DESIGN.md` |
| `anytype` | an unbounded `generic(T)` parameter defers the body to the call (AGENTS.md pitfalls) | `src/evaluator/calls/` |
| `@typeInfo`/`@Type`, `@TypeOf` | `TypeInfo`, `Type.get_info()`, `type_of` | `docs/en-US/TYPE_REFLECTION.md`, `src/expr.yo:28` |
| `@embedFile` | `embed_file` yielding a `comptime_str` | `docs/en-US/CTFE.md:141` |
| `@compileError`/`@compileLog` | `comptime_assert(false, msg)`, `comptime_print`, `comptime_expect_error` | `std/prelude.yo` |
| lazy top-level analysis (only referenced declarations are analyzed) | order-independent, demand-evaluated `::` bindings | `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` |
| `build.zig`, `b.option()`, `-Dname=value`, the global artifact cache, `zig cc` cross-compilation | `build.yo`, `-D`, the content-addressed cache, `--cc zig` | `plans/reference/BUILD_SYSTEM.md` (§"Zig reference", Phase 8 "Zig-style") |
| `@cImport` / translate-c | `c_include(...)` as a module value | `plans/reference/C_INCLUDE_EXTERN_MODULE_VALUE.md` |
| `std.mem.Allocator` as a vtable value; arenas; fixed-buffer allocators | `Allocator`/`AllocatorVTable` in the prelude, `std/arena`, `--allocator fixed` (TLSF) | `plans/reference/EXPLICIT_ALLOCATORS.md`, `FIXED_REGION_ALLOCATOR.md` |
| `test "name" {}` blocks beside the code; `zig test` | `test(...)` declarations in any file; `yo test` | `docs/en-US/`, `std/*.test.yo` |
| `///` and `//!` doc comments, `zig fmt` formatting doc code | the same spellings; `yo fmt` formats ` ```yo ` blocks in docs | `plans/reference/DOCUMENTATION_GENERATION.md` |
| no variable shadowing | the no-shadowing rule ("similar to Zig") | `docs/en-US/DESIGN.md:204` |
| `?T`, `orelse` | `Option(T)`, `?*T` for pointers, `unwrap_or` | `std/prelude.yo` |
| `std.ArrayList`, `std.log` with level filtering before rendering | the same names and the same rule | `std/collections/array_list.yo`, `std/log.yo` |
| the 0.15 `std.Io` interface passed as a parameter | `main :: (fn(io : Io) -> unit)` since the start | `docs/en-US/ASYNC_AWAIT.md` |
| `+%`/`+|` wrapping and saturating arithmetic | `wrapping_*`/`saturating_*`/`overflowing_*`/`checked_*` methods (the operator forms are out: the operator set is fixed) | `std/prelude.yo`, `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` |
| `@divFloor`/`@mod`/`@rem` explicitness | `div_euclid`, `rem_euclid`, `checked_div_euclid` | `std/prelude.yo:5040` |
| `@byteSwap`, `std.mem.readInt` | `swap_bytes`, `to_le_bytes`/`from_be_bytes` and friends | `std/prelude.yo:5424`–`5558` |
| `undefined` + `@memset` for uninitialized buffers | `spare_capacity`/`assume_init`, and ATS A4's init proof token as the safe form | `std/collections/array_list.yo:125`, `plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md` §A4 |
| `asm` blocks | `docs/en-US/INLINE_ASSEMBLY.md` | — |
| `-fstrip`, sanitizers in Debug | `-s`/`--strip`, `--sanitize address\|thread\|undefined\|leak` | `src/main.yo:4308` |
| incremental compilation, stable names, per-definition dependencies | landed | `plans/reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md` |

Where Yo deliberately differs, and should keep differing: Zig has no
hidden allocation because every std call takes an allocator; Yo chose a
scoped current allocator with an optional `alloc` parameter
(EXPLICIT_ALLOCATORS, decided). Zig has no hidden control flow; Yo has
algebraic effects, whose handlers are spelled at the call. Zig frees
manually; Yo owns and counts. None of these is a candidate.

## 1. Language candidates

### Z1. `defer`, and `errdefer` once `try` lands

```zig
// Zig
const fd = try open(path);
defer close(fd);
errdefer log.warn("failed after opening {s}", .{path});
```

**Yo today.** No `defer` (`src/parser.yo`, `src/expr.yo`: no keyword;
`std/prelude.yo`: no macro). Cleanup is `Dispose` (RAII on move-only
values), `_ScopeGuard` in std, and `unwind` for effect handlers. That
covers resources with a type; it does not cover the ad-hoc cleanup Zig's
`defer` is for: restore a flag, unlock something that is not a guard
value, log on exit, undo a partial mutation.

**Why it needs the language, not std.** A std `Defer` would be a stored
closure, and a closure with `mut` captures is second-class (VALUES_BY_DEFAULT
decision 38 A): it cannot be stored in a guard. So `defer(body)` is a
statement the compiler lowers into the scope-exit machinery it already
has for drops (`FunctionGenerationContext.emitted_deferred_drop_ids`, the
early-return and `unwind` paths), with the body a non-escaping closure
that may hold `mut` borrows of the scope's locals — exactly the borrowed
`for` body's rules, applied at scope exit. Order: reverse declaration,
before the scope's drops.

**`errdefer`.** Zig runs it on an error return. Yo's error path is a
`Result` value, not unwinding, so `errdefer` has a meaning only once
`try(expr)` exists (ruled 2026-09-19, not landed,
`LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3): "run when this scope is left by
a `try` that propagated". That is the cleanup for partially built state,
Zig's main use, and it is the piece `Dispose` cannot express because the
half-built value has no type of its own.

**Verdict: adopt `defer` (medium: evaluator scope rules, codegen on every
exit path, async state machines included); `errdefer` with `try`.** Tests:
exit by fall-through, `return`, `break`, `unwind`, panic (must NOT run —
Zig's rule), `await` inside the scope.

### Z2. Error return traces

```text
error: FileNotFound
/src/config.zig:12:5: 0x2039ab in readConfig (app)
    const f = try std.fs.cwd().openFile(path, .{});
/src/main.zig:30:9: 0x2041cd in main (app)
    const cfg = try readConfig("app.toml");
```

Zig's single best debugging feature: every `try` that propagates an error
appends its site to a trace, so an error surfacing far from its origin
still names the chain. Rust has nothing like it; `anyhow` approximates it
with manual context.

**Yo today.** `Error.source` (`std/error.yo:43`) is a manual chain; a
`Result` propagated by hand loses every intermediate site; no trace
machinery *(grep: no "return trace" in `plans/` or `issues/`)*. With
`try(expr)` ruled but not landed, there is no propagation site to hook yet.

**Verdict: adopt together with `try`.** In `-O0` and `--sanitize` builds
(or under a `YO_ERROR_TRACE=1`-style switch), every `try` that propagates
pushes `(file, line)` onto a thread-local ring attached to the error
value's `AnyError` box; an unhandled `Err` reaching `main`, and `expect`/
`unwrap` on an `Err`, print the ring. Zero cost in optimized builds (the
push is compiled out). Algebraic-effect `throw` sites get the same hook
for free, since they are already compiler-visible.

### Z3. Arbitrary-precision `comptime_int`

**Yo today.** `comptime_int` is an `i64` bit pattern: `u64.MAX` is `-1` at
comptime, the comptime division, modulo, shift and comparison paths had
to be redone unsigned, and `parse_raw_int` depends on `parse_i64`
wrapping (recorded in this project's memory on 2026-09; look for
`check_int_overflow` in `src/evaluator/builtins/comptime_numeric_fns.yo`).
Zig's `comptime_int` is arbitrary precision, which is why none of those
cases exist there.

**Verdict: adopt, as a soundness fix rather than a feature:** a bigint
(or, as the first step, a 128-bit signed representation, which covers
every `u64`/`i64` edge and every `u64 * u64` product) behind
`comptime_int`, so comptime arithmetic has one rule ("exact, then
checked at the slot it enters", E1102). File the current behaviour as an
issue if none exists *(verify)*; measure `check ./src` CTFE time before
and after.

### Z4. `@src()` — source location as a value

**Yo today.** Panics bake `file:row:col` into the emitted C; nothing lets
user code ask for its own location *(grep: no `source_location` builtin)*.
Rust gets the same with `#[track_caller]` + `Location::caller()`.

**Verdict: adopt:** a comptime builtin `source_location()` returning a
`Copy` struct `(file : str, line : u32, column : u32, function : str)`,
evaluated where it is written; a defaulted parameter
`loc : SourceLocation = source_location()` then gives any assert or log
helper the caller's site at no cost, which is what `std/assert`,
`std/log` and `std/testing` want. Small (one builtin, one prelude type).

### Z5. Packed structs and bit fields; explicit alignment

**Yo today.** `extern` types keep C declaration order (CODEGEN_PERFORMANCE
CP3a); there is no `packed` layout and no bit-field member *(grep: nothing
in `docs/en-US/FFI.md` or `tests/`)*, and no `align(N)` on a type or an
allocation *(verify: whether `Allocator.alloc` takes an alignment)*.
Zig: `packed struct(u32) { a : u3, b : u29 }`, `extern struct`,
`align(64)`.

**Why.** Protocol headers, device registers, flags words, and DMA/SIMD
buffers. The fixed-region allocator says Yo intends to run on embedded
targets, and those are packed-register-heavy.

**Verdict: adopt later, as one design** `packed(struct(...))` with
integer-width fields lowering to C bit-fields where the ABI is fixed and
to shift/mask accessors where it is not (MSVC and GNU disagree on
bit-field layout, so the accessor form is the portable one), plus
`aligned(N, T)`. Trigger: the first std or user module that hand-writes
shift/mask code for a register map. Arbitrary-width integers (`u7`) come
only as packed-struct field types, not as first-class types (§5).

### Z6. `volatile` loads and stores

**Yo today.** None (`std/sys`: no volatile), which is why
`issues/questions/no-volatile-so-black-box-needs-inline-asm.md` exists.
Memory-mapped I/O on an embedded target cannot be written in safe or
unsafe Yo today without `asm`.

**Verdict: adopt now, small:** `volatile_load(p)` / `volatile_store(p, v)`
on raw pointers under `pragma(Pragma.AllowUnsafe)`, lowering to
`*(volatile T*)`; they also give `std/testing` its `black_box`. One
codegen case and two prelude functions.

### Z7. `comptime_for` — unrolled iteration over comptime lists and fields

**Yo today.** `ComptimeList`, `TypeInfo.Struct(fields : ComptimeList(…))`
exist; derive rules walk fields at comptime through AST reflection. Whether
a `for` over a `ComptimeList` **inside a runtime function body** unrolls
per element (Zig's `inline for`, the generic serializer/formatter idiom)
is *(verify)*: if it already does, document it in `CTFE.md`; if it
evaluates the list at runtime or is rejected, add `comptime_for(list, x => …)`
as a prelude macro that unrolls at expansion time.

### Z8. `@setEvalBranchQuota` — a CTFE budget

**Yo today.** No evaluation budget in the evaluator *(grep: no
budget/quota/fuel in `src/evaluator/`)*: a runaway comptime loop hangs
`yo check` and the LSP with it. Zig's default quota is 1000 branches,
raised per site.

**Verdict: adopt, small:** a default branch quota per comptime
evaluation, an E-code that names the site and says how to raise it,
`comptime_budget(n)` for the sites that legitimately need more (table
generation). Protects every `yo check` and the LSP from one bad loop.

### Z9. Labeled blocks as expressions

Zig's `blk: { … break :blk v; }` is the general form of Rust's labeled
`break` with a value (RUST_ADOPTION_CANDIDATES L3): a block, not only a
loop, can be left early with a value. Yo blocks already have a tail value;
only the early exit is missing. **Verdict: fold into L3**, and prefer the
Zig shape (name a block or a loop by binding it) when the spelling is
decided.

### Z10. `@setRuntimeSafety` per scope

Zig's per-scope safety toggle is the precedent for a scoped
`unchecked(body)` instead of a build-wide "wrap instead of trap" knob.
CODEGEN_PERFORMANCE §7 and SAFE_MODE hold that question and the position
(not before CP2f's numbers). **Cross-reference only;** if a knob is ever
added, the scoped form is the one to add.

## 2. Standard library candidates

### Z11. A tracking allocator — `std.heap.GeneralPurposeAllocator` and `std.testing.allocator`

Zig's Debug allocator reports every leak with the allocation's stack
trace at exit, detects double frees and use-after-free (it never reuses
freed slots in debug), and `std.testing.allocator` fails a test that
leaks.

**Yo today.** `--allocator mimalloc|system|fixed` (`src/main.yo:4347`);
leak detection is `--sanitize leak` (Linux CI only; ASan passes without
instrumenting on this macOS box, and CI runs `detect_leaks=0`), so every
leak gate in the tree is a hand-written `Dispose` counter.

**Verdict: adopt, medium, high value:** `--allocator debug` — a
tracking allocator over the system one (per-block header with site and
size, freed blocks poisoned and quarantined, double-free and
size-mismatch aborts, a leak table at exit with the allocation site from
Z4's `source_location`), and `yo test --allocator debug` failing a test
that ends with live blocks. It works on every platform including the
ones where ASan is hollow, and it is deterministic. CODEGEN_PERFORMANCE
CP0's event counters can ride the same header.

### Z12. Fixed-capacity inline list — `std.BoundedArray`

**Yo today.** `Array(T, N)` (no length) and `ArrayList(T)` (heap) only
*(grep: no bounded/inline list in `std/`)*. An inline list with a
capacity in the type and a length word allocates nothing, which the
fixed-region and embedded story needs, and is what hot paths want for
small vectors (the compiler's own small lists). **Verdict: adopt, small:**
`InlineList(T, N)` in `std/collections`, `push` returning `Result` on
overflow, the same iteration surface as `ArrayList`.

### Z13. Enum-indexed containers — `std.EnumArray`, `std.EnumMap`, `std.EnumSet`

An array indexed by a payload-free enum, a map from it, and a bit set of
its variants, all comptime-sized from the variant count. **Yo today:**
none *(grep)*; `TypeInfo` exposes an enum's variants, so the index is
derivable *(verify: a variant → ordinal builtin)*. **Verdict: adopt,
small,** after RUST_ADOPTION_CANDIDATES L8 settles enum discriminants.

### Z14. Comptime-built string maps — `std.StaticStringMap`

A map from string literals to values built entirely at compile time (a
sorted table plus binary search, or a perfect hash), the keyword-table
idiom. **Yo today:** none *(grep: no comptime map in `std/`)*; the
compiler's own lexer keyword dispatch and `src/cli_lang.yo` tables are the
consumers. **Verdict: adopt, small-medium,** as `ComptimeStringMap(V)`
constructed from a comptime list of pairs; CTFE already does the work.

### Z15. `std.MultiArrayList`

Already parked as `Soa(T)` in `LANGUAGE_FEATURE_CANDIDATES.md` §6.
Cross-reference only.

### Z16. A replaceable panic handler

Zig lets the root module define `panic` and the runtime calls it. **Yo
today:** `__yo_panic` prints to stderr and aborts; nothing can replace it
*(grep: no hook in the runtime)*. Embedded targets have no stderr, servers
want a log line and a core, tests want a captured message. **Verdict:
adopt, small:** `set_panic_handler(f : fn(msg : str, loc : SourceLocation) -> unit)`
in `std/sys` under the pragma, called before the abort; the default is
today's behaviour. Pairs with Z4.

### Z17. Assertion failure output — `expectEqualSlices`, `expectEqualStrings`

Zig prints both values and the first differing index. **Yo today:**
`assert_eq` exists (`std/assert.yo:66`); whether its failure prints both
operands and, for strings and lists, the first mismatch is *(verify)*.
**Verdict: verify, then adopt** the diff output if missing; a model
reading a failed test needs the two values, not "assertion failed".

## 3. Toolchain candidates

### Z18. The result-location question for large returns

Zig's result location semantics construct a returned aggregate in the
caller's slot with no copy. C has no guaranteed NRVO; clang usually elides
through `sret`, but the emitted `T tmp = f(); x = tmp;` pattern can defeat
it. **Verdict: a CP0 workload** ("return a 1 KB struct through three
levels") in CODEGEN_PERFORMANCE, not a language change; if the copies show,
the fix is an out-pointer calling convention for large returns, which
VALUES_BY_DEFAULT decision 34 already shapes for parameters.

### Z19. `yo targets`

`zig targets` lists every triple and the libc/ABI matrix. Yo documents its
triples (`plans/reference/TARGET_TRIPLES.md`) but has no listing command
*(verify)*. **Verdict: adopt if absent,** trivial, and it is what an agent
runs before guessing a triple.

### Z20. Test skipping

Zig skips a test by returning `error.SkipZigTest`, reported as skipped,
not passed. **Yo today:** `--test-name-pattern` filters; whether a test can
declare itself skipped at run time (a platform it cannot run on) and be
counted as such is *(verify)*. **Verdict: verify, then adopt** a `skip(reason)`
that reports a skip; a skipped test that counts as passed is the hollow
green this project has been burned by.

## 4. Rejected

| Zig feature | Why not |
| --- | --- |
| inferred error sets, `!T` | a `Result(T, E)` names the error type a model must see; `AnyError` is the open form; effects cover the rest |
| every std call takes an allocator | decided against: the scoped current allocator with an optional `alloc` parameter (EXPLICIT_ALLOCATORS) |
| `+%` / `+|` operators | the operator set is fixed; the methods exist |
| arbitrary-width integers as first-class types | only as packed-struct field types (Z5) |
| `@fieldParentPtr`, intrusive containers | pointer arithmetic on payloads; `offset_of` under the pragma is the most Yo should offer *(verify that `size_of`/`align_of`/`offset_of` exist as comptime builtins; `sizeof` goldens suggest the first does)* |
| `undefined` as a value | ATS A4's init token is the safe form; `spare_capacity`/`assume_init` the unsafe one |
| `usingnamespace` | the glob import `{ ... } :: import("m")` |
| async frames (Zig removed them) | Yo's state machines are the ASYNC plans' |
| sentinel-terminated slices `[:0]u8` | folded into RUST_ADOPTION_CANDIDATES L1's design question (a view type), with `String.from_cstr` the FFI boundary today |

## 5. Suggested order

| Candidate | Size | Depends on | Suggested slot |
| --- | --- | --- | --- |
| Z6 volatile, Z4 `source_location`, Z8 CTFE budget, Z16 panic handler | small each | nothing | now; one PR each |
| Z11 `--allocator debug` + `yo test --allocator debug` | medium | Z4 for sites | now; the leak gates are waiting for it |
| Z12 `InlineList`, Z14 comptime string map, Z17 assert diffs | small | nothing | now |
| Z3 arbitrary-precision `comptime_int` | medium | nothing | a soundness fix; next |
| Z1 `defer` | medium | V3b Generation B (scope rules final) | after the flip |
| Z2 error return traces, `errdefer` | medium | `try(expr)` landing | with `try` |
| Z13 enum containers | small | L8 discriminants | after L8 |
| Z5 packed structs, alignment | large | a design doc | on the first register-map consumer |
| Z7, Z19, Z20 | verify first | — | — |
| Z18 | a CP0 row | CODEGEN_PERFORMANCE CP0 | with CP0 |

## Maintenance

As for the Rust document: an adopted candidate moves into the plan that
lands it with a dated pointer here; a rejected one moves to §4 with the
reason; the *(verify)* marks are re-checked against the tree before any
PR acts on them.
