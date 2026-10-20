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

## Visible change: such types no longer derive `Acyclic`

`Acyclic` is derived as the negation of the same predicate, so a reference
type of the nested shape stops deriving it. `iso()` rejects a variable of such
a type on that predicate (`src/evaluator/calls/iso.yo`), and `Iso(T)`, `arc()`
and `thread.spawn` require `Acyclic` (`std/prelude.yo`, `std/thread.yo`). A
program that compiled on v0.2.66 is therefore rejected now. For example:

```yo
{ LinkedList } :: import("std/collections/linked_list");
LLNode :: ref(struct(value : i32, children : LinkedList(Self)));
comptime_assert(Type.impls(LLNode, Acyclic));
```

This passes on the v0.2.66 seed and fails on the fix with E1101. The rejection
is correct: these values can form cycles.

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
  `impl(T, Acyclic())` on the compiler's tree node types. It is stacked on
  this fix as branch `perf/acyclic-compiler-containers`; see the next section.

## Recovery: declared `Acyclic` on the compiler's trees (stacked follow-up)

A declared `impl(T, Acyclic())` is trusted, not checked. It needs
`pragma(Pragma.AllowUnsafe)` in the declaring file and a `// SAFETY:`
comment (`src/evaluator/values/impl.yo`). The impl records the type's id in
`g_declared_acyclic_ids` (`src/types/utils.yo`), and the cycle walk stops at
that id. A wrong declaration therefore leaks the cycles it hides. It is not
a memory-safety hole, because `Acyclic` grants no `Send` or `Sync`. The
declaration also makes `Type.impls(T, Acyclic)` true, so the `Acyclic`
requirement of `iso()` and `Iso(T)` no longer rejects the type.

The declaration goes on the tree's NODE type, never on a container
instantiation. `_declared_acyclic` matches the struct id, and every
instantiation of a generic struct shares that id. So
`impl(ArrayList(AstExpr), Acyclic())` would exempt every `ArrayList(T)`,
including the `ArrayList(Self)` cycles that `tests/cycle_collector.test.yo`
checks. Declaring the node is enough: the walk stops there, so every
container and holder whose only path to a cycle runs through the node stops
registering too. `TypeValue` (#1329) uses the same pattern.

A node type is tree-shaped by construction when two things hold. Its
`Self` payloads are fixed when the node is built, because enum payloads
cannot be assigned. And no code writes into a child list that a built node
already holds. The audit (2026-10-20) checked every `.FnCall(…)`, `.App(…)`,
`.Ctor(…)` and `.Quant(…)` destructure in `src/` for a mutating call on the
list binder, on an alias of it, or on a `&mut` pass of it. It also checked
every construction site for a later write to the list it was given.

| Type | Declared? | Why |
| --- | --- | --- |
| `AstExpr` (`src/expr.yo`) | yes | `func` is a fixed payload, and each `args` list is filled before its `FnCall` is built. 1,083 destructures and 104 constructions were audited, and no write reaches a built node's `args`. The one in-place rewrite, `strip_proved_ensures_asserts` (`src/evaluator/builtins/contracts.yo`), refills a body's statement list with a subset of its own elements. A filter cannot close a cycle. |
| `VcTerm` (`src/verifier/terms.yo`) | yes | The `args`/`triggers` lists are built fresh per node (`_app1`..`_app3`, `vc_eq`, …), and no write reaches a built term's list. Substitution shares subterms (decision 21's 2026-10-18 amendment), which adds no back edge. |
| `VcSort` (`src/verifier/terms.yo`) | yes | Its only children are `Self` payloads, and it holds no list or cell. No `VcSort` can reach itself. Whether the walk should infer this instead is `issues/questions/2026-10-20-should-the-cycle-walk-infer-acyclicity-for-self-only-ref-enums.md` (recommended: no; keep the declaration). |
| `EvalValue` (`src/value.yo`) | no | Not this branch: its audit belongs to V4 (decision 21 gives `EvalValue` its own V4 PR, and decision 9 of 2026-10-20 confirms it). Its children include mutable comptime containers and `FuncVal` environment snapshots, which may name the function itself. Its holders (`PendingDef`, `ArrayList(EvalValue)`, …) stay registered. |
| `JsonValue` (`std/encoding/json.yo`) | no | User-facing std, and it can form a cycle: `JsonValue.Array(items)` shares a mutable `ArrayList` cell, so `items.push(JsonValue.Array(items))` closes one. `ArrayList(JsonValue)` stays registered. |
| `JsonObjBuilder` (`src/lsp/protocol.yo`) | no | `obj()` shares the builder's `values` list with the object it returns, so `b.put(k, &b.obj())` puts that list on a cycle. The builder cell itself cannot be on the cycle, so declaring it would be sound, but it is one cell type and not a tree. Skipped (decision 9 of 2026-10-20): measure its registration count first, and declare it only if that number justifies an unsafe declaration. |
| `RegexNode` (`std/regex/node.yo`) | no | User-facing std (exported). `children : ArrayList(Self)` is a shared mutable cell that callers can push into. |

The `Type.can_form_rc_cycle` answers below came from one-file probes. Each
probe imports the module beside a `comptime_print` and runs `check`, at
200–400 MB. The "v0.2.66" column is the seed, which has develop's
predicate. The "#1486" column is this fix's binary on its own tree. The
"declared" column is the same binary on the stacked branch:

| Type | v0.2.66 | #1486 | declared |
| --- | --- | --- | --- |
| `AstExpr` | true | true | false |
| `ArrayList(AstExpr)` | false | true | false |
| `ArrayList(ArrayList(AstExpr))` | false | true | false |
| `HashMap(String, ArrayList(AstExpr))` | false | true | false |
| `SuspensionPoint` | false | true | false |
| `ArrayList(SuspensionPoint)` | false | true | false |
| `VcSort` | true | true | false |
| `VcTerm` | true | true | false |
| `ArrayList(VcTerm)` | false | true | false |
| `VcQuery` | false | true | false |
| `EvalValue`, `ArrayList(EvalValue)`, `PendingDef` | true, false, false | true, true, true | unchanged |
| `ArrayList(JsonValue)`, `JsonObjBuilder` | false, false | true, true | unchanged |
| `RegexNode`, `ArrayList(RegexNode)` | true, false | true, true | unchanged |
| control: `LLNode`, `LinkedList(LLNode)`, `ArrayList(LLNode)` | false | true | true |
| control: `LinkedList(i32)` | false | false | false |

A small emit settles the question at codegen. The program imports
`src/expr.yo` and `src/verifier/terms.yo`, builds an `ArrayList(AstExpr)`
and a `VcTerm`, and is emitted with `--emit-c --skip-c-compiler`. Without
the declarations it has 16 constructors calling `__yo_gc_register`: the
`AstExpr.FnCall` cell, three `VcSort` and six `VcTerm` variant
constructors, and six `ArrayList`/`HashMap` instantiations. With the
declarations it has none. The `AstExpr`, `VcSort` and `VcTerm` nodes were
already registering on develop, so the self-build count should fall below
develop's 139, not merely back to it. The `EvalValue`, `JsonValue` and
`RegexNode` families stay registered.

Not measured yet: the self-build registering-constructor count, and stage-2
`check ./src` max RSS against develop (1.28 GB) and #1486 (1.50 GB). Both
need the compiler build.

**Re-probe after the rebase, before reading RSS.** This branch and #1486
sit on a develop older than #1501, which keys enum identity on the
declaration. Before #1501, two enum declarations of one shape shared their
container instances: in the regression test below, an undeclared twin
spelled exactly like the declared `RExpr` had its `ArrayList(RExprTwin)`
served `ArrayList(RExpr)` and read `false`, so the twins now differ in a
leaf payload. #1501 therefore changes which instance a container
specializes to. After rebasing onto develop, re-run the probe table above
with the rebased binary BEFORE reading any RSS number. If
`ArrayList(AstExpr)` still reads `true`, stop and understand why before
going further.

One observation from the replicas: a reference-struct holder of a
cycle-capable reference enum (`ref(struct(e : X))`) reads `false`, while a
holder of that enum's list (`ref(struct(xs : ArrayList(X)))`) reads `true`
on #1486 and `false` on the v0.2.66 seed. A holder of a cycle-capable
reference STRUCT (`ref(struct(y : Y))`) reads `true` on both, because the
walk re-roots at every reference struct it reaches. That is why
`SuspensionPoint` registers on #1486 through its
`Option(ArrayList(AstExpr))` field, and why the declarations take it off.

## Fix direction (as filed)

Make the constructor's `can_type_form_rc_cycle` ask and the runtime agree with
the structural walk: the list cell is a cycle root exactly when its element
type can reach a managed type. Then the `Node` `Trace` impl the move-only fix
adds (it visits `next`, `prev` and the element buffer) is already the correct
traversal.

## Test

`tests/cycle_collector.test.yo` "declared-Acyclic compiler trees keep their
containers and holders off the cycle walk" turns the probe table into a
regression test (stacked branch). A language test cannot import `src/`, so it
replicates `AstExpr`, `VcSort`, `VcTerm`, `SuspensionPoint` and `VcQuery`
with the same `impl(T, Acyclic())` shape. It asserts `false` for each
declared node, its lists, `HashMap(String, ArrayList(…))` and its holders. It
asserts `true` for an undeclared twin of each and for the `LLNode` /
`LinkedList(LLNode)` / `ArrayList(LLNode)` controls. At run time it checks
that a declared node and its list never register and the twin's do. It
passes with #1486's tree binary (24 of 24 in the file).

`tests/cycle_collector.test.yo` "LinkedList(Self) two-node cycle collected",
beside the `ArrayList(Self)` case. It collects the cycle and pins the three
predicate answers. It fails on the v0.2.66 seed (exit code 6) and passes on
the tree binary.
