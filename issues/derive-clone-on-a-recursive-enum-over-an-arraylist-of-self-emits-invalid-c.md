# `derive(Node, Clone)` on a recursive enum over `ArrayList(Self)` emits invalid C

**Severity:** S2: a valid program that `check` accepts fails in the C compiler (`unknown type name`).

**Status: OPEN.** Found 2026-10-03 while re-verifying the core-patterns cheatsheet's circular-derive section (agent-knowledge consolidation K0). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

```rust
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
