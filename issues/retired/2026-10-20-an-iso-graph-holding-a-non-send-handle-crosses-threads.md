# An `Iso` graph holding a non-`Send` handle crosses threads

**Severity:** S2 — an invalid program is accepted: `^w` over a `ref(struct)` that holds the thread's `Io` (or a `JoinHandle`) moves that thread-bound handle to another thread, where it races with its own event loop. It is not S1 because it takes an explicit `^` over a reference object carrying such a handle, no valid program is affected, and no runtime corruption was observed.

**Status:** RETIRED 2026-10-21: `Iso(T)`, `^v`, `Var.*` and `Isolation` were deleted by the branch `refactor/remove-iso` (`plans/backlog/MACRO_AND_ISO_REMOVAL.md` Part A, pulled forward to v0.2.68 by the maintainer), so the program below no longer compiles and the hole is gone with the feature. Was: open, the window accepted until `Iso` is deleted; see Disposition. Found 2026-10-20 by the design review of `plans/backlog/MACRO_AND_ISO_REMOVAL.md` (PR #1488).

## Symptom

`Iso(T)` is `Send` for every `T`, so a graph that `^` isolates may hold a
value whose type opts out of `Send`. Capturing the same `Io` directly in a
spawn closure is rejected. Putting it in a field of a reference object and
isolating that object is accepted, and the receiving thread then drives the
spawning thread's event loop.

## Reproducer

Checked on 2026-10-20 with a tree-built `yo` (develop `1c22bad7c` plus
unrelated async-runtime edits; neither touches `Iso`) as
`yo check <file> --std-path ./std` against develop `8203bd867`'s std: rc=0,
no diagnostic.

```yo ignore
{ Thread } :: import("std/thread");
_W :: ref(struct(io : Io, r : Rc(i32)));
_work :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async(e => i32(1)));
main :: (fn(io : Io) -> unit)({
  w := _W(io : io, r : Rc(i32)(i32(7)));
  match(
    ^w,
    .Some(iso) => {
      t := Thread(i32).spawn((tio : Io) => {
        got := iso.extract();
        // the MAIN thread's Io, used on this thread
        got.io.await(_work(got.io), got.io)
      });
      _n := t.join();
      ()
    },
    .None => ()
  );
});
export(main);
```

The direct capture is rejected, as it should be (same binary, rc=1):

```yo
{ Thread } :: import("std/thread");
_work :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async(e => i32(1)));
main :: (fn(io : Io) -> unit)({
  t := Thread(i32).spawn((tio : Io) => io.await(_work(io), io));
  _n := t.join();
  ()
});
export(main);
```

```text
error: Captured variable 'io' (type Io) does not implement Send. To move it across threads, wrap it in Arc/Iso, or capture a Send projection of it instead.
```

The same hole admits a `JoinHandle`: `ref(struct(h : JoinHandle(i32), r : Rc(i32)))`,
built from `io.spawn(...)`, isolated and extracted on another thread that
polls `got.h.state()` while the main loop runs the task, also checks with
rc=0.

Runtime evidence is inconclusive. The `Io` program, compiled plainly, ran and
exited 0. The ThreadSanitizer builds proved nothing: on the machine that
tried them (macOS, 2026-10-20), the Iso-free control program
(`Thread(i32).spawn` plus `join`) also died with rc=139 under TSan. So the
defect is a static acceptance hole; no race report was captured.

## Root cause

- `std/prelude.yo:10064` declares `impl(generic(T : Type), Iso(T), Send());`
  with no `T <: Send` bound. The SAFETY comment above it (:10052) argues
  from uniqueness alone: `^v` proves that every non-atomic object reachable
  from `v` has a count of 1, so no other holder can reach the graph.
- Uniqueness covers the graph's non-atomic CELLS. It says nothing about a
  component that is not `Send` for another reason. `Io`
  (`impl(Io, !Send())`, `std/prelude.yo:12911`) is bound to its thread's
  event loop, and `JoinHandle(T)` (`:12884`) to a future on the spawner's
  loop, whatever their fields are.
- `src/evaluator/calls/iso.yo`'s `_iso_function_offense` (:74) is the only
  walk over the graph's component types at `Iso(T)`. It refuses function
  types and a `Dyn` without `Send` (rule D9, `plans/reference/PARALLELISM_RULES.md`),
  and nothing else. `evaluate_iso_type_call` adds only the cell and atomic
  checks of rule D2. No check asks whether a component type opts out of
  `Send`.
- D2 records the choice: "Rejected alternative: bounding `Iso(T)` on an
  interior-`Send` `T` — that removes the feature".

## Disposition

**No interim fix, by maintainer decision (2026-10-20).** The window is
accepted until Part A of `plans/backlog/MACRO_AND_ISO_REMOVAL.md` deletes
`Iso(T)` and `^v` (that plan's §0.2 and its Schedule). The window does not
widen before then. Part A lands before decision 43 step 2
(`plans/VALUES_BY_DEFAULT.md` §6 "Decision 43"). Step 2 keeps the storage
wall (E0909); references become storable in fields only at step 3 (N2), so
they never reach an `Iso` graph.

A prototype fix was written and discarded. It walked the graph's struct
fields, enum payloads, tuple elements, pointees and type arguments, refused a
component whose type has an explicit or generic negative `Send` impl, and
named the path to it (``at `_W.io` ``).

**No regression test is added.** The usual rule asks for a test that fails
before the fix and passes after, and no such test can pass without a fix.
This doc's reproducer is the pin. Part A deletes `Iso`, the `^` operator and
the tests that use them; the capture check above keeps rejecting the direct
form. When Part A lands, move this doc to `issues/retired/` with a line
naming that PR.
