# `Dyn(Trait)` object safety is not enforced by the evaluator; violations become C compiler errors

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** FIXED 2026-09-25 (Phase 2.7 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
says object safety "is enforced at method call time"; no such check exists (grep of `src/` for
object safety finds nothing).
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro 1: a method that returns `Self`

```rust
Sp :: trait(speak : (fn(self : Self) -> i32), me : (fn(inout(self) : Self) -> Self));
Cat :: ref(struct(n : i32));
impl(Cat, Sp(speak : (self -> self.n), me : (self -> self)));
main :: (fn() -> unit)({
  (dd : Dyn(Sp)) = dyn(Cat(n : i32(3)));
  a := dd.speak();
  b := dd.me();
});
export(main);
```

`yo check` OK; clang: `error: initializing '__yo_t_…' with an expression of incompatible type 'void *'`.

## Repro 2: a generic method in a dyn trait

```rust
Gen :: trait(conv : (fn(generic(B : Type), inout(self) : Self, b : B) -> i32));
Cat :: ref(struct(n : i32));
impl(Cat, Gen(conv : (fn(generic(B : Type), inout(self) : Self, b : B) -> i32)(self.n)));
main :: (fn() -> unit)({
  (dg : Dyn(Gen)) = dyn(Cat(n : i32(3)));
  g := dg.conv(i32(1));
});
export(main);
```

`yo check` OK; clang: `error: use of undeclared identifier '__yo_wrap_…_conv'`.

Also measured: there is no upcast from `Dyn(Sp, Ot)` to `Dyn(Sp)`
(`E0601 Expected dyn(Sp), Given dyn(Sp + Ot)`).

## Fix direction

At a `Dyn` method call (or once, when `Dyn(Trait)` is formed), reject any trait member whose
signature mentions `Self` outside the receiver or takes `generic(...)` binders, with a coded error
that names the member. Then either implement that rule or correct DYN_DESIGN.md.

## Related

`issues/blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable.md`,
`issues/dyn-cannot-resolve-a-trait-method-that-comes-from-a-generic-impl.md`.

## Fix

- One predicate, `dyn_member_unsafe_reason` (`src/types/utils.yo`), decides whether a trait
  method can be called through a `Dyn`. The method's first parameter must be `self`, `Self` may
  appear only as the receiver, and it must take no `generic(...)` parameters.
- Codegen gives a vtable slot (typedef, wrapper, initializer) exactly to the methods it accepts.
- The evaluator rejects a call through a `Dyn` to any other method with E0614 (`yo explain
  E0614`). The error names the method, the trait and the reason: `it returns Self, which the Dyn
  erases`, `its parameter "other" has type Self, which the Dyn erases`, or `it takes
  generic(...) parameters, so there is no single function to put in the vtable`.
- Forming the `Dyn` and calling its other methods stays legal, which is what DYN_DESIGN.md
  always described. DYN_DESIGN.md's rule list is corrected: a by-value `self : Self` receiver
  is fine, because the wrapper unboxes it.
- **Upcasting decision:** not supported. `Dyn(Sp, Ot)` and `Dyn(Sp)` have different vtable
  layouts, and the concrete type needed to build the smaller vtable is erased. The type mismatch
  now carries a note saying so (`dyn_upcast_note`), pointing at `dyn(...)` on the concrete value.

## Verification

`tests/dyn.test.yo`:
- "a method a Dyn cannot call is E0614, the rest stay callable": Repro 1, a `Self` parameter,
  and Repro 2.
- "no upcast from Dyn(A, B) to Dyn(A), with a note saying so".

Both repros now stop at `check` with E0614 instead of failing in clang.
