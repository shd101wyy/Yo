/**
 * runtime.ts
 *
 * Generates the async runtime code for single-threaded cooperative scheduling.
 * This implements a simple event loop for async/await concurrency.
 *
 * NOTE: This is for async/await (concurrency on single thread).
 * For spawn (parallelism with multiple threads), see PARALLELISM.md.
 *
 * The runtime is split into modules:
 * - runtime-core.ts: Scheduler, continuation queue, spawn/wait, concurrency helpers
 * - runtime-io-linux.ts: Linux io_uring async I/O operations
 * - runtime-io-macos.ts: macOS Grand Central Dispatch async I/O operations
 * - runtime-io-windows.ts: Windows IOCP-based async I/O operations
 * - runtime-io-common.ts: Cross-platform stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll
 */

import { Emitter } from "../../emitter";
import type { TargetInfo } from "../../target";
import {
  isTargetLinux,
  isTargetMacos,
  isTargetWasm,
  isTargetWindows,
} from "../../target";
import { generateAsyncRuntimeCore } from "./runtime-core";
import { generateAsyncRuntimeIOCommon } from "./runtime-io-common";
import { generateAsyncRuntimeIOLinux } from "./runtime-io-linux";
import { generateAsyncRuntimeIOMacOS } from "./runtime-io-macos";
import { generateAsyncRuntimeIOWindows } from "./runtime-io-windows";

/**
 * Generates the async runtime code with a single-threaded event loop.
 * Async tasks run cooperatively on the same thread - no multi-threading.
 *
 * Only emits the runtime for the compilation target — no platform macros needed.
 */
export function generateAsyncRuntime(
  emitter: Emitter,
  targetInfo: TargetInfo,
  _debugAsyncAwait: boolean
): void {
  generateAsyncRuntimeCore(emitter, targetInfo);

  // Emit only the target platform's async I/O runtime
  if (isTargetLinux(targetInfo)) {
    generateAsyncRuntimeIOLinux(emitter);
  } else if (isTargetMacos(targetInfo)) {
    generateAsyncRuntimeIOMacOS(emitter);
  } else if (isTargetWindows(targetInfo)) {
    generateAsyncRuntimeIOWindows(emitter);
  }
  // wasm32: no async I/O runtime (no io_uring/kqueue/IOCP)

  if (!isTargetWasm(targetInfo)) {
    generateAsyncRuntimeIOCommon(emitter, targetInfo);
  }
}

/**
 * Generates a standalone signal runtime for programs that use signals but not
 * async I/O. When the full async runtime is emitted, signal code is already
 * included via runtime-io-common.ts / runtime-io-windows.ts.
 *
 * POSIX: self-contained (~50 lines, only needs signal.h + errno.h).
 * Windows: requires the full async runtime (signal depends on Windows IO helpers).
 */
export function generateSignalRuntime(
  emitter: Emitter,
  targetInfo: TargetInfo
): void {
  if (isTargetWindows(targetInfo) || isTargetWasm(targetInfo)) {
    // Windows signal code depends on helpers from the full IO runtime.
    // The caller should set usesAsync=true for Windows+signal programs.
    return;
  }

  // POSIX signal runtime (Linux, macOS)
  emitter.emitLine(`
// ============================================================================
// Signal Operations (standalone — no async runtime)
// ============================================================================
#include <signal.h>

static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};

static void __yo_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
    __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  __yo_signal_handlers[signum] = (void (*)(void*))handler;

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = __yo_signal_trampoline;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;

  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_signal_stop(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  __yo_signal_handlers[signum] = NULL;
  __yo_signal_handler_data[signum] = NULL;

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);

  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_kill(int32_t pid, int32_t signum) {
  int result = kill((pid_t)pid, signum);
  return (result < 0) ? -errno : 0;
}
`);
}
