# A closure outside std and src cannot capture a reference parameter

**Severity:** S3. Outside `std/` and `src/`, a closure (an `io.async` body included) has no way to capture a `p : &T` parameter of a move-only `T`, so a future cannot borrow its caller's argument. Every spelling is rejected. The workaround is to give the future an owned copy (`owned := p.clone();`, then capture `owned`), which costs a deep copy and needs `T : Clone`.

**Status:** open. **Found:** 2026-11-05, migrating `std/path`'s `Path` from `ref` to a value (V5 part B, `vbd/v5-part-b-std`): `tests/fs/fs_convenience.test.yo`'s `read_link_probe`/`try_exists_probe` stopped checking. Develop `ac14b5d50`.

## Reproducer

```yo
{ String } :: import("std/string");
P :: struct(s : String);
probe :: (fn(p : &P, io : Io) -> Impl(Future(usize, Io)))(
  io.async({ &p }(io : Io) => p.s.len())
);
main :: (fn(io : Io) -> unit)({
  x := P(s : `abc`);
  _n := io.await(probe(&x, io), io);
});
export(main);
```

| Capture | Verdict |
| --- | --- |
| `{ &p }` | E0926 "`p` is a reference (`&P`): borrowing the value it refers to is spelled `&p.*`" |
| `{ &p.* }` | E0007: a capture list entry is a name, so the brace is parsed as a struct literal |
| `{ p }` | E0926 "reading the value it refers to is spelled `p.*`" |
| none (implicit) | E0901 "the closure captures `p`, whose type `P` is move-only, so the capture moves it" |

In `std/` and `src/` the N1e-1 deref rule does not apply, so `{ &p }` checks there (`src/lock_file.yo`'s `save_lock_file` captures `{ &project_dir, &lock }`).

## Expected

One spelling should capture the reference itself, so the future borrows the caller's value. Either the capture list accepts `&p` for a reference binding (the entry names the binding, not a value read), or an implicit capture of a reference parameter copies the reference rather than moving the referent.

## Notes

The E0926 help names a spelling the capture-list grammar cannot express. Before V5 part B, `Path` was a `ref` handle, and an implicit capture copied the handle, which hid the gap.
