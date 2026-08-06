# yo-self: sizeof(recursive enum) folds to 0 in specialized generic bodies — heap corruption

**Status: FIXED** (this commit). Flips `tests/recursive_enum.test.yo` (3/4 → 4/4)
and `tests/encoding/json.test.yo` (24/35 → see commit gates) — both crashed the
same way.

## Symptom

Any `ArrayList(T)` where T is a **recursive enum** (`Box(Self)` /
`ArrayList(Self)` variants — e.g. `JsonValue`, the AST-style `MyExpr`)
corrupts the heap on push in the s1-compiled binary:

```c
size_t _t = ((0ULL) * (new_capacity));   // sizeof(T) folded to 0 !!
_p = __yo_realloc(old, _t);              // 0-byte buffer
...
target_ptr->... = value;                 // writes a full 24-byte enum into it
```

TS emits `24ULL * new_capacity`. The corruption surfaces as SIGTRAP/SIGSEGV in
a LATER malloc (lldb bt = `mfm_alloc`), which made it look like an RC bug.
`json_parse("[1]")` survives by luck; `"[1, 2]"` crashes.

## Root

`get_size_of_type` (yo-self/types/utils.yo) walked a recursive-`Self` SHELL:
under yo-self's value semantics the recursive reference inside the enum's own
type graph is a value-copied shell with EMPTY variant fields — and the empty
aggregate math computes to exactly 0 bits (`round_up(0, 32) = 0`). TS never
sees a shell here because its type objects are shared by identity
(`getSizeOfType` always receives the completed enum).

The 0 only appears when `sizeof(T)` is evaluated inside a SPECIALIZED generic
body (ArrayList.push's grow) whose `T` binding captured the shell copy; a
direct `sizeof(MyExpr)` at the use site sees the resolved final (24) — which
also masks the bug if it runs first (CTFE cache priming; the corpus guard
deliberately avoids it).

## Fix

Resolve shells to their registered finals at the entry of BOTH
`get_size_of_type` and `get_alignment_of_type` via
`resolve_enum_shell(resolve_struct_shell(ty))` — the same convention
`types/type_key.yo` already uses. Recursion terminates because the resolved
enum's recursive fields are behind `Box`/`ArrayList` (reference structs →
pointer-sized, no descent); non-shell empties pass through unchanged.

This is the FOURTH consumption site needing shell resolution (after the two
eval-match/type-emission sites and type_key) — **any reader of a
struct/enum's fields must expect a shell** under yo-self value semantics.

## Guard

`tests/codegen-bootstrap/recursive_enum_arraylist_sizeof.yo` — pre-fix
rc=137 (heap corruption kill), post-fix `v=37` (matches TS). Note: the guard
must NOT call `sizeof(MyExpr)` directly before the pushes (cache priming
masks the bug).
