# Should the verifier prove std's `assumed()` collection bodies? It needs a raw-buffer model

**Kind:** design question — decided. Filed 2026-10-02 to close §4 of
`plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md`. That section said to revisit
after A1 (the lemma layer) and A4 (the init proof token), and both have
landed.

**Verdict (2026-10-02, maintainer: "do whatever you would suggest"):**
option 1, the recommendation below.
- std's collection bodies stay `assumed()`: their contracts are trusted,
  asserted at runtime where they are runtime-checkable, and used by every
  caller's proof.
- No raw-buffer or heap model is built now.
- **Revisit trigger:** a std bug traced to a wrong `assumed()` clause. Then
  take option 2, a raw-buffer model for `ArrayList` alone. Option 3, a general
  heap model, stays with Open Question 1 of `plans/backlog/FORMAL_VERIFICATION.md`.
- Nothing changes in the code. What the verdict fixes is where the line is
  drawn, and the docs now state it (`docs/*/FORMAL_VERIFICATION.md`, the
  `assumed()` paragraph).

## The question

ATS's headline is low-level code proved safe: pointer arithmetic under
views. Yo's `std/collections/array_list.yo` bodies are `assumed()`. Their
contracts are trusted, checked at runtime, and gate every caller's proof,
but no proof covers the bodies themselves. The verifier could prove them
with a raw-buffer model:
- a capacity;
- an initialized prefix (`len` cells), which is exactly what A4's
  `assume_init(n, spare)` token stands for;
- element ownership over R1's contents array.

That is a heap/pointer model. `plans/backlog/FORMAL_VERIFICATION.md`
deliberately parks it. Task 5 slice 1 (2026-09-15) chose "(a) assumed
contracts — the heap model stays parked", and Open Question 1 asks
"flat per-class heaps vs separation logic".

What changed since then: R1–R2 give the verifier a list domain (contents
array + length, extensional equality, `seq_of`, lemmas, `produced`), and
A4 gives the "initialized up to n" fact a name in the API. The model would
have something to prove the bodies against.

## Options

1. **Keep the bodies `assumed()`.** Spend verifier effort on user code. The
   std contracts stay trusted. The fixtures exercise them at runtime, and a
   wrong clause aborts under `yo compile` and `yo test`.
2. **A raw-buffer model for `ArrayList` only.** `*(T)` plus a capacity, with
   `RawSlice` reads and writes as `select`/`store` on an array that
   `assume_init` extends. A body is proved against its own contract. Scope:
   the `ArrayList` core ops, the bodies `push`, `insert`, `remove` and
   `truncate` delegate to.
3. **A general heap model** (Open Question 1: flat per-type heaps or
   separation logic), with `ArrayList` as its first client.

## Recommendation

**Option 1 now. Revisit option 2 when a std bug is traced to an `assumed()`
clause.** Today's evidence:
- The R1/R2 fixtures, the `tests/collections` suite and the canary that
  aborts on a deliberately wrong `insert` clause (R1's risk item) all check
  the clauses at runtime.
- No `assumed()` clause has been found wrong.
- Option 2 is a new verifier domain: raw pointers, aliasing of the buffer,
  allocator calls. Its cost is weeks, and its payoff is proving code that
  already has edge-case tests.

Option 3 should wait until `object` types enter the subset, as Open
Question 1 says. If option 2 is ever taken, A4's token is the view it
reasons about, and `assume_init` is where its `store`s land.
