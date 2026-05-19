/**
 * Memory-safety helpers (Phase C of plans/MEMORY_SAFETY.md).
 *
 * Per-file privilege tracking via `pragma(Pragma.AllowUnsafe);`. When
 * the `pragma` builtin is evaluated, it records the file's URI in the
 * `privilegedFiles` registry. The pointer-op gates then look up the
 * current expression's source file in this registry — files that
 * declared the pragma bypass the unsafe-wrap requirement.
 *
 * This replaces the Phase A MVP path-based heuristic. The only
 * remaining bypass is `auto-generated://...` URIs (macro/derive
 * expansions), which inherit the surrounding file's privilege via
 * the expansion site.
 */

/** Pragma flags a file can declare. */
export type PragmaKind = "AllowUnsafe";

/**
 * Per-file pragma registry. Keyed by canonical module URI (the
 * value of `token.modulePath`, e.g. `file:///path/to/foo.yo`).
 */
const privilegedFiles: Map<string, Set<PragmaKind>> = new Map();

/** Record that `modulePath` declared `pragma(Pragma.X);`. */
export function registerFilePragma(modulePath: string, kind: PragmaKind): void {
  let set = privilegedFiles.get(modulePath);
  if (!set) {
    set = new Set();
    privilegedFiles.set(modulePath, set);
  }
  set.add(kind);
}

/** Has `modulePath` declared a given pragma? */
export function fileHasPragma(
  modulePath: string | undefined,
  kind: PragmaKind
): boolean {
  if (!modulePath) return false;
  const set = privilegedFiles.get(modulePath);
  return !!set && set.has(kind);
}

/** Reset the registry. Used by tests and the LSP between sessions. */
export function _clearPragmaRegistry(): void {
  privilegedFiles.clear();
}

/**
 * Is the module path implicitly unsafe-capable for pointer ops?
 *
 * Returns true if:
 * - The file declared `pragma(Pragma.AllowUnsafe);` at the top, OR
 * - The expression came from compiler-synthesized code (macros,
 *   derive expansions) whose URI is `auto-generated://...`. These
 *   originate from a privileged caller; the wrap policy of the
 *   expanded code is the caller's responsibility.
 *
 * User code that hasn't declared the pragma must wrap pointer
 * operations in `unsafe(...)` explicitly.
 */
export function isImplicitlyUnsafeCapableFile(
  modulePath: string | undefined
): boolean {
  if (!modulePath) return false;
  if (modulePath.startsWith("auto-generated://")) return true;
  return fileHasPragma(modulePath, "AllowUnsafe");
}
