# yo-self codegen port — stub audit (2026-06-19)

Complete accounting of every stub/placeholder/deferred path in `yo-self/codegen/`,
so nothing is silently incomplete. **None of these is hit by the codegen-bootstrap
corpus (76/76 green)** — all are on unreached paths for the supported corpus.
Categorized as A) FAITHFUL DEFERRAL (matches TS and/or the documented design — not an
"incomplete port"), or B) REAL GAP (a path TS implements that yo-self stubs).

## A. Faithful deferrals (match TS / the BOOTSTRAPPING_CODEGEN plan)

- **WASM async I/O runtime** — `async/runtime.yo:39`, `runtime_io_common.yo:35` panic.
  TS has `runtime-io-wasm.ts` (797 lines); WASM is lower-priority (not requested).
  Deferred, but TS-backed so portable when needed.

> RESOLVED (2026-06-19): **Windows is now ported.** `yo-self/codegen/async/
runtime_io_windows.yo` (4201 lines) ports `generatePlatformSysRuntimeWindows` +
> `generateAsyncRuntimeIOWindows` (IOCP); wired into runtime.yo + runtime_io_common.yo.
> The C templates diff byte-identical to TS, yo-self emits the full IOCP runtime under
> `--target x86_64-windows-gnu` (markers match TS, 0 NUL bytes), corpus stays 76/76.
> Also fixed a latent TS bug (`'\0'`→raw-NUL in the Windows C). All three first-class
> platforms (Linux/macOS/Windows) are now covered. See issues/fixed/
> yo-self-windows-codegen-port.md. WASM remains the only deferred backend.

- **Cyclic GC** — `codegen_c.yo` `compute_needs_cycle_gc` uses the conservative
  `can_type_form_rc_cycle` stub (→ false), and `traverse_fn = NULL` in dyn.yo:140 /
  async.yo:1225. This is the documented "lightweight RC, cyclic-GC deferred" design
  decision (CLAUDE.md / the codegen-port plan), not an accidental gap. FAITHFUL.
- **dyn wrappers / vtables** — `codegen_c.yo:250`'s comment calling these "documented
  stubs" is STALE: `generate_dyn_wrapper_functions` / `generate_dyn_vtables` (dyn.yo
  216/382) are REAL implementations (iterate `dyn_impls`, emit wrappers + typeid
  statics). NOT a stub — comment fixed.

## B. Real gaps (TS implements; yo-self stubs) — all corpus-unreached

Each is a self-contained subsystem; listed with size + TS reference for follow-up.

1. **asm / global_asm** — `generation.yo:367,368` return `/* TODO: not yet ported */`.
   Inline-assembly emitters (`src/codegen/exprs/asm.ts`). Niche; small port.
2. ~~Index-trait dispatch~~ — NOT a gap (CONFIRMED). The evaluator resolves `x[i]` /
   `x(i)` index-trait calls (try_to_call_with_index_trait / has_index_impl,
   index_trait.yo) and records the method FuncVal in the method-callee side-table, so
   they reach generate_other_function_call as ordinary method calls — no separate
   generateIndexTraitCall is needed. Verified: `array_index.yo` corpus fixture passes.
   The `generation.yo:464` comment was stale (now clarified).
3. **Dyn(Fn(...)) closure construction** — `closures.yo:116` returns an error string.
   Impl(Fn) closures (the common case, incl. Thread.spawn) ARE fully ported; the
   heap-allocated Dyn(Fn) variant (`__yo_create_<dynCName>`, closures.ts:314) is the
   remaining branch.
4. **get_type_string bare FnTraitT / FutureTraitT / IsoT** — `utils/index.yo:781,791,
792` panic. In TS these are NOT standalone getTypeString cases either: Fn/Future
   types reach getTypeString as `SomeType` and resolve via `resolvedConcreteType`
   (TS index.ts:619-673; the `case TypeTag.Future` is commented out at index.ts:716).
   yo-self's SomeT branch handles the resolved cases (incl. extern types now). A BARE
   FnTraitT/FutureTraitT reaching here is the unported tail: TS's extern-Future
   FutureTraitType fallback (extractFutureTraitFromType → the future module struct)
   is the one with a real TS implementation worth porting into the SomeT branch.
5. **async state-machine atom resolution** — `atom.yo:140,159,165,180` panic
   ("Phase 5") for SM continue/break/return-completion/variable-resolution inside a
   running state machine. The async SM path works for the corpus (async fixtures
   green), so these are specific in-SM atom forms not exercised yet.

## Recommendation

The supported corpus is fully covered (no stub reachable). The Real Gaps (B) are
unreached today and surface only as the self-source / wider programs exercise them
— i.e. they are exactly the Phase-6 "wave of executing-mode gaps" the plan
anticipates, best fixed as each is hit (with a minimal repro), not speculatively.
The Faithful Deferrals (A) match TS / the documented design and are not porting gaps.
