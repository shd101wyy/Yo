# Async future's owned RC result is never dropped — Dispose of async-produced objects never runs

**Status: FIXED in tree (2026-08-23). Found while implementing std S0 C12
(plans/STD_API_AUDIT.md): the new `TempDir`/`TempFile` `Dispose` impls never
fired because every TempDir is born through `io.await(TempDir.new(io), …)`.**

## Symptom

A reference-semantics value RETURNED from an `io.async` body is never
disposed — not at scope end, not even at program end:

```rust
Probe :: ref(struct(id : i32));
make_probe :: (fn(id : i32, io : Io) -> Impl(Future(Probe, Io)))(
  io.async((io) => Probe(id : id))
);
impl(Probe, Dispose(dispose : (fn(self : Self) -> unit)({ println(`dispose`); })));

main :: (fn(io : Io) -> unit)({
  {
    b := io.await(make_probe(i32(1), io), io);
  };
  // "dispose" never prints — for ANY await shape (temp future, named
  // future, discarded result).
});
```

Every `File` opened via `File.open`, every `TcpStream`, every `TempDir` —
anything RC produced inside a future — leaked its dispose. ASan never
flagged it because the GC thread-exit sweep frees the backing memory
(without running dispose), so this was a silent *semantics* hole, not a
reported byte leak.

## Root cause

The RC ledger for a future's result is: the async body's completion stores
the owned result into `sm->result`; every awaiter DUPs it out
(`await.yo` extraction, `state_machine.yo` extraction — both have inline-dup
fallbacks); the future's own count is supposed to be released by the
future's DISPOSE when the future hits refcount 0. The future's refcounting
itself is correct (constructor 1, event-loop reference +1 released at
completion by `emit_async_future_completion`, awaiter temp released at scope
end) — the future DOES dispose. But both dispose EMITTERS skipped the
result slot:

- **Sync futures** (`io.async` body with no awaits → `_sync_fut_t`,
  `generate_io_async_sync_call` in `src/codegen/exprs/async.yo`): the
  dispose body was gated on `get_drop_function_for_type(result_type)`
  returning `.Some` — and in the self-hosted compiler that is `.None` for
  essentially every type (yo-self synthesizes NO `___dup`/`___drop`
  methods; the inline generator is the only path — the long-documented
  drop_dup trap). Result: an **empty dispose function**.
- **State machines** (`generate_async_block_state_dispose_function`, same
  file): the `.None` arm emitted
  `/* Warning: No ___drop function found for result type … */` — a comment
  where the drop belongs.

## Fix

Both sites now fall back to `generate_drop_code_for_value("sm->result", …)`
— the same inline generator every other yo-self dup/drop site uses (cf. the
awaiter-side dup fallback comment in `src/codegen/exprs/await.yo`). The
sync-future dispose is emitted into the DECLARATIONS buffer while the
inline generator side-emits multi-line code (enum switches, array loops)
into `context.base.emitter`, so that site captures the side lines through a
temp `Emitter` and re-emits them into the declaration stream.

## Deliberately NOT changed (tracked here)

The **capture struct** halves of both dispose emitters have the same
`.None` gap — but their CONSTRUCTION sides copy captures without an inline
dup fallback too (`capture_dup_fn` `.None` → plain copy), so captures are
currently borrow-modeled and adding only the drop would over-release. The
dup/drop pair for RC captures needs to land together:

- sync future: `__capture = (cap){ .field = var, … }` + `capture_dup_fn`
  match at the end of `generate_io_async_sync_call`;
- state machine: `generate_async_block_constructor` capture install +
  `_emit_inline_capture_field_drops` / `_rc_field_drop_line` (both return
  nothing when `get_drop_function_for_type` is `.None`).

Same story for cross-boundary local drops on the unwind path
(`local_drop_lines` via `_rc_field_drop_line`).

## Third family member (also FIXED)

`generate_join_handle_await` (`src/codegen/exprs/await.yo`) had the same
`.None` gap on the EXTRACTION side: `JoinHandle.await` bare-copied
`header->result` instead of dup'ing it, handing out a borrowed reference
that this fix turned into a use-after-free (double-release: the binding's
scope-end drop AND the future's dispose both released the single count).
Same inline-dup fix as the sync-await path; regression test in
tests/async_await.test.yo ("spawned task's ref result is dup'd out…").

(A fixpoint break observed while landing this family was initially blamed
on this UAF — wrongly. It was a HARNESS mistake: passing a repo-resident
binary as `S1` makes it resolve std by exe-walk-up to ABSOLUTE paths while
the /tmp-built stage-2 falls back to relative `./std`, and type keys embed
the module-path spelling — different key strings, different hash-bucket
emission order. `S1` must live at `/tmp/yo-s1` exactly as AGENTS.md shows.)

## Regression test

`tests/async_await.test.yo` — "async-produced ref result is disposed when
the last reference drops": module-level dispose counter, three await shapes
(temp future, named future, discarded result). Red under the pre-fix
compiler, green under a stage-1 carrying the fix. The `TempDir`/`TempFile`
Dispose tests in `tests/fs/temp.test.yo` cover the user-visible symptom.

Note the two-generation rule: these tests pass under a TREE-BUILT stage-1
(what CI's suite legs run) but stay red under a pre-fix SEED binary run
directly against this tree.
