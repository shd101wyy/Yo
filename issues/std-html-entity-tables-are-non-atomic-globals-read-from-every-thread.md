# `std/encoding/html`'s entity tables are non-atomic RC globals whose READ path does RC writes, so two threads decoding race

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-10;
measured by the std-primitives sub-audit).
**Status:** OPEN. **Data race inside std**, reachable from safe code that only calls
`html_decode` from two threads. The std instance of the module-global class
(`issues/module-globals-bypass-send-so-safe-code-can-data-race.md`): the rule that closes the
user-code hole has to cover std's own globals too.
**Measured:** mechanism verified in emitted C (the `HashMap(String, i32).get` specialization
contains `__yo_incr_rc(<key>)` … `__yo_decr_rc(<key>)` on the bucket key, and the global handle
is passed without a dup); NOT observed as a crash in 3 × 300 000-iteration two-thread runs of
`html_decode` on macOS (`--allocator system`, `MallocScribble=1`). Non-atomic `++`/`--` on one
word from two cores is a real race that x86/arm64 lose only occasionally; treat the clean runs as
"not reproduced", not "safe".

## Mechanism

`std/encoding/html.yo` ~53-54:

```rust
_entity_map := _build_entity_map();   // HashMap(String, String), ref(struct), non-atomic RC
_legacy_set := _build_legacy_set();   // HashSet(String)
```

Both are built once at module init (`issues/fixed/html-and-log-globals-raced.md` moved the
construction there) and never mutated afterwards — but a lookup is not a pure read: `HashMap.get`
dups and drops the bucket key (`String`, non-atomic RC) and returns the value `String` dup'd,
which the caller drops. Two threads decoding the same entity perform unsynchronized
`ref_count++ / ref_count--` on the same `String` header. A lost increment leaves the count one
low; the next drop frees a `String` the map still owns, and every later decode of that entity is
a use-after-free.

The general lesson, recorded in the plan: **a non-atomic RC value in a module-level global is
racy on READ, not only on write**, because reading a field of a ref struct through a handle
performs RC traffic. The only thread-safe shapes for a module-level runtime global are a plain
value with no RC inside, an atomic object, or a `thread_local`.

## Fix direction

Make the tables RC-free or atomic: keys as `str` (a `[u8]` slice into static data) and values
as `str`, in an `imm.Map` / a sorted `Array` with binary search — or guard both lookups with a
module `RawMutex` as `std/log.yo` does (slower, and `RawMutex` has its own issue). The audit
sweep in the plan's Phase 3 greps every `^name := ` / `^(name : T) = ` at module level in `std/`
(the complete inventory today: `std/rand.yo` thread-locals — fine; `std/log.yo` five globals
under `_log_mutex` — fine; these two) and the same rule then becomes the evaluator's for user
code.
