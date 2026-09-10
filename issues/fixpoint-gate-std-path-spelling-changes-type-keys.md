# The fixpoint gate's verdict depends on the std path SPELLING — mixed YO_STD / --std-path false-fails it

> Found 2026-09-10 while gating the fixed-region allocator PR locally on Windows.

## Symptom

`scripts/bootstrap/fixpoint_only.sh` (and any hand-rolled equivalent) reports
`FIXPOINT_BROKEN` with ~19k diff lines, all of it `__yo_tN` renumbering
churn that starts at ONE type: the prelude enum whose type key embeds the
prelude file path.

Stage-2 C (first divergent type):

```
<enum:enum_decl_34369_C__Users_shd10_Workspace_Yo_std_prelude_yo>
```

Stage-3 C (same enum, different spelling of the SAME file):

```
<enum:enum_decl_34369___std_prelude_yo>
```

One extra interning slot before that block, so every later `__yo_tN` shifts
by one — 19,160 diff lines from a single path spelling.

## Root cause

Type keys (`type_key` / `_intern_type_c_name`'s registry key) embed the module
file path AS RESOLVED. `resolve_std_path()` can hand out different spellings
of the same directory:

- `YO_STD=C:/Users/shd10/Workspace/Yo/std` → the prelude is keyed by its
  absolute path.
- `--std-path ./std` (relative, or the `./std` fallback after a failed
  exe-walk-up) → the prelude is keyed by the relative path.

The gate emits stage-2 C with the stage-1 binary (which resolves std one way)
and stage-3 C with the stage-2 binary (which can resolve std the other way —
e.g. when it lives in `/tmp` and falls back to `./std`). Different spelling →
different type key → different intern order → byte-different C that is still
SEMANTICALLY identical. The compiler is deterministic; the comparison is not.

On the CI runners both stages resolve to the same spelling, so the gate is
green there. On a Windows dev box (and anywhere the two binaries resolve std
differently) the gate false-fails.

## Reproduction (Windows, Git Bash)

```bash
export YO_STD="C:/Users/<you>/Workspace/Yo/std"
YO_MAIN_STACK_MB=4096 <stage1> compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/s2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/s2.c \
  -lws2_32 -lbcrypt -ladvapi32 -lsecur32 -lcrypt32 -o /tmp/s2bin
# stage 3 with a DIFFERENT spelling than stage 2 used:
YO_MAIN_STACK_MB=4096 /tmp/s2bin compile src/main.yo --optimize 2 --emit-c \
  --skip-c-compiler --std-path ./std -o /tmp/s3
cmp /tmp/s2.c /tmp/s3.c   # differs — 19k lines of __yo_tN churn
# with the SAME spelling (drop --std-path, keep YO_STD):
#   cmp → identical, fixpoint holds
```

## Fix direction

`fixpoint_only.sh` should pin std resolution for BOTH stages explicitly —
export the same absolute `YO_STD` (or pass the same `--std-path`) to the
stage-2 and stage-3 compiles — so the gate never compares two spellings.
Longer term, `resolve_std_path` could canonicalize (make absolute + normalize
separators) before the path reaches type keys, making emitted C
spelling-independent; that changes every recorded golden that embeds paths,
so it needs its own PR.
