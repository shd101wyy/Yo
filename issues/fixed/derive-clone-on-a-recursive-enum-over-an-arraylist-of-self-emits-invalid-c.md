# `derive(Node, Clone)` on a recursive enum over `ArrayList(Self)` emits invalid C

**Severity:** S2: a valid program that `check` accepts fails in the C compiler (`unknown type name`).

**Status: FIXED 2026-10-17** (see Fix below). Found 2026-10-03 while re-verifying the core-patterns cheatsheet's circular-derive section (agent-knowledge consolidation K0). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Node :: enum(Leaf, Branch(children : ArrayList(Self)));
derive(Node, Clone);
main :: (fn() -> unit)({
  xs := ArrayList(Node).new();
  xs.push(Node.Leaf);
  a := Node.Branch(xs);
  d := a.clone();
  println(match(d, .Branch(cs) => cs.len(), .Leaf => usize(0)));
});
export(main);
```

- `yo check`: evaluator OK.
- `yo compile`: `error: unknown type name '__yo_t_4727272517329921912'`. The `ArrayList(Node)` struct is emitted before the `Node` typedef it names.

`derive(Node, Eq)` and `Eq(Node)` on the same enum compile and run, so the ordering defect is specific to what `Clone` emits.

## Expected

The program prints `1`. Whatever `Clone` derives must be emitted after the `Node` declaration, or reach it through the forward declaration, as the `Eq` derivation already does.

## Broadened 2026-10-14 (v0.2.62 batch review)

The defect is not specific to `Clone`. No derive is needed: any `Option(J)` of a recursive enum laid out as a nullable pointer is emitted before `J`'s typedef.

The nullable-pointer layout applies to an enum with one unit variant plus one variant holding a single reference field. Its `Option(J)` data union holds a `J` member, and the type collector emits that union first.

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
J :: enum(JNull, JArr(xs : ArrayList(Self)));
main :: (fn() -> unit)({
  xs := ArrayList(J).new();
  xs.push(J.JNull);
  r := match(xs.get(usize(0)), .Some(_) => i32(1), .None => i32(-1));
  println(`r=${r}`);
});
export(main);
```

`error: unknown type name '__yo_t_…'` on the `Option(T)` union's `__yo_v_value` member. `HashMap(String, Self)` with `HashMap.get` fails the same way. This reproduces on develop a89b8356c and on v0.2.61.

A related shape gives `Option(E)` two C types instead: a recursive value enum with an `Option(Self)` inside a payload, such as `J :: enum(JStr(s : String), JOpt(o : ArrayList(Option(Self))))` together with an `Option(J)` reached from outside. That one is filed separately as `issues/option-of-self-inside-a-payload-gives-option-of-a-recursive-enum-two-c-types.md`.

## Root cause

The defect is in how a self-shell lowers. Emission order is not the problem.

- **The fold.** `J :: enum(JNull, JArr(xs : ArrayList(Self)))` has the nullable-pointer shape, so its final form lowers to the bare payload pointer `ArrayList(J)*`. `get_type_string` renders a final `J` as that pointer and never names a `J` typedef.
- **The shell.** The `Self` written inside the payload is a fieldless self-shell (`resolve_enum_shell`). Every type built from it carries the shell: `ArrayList(Self)._ptr : *(Self)`, and the `Option(T)` that `ArrayList(T).get` returns.
- **The mismatch.** `can_optimize_as_nullable_pointer` judged the shell by its own empty variant list. So the shell kept the tagged layout, and `_lookup_named_c_type` found the C name that `type_key` maps the shell to, which is the final's nullable typedef. Pass 4 of `generate_type_declarations` emits that typedef after every struct and union. The `ArrayList(Self)` struct body and the `Option(T)` data union named it first.

`derive(Clone)` only exposed this. The broadened shapes reach the same shell without a derive.

## Fix

`can_optimize_as_nullable_pointer` (`src/types/guards.yo`) judges an enum by its finalized form (`resolve_enum_shell`). A shell now lowers to the same payload pointer as its final, which needs only the payload struct's forward declaration. Every consumer of the predicate moves together: `get_type_string`, match lowering, the dependency walk and the size model. The size model already resolved shells, so the layout does not change: the typedef was already that pointer.

The same change refuses the fold when the payload pointer leads back to the enum itself. That case was found while checking `Box` payloads and is filed as `issues/fixed/2026-10-17-a-nullable-shaped-enum-over-box-of-self-emits-a-self-referential-typedef.md`.

**Test:** `tests/derive_clone_complex.test.yo` section 12 covers four shapes:

- `derive(Clone)` over `ArrayList(Self)`. The test pushes to the original after cloning and checks that the clone's list is its own.
- `ArrayList(J).get` returning `Option(J)`, with no derive.
- `derive(Clone)` over `HashMap(String, Self)`.
- `derive(Clone)` over `ArrayList(Option(Self))`.

Before the fix, the file failed to compile (21/21 failed on `yo-dev-5425cd7bf`).
