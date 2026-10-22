# An object holding a cyclic cell behind an `Option` or a pointer derives `Acyclic`

**Severity:** S2 — `Type.impls(T, Acyclic)` answers `true` for an object
type whose field holds a cycle-capable cell inside an `Option` (or behind a
raw pointer, as `Channel(T)`'s buffer does), so a `where(T <: Acyclic)`
bound accepts a type whose values reach a cycle of strong edges. The same
cell held directly in the field answers `false`. Bounded: no std API
requires `Acyclic` since decision 48 W2, so only a user-written bound reads
the wrong answer, and the cycle itself is formable with or without it.

**Status:** open. **Found:** 2026-10-22, landing decision 48 W2
(`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §2) on
`feat/arc-without-acyclic`: with the `Acyclic` bound gone,
`OnceCell(Cyclic)` and `Channel(Cyclic)` became formable, and their derived
marker said `true` while `Mutex(Cyclic)`'s and `RwLock(Cyclic)`'s said
`false`. Restoring the containers' conditional
`impl(generic(T), where(T <: (Send, Acyclic)), C(T), Acyclic())` does not
change the answer: a failed conditional impl falls back to the derivation.
The user-defined objects below show the derivation is the cause, independent
of std.

## Reproducer

`issues/repros/2026-10-22-an-object-holding-a-cyclic-cell-behind-an-option-or-a-pointer-derives-acyclic.yo`:

```yo
{ println } :: import("std/fmt");
{ Channel } :: import("std/sync/channel");
{ OnceCell } :: import("std/sync/once");
// A cell type that reaches itself: not Acyclic, correctly.
Cyclic :: atomic(ref(struct(v : i32, next : Option(Self))));
// Objects that hold a `Cyclic` reach that cycle, so none of them is Acyclic.
HoldsDirect :: atomic(ref(struct(x : Cyclic)));
HoldsOption :: atomic(ref(struct(x : Option(Cyclic))));
CYCLIC :: Type.impls(Cyclic, Acyclic);
HOLDS_DIRECT :: Type.impls(HoldsDirect, Acyclic);
HOLDS_OPTION :: Type.impls(HoldsOption, Acyclic);
ARC_OPTION :: Type.impls(Arc(Option(Cyclic)), Acyclic);
ONCE_CELL :: Type.impls(OnceCell(Cyclic), Acyclic);
CHANNEL :: Type.impls(Channel(Cyclic), Acyclic);
main :: (fn() -> unit)({
  println(`Cyclic <: Acyclic: ${CYCLIC} (expected false)`);
  println(`HoldsDirect <: Acyclic: ${HOLDS_DIRECT} (expected false)`);
  println(`HoldsOption <: Acyclic: ${HOLDS_OPTION} (expected false)`);
  println(`Arc(Option(Cyclic)) <: Acyclic: ${ARC_OPTION} (expected false)`);
  println(`OnceCell(Cyclic) <: Acyclic: ${ONCE_CELL} (expected false)`);
  println(`Channel(Cyclic) <: Acyclic: ${CHANNEL} (expected false)`);
});
export(main);
```

Output (tree at `feat/arc-without-acyclic`, 2026-10-22):

```text
Cyclic <: Acyclic: false (expected false)
HoldsDirect <: Acyclic: false (expected false)
HoldsOption <: Acyclic: true (expected false)
Arc(Option(Cyclic)) <: Acyclic: true (expected false)
OnceCell(Cyclic) <: Acyclic: true (expected false)
Channel(Cyclic) <: Acyclic: true (expected false)
```

A user enum in place of `Option` (`enum(Nothing, Just(n : Cyclic))`), a
value struct wrapper and a tuple all answer `false`, as they should; a
non-atomic `ref(struct(x : Option(RcCyclic)))` answers `true`, so the
shape is not specific to atomic cells.

## Root cause (hypothesis)

An object's `Acyclic` is answered from the definition-time walk
(`can_type_form_rc_cycle` / `_type_refs_back_to_cyclic`,
`src/types/utils.yo`), not from its fields' markers
(`src/evaluator/trait_checking.yo`, the `(tn == "Acyclic")` branch defers
objects to the registry). That walk finds the inner cycle when it meets the
cell directly: it re-roots at the cell and sees the cell's own `Self` edge.
Two paths lose it:

- **`Option(...)`.** Probably the visited-id cut: every `Option`
  instance carries the generic enum's id, so after the walk enters
  `Option(Cyclic)` and re-roots at `Cyclic`, the `Option(Self)` in
  `Cyclic`'s field looks already visited and is cut before the back edge
  to `Cyclic` is seen. A user enum, not generic, behaves correctly, which
  fits this explanation; it is not yet confirmed in a debugger.
- **A raw pointer.** `_type_refs_back_to_cyclic` answers `false` for
  `*T`; only a `?(*(E))` buffer field (`buffer_element_type`) is traced.
  `Channel(T)`'s ring buffer is a bare `_data : *T`.

For the collector (`can_type_form_rc_cycle`'s other caller) both answers
are harmless: the holder is not ON a cycle, and the inner cell is tracked on
its own. For the marker they are wrong: plan §4 defines `T <: Acyclic` as
"no cycle of strong edges is reachable from `T`".

## Expected

Every line of the reproducer prints its expected value. The fix belongs to
the W5 derivation rewrite (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §7),
which separates the marker ("reaches no strong cycle") from the
collector's root test ("is on a cycle"): the generic-enum cut has to key by
the instance (`enum_instance_node_id`, as the trait checker's on-demand
guard already does), and `Channel`'s buffer has to be visible to the walk
as an owned element buffer.

## Test

At the fix: the reproducer's six verdicts as `comptime_assert` rows in
`tests/send_sync.test.yo` beside W2's cyclic-payload test, which today
asserts `!Acyclic` only for `Arc`, `Mutex` and `RwLock` because of this
bug.

Related: `issues/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.md`
(a value struct that reaches ITSELF through an atomic cell; a different
path through the same derivation).
