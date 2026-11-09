# A raw pointer bound into a statement temporary dangles once the temporary dies at the statement's end

**Severity:** S1: every compiler invocation without `--std-path`/`YO_STD` reads freed memory in
`current_exe`'s `readlink` walk-up; mimalloc hides it, ASan and glibc crash on it. Production
binaries built from a tree after #1814 are affected.

**Status:** FIXED by #1818 (the nine sites bind the `CString` first; `tests/env.test.yo` "current_exe returns an absolute path to an existing executable" dies in `readlink` under the sanitizer legs if the pattern returns). Re-verified 2026-11-10: no `:= .*to_cstr().ptr()` binding remains in `std/` or `src/`.

> Found 2026-11-07 by the part B leak lane's probes (its ASan probe, built by a develop-tip
> `6b1147192` compiler, died at startup with heap-use-after-free in `readlink`); the lane's
> root-cause read of #1814's statement-end temporary drop named the mechanism. Filed and fixed
> by the coordinator session.

## Reproducer

```yo ignore
{ current_exe } :: import("std/env");
main :: (fn() -> unit)({
  // std/env.yo's own shape, before the fix:
  //   link_cstr := String.from("/proc/self/exe").to_cstr().ptr().unwrap();
  //   unsafe(readlink((*char)(link_cstr), ...))   // next statement: freed
  _p := current_exe();
  ()
});
export(main);
```

`String.from(...).to_cstr()` is a temporary; since #1814 (a borrowed temporary is dropped at its
statement's end, Rust's temporary lifetime) the `CString` dies when the statement ends — but the
binding holds the raw pointer taken from it, and the NEXT statement passes that pointer to C.

This is Rust's documented `CString::new(..).as_ptr()` footgun verbatim: #1814 gave Yo Rust's
temporary lifetime, and this pattern is the canonical dangling-pointer trap under that model.
Rust's answer is the same one applied here — bind the `CString`, then take `.ptr()` — plus a
Clippy lint (`temporary_cstring_as_ptr`).

## The nine sites (`grep ':= .*to_cstr().ptr()'`)

- `std/env.yo:435` — `current_exe`, reached from `resolve_std_path`'s exe walk-up on EVERY
  invocation without `--std-path`/`YO_STD` (the production path);
- `std/log.yo:213` — `init_from_env`'s `getenv("YO_LOG")`;
- `src/module_manager.yo:247` — `getenv("YO_STD")`;
- `src/manifest.yo:60`, `:84` — `stat`/`open` on a manifest path;
- `src/verifier/z3.yo:128`, `:166`, `:167`, `:189` — the Z3 harness's open/fopen("w")/unlink.

`std/env.yo:121`'s inline `String.from("").to_cstr().ptr().unwrap()` inside the `_putenv_s`
argument list is NOT affected: the temporary is used within its own statement, which #1814 keeps
alive. Only bindings that carry the pointer past the statement dangle.

## Fix

Bind the `CString` to a local first, then take `.ptr()` from it — the nine sites above, nothing
else (the pointer variable names are unchanged). The local then owns the `CString` for its scope.

A compile-time lint ("a raw pointer bound into a temporary outlives the statement's temporary")
belongs to the borrow-checker completeness work (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`
O-1's `origin_of` makes the temp's origin computable); it is recorded there, not built here.
