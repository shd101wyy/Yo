# A borrowing future that stores a reference parameter into a sibling parameter is an internal compiler error

**Severity:** S2. A valid program does not compile: the compiler stops with an internal error, E1301. Nothing is miscompiled.

> Found 2026-11-05 while merging develop into `vbd/d43-n3-future` (decision 43 step 4, N3-1). Develop's R2 (#1785) passes a `&T` parameter by pointer when a sibling parameter's value type carries an origin. The probe for that rule beside the borrowing-future ABI hit this error. It reproduces on the N3 branch before the merge too, so the merge did not cause it.

## Reproducer

`issues/repros/2026-11-05-borrowing-future-storing-a-reference-into-a-sibling-parameter-ice.yo`: `_store_after(generic(p : Origin), dst : &mut Option(&(i32, p)), v : &(i32, p), io)` returns an `io.async` whose capture list borrows both parameters, and whose body stores `&v.*` into `dst.*`.

```
error[E1301]: internal compiler error: the capture struct type of an async block is not registered, so its captures cannot be released
```

| Compiler | Result |
| --- | --- |
| develop 6ca498191 | E0909: the future borrows its captures, so it cannot be returned (the program was rejected before N3) |
| N3 branch b8b513edb, and the branch merged with develop | E1301 |

Related forms that compile and run clean under ASan with `detect_stack_use_after_return=1`:
- the same function shape reading `v.*` with no `dst`;
- the non-generic `&i32` version;
- a forwarded future (`_fwd` returning `_bump(&mut c.*, &d.*, io)`).

So the trigger is the combination: an origin-generic future, a `&mut` capture of an origin-carrying parameter, and the store.

## Root cause

Not yet diagnosed. E1301 is raised where codegen releases an async block's captures and finds no registered capture struct type. For an origin-generic function whose body is deferred to call time, the capture struct is probably registered under a key that the release path does not look up.
