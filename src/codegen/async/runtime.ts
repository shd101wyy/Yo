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
 * - runtime-io-macos.ts: macOS kqueue async I/O operations
 * - runtime-io-windows.ts: Windows IOCP-based async I/O operations
 * - runtime-io-common.ts: Timer, directory scanning, DNS, process, FS events, poll, tick
 *   (also exports generateSysRuntime for non-async system helpers: stat, signal, TTY, etc.)
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
import { generateAsyncRuntimeIOWasm } from "./runtime-io-wasm";

/**
 * Generates the async runtime code with a single-threaded event loop.
 * Async tasks run cooperatively on the same thread - no multi-threading.
 *
 * Only emits the runtime for the compilation target — no platform macros needed.
 */
export interface AsyncRuntimeOptions {
  needsCycleGC: boolean;
  /** Register a dispose function for type-tag dispatch (!needsCycleGC). */
  registerDisposeTypeId?: (disposeFnName: string) => number;
}

export function generateAsyncRuntime(
  emitter: Emitter,
  targetInfo: TargetInfo,
  _debugAsyncAwait: boolean,
  options: AsyncRuntimeOptions
): void {
  generateAsyncRuntimeCore(emitter, targetInfo);

  // Emit only the target platform's async I/O runtime
  if (isTargetLinux(targetInfo)) {
    generateAsyncRuntimeIOLinux(emitter);
  } else if (isTargetMacos(targetInfo)) {
    generateAsyncRuntimeIOMacOS(emitter);
  } else if (isTargetWindows(targetInfo)) {
    generateAsyncRuntimeIOWindows(emitter);
  } else if (isTargetWasm(targetInfo)) {
    // WASM stubs: immediately-completed IoFutures with -ENOSYS
    generateAsyncRuntimeIOWasm(emitter, targetInfo);
  }

  if (!isTargetWasm(targetInfo)) {
    generateAsyncRuntimeIOCommon(emitter, targetInfo, options);
  }
}
