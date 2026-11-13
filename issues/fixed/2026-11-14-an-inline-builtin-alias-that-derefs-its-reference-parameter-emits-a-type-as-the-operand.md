# An inline-builtin alias that derefs its reference parameter emits a type as the operand

**Severity:** S2: the deref sweep's spelling of `MaybeUninit.as_ptr`, `addr_of(self.*)`,
makes every program that reaches it fail in the C compiler (invalid C, never a wrong
binary), under the v0.2.77 seed and the tree compiler alike, so the deref flip's stage 2
could not build.

Filed 2026-11-14 from VERDICTS-60 §3 (Q2′), which found it while checking whether the
v0.2.77 seed can build the deref-swept tree. `yo check` passes on the swept text under
both compilers; only a compile shows it.

## Reproducer

One line of std (`v0273/fable/probe-60/seed2.diff`):

```diff
-    __yo_maybe_uninit_as_ptr(Self, BaseType, addr_of(self))
+    __yo_maybe_uninit_as_ptr(Self, BaseType, addr_of(self.*))
```

With that line, any program reaching `MaybeUninit.as_ptr` fails. The same shape in a user
file (a judged file, where `addr_of(m)` is E0926 and `addr_of(m.*)` is the spelling):

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
_uninit_ptr :: (fn(m : &mut MaybeUninit(i32)) -> *i32)(
  __yo_maybe_uninit_as_ptr(MaybeUninit(i32), i32, addr_of(m.*))
);
main :: (fn() -> unit)({
  mut(u) := MaybeUninit(i32).new();
  p := _uninit_ptr(&mut u);
  unsafe(p.* = i32(41));
  v := u.assume_init(p);
  println(v + i32(1));
});
export(main);
```

```text
$ yo compile tmp/fixme.yo --optimize 0 -o tmp/a.out      # yo 0.2.77
tmp/a.out.c:2376:49: error: expected expression
 2376 |   return ((int32_t*)(__yo_t_3328559042712378044));
yo: error: compile: C compiler failed (exit 1) on tmp/a.out.c
```

`__yo_t_…` is the typedef of `MaybeUninit(i32)`.

## Root cause

Two defects in `src/codegen/`, one hiding the other.

1. `_inline_body_passes_params_through` (`src/codegen/utils/index.yo`) treats a wrapper as
   an alias of an inline builtin only when each argument is a parameter, bare or under
   `&(…)`/`unsafe(…)`. `m.*` is a call node, so the wrapper stopped being an alias and was
   emitted as a function. The evaluator already records a written `.*` of a reference
   binding as rewritten to the name (`note_rewritten_node`, `evaluate_property_access`),
   because `&(*m)` is `m` in C; the alias rule did not read through that record.
2. The builtin's direct emission (`src/codegen/exprs/inline_fns.yo`) printed operand 0 as
   the pointer. At an alias call site operand 0 is the caller's receiver; called directly,
   the operands are `Self, BaseType, addr_of(…)`, and operand 0 is the type.

The prelude's two `Array` `index`/`index_mut` bodies, swept to
`__yo_array_index(addr_of(self.*), idx)`, lost their alias the same way; their direct
emission happens to be valid C, so they only stopped being inlined.

## Fix

- The alias rule reads an `&(…)`/`addr_of(…)` operand through `ast_rewritten_node`: the
  deref `p.*` of a parameter declared `&T`/`&mut T` is `p`. A `.*` on a by-value parameter
  (a `Box`, a pointer) is not recorded that way, so it stays a computed argument and the
  wrapper is emitted as a function, as before.
- The direct emission of `__yo_maybe_uninit_as_ptr` prints its last operand, which is the
  pointer in both forms (a wrapper that is not a pass-through alias still compiles).

Test: `tests/inline_builtin_alias.test.yo` ("an inline-builtin alias over `addr_of(p.*)`
of a reference parameter compiles and writes through"): the alias, a non-alias wrapper
that calls the builtin directly, and the `Array` index alias. Before the fix the batch
failed in the C compiler with two `expected expression` errors.
