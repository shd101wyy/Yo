# A borrowed `for` over a wrapper whose walk forwards into an inner collection leaves that collection unguarded

**Severity:** S1 — heap-use-after-free in safe code with no pragma: a borrowed `for` over a user collection that forwards `walk_ref`/`walk_elem` into an inner `ref` collection lets the body (or an earlier alias) grow the inner collection under the live element reference.

**Status:** open. Found in review of B7a (the read walk, `feat/b7a-read-walk`, 2026-10-24). The fix is deferred to V2b Generation B (see "Fix" below).

## Symptom

`issues/repros/2026-10-24-a-forwarded-walk-leaves-the-inner-collection-unguarded.yo`, built with the B7a tree binary:

```text
$ yo compile issues/repros/2026-10-24-a-forwarded-walk-leaves-the-inner-collection-unguarded.yo \
    --optimize 1 --sanitize address --allocator system -o repro && ./repro
==2704072==ERROR: AddressSanitizer: heap-use-after-free on address 0x7aa8d6fe18d0 ...
READ of size 8 at 0x7aa8d6fe18d0 thread T1
```

`yo check` accepts the program (rc 0). The core of it:

```yo ignore
ValBag :: struct(items : ArrayList(String));
// BorrowedWalk impl: walk_ref : (fn(self : &Self, cur : &usize) -> &String)(&self.items(cur))
for(&vb, x => {
  grow(vb.items); // shares the inner list's handle and pushes 100 Strings
  println(x); // x points into the old, freed buffer
});
```

The same happens when:

- the wrapper is a `ref` type (`RefBag :: ref(struct(items : ArrayList(String)))`): the guard takes
  the wrapper's flag, not the inner list's;
- the alias is made in the body (`h := vb.items; h.push(…)`) or before the loop (`h := vb.items`
  before `for(&vb, …)`);
- the walk is the in-place form `for(&mut vb, x => …)` with an alias made before the loop. This
  shape is older than B7a: develop at `ef153b7` with develop's std fails the same way (review probe
  `d4.yo`).

B7a makes the hole reachable from inside the loop body. The read walk lets the body read the walked
source, so the body can share the inner handle without any alias made beforehand. The in-place form
forbids naming the source in the body (E0911).

Control: the same alias-and-grow shape over each std collection (the eight at the time, before `LinkedList` was removed) panics
deterministically with `panic: container operation while an interior reference ... borrows from it`
(rc 134). Every std collection is a `ref` object whose flag the loop's guard holds. The cli-case
`tests/cli-cases/read-walk-alias-push-panics` pins this for the in-body alias of the read walk.

## Root cause

The borrowed `for` (`std/prelude.yo`, the `for` macro) takes `__borrow_guard(c)` on the walk's
SOURCE. `__yo_borrow_acquire` sets a flag only on a reference type's cell header
(`_borrow_operand_has_flag`, `src/codegen/exprs/inline_fns.yo`). A value-rooted source gets no
flag, by design (`plans/VALUES_BY_DEFAULT.md` §3.10, "the borrowed-`for` guard splits by path"),
and a `ref` source gets only its own flag.

The element reference `x` points into storage owned by a DIFFERENT object: the inner `ArrayList`
that `walk_ref`'s body indexes (`&self.items(cur)`). Nothing holds that object's flag for the
loop's extent. A second handle to the inner list (`vb.items` shared into a local or an
argument) can therefore reallocate its buffer while `x` is live. The §3.10 premise ("a purely
value-rooted place needs no guard: unique ownership checks it statically") holds only once the
inner collection is itself a value. While collections are `ref` objects, sharing `vb.items` aliases
the buffer.

## Fix

V2b Generation B closes the hole without new machinery. Once the std collections are values with
no cell header, `vb.items` read in the body is a copy, not a second handle, so
growing it cannot touch the buffer `x` points into. A `ref` wrapper keeps its own flag (§3.10, "a
place reached through an `Rc` deref keeps the guard on that cell"), and a copy of its value field
is again not an alias. An inner storage that is NOT a std collection needs raw pointers, which
need `pragma(Pragma.AllowUnsafe)`.

Until then, two stop-gaps were considered and not taken in B7a:

1. Guard transitively: acquire the flag of every `ref` field reachable from the source. This covers
   neither a `walk_ref` that reaches its storage through a call rather than a field, nor a
   recursive `ref` field graph, which would cost a runtime walk per loop.
2. A static rule: inside a borrowed `for`, sharing a `ref` handle reached from the source is an
   error. This is a language decision. It would reject reads that are fine today
   (`n := vb.items; n.len()`).

When the fix lands, turn the repro into a test: `for(&vb, x => { grow(vb.items); … })` must either
not alias (V2b) or panic deterministically. Run it under `--sanitize address`.

## References

- `docs/en-US/FLOWABILITY.md` / `docs/zh-CN/FLOWABILITY.md`: the borrowed-`for` section, which names
  this gap next to the forwarded `walk_ref`/`walk_elem` spelling.
- `tests/for_macro_borrow_user_collection.test.yo`: `FwdBag` and `ReadOnlyBag`, the forwarded
  spellings (correct when no second handle to the inner list exists).
