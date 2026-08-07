# String `ref(self)` methods + Option payload — by-value/by-pointer C mismatches

**Status:** ✅ RESOLVED 2026-06-17. All three original bugs fixed; growable-`String`
build + byte-iteration compiles and prints `ABC` matching TS (fixture
string_build_iterate). Fixes:
- #1 missing auto-`&` on a `ref(self)` receiver → 4b1c3a158 (apply _apply_ref_amp in
  the concrete-method dispatch using the method's param_is_ref).
- KEYSTONE field-write-in-method emits empty → 21df350d6 (gate the comptime-only
  flag on the base var being compile-time-only; UnknownVal is Some-but-runtime).
- #3 Option-of-object payload / newtype field via ref(self) → dda6be84d (deref a
  newtype field access through a by-ref receiver, mirroring TS's Ptr-type pointer
  branch).
- #2 cond/match arm bare-identifier emitted an undeclared temp → f07cedf18
  (generate_atom resolves a plain identifier by its source TOKEN, not a stamped
  temp `variable_name` — mirrors TS atom.ts:262).
Corpus 50→52 (+method_field_mutation, +newtype_ref_self_mutation, +string_build_iterate;
str_len_method landed earlier). std -O0 sweep held 94/58 throughout.

(Original OPEN diagnosis kept below for the trace.)

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

## Progress 2026-06-17 (update)

The KEYSTONE below (field write in a method body) is FIXED (commit 21df350d6):
OBJECT field mutation in methods now works (`method_field_mutation` fixture → `A`).
Two narrower gaps remain from the original r1 repro:

- **Newtype receiver field access via `ref(self)` pointer** (refself.yo repro): for a
  `newtype Wrap(v:i32)` with `bump : (fn(ref(self) : Self) -> unit)`, `self.v` emits
  `self` (the `int*`) instead of `(*self)` — property_access.yo:313-327 returns the
  newtype field as `object_code` (zero-cost, value-semantics assumption), but a
  `ref(self)` receiver is a POINTER. Fix: deref when the newtype receiver is
  by-pointer. NARROW — `String` (also a newtype) mutates via its `Option(ArrayList)`
  field (push_byte → ArrayList methods), NOT direct newtype-field assignment, so it
  does NOT hit this.
- String bugs #2 (temp-scope leak) + #3 (Option-of-object payload ptr/value) below
  still open.

## Progress 2026-06-16

### ✅ Bug #1 (missing auto-`&` on a `ref(self)` receiver) — FIXED
The concrete-method dispatch (other_fn_call.yo) materialized args WITHOUT applying
ref-`&`, so `w.bump()` for `bump(self*)` emitted `bump(w)` ("take the address with
&"). FIX: mirror the FuncVal-call path — get the resolved method's `param_is_ref`
from its Func type and run `_apply_ref_amp` over the materialized args (a `ref(self)`
on a VALUE type → `&w`; an object receiver is not a ref param so it's untouched).
Minimal repro `/tmp/refself.yo` now emits `yo_id_3692((&(w)))`. Corpus 50/50, std
sweep 94/58 — regression-free. (NOTE: refself still prints `@` not `A` because of
the SEPARATE keystone below — the `&` itself is now correct.)

### KEYSTONE (blocks ALL mutating methods + demonstrating bug #1): a field WRITE
### in a method body emits empty
`p.a = (p.a + 1)` in `main` works, but `self.a = (self.a + 1)` inside a method body
(object OR newtype, unit- OR value-returning) emits NOTHING — the whole assignment
statement is dropped (`bump`'s body is `{}`; `bumpv`'s body is just `return
self->a;`). Field READS (`self.value`, the corpus `get`/`speak`) work — only WRITES
fail, which is why no corpus fixture caught it.

ROOT: `generate_assignment` (assignment.yo) returns empty (no C) for this write via
one of its comptime short-circuits — either line 40 (`ei.is_compile_time_only_assignment`)
or lines 70-85 (LHS base var `self` is compile-time-only,
`_last_is_compile_time_only(lhs_ei.env, "self")`). BOTH are rooted in the DEF-TIME
(validating-mode) method-body eval, where `self`/the write are treated as comptime;
`main`'s `p` is a runtime local so its identical write emits. NEXT PROBE to
disambiguate the exact field (one `-O0` build): in generate_assignment gate on the
LHS being `self.<field>` and print `ei.is_compile_time_only_assignment` +
`_last_is_compile_time_only(lhs_ei.env, "self")`.

This is the method-body-eval-mode keystone (same family as Gap-6 / create_specialized
over-CTFE): non-generic methods (no forall, no runtime-return spec) take their body
ExprInfo straight from def-time validating eval, where `self` is comptime-only. FIX
DIRECTION: ensure a method body's `self`/params are RUNTIME (not compile-time-only)
in the ExprInfo codegen consumes — either re-evaluate method bodies in executing
mode with runtime params, or bind `self` as runtime at the impl-method def-eval.
NOT a codegen-local hack (don't special-case `self` in assignment.yo — that would
mis-emit genuinely-comptime writes).
