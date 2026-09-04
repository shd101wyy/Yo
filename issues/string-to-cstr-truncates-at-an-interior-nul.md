# `String.to_cstr` silently truncates at an interior NUL, so fs/env/net calls target something other than what they were given

**Found**: 2026-09-04, during the std-API audit re-measurement of the path row
(the row asks "should `Path.new` be fallible?"; it should not — but chasing the
only genuinely invalid path input landed here). **Status**: OPEN.
**Severity**: api-lie — the API reports one target and operates on another.

## Symptom

A `String` containing an interior NUL converts to a C string that ends at the
NUL. Nothing reports it. Every std entry point that reaches a syscall through
`.to_cstr().ptr().unwrap()` then acts on the truncated prefix while the Yo-side
value still claims the full length:

```rust
{ String } :: import("std/string");
{ Path } :: import("std/path");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
{ Exception, IoExn } :: import("std/error");
fs_file :: import("std/fs/file");

// "/tmp/yo_nul_decoy.txt" + NUL + "/does/not/exist", built byte-wise.
mk :: (fn() -> String)({
  b := ArrayList(u8).new();
  head := String.from("/tmp/yo_nul_decoy.txt").as_bytes();
  i := usize(0);
  while(i < head.len(), i = (i + usize(1)), {
    match(head.get(i), .Some(c) => { _p := b.push(c); }, .None => ());
  });
  _z := b.push(u8(0));
  tail := String.from("/does/not/exist").as_bytes();
  j := usize(0);
  while(j < tail.len(), j = (j + usize(1)), {
    match(tail.get(j), .Some(c) => { _p := b.push(c); }, .None => ());
  });
  String.from_bytes(b)
});

main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (err -> { println(`error: ${err}`); unwind(()); }));
  e := IoExn(io : io, exn : exn);
  s := mk();
  println(`String.len()          = ${s.len()}`);
  cb := s.to_cstr();
  println(`to_cstr().len()       = ${cb.len()}`);
  match(
    String.from_cstr(cb.ptr().unwrap()),
    .Ok(v) => println(`String.from_cstr(to_cstr()) = "${v}"  (len ${v.len()})`),
    .Err(_) => println("from_cstr err")
  );
  p := Path.new(s);
  println(`Path.new(s).to_string() len = ${p.to_string().len()}`);
  println(`fs_file.exists(p)       = ${io.await(fs_file.exists(p, io), io)}`);
  println(`read_to_string(p)       = "${io.await(fs_file.read_to_string(p, io), e)}"`);
});
export(main);
```

With `/tmp/yo_nul_decoy.txt` containing `SECRET-DECOY`, observed
(yo v0.2.24, `YO_STD=./std`, `--optimize 2`):

```
String.len()          = 37
to_cstr().len()       = 38
String.from_cstr(to_cstr()) = "/tmp/yo_nul_decoy.txt"  (len 21)
Path.new(s).to_string() len = 37
fs_file.exists(p)       = true
read_to_string(p)       = "SECRET-DECOY
"
```

Expected: `to_cstr` (or the fs entry point) reports that the string cannot be
represented as a C string, the way Rust's `CString::new` returns `NulError`.
Instead the API asserts a 37-byte path, converts it to a 38-byte buffer whose
useful content is 21 bytes, answers `exists == true` for a path that does not
exist, and returns the contents of a DIFFERENT file. A caller checking
`exists()` before opening gets a consistent — and consistently wrong — story.

## Root cause

`String.to_cstr` copies the bytes and appends a terminator with no interior-NUL
check (`std/string/string.yo:132-151`):

```rust
to_cstr : (fn(self : Self) -> ArrayList(u8))({
  (bytes_len : usize) = match(self._bytes, .Some(b) => b.len(), .None => usize(0));
  bytes_with_null := ArrayList(u8).with_capacity(bytes_len + usize(1));
  match(self._bytes, .Some(b) => match(b.ptr(),
    .Some(src) => bytes_with_null.extend_from_ptr(src, bytes_len), .None => ()), .None => ());
  bytes_with_null.push(u8(0));
  return(bytes_with_null);
}),
```

The returned `ArrayList(u8)` is correct as a byte buffer — `len()` really is 38.
The lie happens one step later, when callers take `.ptr().unwrap()` and hand the
raw pointer to C, where the NUL at index 21 is the end of the string.

`Path` is not implicated: `Path.new` accepts the bytes, stores them, and
`to_string()` faithfully reports 37. `Path.new` should stay infallible (Rust's
`Path::new` is infallible too; the failure belongs at the `CString` boundary,
and `PathError` was deliberately deleted in the audit's round 1-2 sweep).

## Blast radius

`to_cstr()` has 49 call sites in `std/` and the pattern
`X.to_cstr().ptr().unwrap()` is the standard way this tree crosses into C. Every
one is a place where an externally supplied string silently changes meaning:

| module | sites | what gets misdirected |
| --- | --- | --- |
| `std/fs/dir.yo` | 13 | `mkdir`, `rmdir`, `unlink`, `rename`, `symlink`, `readlink`, `read_dir` |
| `std/fs/file.yo` | 7 | `openat` (`:82-84`), `exists` (`:396-397`), `try_exists` (`:420-421`), `set_permissions` (`:440-441`), `is_file` (`:474-475`), `is_dir` (`:502-503`), `canonicalize` (`:531-532`) |
| `std/fs/temp.yo` | 2 | temp-file creation |
| `std/fs/metadata.yo` | 1 | `_stat_path` (`:116-117`) → every `metadata`/`symlink_metadata` |
| `std/fs/watch.yo` | 1 | watch registration |
| `std/env.yo` | 9 | `getenv`/`setenv` NAMES and VALUES (`:44`, `:57-58`, `:93`, `:97`), `current_exe`/`realpath` (`:393`, `:419`, `:429`) |
| `std/process/command.yo` | 6 | the program name and every `argv` entry (`_build_cstr_storage`, `:199`, `:206`), every `envp` entry (`:233`, `:269`) and the child's cwd (`:304`) |
| `std/net/unix.yo` | 2 | AF_UNIX socket paths (`:48`, `:133`) |
| `std/net/tcp.yo`, `std/net/udp.yo`, `std/net/dns.yo` | 3 | IP text and DNS hostnames |
| `std/crypto/tls.yo` | 1 | the SNI host name (`:180`) |
| `std/string/string.yo` | 2 | `atof`'s input span (`:2739-2740`) |
| `std/assert.yo` | 2 | the assertion message handed to `fprintf` (`:22`) |

The `argv`, hostname and SNI cases are the same class of defect as the path one:
a value that came from outside the program decides where it goes, and the
truncation point is chosen by the attacker.

## Fix

Put the check where the truncation happens, not in `Path`:

1. Add `String.to_cstr_checked() -> Result(ArrayList(u8), StringError)` beside
   `to_cstr` in `std/string/string.yo:132`, returning a new
   `StringError.InteriorNul` variant (`StringError` already exists at
   `std/string/string.yo:31-37` with two variants, `InvalidUtf8` and
   `IndexOutOfBounds`, and is what `from_utf8` (`:90`) and `from_cstr` (`:118`)
   already return). It scans for `u8(0)` before copying.
2. Route the syscall-boundary call sites through it. In `std/fs`, `std/net`,
   `std/env` and `std/process`, an `.Err` becomes a thrown
   `IoError.from_errno(i32(EINVAL))` (already imported at `std/fs/file.yo:31`),
   which is what Linux itself returns for a path containing a NUL byte when the
   kernel can see it.
3. Leave `to_cstr` itself in place and unchanged for the callers where a
   truncating conversion is genuinely wanted (there are none today, but changing
   its signature would touch all 49 sites at once). Add a doc-comment on
   `to_cstr` saying, in one line, that it truncates at an interior NUL and that
   `to_cstr_checked` is the one to use at a C boundary.

**Sequencing.** The audit's fs row also proposes an `AsPath` trait collapsing
the 36 `_str`/`_cstr` path-argument variants in `std/fs` behind one generic
entry point. If that lands first, the natural home for this check is a single
`AsPath.as_path_cstr()` — one checked conversion instead of ~14 edited fs call
sites (the `std/env`, `std/net`, `std/process` and `atof` sites still need doing
separately either way). Do this issue AFTER `AsPath` if `AsPath` is scheduled;
do it now if it is not — the current behaviour should not wait on a refactor.

## Regression test

`tests/string/string.test.yo`: `to_cstr_checked` on a string with an interior
NUL returns `.Err(.InteriorNul)`; on a clean string it returns the same bytes
`to_cstr` does, plus the terminator.

`tests/fs/file.test.yo`: RED before the fix — build a `Path` from
`"<a real file>" + NUL + "<garbage>"` (byte-wise, as in the reproducer) and
assert that `File.open`, `fs_file.exists`, `fs_file.read_to_string` and
`metadata` all FAIL rather than silently operating on the real file named by the
prefix. Today `exists` returns `true` and `read_to_string` returns that file's
contents, so the test is a genuine red.

## Breaking change

Yes, in the sense that inputs previously accepted (and silently misdirected) now
throw. That is the point of the change, but it must be called out in the release
notes for the v0.2.x patch that carries it.
