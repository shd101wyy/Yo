# An `unwind` inside a closure that returns a `String` drops a temp declared after it and returns the unwind value as the closure's result

**Severity:** S2 — a valid program fails to compile (the C compiler rejects the closure); an unwinding closure argument works only for a closure whose result type happens to accept the unwind value.

**Status:** OPEN — found 2026-10-23 by the adversarial review of `RefCell.replace_with`
(step 0 of `issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`). It is why
`tests/sync/refcell.test.yo` checks an unwinding `replace_with` only with an `i32`
payload. Not fixed there: the fix is in codegen, and that change is std-only.

## Reproducer

`issues/repros/2026-10-23-an-unwind-in-a-closure-returning-a-string-drops-a-temp-declared-after-it.yo`
(seed v0.2.68 and a develop tree binary, `--std-path ./std`):

```yo ignore
apply :: (fn(s : &String, f : &Impl(Fn(v : &String) -> String)) -> String)(f(s));
run_unwind :: (fn(b : &String) -> i32)({
  _s := apply(b, v => {
    if((v.len() > usize(2)), {
      unwind(i32(-1));
    });
    v.clone()
  });
  i32(1)
});
```

```
error: use of undeclared identifier '_file____home_temp_177889496664478908490'
yo: error: compile: C compiler failed (exit 1)
```

Expected: `-1` for `"abc"`, `1` for `"a"`.

The same failure follows with the unwind in one `cond` arm and `v.clone()` in
the other (`v => cond((v.len() > usize(2)) => unwind(i32(-1)), true => v.clone())`),
and through `RefCell(String)`'s `replace_with` and `with`.

## The emitted closure

```c
static inline __yo_t_… closure_…(void* closure_context, __yo_t_… __yo_v_v) {
  size_t _file____home_temp_93578243918390555700 = …len(__yo_v_v);
  if (((_file____home_temp_93578243918390555700) > (2ULL))) {
    __yo_unwind_target = …;
    __yo_effect_escaped = 1;
    // Drop consumed variables (unwind propagation)
if ((_file____home_temp_177889496664478908490) != NULL) { __yo_decr_rc(…); }
    __yo_effect_escaped = 1;
    return -1;
  }
  else {
  }
  __yo_t_… _file____home_temp_177889496664478908490 = …clone(__yo_v_v);
  return _file____home_temp_177889496664478908490;
}
```

Two defects:

1. The unwind-propagation drop list (`src/codegen/exprs/return.yo`, the
   "Drop consumed variables (unwind propagation)" block) keeps the drop of
   the `v.clone()` temp, whose C declaration comes after the escape point.
   In the `cond` form it also drops the uninitialized result slot.
2. The unwind returns its payload (`-1`, typed for `run_unwind`'s `i32`) from
   the closure, whose C return type is the `String` pointer. With an `i32`
   closure result the C happens to type-check, which is why the existing
   `i32` tests pass.

A fix adds the reproducer as a run test and a `String`-payload unwinding
`replace_with` case to `tests/sync/refcell.test.yo`.
