# An async loop awaiting a buffer-taking method emits a state machine that segfaults (or invalid C, in a generic impl)

**Found 2026-08-26 while implementing STD_API_AUDIT D5** (async `Reader`/`Writer`).
This is THE blocker for D5's `read_to_end`/`read_to_string`/`write_all`
defaults, for `io.copy`, and (together with its generic-impl face) for
`BufReader(R)`/`BufWriter(W)`. All measurements below are on a compiler built
from develop@`87d34f9ed` (includes the C16 #289 and C23 #291 fixes).

## The shape that breaks

An `io.async` body that, **in a loop**, awaits a method taking a raw-pointer
buffer argument (`read(buf : *(u8), size, io)`), where the buffer lives in an
`ArrayList(u8)` local of the same async body:

```rust
io.async((e) => {
  out := ArrayList(u8).new();
  chunk := ArrayList(u8).with_capacity(usize(4));
  // ...fill chunk...
  p := match(chunk.ptr(), .Some(q) => q, .None => *(u8)(""));
  (done : bool) = false;
  while(!(done), {
    n := e.io.await(<recv>.read(p, usize(4), io), e);
    if(n == usize(0), { done = true; }, {
      (i : usize) = usize(0);
      while(i < n, i = (i + usize(1)), { out.push(chunk(i)); });
    });
  });
  out
})
```

Three hosts, three symptoms — one family:

| host of the async body | symptom | repro |
| --- | --- | --- |
| a trait `?=` default (`<recv>` = `self`/`Self.read(self, …)`, CONCRETE implementor) | compiles clean, **0 stubs, 0 FTT markers — SIGSEGV (rc=139) at runtime** | `issues/repros/async-loop-buffer-await-default.yo` |
| a FREE generic fn (`where(R <: Reader)`, `<recv>` = the `r : R` param) | same: clean compile, **rc=139** | `issues/repros/async-loop-buffer-await-free-generic.yo` |
| a GENERIC inherent impl's method (`impl(generic(R), where(R <: Reader), BufReader(R), …)`, `<recv>` = `self._inner`) | **invalid C**: `use of undeclared identifier '_file____priv_temp_NNNN'` in the state machine | `issues/repros/async-loop-buffer-await-generic-impl.yo` |

## The controls that PROVE the trigger (all green end-to-end)

- **Same loop-until-done default, no buffer args** — awaited method is
  `step(self, io)`, accumulation into an `ArrayList` local, both the
  static-dot (`Self.step(self, io)`) and method (`self.step(io)`) call forms:
  runs correctly (3+2+1=6).
  `issues/repros/async-loop-noarg-await-default-CONTROL.yo`
- **Same buffer-taking implementor called directly from `main` in a loop**
  (four sequential awaits through the same `chunk`/`p`, EOF included): runs
  correctly. So the implementor, the pointer idiom and repeated awaits are all
  fine — only the loop *inside another async body* breaks.
  `issues/repros/async-buffer-await-direct-CONTROL.yo`
- A generic impl's async method awaiting a where-dispatched async method
  with a pointer argument but NO ArrayList locals/loop: runs correctly.

So the trigger needs ALL of: (an async body hosting the loop) + (ArrayList
locals whose pointer is held across suspension) + (the awaited call carrying
that pointer as an argument). Hoisting the `chunk.ptr()` match out of the loop
does not help; swapping `self.read(...)`/`Self.read(self, ...)` does not help.

## Notes for the fixer

- The rc=139 binaries carry **zero** `Failed to transpile` markers and zero
  `#275` abort stubs — the state machine is fully emitted and wrong: this is a
  codegen/state-machine capture-or-restore fault, not the evaluator-hollow
  family (C16/C22).
- The generic-impl face's undeclared `_priv_temp` suggests a temp declared in
  one resume state and referenced in another — likely the same
  capture/restore split, surfacing earlier because the generic path renames
  temps differently.
- Related but distinct, discovered en route (diagnostics): an evaluation
  error inside a trait field's TYPE or `?=` default is SWALLOWED and the
  module env is corrupted, so the user sees `Variable "<next def>" not found`
  at an unrelated line instead of the real error — `YO_DEBUG_SWALLOW=1`
  reveals the true error and location. That alone cost this investigation an
  hour and will hit users writing traits with unimported types; consider
  promoting these swallows to real diagnostics at module level.

## What this blocks (D5)

- `Reader.read_to_end` / `read_to_string` / `Writer.write_all` as trait
  `?=` defaults, and as free generic functions (both faces measured broken).
- `io.copy(r, w)`.
- `BufReader(R)`/`BufWriter(W)` wrapping any Reader/Writer (the generic-impl
  face; also blocked by C17 for the `Dyn` spelling).

The D5 slice that does NOT need this — the traits with required methods,
concrete implementors (`File`, `TcpStream`, stdio handles), and per-type
INHERENT convenience methods (which dispatch directly, not through the
trait) — works and can land first.
