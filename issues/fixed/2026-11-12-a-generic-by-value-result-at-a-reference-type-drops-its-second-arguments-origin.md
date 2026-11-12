# A generic by-value result at a reference type drops its second argument's origin

**Severity:** S1 — use-after-free in safe code: `picked := pick(rx, ry, false)` over `T := &i32` borrows only the first argument's referent, so a write, a growing push or a drop of what `picked` (which is `ry`) points into is accepted while `picked` is still read; with `ArrayList` element references the read is an ASan heap-use-after-free (new since v0.2.76, which rejected the call with E0601).

- Filed: 2026-11-12 (fixdev lane, found while fixing the G-E totality hole in `tests/origins/reference_read_rule.test.yo`'s `_sm_pick`).
- Related: R3 (#1904, `plans/backlog/REFERENCES_AND_ORIGINS.md`'s "a generic `T := &U` is a reference value"); O2's elided-result row (the union of the reference-holding arguments).

## Reproducer

```yo ignore
{ assert } :: import("std/assert");
_sm_pick :: (fn(generic(T : Type), a : T, b : T, first : bool) -> T)(if(first, a, b));
main :: (fn() -> unit)({
  x := i32(1);
  mut(y) := i32(2);
  rx := &x;
  ry := &y;
  picked := _sm_pick(rx, ry, false);
  y = i32(9);
  assert(picked.* == i32(2), "picked is ry");
});
export(main);
```

`yo check` accepts it (expected: E0911, `y` is written while `picked` borrows it). `YO_DEBUG_ORIGIN=1` prints
`_sm_pick(rx, ry, false) -> [x(imm), rx(imm)]`: the call's result is rooted at the first argument (its referent `x`, and
the binding `rx` itself) and never at the second. The same program with `x = i32(9)` instead is E0911, as it should be.

## Expected

The result of a call whose declared result is a by-value binder (`-> T`) specialized at a reference type holds what every
argument of type `T` holds: `[x, y]` here (O-3: a type parameter's instantiation carries one origin into all its
occurrences, so `a` and `b` share it and the result is their union).

## Status

Fixed (smpick lane, branch `fix/generic-ref-result-origins`). The fixdev PR (#1918) fixed only the callee-side totality
hole of the same function (the value tail's origin); this fixes the caller-side root computation,
`projection_call_root_args` / `_origin_carrying_roots_shallow` (`src/evaluator/utils.yo`).

## Severity verdict (2026-11-12, smpick lane)

S1 confirmed as a real memory error, not only a stack aliasing violation. Under `--sanitize address --allocator system`,
each of these is accepted by `check` on develop `a40824a3e` and the binary reports `heap-use-after-free ... READ of size 4`:

- the pick between two `ArrayList(i32)` element references (`rx := xs.index(usize(0))`, `ry := ys.index(usize(0))`),
  then `ys.push(...)` until the buffer reallocates, then `picked.*`;
- the same pick returning `Option(T)` (`.Some(if(first, a, b))`);
- a three-parameter pick returning its third argument (`pick(rx, rx, ry, 2)`);
- `-> T` whose body is `b`, followed by `drop(ys)` instead of the pushes.

The checker already rejected two shapes: the method form (`impl(Picker, pick : (fn(generic(T : Type), self : &Self, a : T, b : T) -> T)(...))`,
`pk.pick(rx, ry)`), whose receiver dispatch records the generic signature, and the fn-value form (`f := _sm_pick; f(rx, ry)`).
The tuple form (`-> Tuple(T, T)` with the body `(b, a)`) does not reach the C compiler:
`issues/2026-11-12-a-tuple-of-by-value-reference-parameters-emits-invalid-c.md` (S2). A local closure
`(fn(a : &i32, b : &i32) -> &i32)(&b.*)` drops its second argument too, by another path, and v0.2.76 already had that hole:
`issues/2026-11-12-a-local-closure-returning-a-reference-borrows-only-its-first-reference-argument.md` (S1).

## Fix

The call's specialization is built from the ARGUMENTS' types: `T` is bound to the first argument's type, `&(i32, x)`,
so the instance's result spells `[x]`, `a`'s slot spells `x`, and `b`'s slot spells the second argument's `y`. Both root
walks match the result's spelled names against the parameter slots, so `b` was never a root. In
`projection_call_root_args` it was not "named", and in `_origin_carrying_roots_shallow` it was mode 1, "not at all".
The specialization cache makes it worse: a second call `pick(rz, rw)` reuses the instance whose result still spells
the first call's `x`.

The rule now comes from the declaration, not the instance (O-3: a type parameter's instantiation carries one origin
into all its occurrences). `create_specialization_at_call` records the callee's declared `Func` type under the call's id
(`record_generic_callee_type`, `src/expr_info.yo`), and `generic_result_binder_modes` (`src/evaluator/utils.yo`) reads
from it which parameters share a type binder with the binders the result holds by value: `-> T`, `-> Option(T)`,
`-> Tuple(T, T)`, but not `-> Option(&(T, p))`, whose references point where `p` says. Each walk keeps its own rule and
widens it:

- a by-value parameter typed over one of those binders is a root like a named one;
- a reference parameter whose pointee is typed over one contributes its pointee's holder (mode 2), never its own place,
  so a cursor receiver is not frozen.

`type_var_ids_of` moved from `calls/function.yo` to `utils.yo` with a `through_refs` switch.
