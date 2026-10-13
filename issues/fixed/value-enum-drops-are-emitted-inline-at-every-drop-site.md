# A value enum's drop is emitted inline at every drop site

**Status:** FIXED 2026-10-13 (branch `feat/v4-value-enum-drop-fns`)

**Severity:** S2 — a large value enum with reference-counted fields multiplies the emitted C: converting the compiler's `TypeValue` to a value enum grew the self-emit from 147 MB to 726 MB of C

Found 2026-10-13 while converting `TypeValue` from `ref(enum)` to a value
enum with `Rc(Self)` children (plans/VALUES_BY_DEFAULT.md decision 21, V4).
The v0.2.59 seed and the tree at `develop` 3b7640edb both emit this shape.

## Symptom

Every point where a value of a value enum goes out of scope (a block end,
every early return, every `__yo_effect_escaped` exit after a call) gets its
own `switch` over the enum's tag that decrements each reference-counted
field of each variant:

```c
switch ((__yo_v_b).tag) {
  case __YO_T_..._PTR: {
    __yo_decr_rc((void*)((__yo_v_b).data.__yo_v_Ptr.__yo_v_p));
    break;
  }
  case __YO_T_..._TUP: {
    __yo_decr_rc((void*)((__yo_v_b).data.__yo_v_Tup.__yo_v_labels));
    __yo_decr_rc((void*)((__yo_v_b).data.__yo_v_Tup.__yo_v_ts));
    break;
  }
  ...
  default: break;
}
```

For a four-variant enum this is ~20 lines per site. `TypeValue` has 40
variants and about 60 counted fields, so each drop site is ~120 lines, and
the compiler has about 51 000 of them.

## Measurement

`yo build --std-path ./std` with the v0.2.59 seed, branch
`feat/vbd-v4-typevalue` (commit 9eefb8c37, `TypeValue` as a value enum)
against `develop` 3b7640edb (`TypeValue` as a `ref(enum)`):

| | develop | value-enum `TypeValue` |
| --- | --- | --- |
| `yo-out/.../yo.c` | 147 MB, 1.97 M lines | 726 MB, 8.85 M lines |
| `case __YO_T_<TypeValue>_POINTER:` lines | 0 | 51 500 |
| `__yo_decr_rc((void*)((_file____User_temp_…` lines | 29 503 | 1 235 738 |

The most frequent line shapes of the 726 MB file are `}`, `break;`, the two
`__yo_decr_rc((void*)(((_file____User_temp_…` forms and one `case` label per
`TypeValue` variant, each ~51 000 times.

## Reproducer

```yo
TV :: enum(
  Unit,
  Int(bits : u8),
  Ptr(p : Rc(Self)),
  Tup(labels : ArrayList(String), ts : ArrayList(Self)),
  Opt(r : Option(Rc(Self)))
);
```

Construct and pass a few `TV` values in `main` and read the C with
`yo compile x.yo --emit-c --skip-c-compiler`: a 4-line `main` already holds
33 copies of the `switch`.

## Root cause

The scope-exit drop of a value enum is generated as the variant switch
itself at each site instead of a call to one per-type drop function (as a
`ref` type gets `__yo_decr_rc`, whose dispose function is emitted once).

## Fix direction

Emit one `static void __yo_drop_<T>(T*)` per value-enum type that has
counted fields (the same for the dup), and call it at each drop site. This
is a prerequisite for V4's `TypeValue` conversion: it must land in the tree
and be carried by a seed before the converted tree can be self-built at a
reasonable size. A regression test (a cli-case counting the `switch` copies
in the emitted C of the reproducer) comes with the fix.

## Fix

`src/codegen/exprs/drop_dup.yo`: the tagged representation's drop and dup
walk is one C function per value-enum type, generated on first use by
`_value_enum_rc_fn` and called at every site:

```c
static inline void __yo_venum_drop___yo_t_N(void* __yo_p) {
  __yo_t_N* __yo_v = (__yo_t_N*)__yo_p;
  switch ((*__yo_v).tag) { case ...: { __yo_decr_rc(...); break; } ... }
}
...
__yo_venum_drop___yo_t_N((void*)&(__yo_v_b));          // a drop site
__yo_t_N temp_dup_enum_0 = x;                            // a dup site:
__yo_venum_dup___yo_t_N((void*)&(temp_dup_enum_0));     //   copy, then retain in place
```

- The functions take the value by address through `void*`, so their
  prototypes name no type. `compile_module` (`src/codegen/codegen_c.yo`)
  appends the prototypes to the headers section, ahead of every caller,
  including the async dispose and spawn-wrapper bodies that are written into
  the declarations section in the middle of codegen. The definitions need the
  complete enum type, so they close the declarations section. Both are
  `static inline`: chunked emission keeps them in the shared header as per-TU
  copies, like the other RC helpers.
- Both go to side buffers on `CodeGenContext` (`value_enum_rc_protos`,
  `value_enum_rc_defs`), never through `context.base.emitter`: several
  callers swap that emitter for a scratch one and splice its text into a
  function body. The body itself is generated under a scratch emitter, so a
  nested field walk (an array loop, a tuple temp, a `Box` dispose, another
  enum's call) lands in the function.
- The functions are keyed by C name, so two type keys that alias onto one C
  type share one function.
- A user `Dispose` on a move-only value enum still runs at the site, before
  the call. The nullable-pointer representation (`Option(Rc(T))` and the
  like) stays a one-line inline test.

## Measurements

macOS arm64. "Before" for the self-emit rows is `develop` 9749d7bf1 plus #1329's
four V4-prep commits (no codegen change), built the same way; "after" is this
branch's tree-built compiler.

| | before | after |
| --- | --- | --- |
| reproducer (`TV` above): `switch` statements in the C | 35 | 14 (the non-`TV` ones) |
| `tests/internal/compile.test.yo` fixture: `case …_VEHOLD:` labels | 18 | 2 (one drop, one dup function) |
| self-emit of `develop` (`src/main.yo`, stage 2) | 148.7 MB | 138.0 MB (the compiler's own value enums: `Option`, `Result`, `String`'s payload, …) |
| stage-2 emit time / max RSS | 357.6 s / 3.25 GB | 355.5 s / 3.22 GB |
| stage-2 `check ./src` time / max RSS | 181.1 s / 1.28 GB | 181.7 s / 1.26 GB |
| self-emit of `feat/vbd-v4-typevalue` (`TypeValue` a value enum) | 726 MB | 141.8 MB (414 s, 3.30 GB) |

The bootstrap fixpoint holds (stage 2 = stage 3, hollow 0).

## Tests

- `tests/internal/compile.test.yo` "a value enum's drop and dup are one
  function each, not a switch per site": compiles a fixture with
  `run_compile --emit-c` and counts the `case` labels of a variant no code
  matches on. Before: 18; after: 2. Each drop function is defined once.
- `tests/recursive_enum.test.yo` "Value enum: every payload is released once
  through the per-type drop and dup": a value enum over a `Dispose`-counting
  reference struct, dropped at scope ends, by-value parameters and early
  returns, copied out of an `ArrayList` with `get`; all six payloads are
  disposed exactly once.
