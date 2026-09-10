# Module-prefix stutter: what is left after the encoding sweep

**Status:** BACKLOG (written 2026-09-11, alongside the landed encoding sweep).
The `std/encoding` half of D2's "module-prefix stutter ×7" row landed on
2026-09-11 — see the §4 Encoding record in
[`../STD_API_STABILIZATION.md`](../STD_API_STABILIZATION.md). This doc is the
measured remainder: every other std module whose exported names repeat the
module name, plus the one member of the original ×7 that could not be renamed
and why.

## The rule being applied

A module is imported as a module (`json :: import("std/encoding/json")`) and
its functions are reached through it (`json.parse(...)`), the way this tree
already reads `std/sys/events` (`events.fs_event_stop(...)`) and the way Rust
reads `serde_json::from_str`. A name that repeats the module says the same word
twice at every call site: `json.json_parse`, `hex.hex_encode`.

The counter-rule is just as real: a name is only stuttering if the module is
the natural qualifier. `std/assert`'s `assert_eq` is imported destructured
(`{ assert, assert_eq }`) by every test file in the tree — nobody writes
`assert.eq` — and `std/sys/clock`'s `clock_gettime` is a C binding whose whole
value is that it is spelled exactly as `clock_gettime(2)` is. So this is not a
mechanical sweep; each row below needs the call-site question asked.

## Blocked: `glob_match` (the 7th member of the D2 row)

`std/glob.yo` exports `glob_match(pattern, text)`. Two things stop the obvious
rename:

1. **`glob.match` is unspellable.** `match` is a Yo keyword — `match(...)` is
   the match expression — so `glob.match(pat, s)` cannot parse. The Rust name
   for this is `Pattern::matches`, which would make it `glob.matches(...)`;
   that is a defensible name but it is a *different* name, not the prefix
   removed, and `GlobPattern.matches` already exists as a method one screen
   below it. Two `matches` in one module is a decision, not a cleanup.
2. **The module binding `glob` is already taken in the one std caller.**
   `std/fs/walker.yo` both calls `glob_match` (line ~125, inside a `cond` arm
   of the walker) and *itself exports a function called `glob`* (line ~299, the
   filesystem expansion added 2026-09-09). So `glob :: import("../glob")` in
   that file collides head-on, and the fix would be either a non-obvious module
   alias or a destructured `{ matches } :: import("../glob")` whose call site
   (`matches(pat.clone(), rel)`) reads worse than what it replaced.

**Recommendation:** decide the name first (`glob.matches` vs leaving
`glob_match` as the blessed spelling for a free function), and if it is
`matches`, do it in the same PR that decides what `std/fs`'s `glob()` is
called, since those two names are the actual conflict. ~50 of the call sites
are in `tests/glob/glob.test.yo`, so it is a cheap change once the name is
settled.

## Measured remainder (exported names repeating their module, 2026-09-11)

Scan: for every `std/**/*.yo`, the names in its `export(...)` lists that start
with the module's file name or its directory name.

| module | exported names | call-site verdict |
| --- | --- | --- |
| `std/glob.yo` | `glob_match` | **blocked above** |
| `std/crypto/random.yo` | `random_bytes`, `random_u32`, `random_u64`, `random_f64`, `random_range` | **clean** — no bare `random` export; `random.bytes()`, `random.u32()` |
| `std/rand.yo` | `rand_u32`, `rand_u64`, `rand_f64`, `rand_bool`, `rand_below`, `rand_range`, `rand_range_inclusive` | **clean** — no bare `rand` export; `rand.u64()`, `rand.range(..)` |
| `std/hash.yo` | `hash_one`, `hash_one_with_keys` | **clean** — no bare `hash` export; `hash.one(v)` |
| `std/sys/tty.yo` | `tty_init`, `tty_set_mode`, `tty_reset`, `tty_winsize` | **clean** — `tty.init()`, `tty.winsize()` |
| `std/sys/file.yo` | `file_size` | **clean** — no bare `file` export; `file.size(...)` |
| `std/crypto/tls.yo` | `tls_available` | **clean** — `tls.available()` |
| `std/regex/unicode.yo` | `unicode_property_ranges` | **clean** but internal-ish; `unicode.property_ranges` |
| `std/crypto/hmac.yo` | `hmac_sha1{,_hex}`, `hmac_sha256{,_hex}`, `hmac_sha512{,_hex}` | **family collision** — the module also exports `hmac`, so it cannot be imported as `hmac` |
| `std/crypto/sha256.yo` | `sha256_hex` | **family collision** — also exports `sha256` |
| `std/crypto/sha1.yo`, `sha512.yo`, `md5.yo` | `sha1_hex`, `sha512_hex`, `md5_hex` | **family collision** — each also exports its bare digest fn |
| `std/fs/metadata.yo` | `metadata_str`, `metadata_fd` | **family collision** — also exports `metadata` |
| `std/log.yo` | `log_target`, `log_lazy` | **family collision** — also exports `log`, and `log :: import("std/log")` is already the idiom in callers |
| `std/time/sleep.yo` | `sleep_blocking` | **leave** — also exports `sleep`, and the long name is the deliberately-scary one (PR #326) |
| `std/testing/bench.yo` | `bench_auto` | **family collision** — also exports `bench` |
| `std/assert.yo` | `assert_eq`, `assert_ne`, `assert_approx` | **leave** — destructured by every test file; `assert.eq` would fight `assert(...)` itself |
| `std/error.yo` | `error_is` | **leave** — `std/error` is destructured everywhere (`{ Error, AnyError, Exception }`); low value |
| `std/sys/clock.yo` | `clock_gettime` | **leave** — C binding, spelled as the syscall |
| `std/sys/statfs.yo` | `statfs_buf_size`, `statfs_type`, `statfs_bsize`, `statfs_blocks`, `statfs_bfree`, `statfs_bavail`, `statfs_files`, `statfs_ffree` | **leave** — field accessors over a C struct, named after its members (and the module exports `statfs` too) |

The recurring blocker worth naming once: **a module that exports both a
`<name>` function and `<name>_<suffix>` functions cannot be imported under
`<name>`** — `hmac`, `sha1`, `sha256`, `sha512`, `md5`, `metadata`, `log`,
`sleep`, `statfs`, `bench`, and `glob` via its caller. Those need the whole
family renamed in one decision, not a prefix strip.

## Suggested phasing

1. The clean, collision-free rows in one PR each: `crypto/random`, `rand`,
   `hash`, `sys/tty`, `sys/file`, `crypto/tls`. Same mechanism as the encoding sweep — real name short, old name
   a deprecated alias for one release, every in-tree call site and every
   `test("...")` name moved, full suite as the gate.
2. The `<name>` + `<name>_<suffix>` families (`crypto/hmac`, `crypto/sha*`,
   `crypto/md5`, `fs/metadata`, `log`, `time/sleep`, `testing/bench`, `glob` +
   `fs.glob`) only after their naming decision is written down here.
3. The `leave` rows need no work; they are recorded so the next scan does not
   re-open them.
