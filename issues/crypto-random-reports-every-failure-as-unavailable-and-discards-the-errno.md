# `std/crypto/random` reports every failure as `Unavailable` and throws away the real errno — `CryptoError.Other` has no producer

**Found**: 2026-09-04, by the std-API-audit re-measurement of the dead-public-surface
row (a per-enum sweep of `std/`: 53 enums, 311 variants, scoped to construction sites
inside the declaring module). **Status**: OPEN. Measured against `develop`
(`8d471c7df`) with `yo` 0.2.24 and `YO_STD=./std`.

**Class**: api-lie plus diagnostic loss. Same shape as C33 (`HttpError.Timeout` /
`TooManyRedirects` / `ResponseTooLarge`) and C34
(`issues/fixed/json-number-parser-accepts-invalid-and-any-garbage.md`), both of
which were closed by making the declared variant real rather than by deleting it.

## Symptom

`CryptoError` publishes two variants (`std/crypto/random.yo:24-29`):

```rust
CryptoError :: enum(
  /// Platform does not support secure random generation.
  Unavailable,
  /// Other platform-specific error.
  Other(msg : String)
);
```

`.Other` is public, documented and formatted, and user code can build and render it:

```rust
open(import("std/string"));
{ CryptoError } :: import("std/crypto/random");
{ println } :: import("std/fmt");

main :: (fn(io : Io) -> unit)({
  a := CryptoError.Unavailable;
  b := CryptoError.Other(msg : String.from("getrandom: Bad address (EFAULT)"));
  println(`Unavailable -> ${a.to_string()}`);
  println(`Other       -> ${b.to_string()}`);
});
export(main);
```

```
Unavailable -> crypto: platform random unavailable
Other       -> crypto error: getrandom: Bad address (EFAULT)
```

But nothing in the library ever throws it. `random_bytes` is the module's only
throwing function (`random_u32` / `random_u64` / `random_f64` / `random_range` /
`uuid_v4` all funnel through it), and all three of its failure sites throw
`.Unavailable`:

```
$ grep -rn "CryptoError" std/ src/ tests/ --include="*.yo"
std/crypto/random.yo:24:CryptoError :: enum(
std/crypto/random.yo:31:  CryptoError,
std/crypto/random.yo:43:impl(CryptoError, Error());
std/crypto/random.yo:44:export(CryptoError);
std/crypto/random.yo:74:          exn.throw(dyn(CryptoError.Unavailable));
std/crypto/random.yo:90:            exn.throw(dyn(CryptoError.Unavailable));
std/crypto/random.yo:115:                exn.throw(dyn(CryptoError.Unavailable));
tests/crypto/random.test.yo:5:{ ... CryptoError } :: import("std/crypto/random");
```

`.Other` appears exactly once in the tree, as the `ToString` match arm at
`std/crypto/random.yo:38`. So the enum's second variant is unreachable through
every public entry point.

## The half that is not cosmetic

Collapsing three distinct OS failures onto one variant loses the diagnosis and
states something false. `"crypto: platform random unavailable"` says the platform
has no CSPRNG. What actually happened, at each site:

- **Linux** (`std/crypto/random.yo:106-123`) — `getrandom(2)` returned `< 0`. The
  code reads the real code into `e_now` at `:110`, tests it for `EINTR` at `:112`
  to decide whether to retry, and then discards it at `:115`. `EFAULT` (bad
  buffer pointer), `ENOSYS` (kernel older than 3.17), `EAGAIN` (the entropy pool is
  not yet initialised on an early-boot system) and `EINVAL` (bad flags) all print
  "platform random unavailable" — and for three of those four, the platform
  emphatically *does* support secure random.
- **Windows** (`std/crypto/random.yo:69-77`) — `BCryptGenRandom`'s `NTSTATUS` is
  bound to `r` at `:70`, compared against `0` at `:72`, and dropped at `:74`.
  `STATUS_INVALID_HANDLE` and `STATUS_INVALID_PARAMETER` are indistinguishable
  from a missing provider.
- **WASI / Emscripten** (`std/crypto/random.yo:78-97`) — `getentropy`'s return is
  bound to `ret` at `:87` and dropped at `:90`. Here `Unavailable` is arguably the
  right answer (a WASI host without `random_get` is exactly "no CSPRNG"), but the
  `EIO` / `EFAULT` cases are not.

`uuid_v4` and `random_range` inherit the message, so a caller that logs the
exception sees the same misleading line for a transient early-boot `EAGAIN` as for
a genuinely entropy-less platform, with no way to tell them apart.

## Root cause

There is no mechanism gap — the errno is already in hand. `std/crypto/random.yo`
imports `../libc/errno` at `:50` (for `EINTR`) and binds `__yo_errno()` at `:110`.
The three throw sites simply do not carry it:

```rust
// std/crypto/random.yo:108-118, Linux
cond(
  (ret < isize(0)) => {
    e_now := __yo_errno();              // :110 — the code, in hand
    cond(
      (e_now == i32(EINTR)) => (),      // :112 — retry
      // retry
      true => {
        exn.throw(dyn(CryptoError.Unavailable));   // :115 — e_now dropped
      }
    );
  },
  ...
```

The module's own comment block at `:99-104` records that this loop was already
tightened once (a short read used to be silently accepted, and a transient `EINTR`
used to throw `Unavailable`) — the errno was plumbed in for that fix and then not
carried into the error.

Nobody caught it because `tests/crypto/random.test.yo` (11 tests) imports
`CryptoError` at `:5` and never asserts anything about it: there is no `to_string`
test for either variant, and no test forces a failure.

## Fix

Wire `.Other`, keeping `.Unavailable` for the one case that genuinely means it.

1. **Linux, `std/crypto/random.yo:112-118`** — replace the non-`EINTR` arm's throw
   with one carrying the code. `IoError.from_errno` (`std/sys/errors.yo:88-124`)
   already maps errno to a named variant and its `ToString`
   (`std/sys/errors.yo:132-179`) renders the text, so the message needs no new table:

   ```rust
   true => {
     exn.throw(dyn(CryptoError.Other(msg : `getrandom: ${IoError.from_errno(e_now).to_string()} (errno ${e_now})`)));
   }
   ```

   Add `{ IoError } :: import("../sys/errors");` to the module's imports. No cycle:
   `std/sys/errors.yo` imports only `../string`, `../fmt`, `../error` and
   `../libc/errno` (`std/sys/errors.yo:2-5`), and `std/crypto/tls.yo:26` already
   takes this exact import.

2. **Windows, `std/crypto/random.yo:71-76`** — `r` is an `NTSTATUS`, not an errno,
   so `from_errno` is wrong here. Throw
   `CryptoError.Other(msg : `BCryptGenRandom failed (NTSTATUS 0x${...})`)` with the
   raw status. Render it in hex via the module's existing `hex_encode` import
   (`std/crypto/random.yo:17`) or `snprintf` (`:16`) — both are already in scope.

3. **WASI / Emscripten, `std/crypto/random.yo:88-93`** — leave `.Unavailable`. This
   is the "the host provides no CSPRNG" case the variant was written for, and
   `getentropy` on WASI does not set a meaningful errno. Say so in a comment so the
   asymmetry is deliberate rather than an oversight.

4. **macOS** (`std/crypto/random.yo:66-68`) needs nothing: `arc4random_buf` cannot
   fail and returns `unit`.

The alternative — deleting `.Other` — is wrong here. Unlike
`HashMapError.KeyNotFound` (dead *by design*, because lookups return `Option`),
these failures are real, they happen, and their diagnosis exists and is being
thrown away. Deleting the variant would freeze "every crypto failure is
`Unavailable`" into the public API.

## Regression test

`tests/crypto/random.test.yo`:

- **`CryptoError renders both variants`** — the honest, runnable half:
  `CryptoError.Unavailable.to_string() == "crypto: platform random unavailable"`
  and `CryptoError.Other(msg : "getrandom: Bad address (errno 14)").to_string() ==
  "crypto error: getrandom: Bad address (errno 14)"`. This pins the message shape
  the fix produces, and it is the coverage the file lacks today (it imports
  `CryptoError` and asserts nothing about it).
- Forcing a real `getrandom` failure needs syscall injection the test harness does
  not have, so **do not** add a test that pretends to. Record the manual
  verification in this doc instead: on Linux, temporarily replace `__yo_getrandom`
  with a stub returning `-1` with `errno = EFAULT` and confirm the thrown message
  reads `crypto error: getrandom: Bad address (errno 14)` rather than
  `crypto: platform random unavailable`.

Gates: `yo fmt std/crypto/random.yo`; `yo check ./std --std-path ./std`;
`yo test ./tests/crypto/random.test.yo --parallel 1`; and, because
`std/crypto/tls.yo` and `std/uuid` sit downstream, `yo test ./tests/crypto --parallel 1`.

## Breaking change

No. `.Other` is already declared and exported, so every exhaustive `match` on
`CryptoError` in existing code already has an arm for it; the fix only makes an
existing arm reachable. The **message text** for a non-`EINTR` Linux failure and a
Windows failure changes, which is a release-note line ("crypto failures now report
the underlying OS error instead of `platform random unavailable`") but not an API
break.
