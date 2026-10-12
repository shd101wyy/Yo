# A value enum's drop is emitted inline at every drop site

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
