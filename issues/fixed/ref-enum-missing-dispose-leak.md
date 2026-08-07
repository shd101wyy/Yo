# ref(enum) never gets a `___dispose` — variant RC fields leak on free (and corrupt WASI heap)

**Status:** FIXED (both compilers)

## Symptoms

Two CI failures on PR #76, both from `tests/ref_enum.test.yo`:

1. **Linux LSan (test / ubuntu-latest):** `✗ ref(enum) drops its variant's RC fields on free — Direct leak of 80 byte(s)` — a `String` stored in `Wrap.Has(s : String)` leaks when the `ref(enum)` handle is freed. Invisible on macOS (no LeakSanitizer on arm64; verified locally with `leaks --atExit` instead).
2. **wasm32-wasi (wasmtime):** `✗ recursive ref(enum) RECONSTRUCTION (Self + ArrayList(Self) fields)` — exit 134, `memory fault at wasm address 0x94000ca0 ... out of bounds`. Native + ASan passed; emscripten passed.

## Minimal repro

```rust
{ assert } :: import("std/assert");
open(import("std/string"));
open(import("std/fmt"));
Wrap :: ref(enum(Empty, Has(s : String)));
main :: (fn() -> unit)({
  w := Wrap.Has(s : `a heap string the ref-enum must free`);
  match(w,.Has(sv) => assert(sv.len() > usize(0), `has a string`),.Empty => ());
});
export(main);
```

`leaks --atExit -- ./bin` reported the 80-byte String leak before the fix; 0 leaks after.

## Root cause

`__yo_decr_rc` only dispatches a dispose when `header->type_id != 0`, and the
ref-enum constructor emitter stamps the dispose id from the enum's `___dispose`
trait method. But the evaluator **never synthesized `___dispose` for enums**:

- TS: `generateDisposeFunctionCodeForEnumType` in `src/evaluator/types/utils.ts`
  was commented out, and `addRcFunctionsToEnumType` only added the `___dispose`
  _signature_ (no body). Ref-enum `___drop` is just `__yo_decr_rc(self)`, so at
  refcount 0 the handle was freed with `type_id = 0` — the active variant's RC
  fields (String, ArrayList, nested ref-enums, …) were never dropped.
- yo-self: same gap in the deferred-synthesis architecture —
  `collect_dispose_methods` (`yo-self/codegen/functions/collection.yo`) only
  covered `is_reference_struct_type`, so ref-enums never got the synthesized
  dispose either.

The WASI OOB is downstream of the same defect: the old binary (missing enum
dispose) crashes in wasmtime, the new binary (identical compiler except the
restored dispose) passes; native/emscripten allocators tolerated the state that
wasmtime's bounds-checked dlmalloc faulted on. The precise corruption chain was
not dissected further — the fix differential is conclusive (old wasm binary
still crashes, rebuilt one exits 0, all 11 `ref_enum` arms pass on native +
wasm-wasi).

## Fix

- **TS (`src/evaluator/types/utils.ts`):** restored
  `generateDisposeFunctionCodeForEnumType` — for RC enums it emits a
  `match(__yo_self, .Variant(fields…) => { (___drop)(rc_field); … }, _ => ())`
  body over the variants with RC-containing fields (empty body for value enums:
  they drop fields in `___drop`) — and wired it into `addRcFunctionsToEnumType`
  after the `containsSomeType` guard, mirroring the struct path. The user
  `dispose()` (Dispose trait) call is still injected by C codegen
  (`generateFunctionImplementation`, generation.ts:1433-1473), which already
  handles any SelfType.
- **yo-self (`yo-self/codegen/functions/collection.yo`):** added
  `_synthesize_and_register_enum_dispose` (the enum counterpart of
  `_synthesize_and_register_dispose`, arms bind fields positionally under
  `__yo_disp_fN` aliases, `self.dispose()` first when a user Dispose impl
  exists) and extended `collect_dispose_methods` to include
  `is_reference_enum_type` entries.

## Tests

- `tests/ref_enum.test.yo` — "ref(enum) drops its variant's RC fields on free"
  (LSan-verified on Linux CI) and "recursive ref(enum) RECONSTRUCTION
  (Self + ArrayList(Self) fields)" (the WASI-crash arm). Both failed on CI
  before the fix; both pass native + wasm-wasi after.
- Regression batch green: recursive_enum, cycle_collector, arc, rc,
  gc_cleanup_exit, closure_capture_rc_leak, continue_rc_cleanup.
