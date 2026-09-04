# `sizeof` of an aggregate with a `unit` field is smaller than the C struct codegen emits — every container built on it under-allocates

**Status:** OPEN
**Severity:** memory-unsafety — silent out-of-bounds heap writes, then SIGSEGV/SIGBUS.
**Found:** 2026-09-04, during the std-API audit re-measurement of the
`collections/*` row, while checking whether `HashSet(T)` can be re-expressed as
`HashMap(T, unit)`. It cannot: `HashMap(K, unit)` corrupts the heap today.

Yo computes type layout itself (`get_size_of_type`, in **bits**), and `sizeof`
folds to a C integer literal at compile time. Codegen, separately, spells a
`unit` field as a real one-byte `uint8_t` C member. The two disagree: Yo counts
the field as **zero** bytes, C counts it as **one**. Every allocation sized with
Yo's `sizeof` is therefore short of the C stride used to address it.

## Measured: Yo's `sizeof` vs the C struct codegen emits for the same type

```rust
open(import("std/fmt"));
open(import("std/string"));
OnlyUnit  :: struct(b : unit);
TwoUnits  :: struct(a : unit, b : unit);
UnitField :: struct(a : i32, b : unit);
I64Unit   :: struct(a : i64, b : unit);
main :: (fn() -> unit)({
  println(`OnlyUnit  yo sizeof=${sizeof(OnlyUnit)}  alignof=${alignof(OnlyUnit)}`);
  println(`TwoUnits  yo sizeof=${sizeof(TwoUnits)}  alignof=${alignof(TwoUnits)}`);
  println(`UnitField yo sizeof=${sizeof(UnitField)} alignof=${alignof(UnitField)}`);
  println(`I64Unit   yo sizeof=${sizeof(I64Unit)}  alignof=${alignof(I64Unit)}`);
  println(`unit      yo sizeof=${sizeof(unit)}  alignof=${alignof(unit)}`);
});
export(main);
```

Observed (`yo compile v_sz.yo --optimize 2 -o v_sz.out && ./v_sz.out`, yo 0.2.24,
aarch64-apple-darwin):

```
OnlyUnit  yo sizeof=0  alignof=1
TwoUnits  yo sizeof=0  alignof=1
UnitField yo sizeof=4 alignof=4
I64Unit   yo sizeof=8  alignof=8
unit      yo sizeof=0  alignof=1
```

The **C structs codegen emits for those exact four types** (`--emit-c
--skip-c-compiler`, lines 361-378 of the emitted file):

```c
struct __yo_t12_struct { // UnitField : UnitField
  int32_t a;
  uint8_t b;
};

struct __yo_t13_struct { // I64Unit : I64Unit
  int64_t a;
  uint8_t b;
};

struct __yo_t10_struct { // OnlyUnit : OnlyUnit
  uint8_t b;
};

struct __yo_t11_struct { // TwoUnits : TwoUnits
  uint8_t a;
  uint8_t b;
};
```

and what the C compiler makes of them:

```
OnlyUnit  C sizeof=1 alignof=1
TwoUnits  C sizeof=2 alignof=1
UnitField C sizeof=8 alignof=4
I64Unit   C sizeof=16 alignof=8
```

| type | Yo `sizeof` | C `sizeof` |
| --- | --- | --- |
| `struct(b : unit)` | 0 | 1 |
| `struct(a : unit, b : unit)` | 0 | 2 |
| `struct(a : i32, b : unit)` | **4** | **8** |
| `struct(a : i64, b : unit)` | **8** | **16** |

Alignment already agrees; only the size is wrong.

## Reproducer 1 — `ArrayList` of a struct with a `unit` field: SIGBUS

```rust
open(import("std/fmt"));
open(import("std/string"));
open(import("std/collections/array_list"));
UnitField :: struct(a : i32, b : unit);
main :: (fn() -> unit)({
  xs := ArrayList(UnitField).new();
  i := i32(0);
  while(i < i32(2000), {
    xs.push(UnitField(a : i, b : ()));
    i = (i + i32(1));
  });
  println(`len = ${xs.len()}`);
});
export(main);
```

Observed:

```
$ yo compile v_al.yo --optimize 2 -o v_al.out && ./v_al.out ; echo "rc=$?"
rc=138
```

rc=138 is SIGBUS; nothing is printed. Expected: `len = 2000` and rc=0.
The threshold is low and deterministic — the same program with a push/read-back
loop already dies at **3** elements (the first growth allocates
`4 * 4 = 16` bytes for four 8-byte elements).

The emitted C is unambiguous. `ArrayList.push`'s growth path:

```c
size_t _file____priv_temp_9327 = ((4ULL) * (new_capacity));   // Yo's sizeof(T) = 4
_file____priv_temp_9334 = __yo_malloc(_file____priv_temp_9327);
...
__yo_t2* typed_ptr = ((__yo_t2*)(new_ptr));
...
__yo_t2* _file____priv_temp_9344 = (typed_ptr + self->_length);  // C stride = 8
__yo_t2* target_ptr = _file____priv_temp_9344;
...
(*target_ptr) = value;
```

(`__yo_t2` is `struct { int32_t a; uint8_t b; }` — the `UnitField` struct shown
above, C `sizeof` 8.)

`malloc(4 * n)` followed by `(__yo_t2*)p + i` writes twice as far as it allocated.

## Reproducer 2 — `HashMap(K, unit)`: SIGSEGV at 12 inserts

```rust
open(import("std/fmt"));
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
main :: (fn() -> unit)({
  m := HashMap(i32, unit).new();
  i := i32(0);
  while(i < i32(12), {
    r := m.insert(i, ());
    i = (i + i32(1));
  });
  println(`len = ${m.len()}`);
});
export(main);
```

Observed:

```
$ yo compile v_hm12.yo --optimize 2 -o v_hm12.out && ./v_hm12.out ; echo "rc=$?"
rc=139
```

rc=139 is SIGSEGV, deterministic; 64 inserts likewise. Expected `len = 12`,
rc=0. The identical program with `HashMap(i32, bool)` and 64 inserts prints
`len = 64` and exits 0 — `bool` is 8 bits in Yo *and* one byte in C, so it is
the control that isolates the cause.

`new()` gives the map 16 buckets in a **64-byte** allocation, so every key whose
bucket index is 8 or higher writes 8 to 71 bytes past the end. Which small inputs
hit one is hash-dependent: 1, 2, 4 and 8 inserts all print their `len` and exit 0,
including under `MallocGuardEdges=1 MallocScribble=1` (the block is small, so
guard edges do not apply to it). That is the dangerous shape here — below the
crash threshold the overflow is **silent**, and the crash threshold is only 12.

Emitted C for `HashMap(i32, unit)`:

```c
struct __yo_t0_struct { //  : <struct:struct_yo_id_8762>   // MapEntry(i32, unit)
  int32_t key;
  uint8_t value;
};
...
size_t _file____priv_temp_11271 = ((capacity) * (4ULL));   // Yo's sizeof(MapEntry) = 4
size_t data_size = _file____priv_temp_11271;
void* _file____priv_temp_11276 = __yo_malloc(data_size);
__yo_t0* data_ptr = ((__yo_t0*)(data_void_ptr));
...
(*(data_ptr + index)) = new_bucket;                        // C stride = 8
```

`DEFAULT_CAPACITY` is 16 (`std/collections/hash_map.yo:19`), so `new()` mallocs
`16 * 4 = 64` bytes for a bucket array it addresses out to `16 * 8 = 128` — a
64-byte heap overflow built into an empty map.

Both reproducers behave the same against the bundled std and against the tree
std (`YO_STD=/Users/yiyiwang/Workspace/Yo/std`).

## Root cause

Three independently-correct decisions that were never reconciled:

1. **Layout says a `unit` field is zero bytes.**
   `get_size_of_type` returns size in bits and answers `.Unit => .Some(usize(0))`
   at `src/types/utils.yo:1535` (`.Void` is 0 at :1539 for the same reason).
   `_aggregate_size` (`src/types/utils.yo:1388`) sums the field sizes with C
   padding rules, so a zero-size field contributes nothing and does not even
   push the running offset. `get_alignment_of_type` answers `.Unit =>
   .Some(usize(1))` at `src/types/utils.yo:1432`, which is right.

2. **`sizeof` freezes that number into the C source.** It is not C's `sizeof`:
   `src/evaluator/builtins/sizeof.yo:96-98` divides the bit count by 8 and
   stores the result as `EvalValue.IntLit`, so the emitted C carries `4ULL`, not
   `sizeof(struct __yo_t2_struct)`.

3. **Codegen gives the field a real byte.** `get_type_string` spells both `.Unit`
   and `.Void` as C `void` (`src/codegen/utils/index.yo:1137-1138`), and
   `get_storage_type_string` rewrites exactly that spelling to a one-byte
   placeholder in every storage position — parameter, struct/tuple/union field,
   local, cast target (`src/codegen/utils/index.yo:1376-1378`,
   `if(s == \`void\`, String.from("uint8_t"), s)`). That change
   (issues/fixed/unit-typed-params-and-fields-emit-c-void.md) deliberately
   **preserves field count and order** rather than erasing unit fields, so the C
   struct really does grow by a byte plus its padding.

Element addressing then uses the C type, never Yo's number: the `ptr.add(i)`
builtin lowers to plain C pointer arithmetic (`_ptr_binop(args, "+")`,
`src/codegen/exprs/inline_fns.yo:194`, defined at :101-110), whose stride is
`sizeof(struct __yo_t2_struct)`.

So any code that allocates `count * sizeof(S)` and then strides by `S*`
under-allocates. In std that is:

- `std/collections/array_list.yo:136` (`malloc(sizeof(T) * cap)`), `:165`, `:168`,
  `:494`, `:497`, plus the `memcpy`/`memset`/`memmove` byte counts at `:268`,
  `:361`, `:524`, `:549`, `:569`;
- `std/collections/hash_map.yo:73` (`bucket_size :: sizeof(MapEntry(K, V))`) and
  the `data_size := (capacity * bucket_size)` at `:82`;
- `std/allocator.yo:25-32` `size_would_overflow`, whose `type_size == usize(0) =>
  false` early-out means a zero-sized element type is declared un-overflowable.

`HashSet(T)` is unaffected today only because its slot type is `T` itself, not a
`MapEntry`.

## Why this is not already covered

- `issues/unit-zst-residual-gaps.md` item 2 covers a *different* shape: the
  DIRECT `ArrayList(unit)`, where `sizeof(T)` is 0 and the list mallocs zero
  bytes. That one does not corrupt anything on macOS/Linux, and it does not
  today — `ArrayList(unit)` with 2000 pushes prints `len = 2000` and exits 0,
  because the unit-store guards in `src/codegen/exprs/assignment.yo:109,124,240`
  suppress the write entirely. The bug here is the aggregate case: the write is
  NOT suppressed (the whole struct is stored), and the allocation is short but
  non-zero, so it is a real out-of-bounds write.
- `issues/fixed/unit-typed-params-and-fields-emit-c-void.md` claims "Every shape
  in the boundary table below now compiles and runs, including `println(())`,
  `ArrayList(unit)` and `HashMap(String, unit)`". `HashMap(K, unit)` **compiles**
  but does not run: the claim was verified against the C compiler, not against a
  populated map. That doc's "fixpoint-neutral by construction" argument holds for
  the C spelling but not for `sizeof`, which was left at 0.
- `tests/unit_as_value_type.test.yo` has a `struct(a : i32, b : unit)` case
  (`:18-21`) that asserts only `s.a == i32(1)`, and an `ArrayList(unit)` case
  (`:26-31`) with two pushes. Neither sizes an allocation, which is the failing
  dimension.

## Fix

**Make Yo's layout agree with the C that codegen already emits: give `.Unit`
(and `.Void`) a size of 8 bits in `get_size_of_type`,
`src/types/utils.yo:1535` and `:1539`.**

That is one line each, and it is the fix `issues/unit-zst-residual-gaps.md`
itself prescribes ("If a real unit store is ever needed, raise the size to 8 bits
first, and note that this is a user-visible change to the `size_of` builtin's
comptime value"). It makes every row of the table above agree:
`struct(b : unit)` → 1, `struct(a : unit, b : unit)` → 2, `struct(a : i32, b :
unit)` → 4+1 rounded to align 4 = 8, `struct(a : i64, b : unit)` → 8+1 rounded to
align 8 = 16. Alignment is already 1 and needs no change. `ArrayList(unit)` then
mallocs `cap * 1` instead of 0, which also closes
`issues/unit-zst-residual-gaps.md` item 2.

Two alternatives were considered and are worse:

- *Erase `unit` fields from the emitted C struct instead, keeping `sizeof` at 0.*
  C11 has no struct with zero members, so `struct(b : unit)` and
  `struct(a : unit, b : unit)` would still need a synthesized member — the same
  mismatch, just rarer. And field count/order is preserved on purpose: erasing a
  field desynchronizes constructor parameter lists and compound literals at every
  call site, which the `get_storage_type_string` design note calls out explicitly
  ("a missed site keeps failing loudly at the C compiler instead of silently
  desynchronizing an ABI").
- *Emit real C `sizeof(T)` rather than folding a literal.* Impossible without
  breaking comptime: `bucket_size :: sizeof(MapEntry(K, V))`
  (`std/collections/hash_map.yo:73`) and `size_would_overflow`'s comptime `cond`
  (`std/allocator.yo:27-31`) both require a compile-time value.

Follow-up, in a separate change once this lands: the unit-store guards at
`src/codegen/exprs/assignment.yo:109,124,240` exist only to keep a one-byte write
out of a zero-byte block and become removable. `issues/unit-zst-residual-gaps.md`
warns not to remove them before this fix, so that ordering must be kept.

While in `get_size_of_type`, check whether `.Void` can actually reach a storage
position. `get_storage_type_string` rewrites it identically, so if it can, it has
the identical bug; if it cannot, say so in a comment rather than leaving the two
arms silently divergent.

## Breaking change

`sizeof(unit)` becomes **1** instead of 0, and any aggregate containing a `unit`
field gets bigger. This is a user-visible change to a comptime builtin and must
be called out in the release notes.

In-tree there is exactly one dependant: `tests/comptime.test.yo:3014`
`comptime_assert(sizeof(unit) == 0)` must become `== 1`. (`sizeof(Type)`,
`sizeof(comptime_int)` and `sizeof(comptime_float)` on the neighbouring lines are
comptime-only types that never occupy a storage position and stay at 0.) Nothing
in `std/` or `src/` uses `sizeof(unit)`, declares a `unit` struct field, or
instantiates a container at `unit` — the only such shapes in the whole tree are
`tests/unit_as_value_type.test.yo:13` and `:27`, the file that gains the new
assertions anyway. So no type in the compiler or the standard library changes
size and the bootstrap fixpoint is not at risk.

## Regression test

`tests/unit_as_value_type.test.yo` — it is the regression test for the change
that created the mismatch, and it is the file that already owns every `unit`-as-a-
value shape. Add:

- a comptime pin of the layout, next to the existing struct case. The file
  already declares `_UnitField :: struct(a : i32, b : unit)` at `:13`; add
  `_OnlyUnit :: struct(b : unit)` beside it and pin both:
  `comptime_assert(sizeof(_UnitField) == 8)` and
  `comptime_assert(sizeof(_OnlyUnit) == 1)` — these fail today (4 and 0), which
  is the red-first check;
- **an allocation test, which is the dimension nothing currently covers**: push
  ≥ 64 `_UnitField` values into an `ArrayList(_UnitField)`, read every one back
  through `get(i)`, and assert `v.a == i32(i)` for all of them. Today this
  SIGBUSes at 3 elements;
- a `HashMap(i32, unit)` case: insert 64 keys, assert `len() == 64` and
  `contains_key` for each. Today this SIGSEGVs at 12.

Also add the layout pin to `tests/comptime.test.yo`'s "Test sizeof" alongside the
flipped `sizeof(unit) == 1`, so the builtin's value and the aggregate rule are
pinned in the same place.

## Consequence for the `collections/*` audit row

`plans/STD_API_AUDIT.md:541` and `plans/HANDOVER_STD_AUDIT_NEXT.md:124` propose
"HashSet = HashMap(T, unit) to kill ~500 duplicated SwissTable lines". That
mechanism is unavailable until this is fixed: `src/` has 188 `HashSet(`
instantiation sites, and the rewrite would hand every one of them a
heap-overflowing container. Either land this fix first, or pick a mechanism that
does not need a zero-sized value type — `std/imm/sorted_set.yo:26` already uses
`bool` as the dummy value for exactly this reason.
