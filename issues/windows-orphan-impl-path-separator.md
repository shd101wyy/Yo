# Windows: Orphan impl check fails for std/ modules due to path separator

## Symptom

On Windows, `impl(__YO_THREAD_SYNC_TYPE, Send())` in `std/sync/mutex.yo` throws:

```
Orphan impl: Cannot implement foreign trait "Send" for foreign type "__YO_THREAD_SYNC_TYPE".
Trait defined in: file://D:\a\Yo\Yo\std\prelude.yo
Type defined in: unknown
Current module: file://D:\a\Yo\Yo\std\sync\mutex.yo
```

## Root cause

The orphan rule exemption for std modules used `currentModulePath.includes("std/")`.
On Windows, module paths use backslash separators (`std\sync\mutex.yo`), so
`includes("std/")` returns false. The exemption fails, and the orphan check
rejects the impl because `__YO_THREAD_SYNC_TYPE` is an extern type with no
`definedInModulePath` (always `undefined`).

## Fix

Normalize the module path to forward slashes before checking:

```typescript
const normalizedModulePath = currentModulePath.replace(/\\/g, "/");
if (
  normalizedModulePath.includes("prelude.yo") ||
  normalizedModulePath.includes("std/")
) {
  return;
}
```

## Files changed

- `src/evaluator/values/impl.ts` — `checkOrphanRule()`: normalize path before comparison
