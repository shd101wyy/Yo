# A `usize` binder nested in a generic type argument is never inferred

**Severity:** S2 — `fn(generic(N : usize), xs : ArrayList(Array(i32, N)))` (or `Option(Array(i32, N))`) cannot be called at all: every call fails with E0604 "Function body has type `Type`" in the callee, even with a plain local argument, so a length parameter can only be inferred when the `Array` sits on the parameter's spine.

**Status:** open. Found 2026-10-22 by the adversarial review of
`fix/generic-binder-inference`, next to
`issues/fixed/2026-10-20-a-usize-generic-binder-is-misbound-from-a-method-call-argument.md`.
Not caused by that branch: the develop build it started from (`6cd3495c5`)
and the branch's tree build fail identically.

## Reproducer

`issues/repros/2026-10-22-a-usize-binder-nested-in-a-generic-type-argument-is-never-inferred.yo`:

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array_list");
count_list :: (fn(generic(N : usize), xs : ArrayList(Array(i32, N))) -> usize)(N);
count_opt :: (fn(generic(N : usize), o : Option(Array(i32, N))) -> usize)(N);
main :: (fn() -> unit)({
  xs := ArrayList(Array(i32, 3)).new();
  xs.push([i32(1), i32(2), i32(3)]);
  assert(count_list(xs) == usize(3), "N = 3 through ArrayList(Array(i32, N))");
  (o : Option(Array(i32, 3))) = .Some([i32(4), i32(5), i32(6)]);
  assert(count_opt(o) == usize(3), "N = 3 through Option(Array(i32, N))");
});
export(main);
```

```text
error[E0604]: Function body has type `Type`, but the declared result type is `usize`.
  --> count_list :: (fn(generic(N : usize), xs : ArrayList(Array(i32, N))) -> usize)(N);
note: in `count_list`, instantiated here
  --> assert(count_list(xs) == usize(3), ...);
```

Measured 2026-10-22 with `yo check`, one call per probe file, under the
develop build `6cd3495c5` and the `fix/generic-binder-inference` tree build:

| Parameter type                                 | Argument                       | Result |
| ---------------------------------------------- | ------------------------------ | ------ |
| `ArrayList(Array(i32, N))`                     | local `xs`, or `xs.clone()`    | E0604  |
| `Option(Array(i32, N))`                        | local `o`                      | E0604  |
| `Array(Array(i32, N), 2)`                      | local array of arrays          | rc 0   |
| `Option(Array(T, 3))` with `generic(T : Type)` | local `o`                      | rc 0   |
| `Array(i32, N)`                                | local, literal, method call    | rc 0 (the method call only on the branch) |

So the failure needs both a VALUE binder and a NOMINAL type (a generic struct
or enum) between the parameter and the `Array`. A type binder at the same
depth, and a length binder under another `Array`, are inferred.

## Where to look (hypothesis, not confirmed)

E0604 is the symptom of `N` being used in the callee body without a value
binding (the same symptom the 2026-10-20 issue had). Two places treat a
length variable inside a nominal type differently from one on the spine:

- `src/types/substitution.yo`, `_without_len_vars`: length resolution stops at
  a nominal boundary (Struct / EnumT / TraitT) by design, because rewriting
  `Array(T, N)` inside a struct field mints a type key no instantiation memo
  entry matches. A specialization with `N = 3` therefore leaves
  `ArrayList(Array(i32, N))` unchanged.
- The FuncVal arm's structural binder inference
  (`src/evaluator/calls/function.yo`, the "STRUCTURAL fallback" that reads
  `_scratch_len_binding` after `_fv_synthesize_arg_into`) only binds a value
  binder when the synthesizer's Array + Array case runs. Whether the
  Struct + Struct and Enum + Enum cases of
  `src/evaluator/types/synthesizer.yo` reach that case for a def-era
  instance whose type argument carries the length variable has not been
  checked.

A fix has to make the nested length reach the binder and has to keep the
nominal type's identity consistent with its concrete twin
(`ArrayList(Array(i32, 3))`), which is what the nominal boundary protects.

## Test

When fixed, add a canary to `tests/type_soundness.test.yo` built from the
reproducer (both parameter shapes, plus a method-call argument), next to the
2026-10-20 length-binder canary.
