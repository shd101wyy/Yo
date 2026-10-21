# `^` sends collector-tracked objects to another thread

**Severity:** S1 — `^v` isolates a value that holds a cycle-capable object
when `v`'s own type is not on that object's cycles. Examples are a
`ref(struct(t : Tree))` with `Tree` a recursive reference enum, or a value
`struct(y : Node)`. The object stays registered with the sending thread's
cycle collector. The receiving thread frees it, and the sender's next
collection or its exit reads freed memory (AddressSanitizer
heap-use-after-free; SIGSEGV without it).

**Status:** open; **no fix — the window is ACCEPTED until `Iso` is deleted** (maintainer, 2026-10-21), as for the `Iso` `Send` hole (`issues/2026-10-20-an-iso-graph-holding-a-non-send-handle-crosses-threads.md`). `plans/backlog/MACRO_AND_ISO_REMOVAL.md` Part A deletes `^v` and retires this doc (A2). **Found:** 2026-10-20 with the v0.2.66 seed, while checking
the cycle walk's holder asymmetry: `ref(struct(e : X))` with `X` a
cycle-capable reference enum reads acyclic, and `ref(struct(y : Y))` with `Y`
a cycle-capable reference struct reads cyclic. The walk in
`src/types/utils.yo` and the `^` macro in `std/prelude.yo` are the same on
develop `7def2203b`. Related:
`issues/fixed/2026-10-20-a-ref-enum-cycle-through-a-ref-struct-is-never-collected.md`
(the same walk, root side).

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio.yo");
{ Thread } :: import("std/thread");
Gc :: import("std/gc");
X :: ref(enum(Leaf(n : i32), Node(l : Self, r : Self)));
HX :: ref(struct(e : X));
main :: (fn() -> unit)({
  h := HX(X.Node(X.Leaf(1), X.Leaf(2)));
  unsafe(printf("main: tracked after building h=%d\n", i32(Gc.tracked_count())));
  match(
    ^h,
    .Some(iso) => {
      t := Thread(unit).spawn((io : Io) => {
        got := iso.extract();
        ()
      });
      t.join();
    },
    .None => {
      unsafe(printf("not isolated\n"));
    }
  );
  unsafe(printf("main: tracked after the thread dropped h=%d\n", i32(Gc.tracked_count())));
  Gc.collect();
});
export(main);
```

```
main: tracked after building h=1
main: tracked after the thread dropped h=1
rc=139
```

With `--sanitize address --allocator system` this is `ERROR: AddressSanitizer:
heap-use-after-free ... WRITE of size 1 ... thread T1`, on memory "freed by
thread T2" and "previously allocated by thread T1". The write is 5 bytes
into the 80-byte node, inside the RC header.

| `h`'s type (seed v0.2.66)                                   | `^h`               | Run                   |
| ----------------------------------------------------------- | ------------------ | --------------------- |
| `ref(struct(e : X))` holding `X.Node(...)` (tracked)        | isolates           | SIGSEGV / ASan UAF    |
| `struct(y : Y)` (a value), `Y :: ref(struct(v : i32, next : Option(Self)))` | isolates | SIGSEGV          |
| `ref(struct(e : X))` holding `X.Leaf(1)` (never tracked)    | isolates           | clean                 |
| `ref(struct(y : Y))`                                        | compile error      | —                     |
| `X` itself                                                  | compile error      | —                     |

## Cause

The `^` macro (`std/prelude.yo`) refuses a type only when
`Type.can_form_rc_cycle(T)` holds ("Cannot isolate value of type containing
Rc type that can form cycles"). The runtime half, `__yo_iso_unique`, proves
every reachable non-atomic object has a count of 1, so no cycle exists at the
hand-off. What neither half checks is whether a reachable object is
registered with the collector. Tracking is per thread: `__yo_gc_register`
links the header into `__yo_current_thread_gc->tracked_objects`. A tracked
object that crosses threads stays on the sender's list. When the receiver
drops it, `__yo_gc_unregister` runs on the receiver's state, and the
sender's list keeps a pointer to freed memory.

`can_type_form_rc_cycle` answers a different question than `^` needs. It asks
whether the root type itself can lie on a cycle, which is the question
registration needs. It answers `false` for every non-reference root, and for
a reference root it follows the path:

- A reference struct reached from the root is re-rooted
  (`_type_refs_back_to_cyclic` replaces `original_id`), and a revisited
  reference struct answers `true`. So a holder of a cycle-capable struct reads
  cyclic, even though the holder is not on the struct's cycles. `^` happens to
  get the answer it needs here.
- A reference enum is never re-rooted, and a revisited one answers `false`.
  So a holder of a cycle-capable enum reads acyclic, which is the precise
  answer for registration (the holder is not on the enum's cycles) and the
  wrong one for `^`.
- A value root (struct, enum, tuple) falls to `true => false` without
  walking at all.

The holder asymmetry is therefore not a policy choice between two sound
answers. The collector is sound under either answer: a holder is never a
cycle member, and trial deletion counts its edge as external. `^` is unsound
under the enum-side answer and under every value root.

The same reading feeds the `Acyclic` derive for reference structs
(`!can_type_form_rc_cycle(self_type)`, `src/evaluator/types/utils.yo`), so
`Type.impls(HX, Acyclic)` and `Type.impls(Iso(HX), Acyclic)` are `true`. A
value struct derives `Acyclic` from its fields, so `struct(y : Y)` is not
`Acyclic`. `^` does not consult `Acyclic`.

A `Self`-only reference enum can close a cycle in the shipped language. A
variant-field write does it: `t := X.Node(X.Leaf(1), X.Leaf(2)); t.l = t;`
builds one, and the collector reclaims it, as does `tests/cycle_collector.test.yo`'s
`a.next = a` on `ENode`. This contradicts a premise of the question doc
`2026-10-20-should-the-cycle-walk-infer-acyclicity-for-self-only-ref-enums.md`
on `perf/acyclic-compiler-containers`, which tried only `s.* = ...` and
handle-first construction. The declared-`Acyclic` trees there rest on their
SAFETY comments ("no node is written after construction"), not on the
language.

## Fix options

1. **Give `^` a reach predicate.** Refuse `T` when any reference type
   reachable from `T` can be registered, that is when it satisfies
   `can_type_form_rc_cycle`. Walk value fields inline, see through buffers as
   the cycle walk does, and stop at atomic objects and declared-`Acyclic`
   types. Both `^` (`std/prelude.yo`) and `iso.yo`'s
   `can_type_form_rc_cycle(&variable.ty)` check use it. Registration keeps
   the root predicate. This rejects `HX` and `struct(y : Y)` at compile time,
   which matches what `^` already does for `ref(struct(y : Y))` and what its
   message says ("containing").
2. **Move tracking with the value.** `__yo_iso_unique` already walks the
   graph; it could unlink each tracked object from the sender's list, and
   `extract` could register them on the receiver. This is more permissive but
   adds runtime work and a new cross-thread invariant on the collector's
   lists.

**Recommendation:** option 1. It is a compile-time check of the same kind `^`
already makes, and it adds no runtime cost. Once `^` stops reading
`can_type_form_rc_cycle`, the reference-struct re-root (which makes holders of
a cyclic struct pay for tracking they do not need) can be narrowed to the
precise root answer on its own. That narrowing is a performance follow-up to
measure with the stage-2 recipe, and it also changes the `Acyclic` derive.
Option 1 rewrites the test below into a `comptime_expect_error(^h, ...)`;
option 2 makes it pass as written.

## Test

`issues/repros/2026-10-20-iso-sends-collector-tracked-objects-to-another-thread.yo` (open-bug repro, `test(...)`-shaped; it fails until the fix), "an isolated graph leaves no collector entry on the
sending thread". It isolates an `_IsoTreeHolder` holding a tracked
`_IsoTree.Node`, has a spawned thread extract and drop it, and asserts the
main thread's `Gc.tracked_count()` is back to its base. The assertion reads a
counter and touches no freed node. With the seed it fails ("the sender's
collector lists nothing the receiving thread freed").
