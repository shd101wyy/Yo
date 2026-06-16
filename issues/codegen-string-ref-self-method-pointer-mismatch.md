# String `ref(self)` methods + Option payload — by-value/by-pointer C mismatches

**Status:** OPEN. Surfaced 2026-06-16 after str.len inlining (54c3f7e37) — the next
cluster blocking growable-`String` use in user code.

## Repro

`/tmp/r1.yo` (TS prints `ABC`):
```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
{ putchar } :: import("std/libc/stdio");
main :: (fn() -> unit)({
  s := String.from("AB");
  s.push_byte(u8(67));
  i := usize(0);
  while(i < s.len(), i = (i + usize(1)), {
    unsafe(putchar(int(i32(s.byte_at(i)))));
  });
});
export(main);
```

Self-hosted compiles to C with three distinct errors:
1. `passing '__yo_struct_3961' to parameter of incompatible type '__yo_struct_3961 *';
   take the address with &` — a `ref(self)` method (`push_byte : (fn(ref(self) :
   Self, b : u8) -> unit)`) takes `self` BY POINTER, but the call passes it BY
   VALUE. The concrete-method dispatch / arg materialization isn't applying the
   auto-`&` for a `ref(self)` receiver here. (Contrast: ArrayList methods with
   by-pointer self worked — the receiver was pre-wrapped; String's `ref(self)`
   path differs.)
2. `use of undeclared identifier '_file____User_temp_3249'` — a temp variable
   referenced out of its declaring scope (block/branch temp leak).
3. `initializing '__yo_enum_3968' with '__yo_struct_3961 *'; dereference with *` —
   String's `_bytes : Option(ArrayList(u8))` payload: a pointer is stored where the
   enum expects a value (or vice-versa) — the Option(ArrayList) representation
   (object/reference-semantics inside an Option) needs a deref the emitter omits.

## Notes / leads

- `str.len()` and `str` (immortal view) work (54c3f7e37). The gap is the growable
  `String` (heap `Option(ArrayList(u8))` backing) + `ref(self)` mutation methods.
- #1 is the most fundamental: find where the concrete-method dispatch decides to
  auto-`&` the receiver (it worked for ArrayList by-pointer self via the
  evaluator's pre-wrap, but `String.push_byte`'s `ref(self)` arg isn't wrapped).
  Compare the evaluator's recorded runtime_arg[0] for an ArrayList by-ptr method
  vs String's `ref(self)` method.
- #3 relates to the Option-of-reference-semantics-type representation (a `Some`
  payload that is itself a pointer-backed object) — distinct from the nullable-ptr
  optimization (which only applies to `Option(*(T))`).

These are codegen-emitter bugs (TS accepts the program); each needs its own minimal
repro split out from r1.
