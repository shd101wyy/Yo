# yo-self stage-2: errno error-enum never collected — 416 clang errors (typedef/dyn-box/temp-decl cascade)

## Status

OPEN. Introduced by the assert/panic refactor family (`7122740e9`..`4355dd1dd`);
NOT by the RC-protocol fix `97e51f176` (bisect: the binary built at `4355dd1dd`
emits the same errors — 417 vs 416, same class). The last clean stage-2
(0 errors, deterministic) was at the handoff `dddcbbbc5`. The true baseline is
unreproducible with the current toolchain (old yo-self sources call the old
builtin `panic`, which the renamed TS compiler no longer recognizes), so the
attribution is to the family as a unit.

## Symptom

```
./yo-cli compile yo-self/main.yo -o /tmp/s1                       # stage-1
YO_MAIN_STACK_MB=16384 /tmp/s1 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I.
# 416 errors (was 0 at dddcbbbc5)
```

Error families (all cascade from ONE missing type):

- `unknown type name '__yo_t782'` — the typedef for t782 is nowhere in the
  file, while forward decls / signatures / a dyn box reference it.
- `use of undeclared identifier '__yo_dyn_box___yo_t782'` — its dyn(Error)
  box struct is used (`__yo_new___yo_dyn_box___yo_t782`,
  `__yo_dispose___yo_dyn_box___yo_t782`) but the box struct was not declared.
- `use of undeclared identifier '_file____User_temp_5487'` (34×, plus
  singletons) — `__yo_t782 _file____User_temp_5487;` declarations in other
  functions were elided (declaration emission presumably failed on the
  unregistered type) while the temps' uses survived.

## What t782 is

An errno-mapping ERROR ENUM: `yo_id_6236(int32_t __yo_c_reserved_errno) ->
__yo_t782` with variants like `__YO_T782_NOTFOUND` (`(errno) == (ENOENT)`
mapping), and it gets dyn-boxed (`dyn(Error)`), i.e. the std/sys or std/fs
errno→Error conversion enum. The stage-2 emit's type-collection pass misses
it; everything referencing it then breaks.

## Suspected mechanism

The assert/panic refactor changed how error paths evaluate:

- `__yo_panic` value-position arms now adopt the sibling arm's expected type
  (evaluate_panic), and std/assert's `panic` pulls `ToString`/`to_c_str`/dyn
  machinery into scope in 20+ yo-self modules;
- the errno enum's instantiation may now be minted via a path whose type id /
  type_key never reaches `collect_type` (the classic collected-vs-referenced
  identity mismatch — same family as the stage-2 endgame's
  resolved_concrete/type_key bugs).

## Repro / debug entry

1. Emit stage-2 (commands above); grep `__yo_t782` — first use at a fn
   signature (`yo_id_6236`), no typedef anywhere.
2. Find the Yo-source enum: grep std for the ENOENT→NotFound mapping
   (`errno`-to-error fn). Trace why `collect_type` never sees the enum's
   type id while `get_type_string` had a registered C name for it
   (two tables: `get_type_c_name` HAS it, the emitted-typedef set does NOT —
   the c-name was minted during function emission AFTER the types section
   was finalized).
3. Candidate fix direction: any `get_type_string` minting during
   function-body emission must either be preceded by collection
   (collect_type at the same site) or the types section must be emitted
   LAST (TS emits type decls from the collected set before functions —
   check where the yo-self pipeline diverges for this enum).

## Validation gates once fixed

- stage-2 clang errors 0, deterministic (emit twice, byte-identical);
- corpus diff-test 107/107 DIFF 0;
- `check ./std` 153/153, `check ./yo-self` 303/303;
- then resume the handoff plan (stage-2 binary runtime → fixpoint → #69/#70).
