# Design: closing the slice-invalidation hole — what should `Slice(T)` be?

**Status: DECIDED — see `plans/archive/SLICE_REWORK.md` (branch `feat/slice-rework`).** Decision: NOT snapshot slices (Rc/CoW overhead rejected); instead `str` becomes a static-only immutable view (immortal backing ⇒ trivially safe), `Slice(T)` is demoted to pragma-gated unsafe vocabulary (the `*(T)` rule), `as_str`/`as_slice` leave the safe surface, and safe windowing uses library view structs over the Rc'd owning handle (alias semantics, no CoW). The hole becomes unconstructible rather than gated.

Original analysis follows.

**Status when written: OPEN design decision.** The flowability audit
(`docs/en-US/FLOWABILITY.md` §Limitations, commit 53d01632 + follow-up) proved
that scope-nesting flowability cannot see _in-scope invalidation of a slice's
backing_. This issue records the empirical findings and the options analysis
for removing that limitation.

## The hole, precisely

`Slice(T)`/`str` are raw fat pointers (`from_raw_parts`; no ownership of the
backing). Three triggers invalidate a live slice, all currently accepted by
safe code:

| Trigger                                                        | Mechanism                                           | Empirically verified                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| (a) reassignment `buf = ArrayList.new()`                       | old Rc dropped → buffer freed                       | stale read (returned old value by allocator luck)                                                |
| (b) growth `buf.push(x)` past capacity                         | realloc moves the buffer                            | **silent corruption**: `s(0)` read `1` instead of `42` — no crash, no ASan hit (region recycled) |
| (c) mutation through an Rc alias `alias := buf; alias.clear()` | same as (b)/(a), invisible to per-variable analysis | follows from (b)                                                                                 |

(b) is the worst in practice: it is the classic _iterator invalidation_
footgun, it needs no unusual code, and it fails **silently**.

## Why static analysis cannot fully close it

Per-variable borrow tracking (mark `buf` "borrowed" while a same-scope slice
lives; reject reassign/consume/mutating calls on `buf`) closes (a) and the
same-name part of (b) — but **(c) is unfixable that way**: `object` types are
Rc-shared by design; any alias can mutate. Closing (c) statically requires
aliasing XOR mutability — a Rust-style borrow checker — which contradicts Yo's
core shared-mutable `object` model. A partial static check is _lint-grade_,
not soundness, and adds false rejections (no NLL — a slice "lives" to scope
end even if never used again).

## Options

1. **Treat `Slice` as unsafe-by-default (like `*(T)`)** — REJECTED
   (recommendation): it inverts the safety architecture. `Slice`/`str` are
   the _safe vocabulary_ the language steers users toward (MEMORY_SAFETY.md
   explicitly offers `Slice(T)` as the safe alternative to raw pointers).
   `str` has the identical hazard (a `String`'s buffer reallocs), so
   consistency would force `str` unsafe too → every string-touching file
   becomes `pragma(Pragma.AllowUnsafe)` → _less_ net safety, not more.

2. **Delete builtin `Slice`** — REJECTED (recommendation): a borrowed view
   type gets reinvented immediately for `str`, `String` windows, and C
   interop. The redesign cost (notably `str`) is paid with no semantic gain
   unless the replacement has different ownership — which is really option 3.

3. **Snapshot slices: `Slice` co-owns its buffer (Swift-style)** — the real
   fix. Representation: `Slice = { Rc<Buffer>, offset, len }`. `ArrayList`/
   `String` hold `Rc<Buffer>` internally; `as_slice` shares it; mutating ops
   perform **copy-on-write when the buffer Rc is shared** (refcount > 1 ⇒ a
   slice exists ⇒ allocate fresh buffer, copy, mutate the copy). Effects:

   - (a) closed: the slice's Rc keeps the old buffer alive.
   - (b)(c) closed: any mutation while shared CoWs; the slice keeps a valid
     immutable **snapshot** (mutations after the borrow are not visible
     through it — a semantics change, arguably an improvement).
   - Object aliasing semantics preserved: `alias := buf` shares the OUTER
     object; both see the post-CoW buffer.
   - `str` literals: static buffer with an immortal refcount sentinel.
   - Costs: slices grow to 3 words + rc traffic; CoW copies on
     mutate-while-borrowed; ABI change everywhere (C interop, codegen);
     `from_raw_parts` stays pragma-gated with a no-own sentinel.
     This is Swift's `ArraySlice`/ARC answer and fits Yo's existing ARC + cycle
     collector machinery naturally.

4. **Runtime borrow bit (RefCell-style)** — middle ground: `as_slice` sets a
   borrow flag on the collection; mutating ops panic while set. Deterministic
   crash instead of UB, near-zero cost. Problem: slices are plain values with
   no drop hook, so the borrow has no end point — needs `with_slice(cb)`
   closure-scoping (the `Mutex.with_lock` pattern, whose escape rules the
   closure-capture gates already enforce). Breaks `as_slice` ergonomics.

5. **Lint-grade static same-name invalidation** — cheap interim: reject
   reassign/`consume`/mutating-method on `X` while a same-scope slice taken
   from `X` is live. Catches the common footgun (a)(same-name b); documented
   as best-effort, NOT soundness ((c) remains).

## Recommendation

- **Short term (pre-self-hosting):** keep the current model + the corrected
  documentation (FLOWABILITY.md now lists all three triggers). Do NOT change
  `Slice`'s ABI before the codegen port reaches the self-host fixpoint — it
  touches str/String/collections/codegen/C-interop simultaneously.
- **Interim (optional):** option 5 as a lint-grade gate.
- **Long term (the decision this issue tracks):** option 3 — snapshot slices —
  is the only path that fully removes the limitation while keeping
  safe-by-default AND `as_slice` ergonomics. Needs its own design doc
  (`plans/SNAPSHOT_SLICES.md`) covering ABI, CoW triggers, `str` literals,
  C-interop sentinels, and perf budget. Raw zero-copy windows remain available
  to privileged code (unchanged).

## Repro probes

See the flowability audit session: (a)+(b) probes in `src/tests/fixme.yo`
form; (b)'s silent-corruption result (`s(0)` = 1 ≠ 42 after 5000 pushes) is
the headline motivator.
