# A `LinkedList` of managed elements forms cycles the collector never frees

**Severity:** S3 — a memory leak, not unsoundness: `LinkedList(Self)` cycles are
registered by neither side of the collection analysis, so `Gc.collect()` leaves
every member tracked and alive. Develop behaves the same; found 2026-10-18
while adding a cycle canary for the move-only element fix
(`issues/fixed/2026-10-16-a-linkedlist-of-a-move-only-element-cannot-pop-or-clear.md`).

## Symptom

```text
2                       # tracked_count() inside, after building a 2-node cycle
2                       # tracked_count() after Gc.collect()
Assertion failed ... "cycle collected"
```

## Reproducer

```yo
{ assert } :: import("std/assert");
{ collect, tracked_count } :: import("std/gc");
{ LinkedList } :: import("std/collections/linked_list");
LNode :: ref(
  struct(
    value : i32,
    children : LinkedList(Self)
  )
);
test("LinkedList(Self) two-node cycle collected", {
  do_test :: (fn() -> unit)({
    a := LNode(1, LinkedList(LNode).new());
    b := LNode(2, LinkedList(LNode).new());
    consume(a.children.push_back(b));
    consume(b.children.push_back(a));
  });
  do_test();
  collect();
  assert(tracked_count() == u64(0), "LinkedList(Self) cycle collected");
});
```

The `ArrayList(Self)` twin (`tests/cycle_collector.test.yo`, "ArrayList(Self)
two-node cycle collected") passes on the same binary, so the gap is specific to
the indirection: `ArrayList` holds its `?(*(E))` element buffer as a DIRECT
field, which `can_type_form_rc_cycle`'s container buffer-walk
(`src/types/utils.yo`) sees, while `LinkedList` reaches its elements through a
`Node(T)` ref cell whose own registration the analysis decides separately.

## Root cause (first findings)

With the values inline (develop's layout) and with the value buffers (the fix's
layout) the result is the same, and the emitted C shows why:

- the `Node(<T>)` constructor emits `__yo_gc_register` and a `traverse_fn`;
- the `LinkedList(<T>)` constructor emits neither — its header is the small
  (16 B, cycle-incapable) one, so `can_type_form_rc_cycle` answered false for
  the instantiation at the constructor's emission, although a hand walk of
  `can_type_form_rc_cycle`'s arms over `LinkedList(LNode)` — `head : Option(Node)`
  re-rooted at the node, whose `next : Option(Self)` is a direct self-reference —
  says true. The `LNode` and `Node` cells are what `tracked_count()` reports;
  the list cells are never tracked, and the collector never walks
  `LNode -> list -> node -> element -> LNode`.

Which TypeValue copy the constructor emission asks (the instantiated
`LinkedList(LNode)` vs a merged-key or unresolved-generic twin) has not been
pinned down. The instantiation-identity family
(`issues/fixed/yo-self-specialization-signature-type-identity.md`,
`src/codegen/exprs/gc.yo`'s DIVERGENCE note) is the likely place to look.

## Root cause (pinned 2026-10-20)

**Fixed 2026-10-20.** This is a real bug, not a design limitation.
`docs/en-US/CYCLE_COLLECTION.md` promises that a container which hand-writes a
`Trace` impl for its buffer is collected, and nothing there exempts
`LinkedList`. The evaluator's own predicate shows the gap at comptime, so no
codegen copy is involved. On the v0.2.66 seed, `Type.can_form_rc_cycle`
answers:
- `false` for `LNode` and `false` for `LinkedList(LNode)`;
- `true` for the `ArrayList(Self)` twin.

Both constructors therefore emit no `__yo_gc_register`. The two cells
`tracked_count()` reports are the `Node(LNode)` cells, which register on
their own `next : Option(Self)` self-loop. This corrects the earlier finding,
which named the `LNode` and `Node` cells: `LNode` was never tracked.

The emitted C names the cause: `LinkedList(<struct:struct_decl_…LNode…>)`.
The list inside `LNode` is instantiated over LNode's declaration SHELL, an
empty placeholder struct, and the shell patch walk's shared-node guard leaves
it unpatched behind `Node(Self)`. Here is how `_type_refs_back_to_cyclic`
(`src/types/utils.yo`) walks it:
1. It starts at `LNode`, re-roots at `LinkedList`, and re-roots again at
   `Node`.
2. Through Node's `?*T` element buffer it reaches the shell.
3. The shell carries no fields, and the walk does not recognise it as the
   `LNode` root already on its path, so it is a dead end.

In the `ArrayList(Self)` case the shell sits directly under the root, where
the "same id as the root" test catches it before the reference-struct test.
That is why only the nested case missed.

## Fix

`_type_refs_back_to_cyclic` resolves its argument through the finals
registries first, with `resolve_enum_shell(resolve_struct_shell(·))`. Four
other walks in the same file already do this. The resolved `LNode` is then
the visited root, and the path closes. On the tree binary:
- `LNode` is `true`, `LinkedList(LNode)` is `true`, and `LinkedList(i32)`
  stays `false`;
- the repro has 6 tracked cells inside and 0 after `Gc.collect()`.

The `Node` `Trace` impl that the move-only fix added (it visits `next`,
`prev` and the element buffer) was already the correct traversal.

## Cost (measured 2026-10-20, stage-2 A/B, aarch64 macOS)

The fix also changes what the compiler's OWN types register. 48 container
instantiations in `src/` have the same shape: a shell behind a nested
instantiation, missed for the same reason. They hold `AstExpr`, `EvalValue`,
`VcTerm`, `JsonValue` or `RegexNode` children, and they were cycle-capable
all along. Examples are `ArrayList(Self)`, `HashMap(String, ArrayList(Self))`,
`SuspensionPoint`, `PendingDef`, `VcQuery`, `JsonObjBuilder` and
`ArrayList(<RegexNode shell>)`. Their cells now use the full RC header and
register with the collector.

| Measure | before | after |
| --- | --- | --- |
| self-build emit: constructors calling `__yo_gc_register` | 139 | 188 |
| self-build emit: small (16 B) headers | 521 | 472 |
| stage-2 `check ./src --std-path ./std`, user time | 132.9 s | 132.8 s |
| stage-2 `check ./src`, max RSS | 1.28 GB | 1.50 GB (+17%) |
| stage-2 `check ./src`, peak footprint | 1.03 GB | 1.25 GB |

- **Time is unchanged.** `__yo_gc_register` links the cell into an
  intrusive list and makes no allocation, so the malloc-count work ratchet
  should not move.
- **RSS does move.** The +17% exceeds the `Evaluator memory ratchet` job's
  ±10% band (`scripts/bootstrap/memory-ratchet.tsv`, Linux max RSS of
  `check src/main.yo`). That job is expected to go red until its Linux
  baseline is re-measured at merge. The macOS number above is not that
  baseline, so it was not written into the TSV.
- **Recovery (follow-up, not this fix):** decision 21's declared
  `impl(T, Acyclic())` on the compiler's tree-shaped container types, which
  never close a cycle in practice. That is an evaluator-wide edit, so it
  stays out of this change.

## Fix direction (as filed)

Make the constructor's `can_type_form_rc_cycle` ask and the runtime agree with
the structural walk: the list cell is a cycle root exactly when its element
type can reach a managed type. Then the `Node` `Trace` impl the move-only fix
adds (it visits `next`, `prev` and the element buffer) is already the correct
traversal.

## Test

`tests/cycle_collector.test.yo` "LinkedList(Self) two-node cycle collected",
beside the `ArrayList(Self)` case. It collects the cycle and pins the three
predicate answers. It fails on the v0.2.66 seed (exit code 6) and passes on
the tree binary.
