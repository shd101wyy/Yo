# A specialization reached through a call keeps its raw signature as its C name

**Severity:** S3. Compile cost only: the emitted C is correct, but it carries
megabytes of identifier bytes, which the C compiler has to lex at every
declaration and call site.

## Symptom

`function_c_name` (`src/codegen/utils/index.yo`) hashes any function id
longer than 160 bytes to `__yo_fs_<fnv1a64>`. A specialization id carries its
full compile-time signature, and a value enum's `type_key` spells every
variant field, so these ids get long.

Three registrations in `src/codegen/functions/collection.yo` named the C
function with `c_symbol_name(func_id)` instead of `function_c_name`:
- the callee walk (`_call_find_function_calls_in_expr`'s call arm);
- the control-function value arm;
- the plain function-value arm.

So a generic function reached through a call kept its raw signature as its
name.

Measured on the compiler's own emitted C (`yo build`, macOS arm64):

| tree | `yo_id_*` names over 160 B | distinct | bytes |
| --- | --- | --- | --- |
| develop 49016882a | 1,968 | 370 | 3.65 MB |
| `TypeValue :: Rc(TypeValueNode)` (feat/vbd-v4-typevalue-rc-handle) | 2,736 | 367 | 12.59 MB |

On the handle tree, every `rc(TypeValueNode.X(...))` calls the prelude's
`rc` specialized at `V = TypeValueNode`. That specialization's name is
17,783 bytes, and it appears 780 times.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Big :: enum(
  Alpha(first_field : i32, second_field : i64),
  Beta(third_field : u8, fourth_field : String),
  Gamma(fifth_field : bool, sixth_field : f64),
  Delta(seventh_field : ArrayList(i32))
);
big_tag :: (fn(b : &Big) -> i32)(match(b, .Alpha(_, _) => i32(1), .Beta(_, _) => i32(2), .Gamma(_, _) => i32(3), .Delta(_) => i32(4)));
main :: (fn() -> unit)({
  h := rc(Big.Alpha(first_field : i32(1), second_field : i64(2)));
  println(big_tag(&h.*));
});
export(main);
```

`yo compile fx.yo --emit-c --skip-c-compiler` emits a 730-byte
`yo_id_1950582074307566843000000_Big_id_enum_decl_..._first_field_i32_...`
for `rc` and a 238-byte name for `println`'s formatter.

## Root cause

Phase 2's content-stable names (#603) introduced `function_c_name` and used
it in the module-export and impl registrations. The three callee-walk
registrations kept `c_symbol_name`.

## Test

`tests/internal/compile.test.yo`: "a specialization reached through a call
gets the hashed C name, not its raw signature". It compiles the reproducer
with `--emit-c` and asserts that no `yo_id_` name is longer than 160 bytes.

## Fix

The three registrations now name the function with `function_c_name`,
like every other registration (feat/vbd-v4-typevalue-rc-handle). A
specialization reached through a call gets `__yo_fs_<fnv1a64>` once its id
passes 160 bytes. Collisions still fall back to `register_function`'s
`_x<k>` suffix.

## Verification

- The reproducer's longest `yo_id_` name drops from 730 bytes to 150.
- The compile.test case fails on develop's `src` (built into the test
  binary) and passes on the fixed tree.
