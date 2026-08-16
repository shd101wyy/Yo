# A comptime-only return type emits `// Unknown type:` as the return type, and GCC rejects the file

**Status: FIXED by PR #130 (233b774dd), verified 2026-08-17.** The
`_func_result_is_comptime_only` skip was ported to the TS declaration
emitter and the fallback hardened; a fresh emit of `yo-self/main.yo` now has
ZERO `static inline // Unknown type` prototypes (was 2), and both GCC-family
consumers are green — the portable-c job AND the musl bundle (whose
`duplicate 'static'` failures were this same bug: Alpine's `cc` is GCC; the
v0.2.7 release run 31925643271 passed both, and #130 is the only substantive
commit between the last red release run 31909103188 and that green).

Not a regression — this has been latent for a long time. It is invisible under
clang and fatal under GCC, and the portable-`yo.c` job is the first thing in the
pipeline that ever runs real GNU GCC over generated C.

## Symptom

```
yo.c:5593783: error: duplicate ‘static’
5593783 | static inline // Unknown type: ComptimeList(Expr) fn_yocd6da6f3_id_19331_cdr_specialized_T_Expr_Self_ComptimeList_u40_Expr_u41__(
##[error]assembled yo.c does not even parse on linux-x64
```

## Mechanism

`getTypeString` (`src/codegen/utils/index.ts:840`) ends with

```ts
return `// Unknown type: ${typeToString(type)}`; // fallback
```

a **line** comment, returned where a C **type** is expected. The declaration
emitter drops it into the return-type slot, so the `//` swallows the rest of
that line and the declaration continues onto the next one:

```c
static inline // Unknown type: Expr           fn_..._car_...();   // line eaten
static inline // Unknown type: ComptimeList(Expr) fn_..._cdr_...();   // line eaten
static inline __yo_str fn_..._int_suffix(...);                       // survives
```

After preprocessing that is a single declaration reading
`static inline static inline static inline __yo_str fn_..._int_suffix(...);`.

- **clang accepts it** (duplicate storage-class specifiers, silent under `-w`),
  so every bundle build has always passed. The two comptime prototypes are
  simply lost, which is harmless — nothing calls them at runtime.
- **GCC rejects it**: `duplicate ‘static’`.

Verified locally: the preprocessed output really is the merged declaration, and
`clang -std=c11 -fsyntax-only` returns 0 on a reduced case. (macOS `gcc` is a
clang shim — `gcc --version` reports clang 21 — so GCC itself cannot be
reproduced on this box; the CI log is the evidence.)

## Severity beyond the release

`--cc gcc` is an advertised choice in the CLI. So **any user compiling with GCC
hits this** whenever the program emits a prototype for a function whose return
type has no C representation. That is a supported-configuration bug, not just a
release-pipeline one.

## The types involved

`ComptimeList(Expr)`'s `car` / `cdr` specializations. Their return types
(`Expr`, `ComptimeList(Expr)`) are comptime-only — there is no C representation
by design, and the functions are never called at runtime.

## Fix: yo-self already does this; TS does not

Reverse parity — the self-hosted compiler has the guard and the TypeScript one
is missing it. `yo-self/codegen/functions/declarations.yo:511` includes

```
_func_result_is_comptime_only(function_type)
```

in its `skip1` condition, and `:513-515` documents the same failure mode in
another guise:

> Array with an UNRESOLVED length variable (`Array(i32, n)`) has no C rendering
> (`// Unknown type:` ate the prototype line — array.test batch clang errors);
> treat it as a generic return like a SomeT one.

`src/codegen/functions/declarations.ts:185-199` skips on
`isComptimeFunction(value)` — a property of the function VALUE — but never
checks whether the RESULT TYPE is comptime-only, which is the case here.

So: port `_func_result_is_comptime_only` to the TS skip.

Do it as well as, not instead of, hardening the fallback: returning a line
comment from a function whose contract is "give me a C type" can only ever
produce broken C. A block comment (`/* Unknown type: … */`) at least cannot eat
the following declarations. Note a block comment alone is NOT sufficient — it
leaves `static inline fn_x();`, an implicit-int declaration that is invalid C99+
— which is why the skip is the actual fix.

## Verify

Locally, without GCC:

```
node --expose-gc --max-old-space-size=4096 ./out/cjs/yo-cli.cjs \
  compile yo-self/main.yo --skip-c-compiler -o /tmp/gate
grep -c "static inline // Unknown type" /tmp/gate.c    # must be 0; is 2 today
```

`grep -c "Unknown type" /tmp/gate.c` is 7 today: 2 are the broken prototypes
above, 2 are inside `__yo_str` literals (yo-self's own source text, harmless),
and 3 are in already-commented positions.

In CI, the real gate is the `portable-c` job's
`gcc -std=c11 -fsyntax-only -w yo.c`.

## Note on where the arms come from

The portable-`yo.c` arms are emitted by the **TypeScript** compiler
(`release.yml`'s "Emit this platform's arm of the portable yo.c" step runs
`node ./out/cjs/yo-cli.cjs … --emit-c-to`), NOT by the seed. So a fix in `src/`
does take effect on the very next release — unlike a seed-side bug, which
cannot be fixed retroactively.
