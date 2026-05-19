/**
 * Memory-safety helpers (Phase A → C of plans/MEMORY_SAFETY.md).
 *
 * Provides per-file "unsafe-capable" detection. Initial MVP uses a
 * path-based heuristic: files under `std/` and `yo-self/` are treated
 * as unsafe-capable, bypassing the `unsafe(...)` requirement for
 * pointer ops. Phase C will replace this with explicit per-file
 * `pragma(Pragma.AllowUnsafe);` declarations registered in a per-file
 * privilege table.
 */

/**
 * Is the module path under a directory that is implicitly
 * unsafe-capable?
 *
 * Until the proper pragma mechanism lands (Phase C), every file under
 * `std/` and `yo-self/` is treated as `pragma(Pragma.AllowUnsafe);`.
 * Pointer deref, arithmetic, and consume-of-deref are permitted in
 * those files without an explicit `unsafe(...)` wrap.
 *
 * User code (any file outside those directories) must wrap pointer
 * operations in `unsafe(...)`.
 */
export function isImplicitlyUnsafeCapableFile(
  modulePath: string | undefined
): boolean {
  if (!modulePath) return false;
  // Normalize: strip file:// prefix if present.
  let path = modulePath;
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
  }
  // Match anything under std/, yo-self/, or tests/.
  // Examples:
  //   /Users/.../Yo/std/prelude.yo
  //   /Users/.../Yo/std/collections/array_list.yo
  //   /Users/.../Yo/yo-self/lexer.yo
  //   /Users/.../Yo/tests/ptr.test.yo
  // We match by directory-substring rather than by absolute prefix so
  // this still works for relocated checkouts.
  //
  // `tests/` is included so existing pointer-exercising tests work
  // without modification; once Phase C lands they should be updated
  // to declare `pragma(Pragma.AllowUnsafe);` explicitly.
  return /\/(std|yo-self|tests)\//.test(path);
}
