# An `Arc` cycle through `Mutex` passes the `Acyclic` bound

**Severity:** S2 — a value struct that reaches itself through
`Arc(Mutex(Self))` (or `Arc(Self)`) is derived `Acyclic`, so a
`where(T <: Acyclic)` bound accepts a type whose values can close a cycle of
strong edges. The marker exists to reject exactly this shape. Bounded: it
needs a self-recursive payload type, and since decision 48 W2 no std API
requires the bound, so only a user-written bound reads the wrong answer.

**Status:** open, as a DERIVATION bug; retired as a LEAK by W2.
**Found:** 2026-10-21 with the v0.2.67 seed, while answering the
maintainer's question whether an `UnsafeArc` without the `Acyclic` bound is
needed (it already is not enforced for this shape).

**2026-10-22, decision 48 W2** (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md`
§2, §4): `Arc`, `Mutex`, `RwLock`, `OnceCell`, `Channel`/`Sender`/`Receiver`
and `Thread` no longer require `Acyclic`, as Rust's do not. The `Arc` cycle
this doc first reported is now a legal program that leaks by design
(`docs/en-US/ARC.md` §Cycles), and the leak is observable under
`--allocator fixed --debug-heap`
(`tests/cli-cases/test-debug-heap-sees-an-arc-mutex-cycle`). That case and
the `tests/send_sync.test.yo` cycle test close the cycle through an ATOMIC
node, which derives no `Acyclic` and which `Arc` rejected before W2 (E0602):
the value-struct `Node` below was accepted even before W2, through this bug,
so it cannot show what W2 changed. The send_sync test also asserts the one
verdicts the derivation gets right today (the atomic node is not `Acyclic`,
`BoxNode`'s shape is).
What stays wrong
is the derivation: `Acyclic` remains a derived structural marker (plan
verdict 5) that user bounds will read, and it answers `true` for `Node`. The
fix is plan phase W5. Until then the reproducer below is the derivation test
W5 turns into a `tests/send_sync.test.yo` row.

## Reproducer

`issues/repros/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.yo`:

```yo
{ println } :: import("std/fmt");
{ Mutex } :: import("std/sync/mutex");
// Each type reaches itself through an atomic cell, so none is Acyclic.
Node :: struct(id : i32, peer : Option(Arc(Mutex(Self))));
NodeDirect :: struct(id : i32, peer : Arc(Self));
// The same shapes with an atomic node: the node itself answers right.
Peer :: atomic(ref(struct(id : i32, peer : Option(Arc(Mutex(Self))))));
PeerDirect :: atomic(ref(struct(id : i32, peer : Option(Arc(Self)))));
// Recursion with no cell on the back edge stays Acyclic.
BoxNode :: struct(id : i32, next : Option(Box(Self)));
NODE_ACYCLIC :: Type.impls(Node, Acyclic);
ARC_NODE_ACYCLIC :: Type.impls(Arc(Mutex(Node)), Acyclic);
NODE_DIRECT_ACYCLIC :: Type.impls(NodeDirect, Acyclic);
PEER_ACYCLIC :: Type.impls(Peer, Acyclic);
ARC_PEER_ACYCLIC :: Type.impls(Arc(Mutex(Peer)), Acyclic);
MUTEX_PEER_ACYCLIC :: Type.impls(Mutex(Peer), Acyclic);
ARC_PEER_DIRECT_ACYCLIC :: Type.impls(Arc(PeerDirect), Acyclic);
BOX_NODE_ACYCLIC :: Type.impls(BoxNode, Acyclic);
main :: (fn() -> unit)({
  println(`Node <: Acyclic: ${NODE_ACYCLIC} (expected false)`);
  println(`Arc(Mutex(Node)) <: Acyclic: ${ARC_NODE_ACYCLIC} (expected false)`);
  println(`NodeDirect <: Acyclic: ${NODE_DIRECT_ACYCLIC} (expected false)`);
  println(`Peer <: Acyclic: ${PEER_ACYCLIC} (expected false)`);
  println(`Arc(Mutex(Peer)) <: Acyclic: ${ARC_PEER_ACYCLIC} (expected false)`);
  println(`Mutex(Peer) <: Acyclic: ${MUTEX_PEER_ACYCLIC} (expected false)`);
  println(`Arc(PeerDirect) <: Acyclic: ${ARC_PEER_DIRECT_ACYCLIC} (expected false)`);
  println(`BoxNode <: Acyclic: ${BOX_NODE_ACYCLIC} (expected true)`);
});
export(main);
```

With the tree at `feat/arc-without-acyclic` (2026-10-22) the first three
lines print `true`. `Peer` prints `false`, as it should, but the three
containers of an atomic node that reaches them back (`Arc(Mutex(Peer))`,
`Mutex(Peer)`, `Arc(PeerDirect)`) print `true`: the containers' own answer
re-enters the in-progress obligation the same way (found at W2, review
round 2; before W2 these types could not be formed, since `Arc` and `Mutex`
required `Acyclic` of their payload). `BoxNode` prints `true`, as it should.

Before W2 the original reproducer formed the cycle: `yo check` accepted
`arc(Mutex(Node).new(...))` with `Node.peer` set under the lock, and with
`--sanitize address --allocator system`, `ASAN_OPTIONS=detect_leaks=1`,
LeakSanitizer reported 112 bytes leaked in 3 allocations (the `Arc` cell,
the mutex, the payload's box). That program is now valid and its leak is
the documented behaviour.

A control with the recursion spelled through a non-atomic cell
(`Option(Rc(RefCell(Self)))`) is the separate
`issues/2026-10-21-an-rc-refcell-cycle-is-never-tracked-by-the-collector.md`.

## Root cause (hypothesis)

The trait checker derives `Acyclic` for a value struct from its fields
(`src/evaluator/trait_checking.yo`, the `(tn == "Acyclic")` branch:
`value_acyclic_obligations`). `Node`'s field reaches `Arc(Mutex(Node))`;
`Arc(V)` is an atomic object, whose `Acyclic` is answered from the
definition-time registry (`can_type_form_rc_cycle`) rather than from its
payload. Before W2, `Mutex(T)`'s `impl(..., where(T <: (Send, Acyclic)),
Mutex(T), Acyclic())` needed `Node <: Acyclic` again, which is the obligation
being derived; W2 deleted that impl and the answer did not change, and
`NodeDirect` (`Arc(Self)`, no `Mutex`) answers the same, so the re-entry is
through `Arc`'s own payload walk. The recursion guard answers the in-progress pair coinductively
(`g_trait_check_recursion_guard` / `g_ondemand_marker_guard`), which is
right for `Send` (a type is `Send` unless some field is not) and wrong for
`Acyclic` (a type that reaches itself through a cell IS cyclic). The same
walk does the right thing for `ref(struct)` roots, where
`can_type_form_rc_cycle` re-roots at every cell and finds the back edge; the
value-struct path through an atomic cell has no such re-rooting.

## Expected

`Type.impls(Node, Acyclic)` is `false`: `Node` reaches itself through
`Arc(Mutex(Self))`. The fix is in the derivation (W5): when the `Acyclic`
obligation for a value struct re-enters itself through an atomic cell, the
answer is "not Acyclic", exactly as `can_type_form_rc_cycle` answers for a
reference root. A recursive value type with no cell on the back edge
(`Option(Box(Self))`, `ArrayList(Self)`) must stay `Acyclic`.

## Test

At W5: the reproducer's verdicts as `comptime_assert` rows in
`tests/send_sync.test.yo` (the `Acyclic` marker's home). The rows the
derivation answers right today are there already: `SsPeer` (the atomic
`Peer`) is not `Acyclic` and `SsBoxNode` (`BoxNode`) is. A `comptime_expect_error` on a bound no longer applies:
std carries no `Acyclic` bound after W2.

A related shape with a different cause, an object that holds a cyclic cell
behind an `Option` or a raw pointer (`OnceCell(Cyclic)`, `Channel(Cyclic)`), is
`issues/2026-10-22-an-object-holding-a-cyclic-cell-behind-an-option-or-a-pointer-derives-acyclic.md`.
