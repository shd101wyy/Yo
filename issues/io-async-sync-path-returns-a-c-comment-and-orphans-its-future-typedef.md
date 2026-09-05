# `io.async`'s sync-future emitter returns a C COMMENT in `return` position and leaves its future struct forward-declared but never defined

**Status:** OPEN
**Severity:** papercut in its observed face — the build fails loudly, but with
seven clang errors that name compiler temporaries instead of the source mistake,
and `yo check` passes first. The underlying marker class is worse than a
papercut: a `/* Error: … */` C comment in STATEMENT position is skipped by the C
compiler, which is the silent-hollowing mechanism `codegen_fatal_expr` exists to
kill. This site only errors because the comment happens to land in `return`
position.
**Found:** 2026-09-04, std-API audit re-measurement, distilling `io.async`
reproducers.

## Symptom

Six lines of Yo produce seven hard C errors and no Yo-level diagnostic:

```rust
{ println } :: import("std/fmt");

noparam :: (fn(io : Io) -> Impl(Future(i32)))(
  io.async({
    w := i32(5);
    w
  })
);

main :: (fn(io : Io) -> unit)({
  v := io.await(noparam(io), io);
  println(v.to_string())
});

export(main);
```

```
$ yo check bareblock.yo
check: bareblock.yo — evaluator OK          # rc=0

$ yo compile bareblock.yo --optimize 2 -o bareblock.out
bareblock.out.c:4053:88: error: incomplete definition of type '_file____priv_temp_9305_sync_fut_t' (aka 'struct _file____priv_temp_9305_sync_fut_t_struct')
 4053 |   int __pre_await_state__file____priv_temp_9308 = __sync_future__file____priv_temp_9308->state;
bareblock.out.c:493:16: note: forward declaration of 'struct _file____priv_temp_9305_sync_fut_t_struct'
  493 | typedef struct _file____priv_temp_9305_sync_fut_t_struct _file____priv_temp_9305_sync_fut_t; // Forward declaration for io.async sync future
… five more "incomplete definition" errors at :4054, :4056, :4059, :4062, :4069 …
bareblock.out.c:4101:3: error: non-void function 'yo_id_7473' should return a value [-Wreturn-mismatch]
 4101 |   return /* Error: no closure FUNCTION for io.async sync path */;
7 errors generated.
yo: error: compile: C compiler failed (exit 1) on bareblock.out.c
```

The emitted function, in full:

```c
static inline _file____priv_temp_9305_sync_fut_t* yo_id_7473(__yo_t10 io) {
  int32_t _file____priv_temp_9304;
  { // begin block
    int32_t w = 5;
    _file____priv_temp_9304 = w;
  } // end begin block
  return /* Error: no closure FUNCTION for io.async sync path */;
}
```

Expected: a Yo diagnostic naming the source mistake and its file:line, the way
every other unreachable-emitter precondition in this compiler now does
(`codegen_fatal`).

## Root cause

Two independent defects in `src/codegen/exprs/async.yo` combine.

**1. The failure return is a C comment, in expression position.** The
sync-future emitter resolves the closure's C function name and capture type and,
when either is missing, `return`s a *string containing a C comment*:

- `src/codegen/exprs/async.yo:2565` — `/* Error: Missing sync future struct name */`
- `src/codegen/exprs/async.yo:2613` — `/* Error: no closure FUNCTION for io.async sync path */`
- `src/codegen/exprs/async.yo:2614` — `/* Error: no CAPTURE type for io.async sync path */`

A C comment in statement position is skipped by the C compiler, which is exactly
the silent-hollowing mechanism `codegen_fatal_expr` was introduced to eliminate —
see the rationale at `src/codegen/constants.yo:218-235`, "A diagnostic the C
compiler can skip is not a diagnostic." Here the comment lands in *value* position
inside `return …;`, so instead of being silently skipped it produces the
`-Wreturn-mismatch` error above. `src/codegen/constants.yo:231` records the
measurement that justified leaving these residual sites alone: "emitting the WHOLE
self-hosted compiler … produces ZERO of these markers". **That measurement is
refuted by the six-line program above** — the compiler's own tree simply never
writes this shape. There are 37 such `String.from("/* Error: …")` returns left in
`src/codegen/` today (`grep -rn 'String.from("/\* Error' src/codegen/ | wc -l`).

**2. The forward typedef is emitted before the emitter can fail.** The
pre-registration pass emits the sync-future typedef unconditionally
(`src/codegen/exprs/async.yo:2365-2369`):

```rust
struct_name := if(has_await_analysis, `${async_block_id}_state_t`, `${async_block_id}_sync_fut_t`);
…
em.emit_declaration_string_line(`typedef struct ${struct_name.clone()}_struct ${struct_name}; // Forward declaration for io.async ${kind_label}`);
```

The struct DEFINITION is emitted further down in the sync-future generator, past
the `return` at `:2613`. When the generator bails, the typedef survives with no
definition, and every `->state` / `->result` / `->__yo_resume_fn` access through
it becomes an "incomplete definition of type" error — six of the seven. Grepping
the emitted file confirms there is exactly one mention of
`_file____priv_temp_9305_sync_fut_t_struct`, the forward declaration at line 493.

**3. Why the existing poison gate does not catch it.** The gate at
`src/codegen/exprs/async.yo:2583-2599` rejects a fully-hollow closure body with a
good diagnostic — but it is reached only through
`match(closure_fn_val, .Some(fv) => …, .None => ())`. When the `io.async`
argument is not a closure at all there is no `FuncVal`, `closure_fn_val` is
`.None`, the gate is a no-op, and control falls through to `:2613`.

## Trigger

`io.async` given an argument that is not a closure — `io.async({ … })` (a bare
block) or `io.async(i32(5))` (any value) produce byte-identical output. The
evaluator accepting those at all is the upstream defect, filed as
`issues/fixed/impl-fn-parameter-accepts-a-non-callable-argument.md` (FIXED
2026-09-05, C67). That makes this path unreachable *from source* — but it stays
reachable from any future
defect that loses the closure's `FuncVal` or capture type, which is precisely the
class this emitter's poison gate exists to catch.

## Fix

1. Replace the three C-comment returns at `src/codegen/exprs/async.yo:2565`,
   `:2613` and `:2614` with `codegen_fatal_expr` calls carrying the async block's
   source location (`ast_expr_token(expr)` is in scope), e.g.
   `codegen_fatal_expr(\`${where}io.async could not resolve its closure's emitted function — the closure argument produced no FuncVal\`)`.
   `codegen_fatal_expr` exists for exactly this (`src/codegen/constants.yo:236`)
   and keeps the caller's `.None => return(…)` shape.
2. Move the `.None` closure-value case into the poison gate at `:2583-2599` so
   the gate's `.None` arm reports "the `io.async` argument is not a closure"
   rather than falling through — one diagnostic, sited where the reader can act.
3. Correct the stale comment at `src/codegen/constants.yo:231`: the
   "zero markers when emitting the whole compiler" measurement is about the
   compiler's own source, not about reachability. Either sweep the remaining 37
   sites to `codegen_fatal_expr` or record why each one is genuinely unreachable.

## Regression test

The CLI corpus is the right home — `tests/cli-cases/` already carries this
family (`await-in-later-cond-branch`, `compile-async-body-type-error`,
`check-wrong-arity-async-body`). Add `tests/cli-cases/io-async-non-closure-arg/`
with `cmd` = `compile main.yo --emit-c --skip-c-compiler --optimize 2`,
`expected_rc` = 1, and a `stdout_keep_match` on the new diagnostic's wording, so
the case asserts THE failure rather than A failure. Verify red-first: today the
case fails with clang errors and rc=1, so the `stdout_keep_match` is what makes
it meaningful.

Add a codegen guard too: a test (or a CI grep) asserting that no emitted C
produced by the suite contains `/* Error:` — the marker class is meant to be
extinct.
