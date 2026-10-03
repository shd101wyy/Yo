# Collections: value semantics (copy-on-write) or reference semantics?

**Kind:** design question (decided; retired into a plan).

**Status:** DECIDED 2026-10-03 by the maintainer: values with copy-on-write, as part of a wider change in which every declared type is a value and sharing is spelled `Rc(T)`/`Arc(T)`. The plan is `plans/backlog/VALUES_BY_DEFAULT.md` (collections are its phase V2). Raised 2026-10-03 with `plans/STRING_VALUE_SEMANTICS.md`, which makes `String` a copy-on-write value and leaves the collections as they are for now.

## The question

`ArrayList`, `HashMap`, `HashSet`, `Deque` and the other std collections are reference types today: a copy shares the container. Once `String` is a value, the collections are the remaining source of half-value behaviour:

```rust
Bag :: struct(n : i32, items : ArrayList(i32));
p := Bag(n : i32(1), items : ArrayList(i32).new());
q := p;
q.n = i32(2);           // p.n stays 1
q.items.push(i32(7));   // p.items.len() is now 1 too
```

A struct copy is a value for its scalar fields and a shared reference for its container fields (measured on yo 0.2.49).

## Options

1. **Values with copy-on-write**, as in Swift. A copy is independent, and the buffer is cloned on the first write to a shared one. Sharing is explicit through `ref` types, `Box(T)` or `Arc`.
2. **Reference types**, as today. A copy shares, and an independent copy is an explicit `.clone()`.

## Recommendation (2026-10-03, awaiting maintainer verdict)

Option 1, as the campaign after `plans/STRING_VALUE_SEMANTICS.md`:
- **One rule.** A copy of any std data type, including a struct holding collections, is independent; sharing is always spelled out.
- **The verifier.** Two list parameters can no longer alias, so `requires(distinct(a, b))` (#1107) and the aliasing cases in the list encoding go away.
- **Agent-written code.** It removes action at a distance through a shared container.

The String campaign builds the machinery this needs and generalizes it: the dead-write warning, the count-accuracy guarantee and the uniqueness step.

The cost is the migration. `src/` passes collections to helper functions that mutate them throughout, and may keep one container in two places on purpose. The warning finds the first pattern; the second needs an audit (a shared container becomes a `ref` wrapper). The change also needs its own memory and time measurements on the compiler.
