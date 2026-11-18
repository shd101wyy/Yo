# How an arena lends a `&mut` reference through a shared receiver

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — raised 2026-11-15 while checking
[`plans/backlog/ZIG_STYLE_ALLOCATORS.md`](../../plans/backlog/ZIG_STYLE_ALLOCATORS.md)
§4 (the real arena, phase A4) against the checker as built. Measured with
`yo 0.2.77` and with a build of `origin/develop` merged into `fix/sig-1`
(`5c1b9c056`, 2026-11-15); both give the results below.

## What A4 needs

A4's one signature is

```yo ignore
alloc : (fn(self : &Self, v : T) -> &mut(T, self))
```

The receiver is shared, because an allocation must not freeze the arena
against the next one. The result is a `&mut` to the new value, and its origin
is the arena, so that `reset` and `drop` (which take the arena exclusively)
are errors while any handle is live. The plan says this needs "no new kind, no
new rule" (§4.2).

## What the checker does today

[`repros/2026-11-15-how-an-arena-lends-a-mut-reference-through-a-shared-receiver.yo`](../repros/2026-11-15-how-an-arena-lends-a-mut-reference-through-a-shared-receiver.yo)
is a two-slot stand-in for a bump arena, in a `Pragma.AllowUnsafe` file.

| Probe | Result |
| --- | --- |
| `alloc(self : &Self, …) -> &(T, self)`; two results live at once | accepted |
| the same, then `arena.reset()` (a `&mut self` method that writes) with a result live | E0911, as A4 wants |
| the same, then `arena = Bump.new()` with a result live | E0911 |
| `alloc(self : &Self, …) -> &mut(T, self)`: the definition | accepted |
| the same: any call, `p := arena.alloc_a(i32(1));` | **rejected**: "Cannot bind `p` to `(arena.alloc_a)(i32(1))`: the projection borrows no argument, so its place has no storage to borrow." |

So the shared form of the arena works today, and the `&mut` form does not: a
`&mut` result reached through a `&` receiver has no place the checker will
lend. The definition is accepted and every call is rejected, with a message
about the caller for a property of the callee's signature.

(An empty-bodied `reset` is accepted beside a live handle. That is the open
rule-G item,
`issues/fixed/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.md`,
not a new finding.)

## Options

1. **The arena lends `&(T, arena)` only.** Nothing new is needed. An arena
   value is then read-only after `alloc` unless it holds a cell, which rules
   out building a node and filling it in afterwards.
2. **A `&mut` result may name a `&` receiver when the receiver's type is
   interior-mutable.** The loan the result keeps on the receiver stays
   shared: two results do not conflict with each other or with a read of the
   arena, and they do conflict with `reset` and with a move or drop. That the
   new value is not aliased is the callee's promise, made under
   `AllowUnsafe`, which is where Rust puts it for `bumpalo`. "Interior-mutable"
   is the structural predicate of
   `issues/questions/2026-11-11-how-the-checker-knows-a-type-is-interior-mutable.md`
   (one primitive cell), so the two questions share one answer.
3. **`alloc` takes `&mut self`.** Every live handle then freezes the arena
   exclusively, and a second allocation is an error. Not an arena.

## Recommendation

Option 2, landing with N2d and the primitive cell of the interior-mutability
question, as a stated prerequisite of A4. Until it lands, reject the
signature at its definition, with a message that names the receiver's mode,
in place of the call-site error. If A4 is wanted before N2d, option 1 is a
sound first version: it already checks.
