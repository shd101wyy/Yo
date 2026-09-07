# Unsafe is FILE-scoped, and that is what makes `iter()` expensive

**Status:** BACKLOG — written 2026-09-07, not started. Raised by the maintainer
while reviewing D14 (#461): *"As `iter()` yields pointers, does it mean it can
only be used under the unsafe context?"* The answer is yes, and chasing why
turned up something bigger than D14.

**Scope:** this is a LANGUAGE-level question (how unsafety is granted), not a
std API one. It is filed separately from `plans/STD_API_STABILIZATION.md` for
that reason, and nothing in the D-batch is blocked on it.

---

## 1. The measurement

All four probes below were run against the D14 branch with a
v0.2.26-descended compiler. Each is a whole file; the only difference is what
the body does.

| probe | result |
| --- | --- |
| `for(list, x => …)` — by value, **no pragma** | **compiles, runs**, and `list.len()` is still 3 afterwards |
| `list(i) = (list(i) * i32(10))` — in-place, **no pragma** | **compiles, runs**, mutation lands |
| `for(list.iter(), ptr => sum = (sum + ptr.*))`, no pragma | `error: Pointer dereference requires 'unsafe(...)'` |
| same, but written `unsafe(ptr.*)`, still no pragma | `error: 'unsafe(...)' is not available in safe code` |

The fourth line is the load-bearing one. **`unsafe(...)` is not a grant** — it
is only a marker, and it still requires `pragma(Pragma.AllowUnsafe)` at the top
of the file. So there is no way to say "just this expression is unsafe": the
smallest unit of unsafety in Yo is a FILE.

D14 makes that concrete. `std/collections/ordered_map.yo` and
`tests/collections/ordered_map.test.yo` both had no pragma before it and need
one after, purely because `iter()` now names and yields a raw pointer.

## 2. Why this is not really an `iter()` problem

Six of the eight std collections — `hash_map`, `hash_set`, `deque`,
`priority_queue`, `btree_map`, `linked_list` — ALREADY yielded pointers from
`iter()` before D14, and every one of their test files already carried the
pragma. D14 did not invent the cost; it finished spreading it. The cost was
always there and nobody had named it.

## 3. How Rust and Swift avoid paying it

**Rust.** `iter()` yields `&T`, which is *safe*, because the borrow checker
proves the reference outlives nothing it shouldn't. Yo has no borrow checker,
so its nearest expressible thing is a raw pointer. **D14 imports Rust's SHAPE
without Rust's SAFETY** — that is the honest summary, and
`plans/STD_API_STABILIZATION.md` §2 justified D14 purely on cross-collection
consistency without weighing it. Rust's escape hatch is also a BLOCK
(`unsafe { … }`), not a file.

**Swift.** Swift has **no `iter()` / `into_iter()` split at all**. One protocol
(`Sequence.makeIterator()` → `IteratorProtocol.next() -> Element?`), always
yielding values; `for x in xs` is the only form. It does not need the split
because `Array<T>` is a copy-on-write struct — iterating never consumes, and
the copy is O(1) until someone mutates. (Yo reaches the same "iteration does
not consume" place by refcounting instead: `for(list, …)` lowers to
`into_iter`, which takes `self` by value, which for an RC type is a dup.)

Where Yo reaches for a pointer, Swift offers three tiers:

| need | Swift | Yo today |
| --- | --- | --- |
| read each element | `for x in xs` | `for(list, x => …)` — safe |
| mutate in place | `for i in xs.indices { xs[i] *= 2 }` | `list(i) = …` — **safe, no pragma** |
| raw contiguous access | `xs.withUnsafeMutableBufferPointer { buf in … }` — **closure-scoped** | `list.iter()` — needs a file pragma |
| safe borrowed view | `Span` / `MutableSpan` (Swift 6.x, SE-0447) | — none |

The middle row matters for D14 specifically: **the in-place-mutation argument
for pointer iterators is weaker than #461's description claims.** Yo already
has Swift's answer, and it is safe.

The third row is the idea worth stealing. Swift's unsafety is *scope*-shaped:
`withUnsafeMutableBufferPointer` hands you a pointer that is valid only inside
the closure. Rust's is *block*-shaped. Yo's is *file*-shaped, which is coarser
than both.

## 4. Options

1. **Do nothing.** `iter()` stays pointers, the safe default stays
   `for(coll, …)` plus indexed assignment. Cost: any hot loop that wants to
   avoid RC dup/drop traffic must make its whole file unsafe.
2. **Make `unsafe(...)` self-granting** — i.e. Rust's model, where the marker
   IS the permission and the file pragma is no longer required for it. Smallest
   change, biggest ergonomic win: D14's cost drops from "this file is unsafe"
   to "this expression is unsafe". Needs a decision about what the pragma is
   still FOR (declaring intent at the module level, presumably, and gating raw
   pointer TYPES in signatures — which is a separate check from the deref one).
3. **Add a scoped accessor** — Swift's model: `list.with_ptrs(closure)` /
   `with_mut_ptrs`, valid only inside. Safest of the three, but needs
   non-escaping-closure support to actually be sound, which Yo does not have.
4. **Reconsider D14 itself** — make `iter()` yield values everywhere and move
   pointers to an explicitly-named `iter_ptr()`. Contradicts D2/D14 and touches
   six collections, but produces a std where the obvious spelling is the safe
   one.

**Recommendation: 2, then leave D14 alone.** It is the only option that
addresses the actual complaint (unsafety granularity) rather than relocating
it, and it makes every future pointer-yielding API cheaper, not just `iter()`.
Option 4 is the one to take instead if the maintainer wants "safe by default"
to be a property of the std API surface rather than of the language.

## 5. Related

- `plans/STD_API_STABILIZATION.md` §2 D14 (#461) — the decision that surfaced this.
- `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`, `plans/reference/MACRO_POLICY.md` —
  prior examples of a language-level policy decision recorded before implementation.
- `.github/instructions/yo-design.instructions.md` "Unsafe operations" documents
  `unsafe.drop` / `unsafe.cast` but does NOT document the
  `pragma(Pragma.AllowUnsafe)` + `unsafe(...)` two-level rule at all. Worth
  fixing regardless of which option is chosen.
