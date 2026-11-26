# std/http ignores `HTTPS_PROXY`, so `yo` cannot download anything behind a proxy

**Severity:** S3 — on a machine whose only way out is an HTTP proxy named by `HTTPS_PROXY` / `https_proxy` (corporate networks, the project's own Linux box), every download the compiler makes itself fails at the transport: `yo verify`'s solver fetch, `yo build`'s first-need solver fetch, `yo version install` and `yo version list --remote`. `curl`, `git` and therefore `scripts/install.sh` and dependency fetches go through the proxy and work. Nothing is wrong once a download is done some other way (`YO_Z3_PATH`, the installer).

- Filed: 2026-11-26 (lane `dov-sd`, step SD of `plans/backlog/DEFAULT_ON_VERIFICATION.md`), while exercising the solver fetch. Pre-existing: the solver download before SD and `src/version-cache.yo` use the same `fetch_with`.

## Reproducer

On a box where `HTTPS_PROXY=http://127.0.0.1:8889` is set and a direct connection to github.com times out:

```bash
mkdir -p /tmp/empty-cache
cat > tmp/fixme.yo <<'EOF'
pragma(Pragma.VerifyOrAssert);

halve :: (fn(a : i32, requires(a >= i32(0)), ensures(r <= a)) -> (r : i32))(
  a / i32(2)
);
EOF
YO_CACHE_DIR=/tmp/empty-cache yo verify tmp/fixme.yo
```

```text
verify: fetching Z3 5.1.0 from https://github.com/shd101wyy/Yo/releases/download/v0.2.79/yo-v0.2.79-x86_64-unknown-linux-musl-z3.tar.gz
yo: error: HTTP connection failed: the server closed the connection without sending a response
```

`curl` on the same box, through the proxy and around it:

```text
$ curl -s -o /dev/null -w "via proxy: %{http_code}\n" https://github.com/shd101wyy/Yo/releases/download/v0.2.79/yo-v0.2.79-x86_64-unknown-linux-musl-z3.tar.gz
via proxy: 404
$ curl --noproxy '*' -m 15 -s -o /dev/null -w "direct: %{http_code}\n" https://github.com/
direct: 000
```

## Root cause

`std/http/client.yo`'s `fetch_with` always opens a direct TCP connection to
the URL's host. It reads no proxy variable, so it never sends the `CONNECT`
an HTTPS proxy needs.

## Fix direction

Honour `HTTPS_PROXY` / `https_proxy` for `https://` URLs and `HTTP_PROXY` /
`http_proxy` for `http://` ones, minus `NO_PROXY` / `no_proxy` hosts: connect to
the proxy, send `CONNECT host:443`, then run the TLS handshake on that stream.
Whether std/http reads the environment itself or `FetchOptions` takes a proxy
the CLI fills from the environment is a design choice (the explicit option is
the house style).
