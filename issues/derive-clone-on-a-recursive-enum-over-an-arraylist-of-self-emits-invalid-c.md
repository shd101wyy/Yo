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
