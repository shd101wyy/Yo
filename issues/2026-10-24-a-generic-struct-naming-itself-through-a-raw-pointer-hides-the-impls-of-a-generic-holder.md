# A generic struct naming itself through a raw pointer hides the impls of a generic holder

**Severity:** S2 — a generic value struct with a `?*Self` field makes every generic `impl` on a generic type that holds it unreachable: each method call fails with a misleading E0610 ("No method `new`"), so the natural spelling of an owned linked structure cannot be written.

**Status:** open. Found 2026-10-24 while implementing P6
(`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4, D23), whose decided node
shape is exactly `_Node(T) :: struct(value : T, next : ?*Self, prev : ?*Self)`.
`std/collections/linked_list.yo` works around it by typing the links
`?*void` and casting in its link accessors. Reproduces identically with the
v0.2.68 seed and a develop build of `f1cfa553d`.

## Reproducer

`issues/repros/2026-10-24-a-generic-struct-naming-itself-through-a-raw-pointer-hides-the-impls-of-a-generic-holder.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
Link :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(
    value : T,
    next : Option(*Self)
  )
);
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(
    struct(
      head : Option(*Link(T)),
      length : usize
    )
  )
);
impl(
  generic(T : Type),
  Holder(T),
  new : (fn() -> Self)(Self(head : .None, length : usize(0)))
);
main :: (fn() -> unit)({
  h := Holder(i32).new();
  println(&h.length);
});
export(main);
```

```text
error[E0610]: No method "new" on Holder(i32): the type has no field or method with that name.
```

Measured variants (`yo compile`, one probe each):

| Shape                                                                 | Result |
| --------------------------------------------------------------------- | ------ |
| as above (`Link` generic with `?*Self`, `Holder` generic, generic impl) | E0610  |
| `Holder` a value struct instead of `ref`                              | E0610  |
| `Link`'s link typed `?*void`                                          | rc 0   |
| `Holder` holds `?*void` instead of `?*Link(T)`                        | rc 0   |
| `Link` and `Holder` both non-generic                                  | rc 0   |
| an `impl(generic(T), Link(T), …)` on `Link` itself                    | rc 0   |
| `Holder(i32)(head : .None, length : usize(3))` built directly          | rc 0   |
| the old `ref(struct(value : …, next : Option(Self)))` node in a generic list | rc 0 (what `LinkedList` used before P6) |

## Where it goes wrong (measured)

`YO_DEBUG_DISPATCH=1` shows the `Holder(T)` impl entry IS tried for
`Holder(i32)`, and its synthesis is swallowed:

```text
[tm-try] recv=struct_tmp__p5_LL_r2c4_n1 pat=struct_tmp__p5_LL_r2c4_n0 trial=false
[tm-synth-swallow] error: Cannot unify incompatible struct types: "<struct:struct_decl_tmp__p5__Node_r1c2>" and "_Node(i32)"
```

`YO_DEBUG_WARM=1` (the `[unify-struct]` line in
`src/evaluator/types/synthesizer.yo`, the struct+struct case) shows the
pattern's `Link(T)` carries the module-level DECLARATION id
`struct_decl_…_Link…` with an empty constructor funcId, while the receiver's
`Link(i32)` is a CTFE instantiation (`struct_…_Link…_n2`) with its funcId.
`lookup_struct_ctor_fid` has no stamp for the `struct_decl_` id, the
def-time-trial shape fallback does not apply (`trial=false`), so the pair is
rejected before field unification can bind `T`. The pattern's `Link(T)` also
names itself as `*(struct_decl_…)` in its own `next` field, i.e. it is the
self-shell's final registered under the declaration id, not an instantiation
of the impl's `T`.

`evaluate_struct_type` (`src/evaluator/types/struct.yo`) mints a
`struct_decl_` id only at `ctfe_depth == 0`, so some path evaluates
`Link`'s body at depth 0 with a symbolic `T` (a definition-time trial of the
constructor is the likely one) and that result reaches the impl pattern —
through the CTFE memo or the self-shell finals registry
(`g_struct_finals`, keyed by the shared declaration id, `resolve_struct_shell`).
Not confirmed which.

## Fix direction

Either stamp the constructor funcId on the depth-0 self-referential
declaration result too (so the struct arm's `same_constructor3` holds and
field unification binds `T`), or keep the trial's depth-0 struct out of the
memo / finals entry a later instantiation with a symbolic argument can read.
The regression test is the repro above as a `tests/` case, plus
`std/collections/linked_list.yo` going back to `next : ?*Self`.
