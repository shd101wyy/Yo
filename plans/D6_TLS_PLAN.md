# D6 — `std/crypto/tls`: TlsStream over OpenSSL and Schannel (measured execution plan)

**Status: D6 CLOSED (2026-09-04).** All three PRs landed. PR-3 (the compiler's
own curl→`std/http` swap) shipped as #364 on 2026-09-02, and the Windows gap it
left — `yo version install` / `yo version list --remote` refusing to run with
"TLS is unavailable in this build" — is closed by the **Schannel backend**
below. Every supported target now has a real TLS backend: OpenSSL on unix,
Schannel on Windows, and an honest `tls_available() == false` on wasm.

## The Schannel backend (Windows), 2026-09-04

Nothing in the ABI `std/crypto/tls.yo` binds is OpenSSL-specific: the Yo pump
only moves ciphertext between two opaque in-memory buffers and the socket, and
asks for plaintext through `read`/`write`. So Windows needed **no Yo-side
change at all** — only a second C implementation of the same fifteen
`__yo_tls_*` functions, selected by the emitted C's own `#if defined(_WIN32)`
in `generate_tls_runtime` (`src/codegen/async/runtime_io_common.yo`).

- `AcquireCredentialsHandleW(UNISP_NAME_W, SECPKG_CRED_OUTBOUND)` with
  `SCH_CRED_AUTO_CRED_VALIDATION | SCH_CRED_NO_DEFAULT_CREDS |
  SCH_USE_STRONG_CRYPTO` and `grbitEnabledProtocols = 0` (inherit the system's
  protocol policy rather than freezing this build's idea of "modern TLS").
  No revocation check — deliberately the same posture as the OpenSSL branch, so
  the two backends accept and reject the same peers.
- The handshake is the `InitializeSecurityContextW` loop. The first call takes
  no input and emits the ClientHello; later calls feed `in`. `SEC_E_INCOMPLETE_MESSAGE`
  keeps every byte and reports `WANT_READ`; `SECBUFFER_EXTRA` counts the bytes
  Schannel did **not** take (they sit at the end of what it was handed), so the
  consume is `len - extra`. `SEC_E_OK` queries `SECPKG_ATTR_STREAM_SIZES`.
  Output tokens are appended even on failure — with `ISC_REQ_EXTENDED_ERROR`
  that token is the alert, and the pump flushes before it inspects the result.
- `read` serves buffered plaintext first, then `DecryptMessage`, which works
  **in place**: its output buffers point into `in`, so plaintext is copied out
  before `in` is touched. `SEC_I_CONTEXT_EXPIRED` is a clean close_notify
  (`ZERO_RETURN`); `SEC_I_RENEGOTIATE` drops back into the handshake on the
  next turn of the loop. A `SEC_E_OK` with no data buffer (TLS 1.3
  post-handshake messages) simply loops round to `WANT_READ`.
- `write` chunks by `cbMaximumMessage` and stages header+payload+trailer in one
  scratch buffer per record, appending exactly the three buffers `EncryptMessage`
  reports back (it may shrink them). All-or-nothing, matching `SSL_write`.
- `shutdown` is `ApplyControlToken(SCHANNEL_SHUTDOWN)` plus one more
  `InitializeSecurityContextW` to produce close_notify into `out`.
- The error channel is a thread-local buffer consumed on read, mirroring
  OpenSSL's `ERR_get_error()` (the ABI's `__yo_tls_err_string` takes no
  connection argument).
- `src/main.yo` links `-lsecur32 -lcrypt32` for every Windows target. Both ship
  with Windows, so unlike OpenSSL there is nothing to probe for — the same
  unconditional stance as `ws2_32`/`bcrypt`.

**Gates.** The OpenSSL and wasm-stub C is **byte-identical** to before the
restructuring (verified by extracting and diffing the emitter's literals), so
no non-Windows target changed. The Schannel C is compiled and linked for both
`x86_64-windows-gnu` and `aarch64-windows-gnu` locally via `zig cc` with the
same warning flags `src/main.yo` passes — a ~40 s gate instead of a CI round
trip. End-to-end proof is CI: `tests/crypto/tls.test.yo` and
`tests/http/http.test.yo` no longer skip Windows, and both were made
non-vacuous first
(`issues/fixed/live-tls-tests-pass-vacuously-when-the-handshake-fails.md` — the
old handlers unwound out of the test body on every error, so a broken backend
passed with no assertion at all).

**Not covered, deliberately:** client certificates, pinning, ALPN, session
resumption control, and a server-side `TlsListener`. None is used by std today;
all are additive.

## Original plan text

**PR-1 LANDED (2026-08-28)** — `std/crypto/tls.yo` connects, verifies
(system trust store + hostname + SNI), reads and writes over memory BIOs,
implements the D5 `Reader`/`Writer` traits, and is proven by a LIVE handshake
to example.com:443 (HTTP/1.1 200 OK over the encrypted stream, in
tests/crypto/tls.test.yo — guarded to skip offline). The `_probe_openssl`
flag plumbing is in `src/main.yo` (liburing pattern + Homebrew keg
PKG_CONFIG_PATH fallbacks). Two follow-ups remain (PR-2, PR-3 below).
Original plan text follows.

**Status: PLAN (measured 2026-08-28).** The O2 decision (2026-08-23) stands:
one `TlsStream` type implementing the D5 `Reader`/`Writer` traits, over
platform libraries. This document turns that row into an executable plan by
measuring the mechanisms in-tree. Until it lands, C1 keeps `https://`
throwing `UnsupportedScheme` — std stays honest.

## Decisions sharpened by measurement

1. **OpenSSL-first, everywhere it exists; Schannel followed 2026-09-04,
   SecureTransport never needed** (macOS has OpenSSL via brew, and
   SecureTransport is deprecated by Apple).
   Original decision text: **OpenSSL-first; Schannel/SecureTransport deferred.**
   The GH runners: ubuntu images carry libssl-dev; macos images carry brew
   `openssl@3`; this dev box has `/opt/homebrew/Cellar/openssl@3/3.6.3`
   (pkg-config finds it only with
   `PKG_CONFIG_PATH=/opt/homebrew/opt/openssl/lib/pkgconfig` — brew does not
   put keg .pc dirs on the default path, so the probe must add the keg
   fallbacks). Windows TLS goes to the same platform-audit backlog as the
   fs/process Windows story (issues/s3-fs-wrappers-windows-semantics-audit.md).
2. **Not seed-gated.** No new C-runtime externs: the OpenSSL functions come
   from the system library through `c_include("<openssl/ssl.h>", ...)`
   bindings in std (the `std/libc/*` mechanism), and the link/include flags
   are added by the COMPILER DOING THE COMPILE (this tree's binary for tests
   and CI), not the seed. `yo build` of the compiler itself never imports tls.
3. **Flag plumbing = the liburing pattern**, measured at `src/main.yo`:
   - `_probe_liburing` (main.yo:931) runs `pkg-config --exists` under a
     swallowing handler and gates `-luring` (main.yo:2152-2158).
   - Mirror as `_probe_openssl(io, includes, libdirs, ok)`: run
     `pkg-config --cflags --libs openssl`; on failure and macOS, retry with
     `PKG_CONFIG_PATH` pointed at `/opt/homebrew/opt/openssl/lib/pkgconfig`
     then `/usr/local/opt/openssl/lib/pkgconfig` (Command.env exists since
     PR #308). Parse `-I`/`-L` tokens; add them into the existing
     include/libdir loops (main.yo:1940+) and `-lssl -lcrypto` beside the
     liburing block, non-wasm non-windows only.
   - Linking `-lssl -lcrypto` unconditionally-when-present adds DT_NEEDED to
     programs that never use TLS; acceptable v1 (liburing already works this
     way). A later refinement can key on whether the emitted C includes
     `<openssl/ssl.h>`.
4. **Async integration = memory BIOs, not SSL_set_fd.** Our TcpStream fds
   belong to the per-thread async runtime (non-blocking, kqueue/io_uring
   owned); handing them to OpenSSL's blocking I/O would fight the loop.
   `TlsStream` holds `rbio`/`wbio` memory BIOs:
   - handshake: loop `SSL_do_handshake` → on `SSL_ERROR_WANT_READ`, drain
     `wbio` (BIO_read) → `tcp.write_all`, then `tcp.read` → BIO_write into
     `rbio`; repeat until success or fatal.
   - `read`/`write` (the D5 trait impls): same pump around
     `SSL_read`/`SSL_write`.
   - This is a plain async method loop — no new compiler shapes (the C27
     closure-param trap doesn't apply: no closure params captured in the
     io.async bodies; self-captures only, the proven-safe face).
5. **Bindings needed** (all real functions in OpenSSL 1.1.1+/3.x — macros
   avoided deliberately): `TLS_client_method`, `SSL_CTX_new`,
   `SSL_CTX_set_verify`, `SSL_CTX_set_default_verify_paths`, `SSL_new`,
   `SSL_set_bio`, `BIO_new`, `BIO_s_mem`, `BIO_read`, `BIO_write`,
   `BIO_ctrl_pending`, `SSL_set_connect_state`, `SSL_set1_host` (hostname
   verification), `SSL_ctrl` (for SNI — `SSL_set_tlsext_host_name` is a
   macro over it: `SSL_ctrl(ssl, SSL_CTRL_SET_TLSEXT_HOSTNAME, TLSEXT_NAMETYPE_host_name, name)`),
   `SSL_do_handshake`, `SSL_get_error`, `SSL_read`, `SSL_write`,
   `SSL_shutdown`, `SSL_free`, `SSL_CTX_free`, `ERR_get_error`,
   `ERR_error_string_n`.
6. **Surface**: `TlsStream.connect(host : String, port : u16, io) ->
   Impl(Future(TlsStream, IoExn))` (dials TcpStream, SNI + verify ON by
   default), `read`/`write`/`close` + the D5 `Reader`/`Writer` impls;
   `TlsError` enum (D1 style) wrapping the ERR_ string. Then C1's
   `UnsupportedScheme` throw in `std/http/client.yo` becomes a real TLS path
   — which also unblocks the P0+ "curl → std/http" swap.
7. **Tests**: unit-testable pieces (error mapping, bio pump against a
   loopback pair with a self-…) require either a local cert fixture or a
   network endpoint. Plan: one guarded network test (fetch
   `https://example.com`, SKIP with a printed note when the socket connect
   fails — CI runners have egress; offline boxes skip), plus pure-logic
   tests for the error enum. The `SkipWasm32*` pragmas apply (no sockets on
   wasm); Windows skips until the Schannel pass.

## Order of work (one PR each)

1. ~~`_probe_openssl` + flag plumbing in main.yo, plus `std/crypto/tls.yo`
   with bindings + `TlsStream` + tests.~~ **LANDED 2026-08-28.** En route:
   the connect body FTT'd on an unreachable `*(void)("")` post-throw
   placeholder (fixed by nullable-check-then-unwrap, no placeholder), and
   the read pump needed a single post-cond awaiting `if` instead of two
   (issues/async-postwhile-multiple-await-ifs.md).
2. ~~`std/http/client.yo`: route `https://` through TlsStream.~~ **LANDED
   2026-08-28** — scheme branch (TcpStream|TlsStream), generic-Reader shared
   response loop, default port 443, live https fetch pinned. (The
   build-without-OpenSSL error message polish is deferred; the linker names
   the missing library, which suffices.)
3. ~~**BLOCKED 2026-08-29 on Windows TLS (Schannel).**~~ **LANDED as #364
   (2026-09-02)**, with Windows getting ABI stubs and an honest
   `tls_available() == false` until the Schannel backend above closed the gap
   on 2026-09-04. Original blocker text follows.
    `version_cache.yo`'s two
   curl calls are `https://api.github.com` + release-asset downloads; swapping
   them onto `std/http` makes the COMPILER BINARY depend on `TlsStream`, which
   today is OpenSSL-only — `yo version install` / `yo version list --remote`
   would lose TLS on Windows (no OpenSSL on the runners or on user machines),
   and every from-source build of the compiler (`yo.c`, `install.sh`) would
   need libssl headers. Re-open once Schannel lands with the Windows platform
   audit; until then curl stays (it is present on every supported OS).
   Original item: P0+ curl swap in `src/fetch.yo`/`version_cache.yo` (measure first — the
   row notes it is blocked on this).
