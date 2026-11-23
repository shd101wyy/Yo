---
applyTo: "src/codegen/**"
description: "Use when working on C code generation, the codegen transpiler, emitting C code, or fixing C output bugs. Covers C11 standard compliance, emitter patterns, async lowering, RC/dup/drop emission, effects codegen and allocators."
---

# C Codegen Conventions

- Stick with **C11 standard**. No GNU extensions (`__builtin_*` included): we target multiple C compilers, and MSVC makes C11 the ceiling.
- No `setjmp`/`longjmp` for state machine generation (async/await).
- Do not call `emitter.emitLine` several times when one `emitter.emitLine(multi-line string)` does.
- If a codegen bug is hard to debug from the emitter source, edit the generated C until it works, document what you found, then fix the emitter in `src/codegen/`. Never weaken the failing test; extract a minimal repro (AGENTS.md).
- `--debug-parallelism` / `--debug-async-await` turn on the runtimes' debug output.

## `#line` directives (`--line-directives`, plans/reference/LINE_DIRECTIVES.md)

- **With the flag OFF, emission is byte-identical to the pre-flag compiler** (a standing acceptance property).
- **Statement flush points** (the begin/function-body/loop-body/case-body/cond-arm statement loops in `begin.yo`, `while-loop.yo`, `match.yo`, `cond.yo`, `functions/generation.yo`) call `note_line_position(em, stmt)` (`src/codegen/utils/index.yo`) before `_call_generate_expr`; a new statement loop must too (a no-op without the flag). The emitter dedupes adjacent statements from one `.yo` line. Function boundaries call `em.clear_yo_line_position()` so scaffolding keeps honest C numbering.
- **Restore directives** are emitted as `#line 00000000 "<c>"`: the 8 zeros are a MARKER (the real number is unknowable while the declarations buffer still grows). `Emitter.patch_restore_line_numbers` (via `sections`/`print`) and `_ca_patch_chunk_markers` in `chunk-assembly.yo` rewrite the digits against the final layout. Never emit a zero-padded number yourself: a leading-zero pp-number reads as octal.
- **Pseudo-paths never map**: `_` (error nodes), `drop` (synthesized drops), `auto-generated://` (expansions). The gate is `Emitter.set_yo_line_position`.
- The **code spill is disabled** with the flag (a marker in the spill file cannot be patched in place); chunked emission rewrites markers per translation unit. `assemble_chunks` mints chunk names from the driver's `<base>_chunk` prefix: main.yo's `_pad3` and `_ca_pad3` must stay in sync.
- `yo compile x.yo --line-directives -g -o x && lldb ./x` steps through `.yo` files; a failing C compile re-renders the C compiler's stderr as diagnostics with `.yo` spans.

## Writing emitted C inside a Yo backtick literal

Runtime C is emitted from backtick string literals in `src/codegen/`.

1. **Write the C as ONE multi-line backtick literal**, not a right-nested `+` staircase of one-line literals (`yo fmt` renders that as an unreadable ladder). A real newline is a newline and `"` needs no escaping. Model: `src/codegen/async/runtime-io-macos.yo`'s kqueue block.
2. **A `\r` or `\n` inside the literal becomes a REAL control character in the emitted C** (`'\r'` emits `'<CR>'`, and clang reports `expected expression` on a line that looks fine). Write `\\n` / `\\r` when the C source must contain the escape (hence the doubled `ASYNC_DEBUG("...\\n")`), or compare with numeric codes and a comment (`== 13 || == 10`). Only `\n`, `\r` and `\"` are transformed; `\` + newline passes through, so `#define X \` continuations work.
3. **A backtick inside the literal must be escaped as `` \` ``**, including inside an emitted C comment: an unescaped one closes the string, the rest is parsed as Yo, and the error (`E0008: paren-less function and operator calls are not supported`) points at a word inside the C comment. Ordinary Yo comments may contain backticks freely. The escape is supported, survives `yo fmt`, and emits a real backtick:

   ```yo
   c := `// reads \`state\` first, then registers
   static int x = 1;`;
   ```

4. **A new runtime function must be DECLARED before anything that calls it.** The declarations buffer is flushed before the code buffer, so a call emitted into declarations reaching a later `static` definition fails (`static declaration of 'X' follows non-static declaration`). Hoist the state and a forward declaration into the flags block (`src/codegen/async/runtime-core.yo` does this for the waker); `generate_object_constructor_declarations` (`src/codegen/functions/declarations.yo`) forward-declares `__yo_decr_rc`/`__yo_incr_rc` and their `_atomic` counterparts for this reason.
5. **A per-type helper generated on first use goes to side buffers, never through `context.base.emitter`.** It needs the complete type (so not at the top of declarations) and is called from bodies written into declarations mid-codegen (async disposes, spawn wrappers); callers also swap `context.base.emitter` for a scratch emitter spliced into a function body, so file-scope text written through it lands inside a function. Pattern: the value-enum drop/dup functions (`_value_enum_rc_fn`, `src/codegen/exprs/drop-dup.yo`): a `void*` prototype that names no type goes to a `CodeGenContext` buffer `compile_module` appends to the headers; the `static inline` definition, built under a scratch emitter, goes to a second buffer that closes the declarations section; dedupe by C name.

**Gate for restructuring an emitter literal:** extract every backtick literal from the function, concatenate, unescape, and diff against the same extraction from `HEAD`. Byte-identical output proves no target's C changed.

## Platform runtime C

- **Gate for platform C you cannot compile locally:** `zig cc -target x86_64-windows-gnu` (and `aarch64-windows-gnu`) compiles and links emitted Windows C against MinGW's Win32 headers with the warning flags `src/main.yo` passes; the link proves the import libraries added to `src/main.yo` export every symbol you call. A five-line probe with `zig cc -target wasm32-wasi` / `x86_64-linux-musl` / `x86_64-linux-gnu` / `aarch64-macos` (or `emcc`) settles "does this libc define that macro?" per toolchain.
- **Platform constants in runtime C are macro names, never one platform's literal.** `AT_FDCWD` (-2 on macOS, -100 on Linux), `AT_REMOVEDIR`, `AT_SYMLINK_NOFOLLOW` differ per kernel, and the Yo half (`std/sys/constants.yo`, re-exporting `std/libc/fcntl`'s `c_include`) emits the macro name too. The Windows template's `#ifndef AT_FDCWD`-style fallback block is the one sanctioned place for a literal (the CRT defines none). `tests/internal/uring-runtime.test.yo` pins the spellings per target.
- **Windows reparse-point structs: spell them as the kernel writes them.** `REPARSE_DATA_BUFFER` (driver-kit `<ntifs.h>` only, so runtime code defines it) is `DWORD ReparseTag; USHORT ReparseDataLength; USHORT Reserved;` with the name block at offset **8** (the often-quoted `DWORD ReparseDataLength` shifts every offset by 2). The symlink variant (`IO_REPARSE_TAG_SYMLINK`) has a `ULONG Flags` before `PathBuffer`, the mount-point variant does not: compute `PathBuffer`'s base per tag.
- **Winsock errors never reach `errno`:** every socket-error site translates through `__yo_wsa_to_errno` (`runtime-io-windows.yo`), or `IoError.from_errno` reports "unknown I/O error (os error 10048)".

## Spelling a Yo name in C: `__yo_v_` (src/codegen/utils/index.yo)

Every Yo-derived LOCAL, PARAMETER, FIELD and enum VARIANT payload member is emitted with the prefix `__yo_v_` (`x` is `__yo_v_x`, `opt.value` is `opt.data.__yo_v_Some.__yo_v_value`): a header may define a macro of any spelling, so no Yo name is emitted bare (issues/fixed/emitted-c-identifiers-collide-with-header-macros.md).

| Name | Function |
| --- | --- |
| Yo local, parameter, capture, field label, union member | `sanitize_for_c_identifier(name, false)` |
| A field of a struct that may be ADOPTED from a header (`Point : Type`) | `c_field_name(owner_type, label)` (raw header spelling when adopted) |
| An enum variant's member in the `data` union | `c_variant_member_name(variant)` |
| A real C symbol (`c_include`/`extern("c")` function or global) | `sanitize_for_c_identifier(name, true)` |
| An ABI or a fragment: exported/extern "Yo" function names, function ids, pieces of type/static names | `c_symbol_name(s)` (no prefix) |

- `sanitize_for_c_identifier(_, false)` is idempotent and leaves compiler-generated shapes alone (names starting with `_`, `fn_yo_id_…`, `yo_id_…`, `closure_yo_id_…`, `var_…`). Apply it at the DECLARATION and at EVERY USE; sets keyed by emitted names (`declared_c_var_names`, `declared_scopes`, `local_shadowed_variables`) are queried with the sanitized spelling. A raw Yo name pasted into C (`.${label} =`, `closure_context->${name}`, a hard-coded `self` or `.Some`/`.value`) is a C compile error.
- A `match` pattern binding may shadow an enclosing local: one whose name is already declared in an open enclosing block gets a fresh name (`shadow_binding_decl_name`), and reads go through `shadow_binding_c_name`. Never paste a binding's sanitized name yourself. A drop emitted inside an arm resolves its target by identity (`_drop_operand`, `src/codegen/exprs/rc-fns.yo`), so an early exit in the arm still releases the hidden enclosing local.

## A codegen fix does not license the source form until the seed has it

`yo build` compiles `std/` and `src/` with the SEED's codegen (`SEED_VERSION` in `.github/workflows/test.yml`). After fixing a miscompile, keep every workaround spelling in `std/`/`src/` until `SEED_VERSION` carries the fix. Tests do not catch a premature rewrite (test binaries use the tree's codegen); a seed-built stage 1 scoring the cli-cases (`scripts/bootstrap/gates_fast.sh`) does, as does comparing a suite run's file count with `find tests -name '*.test.yo'` (issues/fixed/seed-built-compiler-read-dir-reports-every-entry-as-the-zero-file-type.md).

## Async/await threading model

The model (one single-threaded event loop per OS thread; parallelism is separate) is in AGENTS.md. Worker threads from the parallelism runtime that share an OS thread share its event loop.

**Platform implementations:**

- **Linux**: `io_uring` (the runtime vendors the ring layer, no liburing: `plans/reference/DROP_LIBURING.md`), with an epoll fallback where the ring cannot exist (`plans/reference/LINUX_ASYNC_IO_PERFORMANCE.md`). An op that can finish now finishes inline (socket ops try `MSG_DONTWAIT` first; metadata ops and creating/truncating opens, which io_uring always punts to io-wq, are plain syscalls). Sleeps are a userspace timer heap whose earliest deadline bounds the wait. Reserve SQEs through `__yo_io_get_sqe` (it flushes a full SQ), never `__yo_uring_get_sqe`. An inline attempt must not run ahead of a queued op of the same direction on that fd (`__yo_io_fd_busy`). Any path that closes a descriptor (including `dup2` over an open fd) calls `__yo_io_close_hook` first.
- **macOS**: `kqueue`, same rules (`plans/reference/MACOS_ASYNC_IO_PERFORMANCE.md`).
  - Regular file I/O is synchronous: `pread` first (`ESPIPE`/`ENXIO` → the readiness path), and `F_GETFL` before a write (macOS `pwrite` honors the offset on `O_APPEND`).
  - Pipes and sockets try inline (`MSG_DONTWAIT`) and park only on would-block, on a per-(fd, filter) **registration**: a FIFO of waiters in the per-fd slot table `__yo_kq_slots`.
  - **One knote per (ident, filter)**, registered `EV_DISPATCH` and re-enabled per park with `EV_ADD|EV_ENABLE` (XNU's `EV_ADD` alone does NOT re-enable a dispatched knote). Events match registrations by **(ident, filter), never udata**.
  - Every parked op sets `cancel_fn`/`backend_link` and holds a future reference; an inline attempt must not run ahead of a parked op of the same direction (`__yo_kq_dir_busy`).
  - A zero-timeout `kevent()` that finds nothing is expensive (~12 µs): non-blocking passes probe with `select()` on the kqueue fd first (`__yo_kq_has_events`), and `__yo_io_poll` skips the kernel when the next step blocks anyway.
  - Timers are a userspace heap; poll/fs-event handles live in one watch kqueue nested in the loop's.
  - Any path that closes a descriptor (including `dup2`) calls the per-thread `__yo_kq_close_hook` first (the sys runtime is emitted for every program, so it cannot name kqueue symbols directly).
- **Windows**: IOCP, per-thread `GetQueuedCompletionStatus` with `NumberOfConcurrentThreads = 1`.

**Implications for runtime code:**

- No mutexes, atomics or other synchronization on async runtime variables (`__yo_pending_io_count`, timer lists, future state).
- All per-thread event loop state is `_Thread_local` (`__declspec(thread)` on Windows): `__yo_pending_io_count`, `__yo_active_watch_count`, `__yo_io_initialized`, `__yo_async_scheduler_initialized`, the backend handle (`__yo_io_ring`, `__yo_kq`, `__yo_io_iocp`), and lists like `__yo_active_fs_events`, `__yo_active_polls`, `__yo_win_timer_head`.
- Process-global state (signal handlers, WSA init, TTY/console settings, umask) stays `static`.
- **Thread exit releases what no loop driver ended** (`__yo_async_thread_exit_release`, installed by `__yo_async_arm_thread_exit`, `runtime-core.yo`). A test body or plain `main(io)` is driven by synchronous awaits, so this is where its pending work is freed.
  - Every backend teardown first aborts the tasks parked on its pending futures (`__yo_io_teardown_abort_waiters`: aborts the waiter through its ordinary path, then fails a still-pending future so the aborted task is enqueued); the hook then drains the ready queue by running each task's aborted-entry guard, never its body. A new backend teardown that strands a pending future must call the helper first, walking a SNAPSHOT of the futures (the abort can free registrations under the walk).
  - It quiesces the cross-thread inbox first, as a loop driver does, and runs a queued `__yo_join_wait_fire` even when the wait is already Completed (that entry owns a reference). A new waiter callback whose payload is not a task needs the same treatment.
  - The full-GC runtime's `__yo_cleanup_thread_gc` calls the hook BEFORE its dispose/free passes (after them it would drop captures the GC already freed); keep that order.

## The single-pass async lowering (`io.async` state machines)

An `io.async` body is emitted ONCE, by the ordinary expression generators, into its resume function (`generate_async_block_resume_function_inline`, `src/codegen/async/state-machine.yo`; record: `plans/archive/ASYNC_STATE_MACHINE_GENERATION.md` phase 5). No segments or per-construct async emitters: `await` is legal in any expression position and suspends in source order. `YO_DEBUG_ASYNC_LAYOUT=1` prints, per block, each closure parameter's declaration sites and each captured local's id, site and whether it got a field.

- **Shape.** Aborted-entry guard, `goto __yo_dispatch;`, `__yo_state_0:`, the body, its completion, then `__yo_dispatch: switch (sm->state)` listing exactly the labels the body produced. `generate_await` in SM context calls `emit_inline_await` (state store, ready check, cold start, waiter registration, `return`, then the `__yo_resume_K:` label). An await outside the resume function is a `codegen_fatal_expr`; an await emitted TWICE is a `codegen_fatal`: generate an expression containing an await exactly once.
- **Rule 1: nothing that lives across an await is a C local.**
  - A captured non-unit local live across a suspension lives in `sm->var_<id>` (`compute_cross_boundary_variables`, a linear live-range walk: a read counts at the end of its statement; a local defined before a loop and used in it is live through the loop; a local with a scope-end drop or whose address is taken lives to the end of its scope).
  - An address is taken by `&x` and by any call passing `x` to a C pointer parameter without `&` spelled (`fn_abi_param_is_ptr`: a `self : &mut Self` receiver like `buf.as_ptr()`, an operand an operator borrows) (`_lv_mark_call_lends`).
  - Every other local is a plain C local (the resume jumps past its declaration, which C allows), so the escape path must release it: `emit_effect_unwind_check` emits the pending drops in an SM as in a plain function (a field's drop zeroes the slot, so the abort dispose does not release it twice).
  - A node from another module (a macro expansion) makes positions incomparable: every local then gets a field.
  - A read the walk cannot resolve (an atom with no environment, e.g. a `return(x)` argument) is a use of every local with that name (`_LiveWalk.names`).
- **Pattern bindings are locals**, including one bound compile-time-only (captured at its declaration atom, `_capture_pattern_bindings`; an extern constant keeps its C name). Declared in its arm, stored by `_bind_pattern_name`, found by declaration site (`_inline_binding_sm_field`: sibling arms share names), read through `shadow_slots`. A `mut` match's place binding is an `is_ref` variable: its slot is `T*` (`_capture_env_variable`), read as `(*sm->…)`, pointing into the scrutinee (a `mut` match never copies its subject).
- **Await results** live in `sm->__yo_await_result_<k>` only when a later await in the same statement can suspend before the result is consumed (`f(await a, await b)`); otherwise a C local (`g_local_await_results`, consulted by the struct emitter and `emit_inline_await`). A C-local result owning an RC or move-only value is declared under the await's owning temp's name and stored into the temp's slot when it has one (`_bind_await_result_to_temp`), or a consumer that reads only a field (`match(await(f).s, …)`, a `while` condition) leaks the value.
- **The future prefix points at a per-type vtable** (`__yo_future_vtable_t`: `resume`, `set_effect`, `cancel_pending`, `bundle_offset`, `bundle_size`). A raw I/O future's `vt` is NULL; every read tests `X->vt && X->vt->op`. A whole effect bundle (`io.await(f, bundle)`, `io.spawn`) is injected with `__yo_future_set_bundle(f, &bundle)` (a `memcpy` to the bundle slot); the per-type `set_effect` handles per-field injections by name. `generate_future_effect_setter` returns the vtable's bundle pair, so setter and table cannot disagree.
- **A closure parameter lives in its `__yo_param_<i>` slot** only; its own local (by declaration site) is dropped from the field set. The struct definition and the resume function read ONE cross-boundary result (`_block_cross_boundary`); a second `compute_cross_boundary_variables` call declares fields nothing uses.
- **Slot sharing** (`compute_overlapping_slots`): same-C-type locals with non-overlapping ranges share `sm->slot_<k>`, heap-owning temps included. Sound because a temp's slot is non-zero exactly while it owns its value: every drop of an `sm->var_…`/`sm->slot_…` zeroes it (`generate_drop`), every consuming read of a temp zeroes it (`_sm_consuming_read`), and the dispose drops a shared RC slot once. Pattern bindings, both sides of `is_owning_the_same_rc_value_as`, and NAMED RC locals never share. Two RC locals of one scope always overlap; sibling scopes share.
- **A zeroed move-only slot is not empty.** A zeroed RC handle is NULL (release skipped), but a zeroed move-only value (`type_is_move_only`) is still a value whose drop runs the user's `Drop`. A dispose that relies on "finished regions are zeroed" must gate on a flag: a fused await site's fields are released only under its `<prefix>live` flag (`_emit_fused_sites_dispose`); a named local gates on its move flag (next item); a temporary's slot still relies on its zeroes (issues/2026-11-05-an-aborted-task-drops-a-temporary-s-slot-before-it-is-stored.md).
- **A named local's move flag is its drop flag.** `(cur : T) = t` moves `t` without a dup and `t` may still be read, so a named local's slot is NOT emptied by a move: its `uint8_t __yo_mv_<field>` flag (`sm_move_flag_of`) means "the slot holds no value of its own". It starts set (`<struct>_init_move_flags`, at allocation); every store into the slot (binding, destructuring, reassignment, pattern binding) clears it; a scope-end drop (`generate_drop_of_operand`) sets it; every compiler-emitted drop of a flagged slot (abort dispose, fused site release, early completion, loop exit) runs only while it is clear. A consuming `match`'s binding owns its part, so its slot is in the dispose set; only a borrowing match's binding slots stay out (`note_state_machine_binding_id`).
- **An alias is read through its owner's slot only when the owner is a body local** (`sm_storage_id`). The suspension analysis has no closure boundary and records `s` as captured for `sb := s` even when both live in the enclosing function; the `io.async` re-kind pass (`src/codegen/exprs/async.yo`) turns captures into `.Outer` and drops an owner whose alias is a capture and that the body does not capture itself. An SM struct field that no state stores into is this class of bug. The alias and owner are ONE storage holding one reference: `sb := s` into the owner's slot emits no dup (`init-assignment.yo`), and the two scope-end drops release it once (the first zeroes it).
- **A capture is identified by its declaration site, never its name** (a pattern binding may shadow a captured name). The re-kind pass asks `is_capture_field_binding(<capture struct id>, name, decl_site)`, recorded per field by `create_capture_type_and_value` (`FuncCapturedVarInfo.decl_site`). An `.Outer` entry's slot is `sm-><sm_capture_slot>.<name>` (`sm_slot_of_variable` takes the context's `sm_capture_slot`, which a fused await site renames).
- **A fused wrapper is emitted inside the caller's match arm but is not in its scope.** The arm state (`local_shadowed_variables`, `shadow_bindings`, `shadow_slots`, `place_bindings`) is name-keyed and consulted by `_generate_sm_atom` first, so `emit_fused_await` takes it out (`_enter_wrapper_scope`) around the wrapper's parameters, prologue, capture and block. The caller's escape-drop lists (`pending_deferred_drops`, `consumed_var_pending_drops`) leave with it (an escape inside the site is the awaited future's abort; the caller's dispose releases what it owns). The prologue runs under the wrapper body's own lists; the block's pending list holds only its own drops. Any new path that emits one function's nodes inside another's must do the same (issues/fixed/2026-11-07-a-fused-await-reads-the-callers-match-binding-of-the-wrappers-name.md).
- **A consuming read of a slot takes the value where the consuming line runs** (`_sm_consuming_read`, via `Emitter.defer_move_zero`'s `/*yo_mv:…*/` marker; the evaluator's `consumed_at_token` is that atom): a temp's slot is zeroed, a named local's slot sets its move flag. A drop or RC builtin's operand is NOT a move (`InlineSmLowering.rc_operand`, set by `_rc_operand` in `rc-fns.yo`). The move is recognized by POSITION, so a desugar that synthesizes several reads of one local must give them distinct tokens (the template literal's `__yo_tpl_N` tail sits at the closing backtick for this reason).
- **In an SM, a C local renders by its source token** (`_generate_sm_atom` step 5 uses `_var_read_code`; see the next section).
- **Nested blocks are ordinary C blocks.** A `goto` into one is legal; never splice a block into its parent (its locals would live until the task ends).
- **Released machines go back to a per-type pool.** A constructor allocates with `__yo_sm_take(<pool>, sizeof)` (`_sm_alloc_call`); `__yo_dispose_dispatch` returns 1 when it gave the memory to `__yo_sm_give`, and every caller must then skip `__yo_free` (both release paths in `gc-runtime.yo` do). Anything else freeing a future's memory goes through the dispatch too. Pools are thread-local, capped at 32 blocks, drained by `__yo_async_free_cont_pool` (the thread-exit hook), and off under ASan (`__YO_SM_POOLS`), so they are tested by the CLI case `async-state-machine-pools`. **A pooled block is always untagged and global-allocator-owned:** `_sm_alloc_call` takes from the pool only when no explicit allocator is current (`sc.vtable == NULL`, as in `__yo_rc_tag_of`), `__yo_sm_give` refuses a block with `ref_count & __YO_RC_TAG`, and `__yo_sm_pools_drain` frees with `__yo_free`. Keep this if a pool ever accepts gives from another thread.
- **One `__yo_await_slot`** (a task has at most one pending await) owns an anonymous future. `emit_future_store_into_slot` dups a future read out of a place (a field chain is borrowed), and the future's temp goes into `moved_into_slot`, which suppresses its scope-end drop. A named future is awaited in place and stays with its owner.
- **Do not redeclare a self-named atom.** The materializers (a `return`'s deferred dup, an arm value, a dup-or-code) declare `T <variable_name> = <rendered code>;` when the two differ; for an atom named after itself the rendering is its slot, and the declaration redefines the binding. Test `is_self_named_atom` (`src/codegen/utils/index.yo`) at every site comparing a temp name to the raw code.

## `ExprInfo.variable_name` is UNTRUSTWORTHY in cond/match arm-value position

`attach_temp_variable_to_expr` can stamp a SPURIOUS temp `variable_name` onto a bare variable reference used as an arm's value (`(n == 0) => min`). **Ask every question about a variable in this position about the SOURCE TOKEN, not `variable_name`** (`src/codegen/exprs/atom.yo`). The guard that decides an early return and the site that emits must call ONE predicate (`_is_captured_here`): two copies disagreed, and a closure body emitted a bare identifier that does not exist in it (issues/fixed/captured-variable-as-a-cond-arm-value-emits-a-bare-identifier.md). A capture wrapped in any expression (`cap + usize(1)`) takes the call-argument path and hides the bug; test the bare-atom arm.

## Recorded envs are released at scope exit: look names up through `scope_variables`

`compile` releases recorded environments (`plans/backlog/CODEGEN_MEMORY_REDUCTION.md` §6.1): when an outermost function body finishes evaluating, every `ExprInfo` recorded during it gets a **husk** env (a copy of the body's entry frame list); the body's frames are freed. What codegen needs was recorded then: an atom's `source_variable`, and per-info lists of the variables of its names (`variable_name`, deferred drop/dup/consumed targets, a binder's bound name, a property atom's token).

Rules for codegen and for the evaluator analyses codegen calls late (`mutation-summary.yo`, `await-analysis.yo`, `suspension-analysis.yo`):

- **Never call `get_variables_from_env(ei.env, name)` on a recorded env.** Call `scope_variables(key, env, name)` (`src/expr-info.yo`), or `get_variable_name_for_codegen_at(key, name, env)` for a C name. A live env falls through to the plain lookup; a husk answers from `key`'s records.
- **`key` is the node whose record holds `name`**, not always the node being generated: a binding site uses the bound name atom (the `:=` lhs, a destructured field atom, `y` in `y := &mut place`, the pattern binding); a cleanup drop uses the drop target atom (`deferred_drop_target_variable`); a place's base uses its binder (`_lhs_root_binder` in `exprs/assignment.yo`).
- **A new name source needs a record**: the evaluator notes it with `scope_release_note_binding` (a binding) or `scope_release_note_query` (a name the node reads); otherwise a husk answers from the entry frames only.
- **Whole-env scans cannot be answered from records.** `_call_is_handler_installation` and the `given` evidence scans keep their nodes' envs (`_scope_keeps_env`); a new whole-env reader needs the same.
- **Verify with shadow mode.** `YO_SCOPE_RELEASE=shadow yo compile src/main.yo --skip-c-compiler -o /tmp/x` answers codegen from kept envs and prints `[scope-release] ... mismatch=N` with a per-kind breakdown; a new site must not raise `mismatch`. The C of `YO_SCOPE_RELEASE=off` and the default must be byte-identical.

## Memory allocator options

- `--allocator system` (default): the platform allocator.
- `--allocator mimalloc`: links `<std>/../vendor/mimalloc`; missing, the compile fails before evaluation naming the path (`_require_bundled_mimalloc`, `src/main.yo`), and the emitted C stops at `#error` without `<mimalloc.h>`. No fallback to `malloc`; wasm targets reject it. Compile such C by hand with `vendor/mimalloc/src/static.c -Ivendor/mimalloc/include -DMI_BUILD_RELEASE`, or on the C library's heap with `-I scripts/bootstrap/libc_mimalloc`.
- `--allocator fixed`: TLSF over ONE static `.bss` region (`plans/reference/FIXED_REGION_ALLOCATOR.md`), emitted by `src/codegen/c/allocator-fixed.yo`: defines and prototypes in the header section, region/control block/functions ONCE in the code section (chunked emission keeps one copy in chunk 0; never move the state into the header, or every TU gets its own region). One family: `__yo_aligned_free` IS `__yo_free`. Keep the standalone C stress harness (randomized integrity hammer, physical-block invariant walker, multi-threaded hammer) in sync when touching the algorithm. `--heap-size <n>[K|M|G]` (64K..4G) sizes the region; `--debug-heap` prints peak/live-at-exit.
- `--allocator debug`: a tracking allocator over the system heap (`src/codegen/c/allocator-debug.yo`, same header/code split; `__yo_aligned_free` IS `__yo_debug_free`).
  - Each block has a header (system pointer, size, allocation number, address-keyed canary), sits on a live list and in a block table keyed by payload address; free/realloc consult the table BEFORE reading the header, so a foreign or evicted pointer never crashes the check. Freed blocks are poisoned 0xDD and quarantined (64 MiB FIFO; the newest always stays).
  - `main` calls `__yo_debug_alloc_init()` first so its atexit report runs LAST; the body marks a normal return with `__yo_debug_alloc_main_returned()`, and only then does a leaked block exit 23 (`yo test` calls it a leak).
  - Roots: `__yo_main_module_init` registers each module global with `__yo_debug_alloc_root`, and a runtime static holding heap for the process's life (the worker array, the GC-state list) is registered the same way. A running thread's stack is NOT a root: threads are counted (`__yo_debug_alloc_thread_enter` before `__yo_raw_thread_create`, `__yo_debug_alloc_thread_leave` as the entry's last statement); the report waits up to 1 s, then lists without judging. A new thread-creation site must call the pair.
  - The program reads the mode through `__yo_debug_alloc_on()` (extern "Yo").

**Out-of-memory policy (all allocators):** runtime sites that cannot propagate failure (RC constructors, async/parallelism runtimes) allocate through `__yo_rc_alloc`, which panics via `__yo_alloc_fail`. Never use a bare `__yo_malloc` result without a NULL check (an explicit `if (!p) return -ENOMEM;` path is preferred where one exists).

## Safe-mode runtime guards (`plans/backlog/SAFE_MODE.md` phases 1–3)

Every guard is a `static inline` C11 helper emitted by `src/codegen/c/collection.yo` that prints `<what> (at %s:%d:%d)` and aborts:

- `__yo_idx_chk(i, n, f, r, c)` returns `i`. Every fixed-array / `str` subscript routes its index through `_checked_index_expr` / `_checked_fixed_array_subscript` (`src/codegen/utils/index.yo`). **Never write a `->data[` / `.ptr[` subscript with a user-reachable index outside those helpers**; only compiler-chosen in-range indices stay raw (drop/dup walks over `0..N`, constructor fill loops). A bare-decimal index into a bare-decimal length folds when in range.
- `__yo_div_guard` / `__yo_div_guard_u` in comma form before integer `/` and `%` (`_div_checked_expr`); float ops stay unguarded.
- `__yo_{add,sub,mul}_chk_{s,u,s64,u64}` and `__yo_neg_chk*`: widths ≤ 32 bits widen to `long long` and range-check; 64-bit widths use the xor identities and a division-free multiplication ladder (the naive identity misses `MIN * -1`). `wrapping_*` maps to the raw `__yo_op_*_wrap`.
- `__yo_sh_chk(sh, bits, …)` in comma form; an in-range literal count folds to the plain shift.
- `__yo_sat_i64` / `__yo_sat_u64` for float→int casts.

Derive width bounds from the type, never hard-coded 61/63 (`usize` is 32 bits on wasm32). Validate new helper arithmetic with a standalone C probe, and use `--sanitize undefined` to check the guards themselves are UB-free.

**Every runtime trap is `fflush(stdout); fprintf(stderr, …); __yo_abort();`** Never emit a bare `abort()`: it discards a piped stdout's buffer, so a panicking program's output vanishes from logs. `__yo_abort()` (emitted right after the includes, `src/codegen/c/collection.yo`) flushes and aborts; a site that prints flushes stdout BEFORE its `fprintf` to keep terminal order.

**The Windows main wrapper owns the console code pages.** The Windows arm of `generate_main_wrapper` brackets the body with `__yo_win_console_cp_enter()` / `__yo_win_console_cp_exit()`: enter saves both console code pages and switches them to `CP_UTF8` (Yo emits UTF-8; a legacy ANSI page mojibakes non-ASCII), exit flushes stdout/stderr and restores them (aborts skip the restore). No-ops when the pages are already UTF-8 (a parent Yo process switched them) or no console is attached. `WIN32_LEAN_AND_MEAN` excludes `<wincon.h>`, so the wrapper includes it itself. Test: `tests/internal/main-wrapper-console-cp.test.yo`.

## RC and pointer layout

### RC headers: one layout

Every counted cell starts with `__yo_ref_header_t`, aliased `__yo_rc_prefix_t` (`src/codegen/types/generation.yo`): a `uint32_t` count at offset 0 (top bit = the explicit-allocator tag, below), a 16-bit type id, and a 16-bit word holding the `Weak` count on an `Rc`/`Arc` cell. No cycle collector, no `traverse_fn` (`plans/archive/WEAK_AND_UNCOLLECTED_RC.md` §6). `tests/internal/gc-runtime-atomics.test.yo` pins the runtime text.

The runtime helpers are `static inline`, emitted into every file (`src/codegen/functions/gc-runtime.yo`):

- `__yo_incr_rc` / `__yo_decr_rc`, and `_atomic` variants for atomically counted cells (`Arc`);
- `__yo_dyn_retain` / `__yo_dyn_release` / `__yo_dyn_clone`: a `Dyn` payload's count, through its vtable;
- `__yo_rc_weak_retain` / `__yo_rc_weak_release` / `__yo_rc_weak_upgrade`: `Weak` / `ArcWeak`;

There is no runtime borrow flag: a cell header's 16-bit word is the `Weak` count alone, and no emitted call acquires, releases or asserts a borrow. Aliasing is rejected statically (E0901, E0910, E0913) or checked by `RefCell`. The prelude's `__yo_borrow_*` externs lower to nothing.

At count zero, `__yo_dispose_dispatch` switches on the type id to the payload's `___dispose`, then frees the cell. A type id of 0 frees without a dispose, so a payload whose constructor stamps no id leaks its fields (`debugging.instructions.md`, "Leaks").

Explicit allocators (`plans/reference/EXPLICIT_ALLOCATORS.md`):

- The TOP BIT of `ref_count` is `__YO_RC_TAG`: every count read masks with `__YO_RC_COUNT` (`(ref_count & __YO_RC_COUNT)`), never the raw field.
- A tagged block carries a 16-byte `__yo_alloc_prefix_t` owner prefix AHEAD of the RC header: free through `__yo_rc_free` (routes to the owning allocator), never a bare `__yo_free`.
- There is no allocation scope (no `__yo_current_allocator`). Only a cell primitive's constructor (`__yo_cell`/`__yo_atomic_cell`, the box of `Rc`/`Arc`) is placed: it takes `__yo_alloc_scope_t __yo_sc` first and allocates with `__yo_rc_alloc_in(__yo_sc, …)` (a NULL vtable is the global allocator); the call site passes `alloc`'s `{ctx, vtable}` or `{0, 0}`, and a `Dyn` clone passes `__yo_scope_of_object(self_ptr)`. Every other RC block (a `ref` constructor, `dyn`'s box, an `io.async` state machine, the runtime's own blocks) is global: `__yo_rc_alloc` or the SM pool. A container's `alloc : .Some(a)` hands the `Allocator` straight to its buffer allocation.
- **Two allocator interface versions, one switch.** `CodeGenContext.alloc_abi_v2` is read off the shape of std's `AllocatorVTable` (`std_allocator_abi_is_v2`, never a flag); std's struct is the one whose id was minted by a module under the std path (`stable_id_module_path`). Any other shape, two disagreeing std copies, or a version-2-shaped vtable outside std is an internal compiler error. Version 1: `alloc(ctx, size)`/`realloc(ctx, p, n)`/`free(ctx, p)`, 16-byte prefix. Version 2: `alloc(ctx, size, align)`, `realloc(ctx, p, old, new, align)`, `free(ctx, p, size, align)`; a placed RC block's prefix is `max(32, align)` bytes, the owner in the last 16 and the extent `{size, align}` in the 16 before. Spell a placed allocation through `CodeGenContext.rc_alloc_in_call` (it adds `_Alignof(T)` under version 2), never a literal `__yo_rc_alloc_in(...)`. std speaks version 2; version 1 stays until no supported seed's std is version 1.
- **`align_of(T)` of a layout only C knows** (an `extern` type, or a struct holding one) folds to a typed unknown, and `generate_alignof` emits `_Alignof(T)` (as `generate_sizeof` emits `sizeof`).

### A `Box` payload projection masks the handle's placed bit

`Box(T) :: newtype(_cell : *T)` is C-transparent, and bit 0 of the cell pointer is the handle's "placed" bit (`plans/backlog/ALLOCATOR_PLACEMENT.md` "Related: `Box`'s layout"). Every payload projection (`b.*`, `b.field`, `b.method()`, `&b.*`, `addr_of(b.*)`, a `Box(p)` pattern) goes through `box_payload_place_code` (`src/codegen/utils/index.yo`), which writes `(*((BoxT)((uintptr_t)(b) & ~(uintptr_t)1)))`, or masks the address word of the fat pointer for an unsized payload; never spell `(*b)` for a `Box`. A place that takes the address back strips the outer `(*…)` and keeps the masked pointer. `tests/box-layout.test.yo` covers every projection.

### A pointer to an unsized type is the fat `__yo_slice_t`

`[T]` and a struct whose last field is `[T]` are unsized (decision 49, `plans/VALUES_BY_DEFAULT.md`). Every pointer to one (`&[T]`, `&mut [T]`, `*[T]`, same over a tail struct) is the erased C type `__yo_slice_t { void* ptr; size_t len; }`, emitted once with the type declarations. Spell a pointer's C type with `pointer_c_type_string` (`src/codegen/utils/index.yo`), never `get_type_string(pointee) + "*"`. A `?Sized` generic slot stays thin until specialized (`_pointee_is_fat`, `src/types/utils.yo`, is false for a type variable).

- **An unsized place is `(*F)`, `F` its fat pointer**; a consumer needing the pointer strips the outer `(*…)`. `unsize(&a)` emits `(*fat)`; `unsize(p)` over a `*T` emits `fat`. A local bound to `unsize(&a)` is a reference binding declared `__yo_slice_t s = fat`.
- **A tail struct's `[T]` field is a C flexible array member** (`E items[];`). Other fields are read through the fat pointer's `ptr`, the tail through a fat pointer with the outer `len`. The declaration-order walk (`src/codegen/types/generation.yo`) orders the struct after `E`.
- **`unsize(&a)` is a projection call**: its ExprInfo type is the unsized place, its mode in `unsize_reference_mode` (`src/expr-info.yo`), so `call_projection_mode` and the evaluator's `projection_call_mode_of` treat it like a function returning `&T`. Never give a call's ExprInfo a reference type for a reference it yields (a generic `&T` would bind `T` to the reference).
- **`size_of_val`** of a tail struct is `round_up(offsetof(tail) + len * sizeof(E), alignment)`; of `[E]`, `len * sizeof(E)`.
- **`___drop` of an unsized place** (`_emit_unsized_place_drop`, `src/codegen/exprs/rc-fns.yo`) drops a tail struct's fields, then loops over the elements; the loop variables are declared before the element drop is emitted (its code names them).

## Emission rules that sanitizers enforce

Sanitizer flags (`--sanitize address|leak|undefined`, UBSan non-recovering) and leak testing: `testing.instructions.md`.

- **Never load a value you have not written as its type.** macOS hands out zeroed fresh heap, so a UBSan run there misses uninitialized `bool` loads Linux reports; reproduce with `MallocScribble=1`. A new emitter that SAVES or COPIES an unwritten value (a by-value copy of `MaybeUninit(T).new()`, the old-value save of `consume(p.* = v)`) uses `memcpy` (issues/fixed/consume-assignment-loads-the-uninitialized-old-value.md).
- **A function VALUE is called through exactly the type it was defined with** (`-fsanitize=function`; a `(void*)` cast only hides the mismatch). A `-> Impl(Future(...))` function returns its concrete `<block>_sync_fut_t*` / `<block>_state_t*`, while a `fn(...) -> Impl(Future(...))` slot spells the generic Future pointer. So every `FuncVal` that becomes a runtime value goes through `fn_value_c_name` (`src/codegen/functions/declarations.yo`), which hands out an erased-signature `__yo_fnval_thunk_<fn>` when the spellings differ, and a call through a function pointer casts to the erased result (`erased_future_result_type_string`). Never use `get_function_entry(..).c_name` in VALUE position.
- **An assignment evaluates its place once.** `generate_assignment` splices the LHS's C into up to two statements (old-value save and store). A place whose evaluation runs a call (a by-name Index dispatch `m(k)`, a method or projection call in its base chain) must not be spliced: `m(s) = v` dropped the key twice (`_place_evaluation_runs_a_call`, `src/codegen/exprs/assignment.yo`). Such a place is materialized once into a pointer temp taken AFTER the right side (a growing right side would dangle an earlier pointer). A provably pure spelling (an atom, a field/deref chain, `Array`'s inline `data[i]` over pure parts) still splices. Any emission reusing a rendered expression twice asks the same question.

## Drop glue and the cell runtime

The cell header and runtime helpers: "RC headers: one layout" above.

### Drop glue

Per type the compiler derives `___dup` / `___drop` / `___dispose`: a dup retains each counted field, a drop releases what the value owns, a dispose runs the payload's `Drop` and then drops its fields (`_synthesize_and_register_dispose`, `src/codegen/functions/collection.yo`). `generate_drop_code_for_value` (`src/codegen/exprs/drop-dup.yo`) lowers a drop by kind:

- a value owning a buffer or with a `Drop` impl (`String`, `ArrayList`, `Box`, a user `Drop` type): its `___dispose`, then its fields inline;
- an `Rc`/`Arc` handle: decrement its cell;
- a value aggregate holding handles: walk its fields, inline or through `__yo_venum_drop_<T>`;
- a `Dyn`: release through its vtable.

Under `--emit-chunks` every translation unit gets its own `static` copy of these helpers (they are the hot path).

The evaluator places each drop; codegen emits it there:

- **Scope end.** `_schedule_scope_end_drops` (`src/evaluator/exprs/begin.yo`) drops a block's owning, unconsumed locals in reverse declaration order, then (for a function body) the by-value parameters.
- **Early exit.** A local the block moves later still owns its value on a `return`/`unwind`/`break`/`continue` taken before the move: the begin epilogue's M3 driver attaches that drop to each such exit, and to effect escapes (`consumed_variable_drop_expressions`); `attach_consumed_binding_exit_drops` does the same for a consuming `match` arm's bindings.
- **Old value.** An assignment drops the value it replaced (`_drop_unused_old_value_now`): an explicit-copy value right after the store, a still implicitly copyable kind at block end.

### Where a `___dup` comes from

A dup is a second owner of counted data: `Rc.clone(h)` / `Arc.clone(h)` (an explicit `___dup` in the prelude), an implicit copy of a still implicitly copyable value that holds a count, and the aliasing guard below. A last-use move has no count traffic; plain data copies without a count; a `Box` moves and is never counted. `ref_count` reads a count.

### The borrowed-argument aliasing guard

A place inside an `Rc`/`Arc` payload lent to a `&T` parameter could dangle if the callee released its container through another handle. `consume_argument_for_parameter` (`src/evaluator/calls/helper.yo`) closes that:

- **Stage 0.** An RC-typed field projection lent to a borrowing parameter gets a caller-owned +1 for the call (`set_expr_as_needs_to_call_dup_for_borrowed_projection`, `src/evaluator/utils.yo`), released by the call's post-call drop (`mark_call_scoped_share_dup`); a place reached through a read-only handle takes the +1 on the handle (`borrowed_place_read_only_handle`). Plain locals, owned temps, `&mut` parameters and extern/builtin callees stay +0.
- **Stage 1.** `function_may_mutate_rc_storage` (`src/evaluator/effects/mutation-summary.yo`) gives a read-only callee its +0 back. A callee MAY mutate if it (transitively) assigns an RC-typed place, decrements explicitly (`___drop`, `__yo_decr_rc`, …), calls a runtime/allocator extern or libc `free`/`realloc`, takes a callback, yields through an io builtin, is a control function, or calls anything unresolved. Compiler-generated drops are no hazard: they target owning variables, and a borrow owns nothing.
- The guard emits almost every remaining `___dup`. `YO_DEBUG_GUARD_OFF=1` (an internal knob, not a user flag) skips it, to see what the +1 masks; `scripts/guard-off-probes.sh` runs `tests/origins/guard/` both ways against each program's `// expect:` / `// guard-off:` headers, and test 7's guard-off axis runs its corpus with it set. A program accepted and ASan-dirty only with the knob set blocks deleting the guard (VERDICTS-70 row 5).

### Owning result temps

A VALUE literal with RC-typed fields passed straight to a call (a tuple `(i32(1), list)`, an array literal, a struct constructor) must carry an OWNING RESULT TEMP (`attach_temp_variable_to_expr` in its evaluator path): the callee stores its OWN dup of each RC field and never consumes the argument, so the caller's scope-end drop of the temp balances it. A path that skips the attach leaks one reference per RC field per call.

### Move-only values ride the RC machinery, without dups

A move-only value type (a value `struct`/`enum`/`newtype` with a `Drop` impl, or an aggregate holding one; `type_is_move_only`, `src/types/utils.yo`) makes `type_contains_rc_type` true: owning temps, scope-end drops and flow joins like an RC value, but never a dup. `set_expr_as_needs_to_call_dup` moves every value that is not implicitly copyable (`type_requires_explicit_copy`; `transfer_explicit_copy_value`, `src/evaluator/utils.yo`) or rejects the copy (E0901); a closure capture consumes it.

- Its drop (`generate_drop_code_for_value`) calls the type's `___dispose` first, then drops fields inline. For a `Drop` impl the `___dispose` is a synthesized `(Self <: Drop).drop(self)` (`_destructor_method_name`, registered by `collect_dispose_methods` → `_synthesize_and_register_value_dispose`); its source is `auto-generated://`, the one caller E0915 (explicit destructor call) exempts.
- Over a `Drop` impl `___dispose` takes `self : &mut Self` (a C pointer): `dispose_call_on_value` emits `X(&(value))` so the destructor's writes reach the storage the field drops read; a reference type's header goes through `dispose_fn_thunk`, which passes the address of a local holding the handle (`dispose_function_takes_pointer` decides; a `___dispose` with no user destructor keeps the by-value ABI).
- A dup of a move-only value reaching codegen is an evaluator bug: find the copy point that skipped the funnel.

### A capture's reference is taken once, by whoever decided it

- **A capture-list entry is a field store.** The evaluator decides it on the entry's initializer (`set_expr_as_needs_to_call_dup`): a copy carries its own deferred dup, a move carries none and consumes its source. The emitter emits the initializer through `emit_deferred_dup_or_code` and takes no other reference (`closures.yo`, `_build_async_capture_struct_literal` in `exprs/async.yo`).
- **An implicit capture's copy is the closure's capture dup.** A capture that is not implicitly copyable (`type_requires_explicit_copy`: a future, a waker, a channel half) and has no dup was MOVED; retaining it leaks it.
- **A closure construction's deferred dups belong to the closure emitter** (its captures' references, written into the capture struct's initializer). `generate_deferred_dup_expressions` emits nothing for a closure construction (`is_closure_construction`, `drop-dup.yo`), and a site that treats a tail or returned value's dups as a borrowed value's must test it too (`functions/generation.yo`).
- **Every drop an `FnOnce` body schedules for its own capture must carry the tag.** In a closure body, codegen skips any drop whose target names a capture (`is_deferred_drop_for_closure_capture`) unless it is tagged `mark_fnonce_capture_drop`. The capture-frame scope-end and early-exit drops (`begin.yo`) carry it, as do the drops for a capture moved on some paths only (`_drop_in_arms_that_keep`, `drop_moves_of_skippable_operand`, tagged when `is_own_fnonce_capture` holds). A new evaluator path that drops a value a sibling path moved must tag it, or the keeping path leaks the capture.

### A hand-written C declaration must be registered, or its drops vanish

`generate_deferred_drop_expressions` (`src/codegen/exprs/drop-dup.yo`) silently skips a `___drop` whose target is not in `declared_c_var_names` (the guard for elided declarations). `get_variable_type_string` records every name it declares; a site that writes its own `get_type_string(t) + " " + name + ";"` must call `context.base.declared_c_var_names.insert(name)` itself. When a scheduled drop is "missing" from the C, check this set before the evaluator.

- **Release timing** (for leak tests): statement temps are released at SCOPE end, except a temp the statement LENDS (`&temp` call arguments, a borrowed `match` scrutinee), dropped right after its statement (`_flush_stmt_lent_temp_drops`, `src/codegen/exprs/begin.yo`). The old-value save of a FIELD reassignment (`k.next = .None`) is released at the enclosing scope's end, so a `Drop` counter read later in the same scope still sees the old handle alive: clear the field inside its own function.
- **An emitter whose expression carries an owning result temp declares that temp itself** (`attach_temp_variable_to_expr(expr, true, …)` in the evaluator) and returns its name. Calls, tuples, arrays, `dyn()`, `match`, `cond`, `downcast` and `upcast` do; a single-expression emitter uses `bind_owning_result_temp` (`exprs/other-fn-call.yo`). A binding, a by-value argument and `&` re-declare an operand that is not already its temp; a `&self` receiver and a discarded statement do not. Check a new producer by comparing `x := e`, `e.m()` (a `&self` method) and `e;` under `--sanitize address`.
- **Early exits need the block-scope stack too.** `declared_c_var_names` covers only the scope-end release; the early-exit gates (explicit `return`, `if (__yo_effect_escaped)`) also require the target in the emitter's block-scope stack (`_emitter_track_scope`), which records only `<type> <name> = …` lines. A temp declared bare (`T tv;`) and assigned in later branches is pushed with `em.mark_declared_in_scope(tv)` once those branches close, not at the declaration (that would release an unassigned temp on an exit inside a branch).

### A call emitter must emit its arguments' deferred dups

The evaluator decides one ownership rule for every call form (`consume_argument_for_parameter`, `src/evaluator/calls/helper.yo`): a borrowed argument of a `sink` parameter gets a +1 the callee releases, and a borrowed projection passed to a borrowing parameter gets a +1 the caller releases after the call. Both ride on the argument as a deferred `___dup`, so every argument emitter honors it: the plain call through `_materialize_arg`, method dispatch through `_dispatch_arg_code` (`src/codegen/exprs/other-fn-call.yo`). A bare `_call_generate_expr(arg)` in an argument loop drops the dup. Check a new loop by comparing `f(x.field)`, `T.f(x.field)` and `x.field.g(...)` under `--sanitize address`.

Constructor arguments follow the same rule: `set_expr_as_needs_to_call_dup` (`src/evaluator/calls/type.yo`) puts the dup on struct and newtype field arguments alike, so both arms of the value-struct constructor emitter (compound literal and newtype cast) use `emit_deferred_dup_or_code`.

### A call with a result temp is a statement on every call path

Arguments and operands are ordered only by the statements they emit: an argument left inline runs at its point of use, after every later sibling's statement. So every call emitter in `generate_other_function_call` turns a call the evaluator gave a temp (`ExprInfo.variable_name`) into `T tv = <call>;`, including the function-pointer / closure tail (a `fn`-pointer field, a `Dyn(Fn …)` vtable call, a static `Impl(Fn …)` capture-struct call), whether or not the call may unwind.

**Plain operands are settled by `sequence_operand`** (`src/codegen/exprs/other-fn-call.yo`). Every operand loop (plain call, method dispatch, dyn, constructor, primitive operator in `generation.yo`, tuple in `tuple-fn.yo`, array in `array-fns.yo`, fused await in `async.yo`) passes each earlier by-value operand's final code (after its deferred dup) to it; if a later operand names the operand's local root or may write, the value is spilled into a fresh `__yo_seq_<n>` local (a bitwise copy owning nothing). Address operands, settled codes (literals, comptime values, own temps), the last operand and unit/never/unresolved-`SomeType` values stay inline. In a state machine, when a later operand contains an `await`, the value is held in a task slot `sm->__yo_seq_<expr id>` laid out by `collect_operand_holds` (`async.yo`); an operand with no slot stays inline.

**A declared temp needs its drop in the C scope that declares it.** A temp names itself in the nearest begin-block frame and is dropped at that block's end, except a temp the statement LENDS (a call argument whose parameter slot is a `Reference` (marker, exempt or receiver spelling), and a borrowed `match` scrutinee):

- The evaluator marks the lent expression's SOURCE TOKEN (`note_lent_temporary`, `src/expr-info.yo`, at `apply_call_site_borrow_markers` and the match scrutinee; a call argument is evaluated several times with a fresh temp name each, so the token is the stable fact). `_flush_stmt_lent_temp_drops` flushes, right after the statement, each pending drop whose target's mint token is marked and lies in the statement's span.
- Only drops on the CURRENT block's own scope-end list are candidates: the pending list also carries enclosing scopes' drops, and the `for` lowering mints the receiver's temp and the element binding at the same token (a span test alone released the outer temp once per iteration).
- The drop STAYS in the block's list (every escape path inside the statement releases it); the emitted-once guard keeps the two channels to one release.

**One-expression blocks flush their own drops.** A `cond` condition, a `match` guard, a `while` condition, a three-argument `while` step and a non-place `match` scrutinee are each evaluated as a one-expression block (`evaluate_begin_expression`) whose node shares its id with its tail. A call tail's post-call flush emits the frame's drops; a field read or operator tail (`RI(v : j).v < 3`, `match(mk(7).n, …)`) needs its own flush:

- A `cond` condition's and a `match` guard's drops ride on the node; the emitter flushes them right after the bool.
- `_emit_while_cond_break` puts the condition in a bool, flushes its drops, then breaks.
- `generate_while_loop` flushes the step's drops right after the step. An ASSIGNMENT step goes through the assignment generator, never a hand-built `lhs = rhs` (a bitwise move that skips the right side's dup and the replaced value's release).
- `_generate_match_expression_body` flushes the scrutinee's drops once the arms read only the subject's materialized temp; a `mut` match, a pointer subject or a subject with no temp flushes after the construct.
- A new construct that evaluates a sub-expression through `evaluate_begin_expression` must flush that node itself.

An exit (`break`/`continue`) between a flush and the end of the enclosing scope consults `emitted_deferred_drop_ids` before re-emitting a pending drop (`_emit_loop_body_drops_before_exit`). Consult only: an exit path never records into the set, or the normal path's scope-end flush would skip its own release.

### Inside a state machine, a temp declared as a C local must also be stored to its slot

A minted temp that has a `sm->var_<id>` slot has its deferred drop rendered against the slot. A site that declares it as a C local (`T tv = <ctor or call>;`) calls `_store_temp_var_to_state_machine_if_needed(tv, indent, context)` right after, or the drop releases calloc zero and the value leaks per iteration. Every temp-declaring site in `other-fn-call.yo` does this. A consumer that reads such a temp after a later operand's await reads the slot, never the C local: `_sm_lent_temp_slot` maps the temp name to its slot for a by-value argument (`_apply_ref_amp`), a pointer argument and a borrowing `match` subject.

### An arm emitter must emit the rendered code of a unit arm

Some generators RETURN their statement instead of emitting it (`___drop(x)` renders `__yo_decr_rc(x)`). An arm emitter that assigns value arms to the result temp and emits NOTHING for a unit arm loses the statement (it emptied `HashMap._resize`'s release loop). An unassigned unit arm's non-empty code goes out as `code;` (a bare temp name excepted): `_emit_unassigned_arm_code` in `cond.yo`, `_emit_case_body_no_break` in `match.yo`. A suspiciously empty C body (an `if` with two empty branches, a loop that only computes a pointer) is this class.

### A function returning a reference: cond arms

In a function returning `&T`/`&mut T` (`fn_result_is_ref`), a `cond` whose value type is a pointer declares its temp as the pointer; `_maybe_address_of` (`src/codegen/exprs/cond.yo`) wraps an arm whose value is not a pointer in `&(...)`, and a projection-call leaf yields its own pointer (`chain_leaf_pointer_code`).

## `&mut T` parameters

`name : &mut T` lowers to `T*`: the callee reads `(*name)` and writes `(*name) = v`. `comptime(name) : &mut T` is erased.

## Index trait codegen

`_generate_index_trait_call` (`src/codegen/exprs/generation.yo`) emits `value(arg)` dispatched through the Index trait:

- The builtin `__yo_array_index` is inlined as `(&((&value)->data[idx]))` (through the safe-mode subscript check). Index methods backed only by a builtin are detected by `is_function_value_with_only_builtin_yo_inline_function_call` (`src/codegen/utils/index.yo`) and get no standalone C definition; the expansion is inlined at each call site.
- Other methods (ArrayList, HashMap, …) become a named call (`_index_method_call_by_name`). Range indexing dispatches to `slice_copy` methods (owned copies).
- The pointer result is auto-dereferenced unless `ExprInfo.is_index_trait_address_of` is set: `addr_of(arr(i))` / `&arr(i)` keeps the pointer (`generate_address_of`, `src/codegen/exprs/ptr-fns.yo`).
- A zero-sized element (`Array(unit, N)`) has no `data` member: its value emits nothing, its address is `((void*)0)`.

## Dyn codegen: `dyn_impls` is the whole-program registry, and it decides

`context.base.dyn_impls` holds one entry per `dyn()` CREATION site, keyed by `(dyn_type, concrete_type, convention)`. The collection pass fills it (`collect_required_functions`, `src/codegen/functions/collection.yo`), `fixup_dyn_impl_keys` re-keys it to C names, and everything that emits dyn machinery reads it: box typedefs (`generate_dyn_box_types`), box ctor/dispose and wrapper functions, vtables with their `__yo_typeid_<concrete>` statics (`src/codegen/functions/dyn.yo`). Collection runs before any body is emitted (`src/codegen/codegen-c.yo`), so a body emitter can treat it as complete. Before touching `src/codegen/exprs/downcast.yo`:

- **A registry MISS is a decision, not a fallback.** The is-check is `dyn.vtable->__yo_type_id == &__yo_typeid_<T>`, and that address only lands in a vtable built from an entry, so no entry for `(Dyn, T)` means `downcast` lowers to a constant `.None` (operand still spliced for effect). Falling through to an object cast emits invalid C.
- **Every key carries the convention suffix `dyn_impl_key_suffix`** (`_P` for a `dyn(&v)` instance whose data word is the payload's address, `_A` for a legacy `Arc(V)` cell, empty for the legacy cell), in collection, the fixup's re-key, an upcast target and the `dyn(...)` site alike; without it a `dyn(&c)` and an owned `dyn(Box.new(...))` of one Dyn share an entry and an upcast slot goes NULL.
- **Resolve `concrete_type` through `resolve_some_type_to_concrete` before keying or comparing**, as `generate_dyn_box_types` does: an unresolved `SomeT` turns a real match into a miss.
- A fieldless enum target hides bugs here (it lowers to a C integer, so a bad pointer cast compiles); reproduce with a payload-carrying variant or a struct-shaped value type (`String`).
- **`is_void_type` is false for `unit`, which still renders as C `void`.** An emitter that keeps a call result in a temp (the `Dyn(FnOnce(...))` call slot's `__yo_once_r`) must also test the rendered return type (`return_str == "void"`).

## Algebraic effects codegen

The semantics (`return` resumes, `unwind` discards) are in AGENTS.md; the design is `docs/en-US/ALGEBRAIC_EFFECTS.md`. The load-bearing part here is the emitted C contract: `__yo_effect_escaped`, evidence records lowered to function pointers, the `sync_fut_t` resume shape. When a name does not resolve, grep the emitted C string (e.g. `__yo_effect_escaped`).

### Evidence passing for effects

**All** effects (struct records like `Exception`, `Raise`, and function types) use **evidence passing**: an effect record's function fields are passed as explicit C function-pointer parameters. `generic(...)` stays compile-time-only.

- `exn : Exception` adds a C parameter `void (*throw)(AnyError)`; `raise_mod : Raise` with `Raise :: struct(raise : (fn(msg: String) -> i32))` adds `int32_t (*raise)(__yo_string)`. The body calls the operation through the pointer.
- Call sites pass: in sync code, the handler address from `exn := Exception(throw: handler_fn)`; in an async SM, `sm->__capture.throw` from the Future's capture struct; transitively, the caller's own evidence parameter. This is what crosses sync/async boundaries (issues/fixed/sync-effect-inlining-inside-async-context.md); a `ctl` handler called directly is inlined at the call site (`is_control_fn`, `functions/collection.yo`).
- There is no codegen effect pre-pass: `ExprInfo.effect_analysis` is never written in a self-emit (see the rare-field note in `src/expr-info.yo`), so effect codegen is driven by the evidence parameters collected at declaration time (`collect_evidence_from_record` / `get_evidence_parameters`, `src/codegen/functions/declarations.yo`).
- **Forall function-type effects** (`Raise :: ctl(generic(T), msg: String) -> T`): handlers from local `(raise : Raise) = ((msg) -> { ... })` bindings are marked effect-record members (`src/evaluator/exprs/initialization-assignment.yo`; predicate `is_effect_record_member`, `src/function-value.yo`), so their C body is emitted despite generic parameters (erased at runtime). They are included in async capture structs as `void*` and cast at each call site (`src/evaluator/values/anonymous-function.yo`). `io.await`/`io.spawn` injection writes the handler pointer for struct-record and generic function-type effects alike (`emit_effect_injection_for_await`, `src/codegen/exprs/await.yo`).

### Thread-local unwind flag

The caller cannot see statically whether a handler called through a pointer unwinds, so the thread-local `__yo_effect_escaped` signals it:

1. Before calling a handler through a function pointer, the flag is reset to 0.
2. `unwind()` in a handler sets it to 1 (`generate_unwind`, gated by `is_effect_record_member_function`); a non-unit `unwind(value)` also stores the value in the thread-local `__yo_unwind_value`. `return(v)` is a plain C `return v;` with the flag left at 0. A handler may do both in different branches.
3. After the call the caller checks the flag; if set it drops RC-typed arguments and propagates: an async SM aborts the Future (state = -2), runs the continuation, self-decrements the event-loop RC and returns; a `sync_fut_t` resume sets state = -2, self-decrements and returns; sync code drops locals and returns a dummy, and each caller in the chain checks and propagates.

Destructors are ordinary code, and every may-unwind call in one clears the flag first, so drops emitted while an unwind is in flight must not lose it:

- Drops ON the escape path (`generate_unwind`, `emit_effect_unwind_check`) raise the flag again after them (`_reraise_escape_after_drops`).
- A call's deferred drops between its return and its unwind check go through `generate_call_deferred_drops` (`exprs/return.yo`), which saves the flag and MERGES it back (`int __yo_escaped_keep_N = __yo_effect_escaped; <drops>; __yo_effect_escaped = (__yo_effect_escaped | __yo_escaped_keep_N);`), so a destructor that unwinds itself is kept. A new call shape that emits `generate_deferred_drop_expressions` before `emit_effect_unwind_check` must use it.

`__yo_effect_escaped` and `__yo_unwind_value` are declared through `emit_declaration_line` so `sync_fut_t` resume functions (also in the declaration section) see them. Key files (`src/codegen/`): `functions/context.yo` (`is_effect_record_member_function`), `functions/generation.yo`, `exprs/return.yo` (`generate_unwind`), `exprs/other-fn-call.yo` (check + abort at call sites), `exprs/async.yo` (`sync_fut_t` resume).

### Escape detection in sync_fut_t resume functions

A `sync_fut_t` (a future with no await points) with evidence parameters checks the flag after calling its closure:

```c
void resume(void* ptr) {
  sync_fut_t* sm = (sync_fut_t*)ptr;
  sm->result = closure(&sm->__capture, ...evidence_args...);
  if (__yo_effect_escaped) {
    __yo_effect_escaped = 0;
    sm->state = -2;  // Aborted
    __yo_decr_rc(ptr); // Event loop reference — matches full SM behavior
    return;
  }
  sm->state = -1;    // Completed
  // ... continuation + __yo_decr_rc(ptr)
}
```

**Event-loop RC convention:** ALL futures (`sync_fut_t` and full SM) self-decrement the event-loop reference on BOTH completion AND unwind. The synchronous await abort path (`src/codegen/exprs/await.yo`) does NOT decrement; the awaiter's pending deferred drops release a locally owned future's ownership reference.

### Await unwind value: handler installation vs propagation

When an `io.await` sees an aborted Future (state == -2):

- **Handler installation** (the function binds the handler locally, `(raise : Raise) = ((msg) -> { ... })`): clear `__yo_effect_escaped`, `memcpy` the value out of `__yo_unwind_value`, return it.
- **Propagation** (the effect arrives as an evidence parameter): set `__yo_effect_escaped = 1` and return `(ReturnType){0}`.

`_call_is_handler_installation` (`src/codegen/exprs/other-fn-call.yo`) decides by locating the handler binding locally (a control/effect-record callee or its name bound in a begin-block frame of the enclosing function, or a fn-typed/ctl-bound parameter whose threaded argument resolves to one); `emit_effect_unwind_check`'s `is_handler_installation` parameter (`src/codegen/exprs/return.yo`) carries the verdict.

### Which effect functions get emitted

- **Effect-record handlers get real bodies.** A lambda bound to `throw : ctl(generic(ResumeType), ...) -> ResumeType` would normally defer evaluation (`should_defer_body` in `src/evaluator/values/anonymous-function.yo`, `should_defer_ft`), but its address is stored as `void*` in the record's capture struct (`emit_effect_record_injection`, `src/codegen/exprs/await.yo`). `ctl_force` in `evaluate_anonymous_function_implementation` clears `should_defer_body` for every `ctl` handler so the body is evaluated at definition time and emitted. A handler body that fails to evaluate is a MISCOMPILE: it is emitted as an `abort()` stub, and the stub's `__attribute__((error(...)))` never fires through a function pointer. Every function-body trial must go through `evaluate_begin_expression` (`return` is only recognized as a BEGIN statement; issues/fixed/resumable-exception-bare-return-handler-body-aborts.md).
- **Skips must let evidence-bearing functions through.** `should_skip_function_codegen` (`src/codegen/functions/declarations.yo`) exempts effect-record members and functions with evidence parameters (`has_evidence`) from the hard-generic skip: evidence parameters may trace back to a comptime `generic(...)` binding yet are plain C function pointers. A specialization inherits `value.type` from its generic, so it can answer `is_function_type_hard_generic == true` while being concrete at the C ABI; a skip must not drop it. In `functions/collection.yo` the `expr_contains_unknown_value` skip applies only while a parameter is still a SomeType (`_func_has_some_param`).
- **Probe "still generic" with `type_contains_some_type_for_codegen_param`** (`src/evaluator/trait-checking.yo`), never the strict `type_contains_some_type`: a `Function`-typed struct field (an effect-record handler) is an erased fn pointer, so its inner generic does not make the struct still-generic.

### Effect member return types and casts

- Effect-record member handlers with a SomeType return (`Raise :: (fn(generic(T), ...) -> T)`) use C `void` in BOTH the forward declaration (`functions/declarations.yo`) and the definition (`functions/generation.yo` skips the SomeType body override when `is_effect_record_member`). The unwind value travels through `__yo_unwind_value`, not the return value. `override_return_type_str` on `FunctionGenerationContext` (`functions/context.yo`) keeps the body's real C return type so `generate_unwind` emits correct dummy returns.
- **Evidence function-pointer casts use the handler's real C return type.** For a generic handler (`Exception.throw :: (fn(generic(T), error: AnyError) -> T)`) that is `void`; casting to the call-site type (`JsonValue`) is an ABI mismatch (UB: `RuntimeError: unreachable` on wasm, stack corruption natively). The "handler returns void" branch in `src/codegen/exprs/other-fn-call.yo` declares a zero-initialized temp, calls the handler as void, checks `__yo_effect_escaped` and propagates (issues/fixed/evidence-fn-ptr-void-return-abi-mismatch.md).

### Handler functions are standalone, not closures

Effect handler functions (struct-record and fn-type) are compiled as standalone C functions via evidence passing. They are **not closures** and cannot reference variables from the enclosing scope: no capture struct is generated. This is **by design**. A handler that needs state takes it as explicit arguments to the effect functions, or the address of an `Rc` allocated outside the handler. See `docs/en-US/ALGEBRAIC_EFFECTS.md` (§ Handler Functions Are Not Closures).

## JoinHandle(T) codegen

`JoinHandle(T)` is returned by `io.spawn`; it is a move-only value struct in the prelude that OWNS one reference to the future.

**`io.spawn(task, ctx)`** (`_generate_io_spawn`, `src/codegen/exprs/generation.yo`):

1. Store the future pointer in a local.
2. Inject the effect bundle via `emit_io_spawn_effect_injection`.
3. Cold-start only a cold future (state 0): `__yo_incr_rc` (the execution reference), then `vt->resume`. An already-aborted future is not started; its handle reads `.None`.
4. Move the caller's reference into the handle, `(JoinHandle cname){ .__future = fut }` (allocates nothing), materialized into the spawn's own temp so a discarded handle is dropped. Its `Drop` calls `__yo_join_handle_release_raw`; a dropped, never-awaited handle detaches the task (the running task holds its own reference).

**`emit_io_spawn_effect_injection`** (`src/codegen/exprs/await.yo`; the `io.await` sibling is `emit_effect_injection_for_await`) resolves each handler pointer in order:

- Struct-record effects (e.g. `Io`), per function field: SM capture variables (`sm->__capture.<field>`); struct value fields (the evaluator's concrete value); the caller's evidence params; locally installed handler bindings.
- Function effects (e.g. `Raise`), generic ones included (NOT skipped; they are `void*` at runtime): the caller's evidence params; SM capture variables; the bound handler's function value; fallback `generate_expr` on the handler argument.

**`handle.await(io)`** (`generate_join_handle_await`, `src/codegen/exprs/await.yo`) reads the handle's `__future`, casts it to an inline struct of `__YO_FUTURE_PREFIX` + `result`, and polls `while (state != -1 && state != -2) { __yo_async_poll_step(); }`. On completion it moves the result out as `Option(T).Some` and marks the future `-3` (result taken); on abort it clears `__yo_effect_escaped` and yields `.None` (`__yo_task_abort_observed`). It consumes the handle: it releases the handle's reference (`__yo_join_handle_release_raw`), and the evaluator marks the handle moved, so no scope-end `Drop` follows. For `Option(unit)` the `.Some` variant has no data field, only the tag.

### The future prefix

Every future (async-block state machine, sync-closure future, the generic Future interface, the raw I/O future `__yo_io_future_t`) starts with the `__YO_FUTURE_PREFIX` macro (`src/codegen/types/generation.yo`):

```c
__yo_ref_header_t header; int state; const __yo_future_vtable_t* vt; void (*continuation_fn)(void*); void* continuation_sm;
```

`result` comes AFTER the prefix (its size varies). `__yo_future_header_t` is the prefix alone and is all the type-erased runtime reads (JoinHandle helpers, waiter list, abort). `__yo_io_future_t` spells the prefix with `_Atomic` fields, with `_Static_assert`s pinning its offsets. Emit a new future struct with the macro; never re-spell the fields or put anything ahead of them.

The protocol on the prefix lives in `src/codegen/async/runtime-core.yo`:

- **Waiters.** `continuation_fn`/`continuation_sm` is one inline waiter slot. Register with `__yo_future_add_waiter(fut, fn, sm)`, never by storing into the slot; a second waiter turns the slot into a list (`__yo_waiters_dispatch`). Complete or wake with `__yo_future_wake_waiters(fut)` (registration order).
- **Abort.** `__yo_future_abort(fut)` marks a non-terminal future -2 and calls `fut->vt->cancel_pending(fut, prev_state)` (a future with no vtable just wakes its waiters). Each async block emits that hook beside its resume function (`generate_async_block_cancel_pending_function`), switching on `prev_state`: an I/O await cancels the operation (`__yo_async_io_cancel` → the backend's `cancel_fn`); a child-future await aborts the child (structured cancellation); then it wakes the waiters. A park's hook is `__yo_park_cancel`, so a cancelled park reads `is_woken() == false`, and `Mutex`/`Channel` pass the wake to the next waiter.
- **Wake.** `__yo_async_wake(fn, sm)` hands the first wake made while a task runs to a same-step LIFO slot that `__yo_async_run_task` drains (capped at 64) instead of the run queue. An await that finds its future already complete continues inline, within the inline budget (1024).

## The native `Io` (`plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md` §2, §3)

Codegen reads the prelude `Io`'s shape once per compile (`std_io_type`, `CodeGenContext.io_type`):

- **Four-field `Io`** (`async`/`await`/`state`/`spawn`, never read): `__yo_io_native()` returns a zeroed `Io`; every lowering is inline (cold start + `__yo_async_poll_step` loop).
- **Interface `Io`** (`ctx` + `vtable : *IoVTable`): `__yo_io_native()` returns `{ ctx = __yo_async_loop_self_ptr(), vtable = &__yo_io_native_vtable }`; `io.spawn`, a sync-context `io.await` and `JoinHandle.await` call the table's `spawn` / `run_until` after the compiler-owned bundle injection (`io_vtable_lowering_code`, `src/codegen/exprs/await.yo`). Inside a task `io.await` stays inline. A program whose types include this `Io` always links the async runtime (`io_native_needs_reactor`).

- Every entry point hands its `io : Io` parameter `__yo_io_native()`, called on the thread that runs the body: the main wrapper (`_main_call_args`) and the `Thread`/pool spawn wrappers (`_closure_runtime_arg_zeroinits`), both through `entry_param_c_value`. Other runtime parameters stay `(T){0}`.
- `__yo_io_native_vtable` is BUILT from the prelude's `IoVTable`: one `__yo_io_vt_<label>` wrapper per field, typed by the field's Yo signature, passing everything after `ctx` to the entry `native_io_entry_c_name` (`src/codegen/async/runtime-core.yo`) maps the label to. Filled by label, so the prelude alone decides fields and order. An unmapped label is an internal compiler error; every mapped entry must exist on every backend (`tests/internal/io-native-runtime.test.yo`). Under chunked emission the table is `extern` in the shared header, defined in chunk 0.
- The executor entries (`__yo_io_spawn_task`, `__yo_io_run_until`, `__yo_io_now_ns`) and `__yo_io_future_completed` (`IoFuture.completed`) are emitted after the backend (`generate_async_runtime_io_entries`). The §3 ABI comment block above `__YO_FUTURE_PREFIX` changes only together with §3 and the async suite.
- In the interface shape, `impl(Io, async : __yo_io_async, …)` binds the builtins as methods that take **no receiver**: the property access types the callee as the builtin's own function type (`_io_builtin_method_type`, `src/evaluator/exprs/property-access.yo`) and the call skips method dispatch (`_io_builtin_method_marker`, `src/evaluator/calls/function.yo`); the receiver only names the `Io` the lowering goes through. The prelude's `Io` is an opaque handle in safe code, like `Allocator` (`parameter_type_contains_raw_ptr`).

## Extern functions and `#include` emission

- The header for a `c_include`d symbol comes from extern-function REGISTRATION during codegen collection, not module evaluation: `FuncMeta` has no `c_include` field; the header lives in an evaluator side table keyed by extern symbol name (`src/evaluator/exprs/c-include.yo`, `get_c_include_for_extern`), looked up by `_register_extern_fn_callee` (`src/codegen/functions/collection.yo`).
- **A `c_include`/extern callee's expr-info VALUE is `Some(UnknownVal)`, not `None`.** Collection logic that dispatches on the callee value treats "present but not a FuncVal" like "no value".
- **A renamed extern-C GLOBAL keeps its C symbol through an ALIAS registry.** `{ stdout : out } :: c_include(...)` records `out → stdout` (`register_extern_c_global_alias`, `src/expr-info.yo`, called from the destructurer when the RHS is a `c_include` module, `is_extern_c_module_id`); `get_variable_name_for_codegen` emits `extern_c_global_c_name(name)` and `_register_extern_global_header` looks the header up by it. A module-qualified read (`c.stdout`) has no variable: the property atom is matched by name + declared type (`is_accessing_property`) in `property-access.yo` (raw C name, no reserved-word prefix) and in the header registration.
- **A `c_include` pointer parameter must match the header's type**; the C compile enforces `-Werror=incompatible-pointer-types` at every optimization level. Yo emits no prototype for a `c_include` function, so the mismatch surfaces at the CALL. Spell a pointer-to-C-struct parameter `*void` (C converts implicitly; the `_localtime64_s` idiom in `std/libc/windows.yo`) or `*Opaque` with `Opaque : c_type("struct name")` (docs/en-US/FFI.md), never a pointer to the buffer's element type.
- **Missing-header failures are MASKED for common headers:** `emit_c_includes` (`src/codegen/c/collection.yo`) always adds `<unistd.h>`/`<sys/stat.h>`/`<sys/random.h>` (POSIX) or `<bcrypt.h>`/`<io.h>`/`<sys/stat.h>` plus `<windows.h>` (Windows), and the sys-runtime templates carry their own includes. Test a new `c_include` binding with a header outside those sets by compiling a user all the way through the C compiler, not `--skip-c-compiler`.
- Platform-unique headers (e.g. `<mach-o/dyld.h>`) go into the target-filter sets in `src/codegen/c/collection.yo` (posix-only / windows-only / macos-only): an include can leak from a comptime-eliminated platform branch, which the collection walk still sees.
