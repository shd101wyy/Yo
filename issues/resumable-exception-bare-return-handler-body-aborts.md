# A `ResumableException` handler written as a BARE `err -> return(v)` fails to transpile and aborts at runtime

**Status:** OPEN
**Found:** 2026-09-05, while building a loop reproducer for
`issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md`. Reproduces
identically on the pre-fix compiler, so it is independent of that fix.
**Severity:** silent miscompile — the program compiles clean and aborts
(SIGABRT, no diagnostic on stderr) the first time the handler runs.

## Symptom

```rust
open(import("std/string"));
open(import("std/fmt"));
open(import("std/error"));

risky :: (fn(exn : ResumableException(i32)) -> i32)(exn.throw(dyn(`boom`)));

main :: (fn(io : Io) -> unit)({
  println(`start`);
  exn := ResumableException(i32)(throw : (err -> return(i32(0))));
  _r := risky(exn);
  println(`one throw done r=${_r}`);
});
export(main);
```

```
$ yo compile g5.yo --std-path ./std --optimize 2 --allocator system -o g5.out
$ ./g5.out
start
$ echo $?
134
```

No message on stdout or stderr beyond `start`.

## Where it goes wrong

The emitted C marks the handler's C function as untranspilable and turns it
into an `abort()` stub:

```c
__attribute__((error("yo: the body of fn_yo_id_10204 failed to transpile — its
  definition-time evaluation failed and was swallowed (run yo check with
  YO_DEBUG_SWALLOW=1); this call would abort at runtime")))
static inline int32_t fn_yo_id_10204(__yo_t14 err);
...
  abort(); /* untranspilable body in a value-returning fn: aborting beats falling off the end (UB) */
```

The `__attribute__((error(...)))` never fires because the call is emitted
through a function POINTER (evidence passing), so nothing is reported at C
compile time either.

## It is specifically the BARE-EXPRESSION body

Wrapping the same `return` in a block compiles and runs correctly:

```rust
exn := ResumableException(i32)(throw : (err -> { return(i32(0)); }));   // works, r=0
exn := ResumableException(i32)(throw : (err -> { println(`caught: ${err}`); return(i32(0)); })); // works
exn := ResumableException(i32)(throw : (err -> return(i32(0))));        // ABORTS
```

`tests/error.test.yo`'s existing `ResumableException` tests all use the block
form, which is why the corpus never caught this.

## Suspected area

`should_defer_body` / the effect-record-member stub gate — see the
"Effect-record handlers whose body uses `return(value)`" section of
`.github/instructions/c-codegen.instructions.md`, which describes the intended
`__yo_effect_escaped = 1; return ZERO;` stub for exactly this shape. A bare
arrow body appears to take the generic "def-time eval swallowed" path instead
of that gate.

## Next steps

1. Re-run with `YO_DEBUG_SWALLOW=1` to get the swallowed def-time error.
2. Either make the bare arrow body reach the same stub gate as the block form,
   or REJECT the shape at check time — silently emitting an `abort()` stub for
   a handler that the user can see is well-formed is the worst outcome.
