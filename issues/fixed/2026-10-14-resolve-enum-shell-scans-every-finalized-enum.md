# `resolve_enum_shell` scans every finalized enum on each shell it meets

**Severity:** S3. Compile time only. On the `TypeValue :: Rc(TypeValueNode)`
tree, `check ./src` went from 188 s to 224 s and the self-emit from 402 s to
587 s (+20 % and +46 %).

## Symptom

A microbenchmark pushes one `TypeValue` handle 900 times. On the handle tree
each push cost 2.2 ms of checking, against 1.3 ms on develop's `ref(enum)`
`TypeValue`. An `i32` push cost the same on both.

`sample` of a 6,000-push run put `resolve_enum_shell`
(`src/types/creators.yo`) at the top of the stack, with `__yo_decr_rc`
second from the entries it cloned.

## Root cause

`g_enum_finals` was an `ArrayList(EnumFinalEntry)`. `resolve_enum_shell`
walked it front to back for every empty-variant `EnumT` it was handed.

A recursive value enum's `Rc(Self)` children stay self-shells inside
nested containers (`_patch_self_shell` stops at its visited guard), so every
type walk over a `TypeValueNode` resolves shells. A `ref(enum)` has no
shell, which is why develop never paid this. The struct registry
(`g_struct_finals`) was turned into a map for the same reason earlier.

## Fix

`g_enum_finals` is a `HashMap(String, TypeValue)`. The first registration
wins, which matches the old front-to-back scan.
`stamp_enum_final_type_arguments` updates the shell's entry in place.

## Verification

Measured on macOS arm64. Each tree is checked by its own S1, seed-built by
v0.2.62, under the exclusive heavy lock:

| | `check ./src` | emit (`compile src/main.yo --skip-c-compiler`) |
| --- | --- | --- |
| develop 93de1de73 | 188.1 s | 401.6 s |
| handle tree before the fix | 224.1 s | 586.8 s |
| handle tree with the fix | 172.1 s | 334.5 s |

The fix is a lookup-structure change with no behavior to test. The tests that
cover shell resolution pass: recursive_enum, match_nested, rc,
cycle_collector, and tests/internal types_utils, types_value, type_key and
hierarchy.
