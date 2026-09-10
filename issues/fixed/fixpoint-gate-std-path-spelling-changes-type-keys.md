# The fixpoint gate's verdict depended on the std path SPELLING — mixed YO_STD / --std-path false-failed it

> Found 2026-09-10 while gating the fixed-region allocator PR locally on
> Windows. **FIXED same day** by canonicalizing `resolve_std_path` (plus an
> explicit `--std-path ./std` pin in `scripts/bootstrap/fixpoint_only.sh`).

## Symptom

`scripts/bootstrap/fixpoint_only.sh` (and any hand-rolled equivalent) reported
`FIXPOINT_BROKEN` with ~19k diff lines, all of it `__yo_tN` renumbering
churn that started at ONE type: the prelude enum whose type key embeds the
prelude file path.

Stage-2 C (first divergent type):

```
<enum:enum_decl_34369_C__Users_shd10_Workspace_Yo_std_prelude_yo>
```

Stage-3 C (same enum, different spelling of the SAME file):

```
<enum:enum_decl_34369___std_prelude_yo>
```

One extra interning slot before that block, so every later `__yo_tN` shifted
by one — 19,160 diff lines from a single path spelling.

## Root cause

Type keys (`type_key` / `_intern_type_c_name`'s registry key) embed the module
file path AS RESOLVED, and `resolve_std_path()` returned the raw spelling from
whichever route won:

- `YO_STD=C:/Users/.../std` → the prelude keyed by its absolute path.
- `--std-path ./std` (or the `./std` cwd fallback after a failed exe-walk-up)
  → the prelude keyed by the relative path.

The gate emits stage-2 C with the stage-1 binary (which resolves std one way)
and stage-3 C with the stage-2 binary (which can resolve it the other way —
e.g. when it lives in `/tmp` and falls back to `./std`). Different spelling →
different type key → different intern order → byte-different C that is still
semantically identical. The compiler was deterministic; the comparison wasn't.

On the CI runners both stages of each job resolved the same way, so CI was
green. On a Windows dev box the routes genuinely differ and the gate
false-failed. (A related but distinct fact discovered while chasing this:
the INPUT file spelling — `src/main.yo` vs an absolute path — ALSO changes
emitted C, deterministically. That one is consistent by construction within
every gate and golden and is deliberately left alone.)

## Fix (two layers)

1. `src/module_manager.yo`: `resolve_std_path` now canonicalizes every branch
   through `_std_canonicalize` — absolute (against the cwd when relative),
   separators normalized, `.`/`..` folded LEXICALLY (no symlink resolution;
   the loader is sync). Every route to one directory now yields one string,
   so type keys and mangled C names are spelling-independent.
2. `scripts/bootstrap/fixpoint_only.sh`: both stages pass an explicit
   `--std-path ./std`, keeping the gate self-describing and independent of
   the resolution routes even on older compilers.

## Verification

With the fixed compiler, `compile --emit-c` of the same program under all
three spellings — `--std-path <absolute>`, `--std-path ./std`, and the
cwd fallback — produces byte-identical C (the issue's reproduction now
passes). Goldens are unaffected: the cli-case harness already injects an
absolute `YO_STD`, and every recorded golden shows the `<REPO>/std/...`
form.
