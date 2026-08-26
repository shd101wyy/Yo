# An async loop awaiting a buffer-taking method emits a state machine that segfaults (or invalid C, in a generic impl)

**FACET 1 FIXED 2026-08-26** (branch fix/async-capture-and-swallows). Root
cause of the dropped-parameter face, traced through the new
`YO_DEBUG_CAPTURE=1` channels: the call-time param binding derived
`is_compile_time_only` FROM THE ARGUMENT'S VALUE (`arg has a value && not a
FuncVal`) — and **`UnknownVal` counted as a value**, so any param whose
argument evaluated to a runtime unknown (e.g. `list.ptr().unwrap()`) was
bound compile-time-only; capture tracking then excluded it as comptime and
the async closure's C read it as a bare undeclared identifier. TS derives the
flag from the DECLARED param alone (helper.ts:671) and its own comment calls
UnknownValue "a runtime-only" value — the yo-self heuristic was a mis-port.
Three fixes landed together: (1) `is_ct` no longer counts `UnknownVal`
(calls/function.yo); (2) capture tracking's comptime gate judges the
CALLER-RESOLVED binding, not a name-re-found stale one
(`track_variable_usage_resolved`, context.yo); (3) the `.AsyncBlock`
classifier arm gained the generation-safe inner test the `.FunctionBody` arm
already had (identifer_and_operator.yo). Red-first:
`tests/async_generic_param_capture.test.yo` (undeclared-identifier clang
failure before, 2/2 after).

**FACET 2 (the three silent segvs) FIXED 2026-08-26** (branch
fix/async-loop-state-restore). Mechanism, read straight off the emitted C:
the nullable-pointer match's payload binding (`.Some(q) => q` over
`chunk.ptr()`) declared `q` as a plain C LOCAL while the arm's reads —
which consult `state_machine_variables` — emitted the hoisted
`sm->var_N` slot, which no code ever wrote; the buffer pointer the loop
awaited through was therefore uninitialized garbage. Two repairs:
`codegen/exprs/match.yo`'s `_gen_nullable_ptr_match` binding now ALSO
stores the hoisted slot (env-id resolution with owning-alias + remapping,
then a name-scan over the hoister's map — pattern bindings are often
absent from the recorded env entirely), and
`codegen/async/state_code_gen.yo`'s `_resolve_pattern_binding_sm_field`
no longer short-circuits past its name-scan fallback when the env lookup
finds a stale-generation id (it also gained the owning-alias + remapping
steps). Red-first: `tests/async_loop_buffer_await.test.yo` (both the
trait-default and free-generic loop shapes; rc=1 on the pre-fix binary,
2/2 after). All three loop reproducers now run rc=0; controls unchanged.

**REMAINING OPEN — the generic-impl face only**: `BufReader(R)`-style
generic inherent impls still fail LOUDLY at C compile — the arm's read of
the pattern binding resolves to a MINTED TEMP name
(`_file____priv_temp_NNNN`) that is never declared (a rename/remap on the
read side the binding does not mirror), distinct from the fixed
slot-store split. `issues/repros/async-loop-buffer-await-generic-impl.yo`
still reproduces. This is the one remaining blocker for the generic
`BufReader(R)`/`BufWriter(W)` (together with C17 for the Dyn spelling).


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

## Two sharper facets, measured after filing (2026-08-26, same session)

1. **A GENERIC fn's async closure DROPS the enclosing function's parameters
   from its capture struct** — the emitted C references `buf`/`size`/`io` as
   bare identifiers (loud clang failure: "use of undeclared identifier").
   Workaround that works: hoist each param into a LOCAL before `io.async`
   (`the_r := r; the_buf := buf; …` — locals capture correctly, the same
   pattern std/fs/file.yo's `fd := self._fd` hoist uses), and reach the `io`
   effect as `e.io` inside the body (the hoisted-`io` spelling was not
   tried — `io`-named params are structurally special). With that
   discipline a SINGLE-await generic helper works end-to-end:
   `tests/io/async_traits.test.yo`'s `read_once`/`write_once` are the green
   proof.
2. **The LOOPING await segfaults even with the full hoist discipline**
   (`issues/repros/async-loop-buffer-await-free-generic-hoisted.yo` — same
   as the free-generic repro plus `the_r`/`e.io`; still rc=139). So the loop
   case is a second, deeper state-machine fault, not just the dropped
   capture.

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
