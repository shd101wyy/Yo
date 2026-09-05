# A value-position `cond` with a THROWING arm, after an await in `io.async`, reads an undeclared C temp

**Status: OPEN.** Found 2026-09-05 writing `std/fs/dir.yo`'s `file_type`
(issues/fixed/fs-metadata-restats-by-path-and-walker-drops-dt-unknown.md). Hard
clang error, so it cannot ship silently — but `yo check` is green and the
message names only compiler-generated identifiers.

## Symptom

```rust
_late :: (fn(v : i32, io : Io) -> Impl(Future(i32, Io)))(io.async(io => v));
Kind :: enum(A, B);

_pick :: (fn(bad : i32, io : Io) -> Impl(Future(Kind, IoExn)))(
  io.async(e => {
    result := e.io.await(_late(bad, e.io), e.io);
    k := cond(
      (result < i32(0)) => Kind.A,
      true => Kind.B
    );
    cond(
      (result < i32(0)) => e.exn.throw(dyn(IoError.from_errno(i32(2)))),
      true => k
    )
  })
);
```

```
/tmp/repro_throw.c:5179:35: error: use of undeclared identifier '_file____User_temp_9530'; did you mean '_file____User_temp_9531'?
 5179 |         _file____User_temp_9531 = _file____User_temp_9530;
      |                                   ^~~~~~~~~~~~~~~~~~~~~~~
      |                                   _file____User_temp_9531
/tmp/repro_throw.c:5128:15: note: '_file____User_temp_9531' declared here
 5128 |       __yo_t3 _file____User_temp_9531;
      |               ^
1 error generated.
yo: error: compile: C compiler failed (exit 1) on /tmp/repro_throw.c
```

The emitted C declares the cond's result temp and the THROWING arm's value,
then the non-throwing arm assigns from a temp nobody ever declared:

```c
      __yo_t3 _file____User_temp_9531;          // the cond result
      if (…) {
        …
        __yo_t3 _file____User_temp_9529 = (__yo_t3){0};
        (((void* (*)(__yo_t15))sm->__yo_param_0.exn.throw)(…));
        …escape check…
        _file____User_temp_9531 = _file____User_temp_9529;
      }
      else {
        _file____User_temp_9531 = _file____User_temp_9530;   // ← never declared
      }
```

## Narrowing

- **The await is required.** The identical function with `result := bad;`
  instead of the await compiles and prints `B`.
- **The variable read is required.** `std/fs/file.yo`'s `try_exists` has the
  same await-then-`cond(… , true => e.exn.throw(…))` shape and compiles — its
  non-throwing arms are literals (`true` / `false`). Here the surviving arm's
  value is a read of the local `k`, which needs a temp, and that temp is the
  one never emitted.
- Distinct from `issues/async-cond-value-with-await-arm-inside-while-yields-zero.md`
  (no `while` here, no await inside the cond, and this one is a compile error
  rather than a silent zero).

## Where to look

`src/codegen/exprs/async.yo` / the cond-branch emitters: the arm carrying the
`throw` short-circuits the emission of its SIBLINGS' operand temps (the throw's
own `(__yo_t3){0}` placeholder is emitted, so the machinery ran) while the
merge still writes the assignment that reads them.

## Workaround in std

`file_type` predeclares `(ft : FileType) = FileType.Other;`, fills it in a
statement-form `cond`, throws in a second statement-form `cond`, and ends on
the bare `ft`.
