/**
 * async-completion.ts
 *
 * Shared helper for emitting "complete the async Future" boilerplate in C codegen.
 * Used by:
 * - generateAtom (return atom in state machine)
 * - generateReturn (return with/without arg in state machine)
 * - state-machine.ts (normal final-state completion)
 */

import type { Emitter } from "../../emitter";

export interface AsyncCompletionOptions {
  emitter: Emitter;
  indent: string;
  resultCode?: string;
  debugLabel?: string;
}

/**
 * Emits the C code to complete an async Future state machine:
 * 1. Optionally store the result value
 * 2. Set state to COMPLETED (-1) with release semantics
 * 3. Check for and spawn any waiting continuation
 * 4. Release the "running task" reference (decr rc)
 * 5. Return from the resume function
 *
 * @param opts.emitter     The C code emitter
 * @param opts.indent      Current indentation string
 * @param opts.resultCode  If provided, emit `sm->result = <resultCode>;` before completing
 * @param opts.debugLabel  Optional label for ASYNC_DEBUG messages (e.g. function name)
 */
export function emitAsyncFutureCompletion(opts: AsyncCompletionOptions): void {
  const { emitter, indent, resultCode, debugLabel } = opts;

  if (resultCode !== undefined) {
    emitter.emitLine(`${indent}sm->result = ${resultCode};`);
  }

  if (debugLabel) {
    emitter.emitLine(
      `${indent}ASYNC_DEBUG("${debugLabel}: Setting state to COMPLETED\\n");`
    );
  }
  emitter.emitLine(
    `${indent}atomic_store_explicit(&sm->state, -1, memory_order_release);  // -1 = completed`
  );

  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}void (*continuation_fn)(void*) = (void (*)(void*))atomic_load_explicit(&sm->continuation_fn, memory_order_acquire);`
  );
  emitter.emitLine(
    `${indent}void* continuation_sm = atomic_load_explicit(&sm->continuation_sm, memory_order_acquire);`
  );
  emitter.emitLine(``);
  emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
  if (debugLabel) {
    emitter.emitLine(
      `${indent}  ASYNC_DEBUG("${debugLabel}: Spawning continuation: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
    );
  }
  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}  atomic_store_explicit(&sm->continuation_fn, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(
    `${indent}  atomic_store_explicit(&sm->continuation_sm, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
  );
  emitter.emitLine(`${indent}}`);

  emitter.emitLine(``);
  emitter.emitLine(`${indent}__yo_decr_rc((void*)sm);`);
  emitter.emitLine(``);
  emitter.emitLine(`${indent}return;`);
}

/**
 * Emits the C code to mark an async Future state machine as ABORTED (-2):
 * 1. Optionally store the result value (for proper RC cleanup in dispose)
 * 2. Set state to ABORTED (-2) with release semantics
 * 3. Check for and spawn any waiting continuation (so awaiter can detect abort)
 * 4. Release the "running task" reference (decr rc)
 * 5. Return from the resume function
 *
 * This is called when `abort` is used inside an async state machine's effect handler.
 * Any task that `io.await`s this Future will panic.
 */
export function emitAsyncFutureAbortion(opts: AsyncCompletionOptions): void {
  const { emitter, indent, resultCode, debugLabel } = opts;

  if (resultCode !== undefined) {
    emitter.emitLine(`${indent}sm->result = ${resultCode};`);
  }

  if (debugLabel) {
    emitter.emitLine(
      `${indent}ASYNC_DEBUG("${debugLabel}: Setting state to ABORTED (effect handler abort)\\n");`
    );
  }
  emitter.emitLine(
    `${indent}atomic_store_explicit(&sm->state, -2, memory_order_release);  // -2 = aborted`
  );

  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}void (*continuation_fn)(void*) = (void (*)(void*))atomic_load_explicit(&sm->continuation_fn, memory_order_acquire);`
  );
  emitter.emitLine(
    `${indent}void* continuation_sm = atomic_load_explicit(&sm->continuation_sm, memory_order_acquire);`
  );
  emitter.emitLine(``);
  emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
  if (debugLabel) {
    emitter.emitLine(
      `${indent}  ASYNC_DEBUG("${debugLabel}: Spawning continuation for aborted future: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
    );
  }
  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}  atomic_store_explicit(&sm->continuation_fn, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(
    `${indent}  atomic_store_explicit(&sm->continuation_sm, NULL, memory_order_relaxed);`
  );
  emitter.emitLine(``);
  emitter.emitLine(
    `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
  );
  emitter.emitLine(`${indent}}`);

  emitter.emitLine(``);
  emitter.emitLine(`${indent}__yo_decr_rc((void*)sm);`);
  emitter.emitLine(``);
  emitter.emitLine(`${indent}return;`);
}
