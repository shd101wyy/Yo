# v0.2.32

> **ARCHIVED 2026-09-13 — v0.2.32 shipped.** This was the pre-release draft;
> the published notes are on the GitHub release
> (https://github.com/shd101wyy/Yo/releases/tag/v0.2.32), edited in from this
> file because the workflow fills the body from the last commit message only.
> 13 assets, `SEED_VERSION` auto-bumped to v0.2.32 in all three workflows by
> `6943c89af` — which is what unblocks #654's un-vendoring of `markdown_yo`.
> Verified byte-for-byte: the published body is this file minus its title line
> and this banner.

This release is the **build and dependency system redesign**
(`plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`, P1 complete): `yo.toml` is
now the package manifest, dependency resolution is a real semver resolver over
a content-addressed store, and `import("<dep>")` resolves. Alongside it: four
evaluator/codegen correctness fixes, the verifier's V5 ghost-specification row,
and the async runtime's cross-thread wake.

**Breaking.** `deps.yo`, `yo fetch` and `yo install <spec>` are gone, replaced
by `yo.toml` + `yo add` / `yo update` / `yo install`. There is no migration
shim — see "Migrating" at the end.

## Build: `yo.toml` is the manifest (#596, #601, #602)

The manifest is declarative data, read **without** the evaluator, and edited
in place by a comment-preserving TOML editor — so `yo add` keeps your comments
and key order. `deps.yo` (a `build.yo`-evaluated dependency list) is gone.

- `yo add <dep>` / `yo remove` / `yo update [--latest]` / `yo install`.
- **A real resolver** (#601): semver ranges over git tags, graph-wide version
  unification (Cargo's model — one version per package across the graph),
  and `yo.lock` **v2** carrying the resolved graph plus integrity hashes.
  `--locked`, `--offline` and `--frozen` mean what they mean in Cargo.
- **A content-addressed store** (#602): `store/sha256` trees, bare mirrors
  shared across projects, a tag index, and `yo cache gc`.
- `import("<dep>")` resolves in **every** command, not just `yo build`, via an
  explicit `--imports` mapping handed to the child compile.

## Build: the runner does what the API promised

The audit that opened this campaign found most of the build API decorative.
It no longer is:

- **Shared libraries are real** (#615): `--shared-library` emits
  `lib<name>.{dylib,so,dll}` — it used to compile as an executable — and
  consumers get an rpath.
- **A dependency's `build.yo` is evaluated** in an isolated registry, and
  `dep.artifact()` builds and links for real (#611).
- **Parallel DAG levels** (#620): a level's nodes overlap, `-j N`.
- **Workspaces** (#646): `[workspace] members`, `yo build -p <pkg>`,
  `yo test --workspace`.
- **The runner stops failing silently** (#616): dangling dependencies, dead
  dependents, a `--dry-run` that actually dry-runs, validated `-D` options.
- **Stamps hash what the compile actually read** (#631) — `--emit-deps`
  depfiles, so an edit to a transitively imported file invalidates the stamp.
  The stamp also stopped tripping over dotted directory names (#618).
- **`build.env`** (#642): the environment as a *declared*, stamped input,
  honoured only under `yo build`.
- Run arguments, and one name namespace for steps and artifacts (#618).
- The last of the write-only state is gone (#626): test flags are surfaced,
  `logo`/`favicon` are rendered, `include_deps` and `runtime_files` deleted.

## Comptime inputs (#633, #640)

- `comptime_read_file` — a file's bytes as a compile-time string, bounded to
  the package root.
- `comptime_json_parse` / `comptime_toml_parse`, over a new comptime-only
  `ComptimeValue` enum with builtin parsers.

`comptime_fetch` was considered and **rejected**: network access belongs to
the package manager, not the evaluator.

## Compiler correctness

- **A static-dispatch call takes its C return type from the CALLEE**, not the
  call site (#598).
- **Content-stable symbol names** (#603, Phase 2 of the incremental-compilation
  plan): `yo_id_N` no longer churns on every edit.
- **A generic function returning `Impl(Future(T))` resolves its return type per
  call** (#619) — and the adoption gate that shipped with it takes an
  existential, not a type that merely *contains* one (#649), which is what
  made a `Box` over an `Impl(Fn)` emit as two different C structs.
- **Nested `while` loops in one async body** chain past their awaits, and a
  local named after a field keeps its own slot type (#593).
- **Two externs with one signature each get a prototype** (#624) — they used
  to collapse into one, and `-O2` downgraded the resulting undeclared-call
  error to a warning.
- **`Thread(T)` carries its body's value out** (#612, D18b) — with the four
  compiler defects found underneath it.

## Async runtime

- **A wake can cross a thread** (#628): waker step 5's machinery.
- `yield` has no timer under it any more (#608).
- Windows: the deadline clock is QPC-derived, not `GetTickCount64` (#627).

## Windows async I/O: the IOCP audit (#638)

An audit of `src/codegen/async/runtime_io_windows.yo` against the Linux and
macOS backends. Four defects, each reproduced before it was fixed:

- **A blocking `connect()` parked the whole event loop** (HIGH). Against a
  black-holed address every concurrent task froze for the SYN-retransmit
  window — measured, a concurrent 300 ms sleep took **21.3 s**. Now overlapped
  **ConnectEx**, the connect-side twin of the landed AcceptEx work. AF_UNIX and
  UDP `connect` keep the plain call, which is local and immediate.
- **UDP `sendto`/`recvfrom` were blocking calls on the loop thread** (HIGH) — a
  quiet `recv_from` froze the runtime until a datagram arrived. Now overlapped
  `WSASendTo`/`WSARecvFrom`, with the source-address length riding in the
  overlapped struct because the kernel writes it at completion time.
- **A sync file close leaked the CRT fd until Winsock was started** (HIGH).
  Both close paths probed Winsock first, and in a program that never ran
  `WSAStartup` the probe failed `WSANOTINITIALISED` rather than `WSAENOTSOCK`,
  so the `_close` fallback never ran: **812 of 9000 open/close rounds failed**,
  first at `errno=24`. A socket-fd registry now records every socket the
  runtime creates, and both close paths consult it instead of probing.
- **`fs.watch`'s re-arm dropped the recursive flag**, and the single-file branch
  copied an unbounded path into `dir_part[MAX_PATH]`. Both fixed.

Then a fifth, found in the audit's own first cut and worth stating because the
rule generalises: **the ConnectEx family gate read `getsockname()`**, which
fails `WSAEINVAL` on an unbound socket — precisely the fresh client socket the
overlapped path exists for. The `AF_INET` fallback therefore fired every time
and the gate never gated, routing AF_UNIX connects into ConnectEx (and
AF_INET6 clients would have died the same way). It now reads
`getsockopt(SO_PROTOCOL_INFOW)`, which is valid before bind and returns family
and type together, and it **fails closed**: if that call fails, the plain
`connect()` runs. The rule: *a probe used to GATE a path must not have a
failure fallback that satisfies the gate*, or the gate becomes an
unconditional yes.

New coverage: `tests/net/tcp.test.yo` gains an IPv6 loopback connect
round-trip. The suite had no IPv6 **client** connect at all — only a `bind`
test — which is why an AF_INET6 client failing would have gone unnoticed.

## Verifier: V5 ghost specifications

- `forall_val` / `exists_val` / `==>`, ghost-only, with `inout` two-state
  pinned (#564).
- `ghost_fn` calls gated to ghost context (#606), then inlined in the walk,
  with ghost bindings reporting escape errors (#613).
- The `std/spec` ghost collections — `Seq`, `Multiset`, `Set`, `str` content
  (#636).

## Migrating

There is no compatibility shim. A project on v0.2.31:

1. Replace `deps.yo` with a `[dependencies]` table in `yo.toml`
   (`yo add <dep>` writes it for you).
2. `yo fetch` → `yo install`; `yo install user/repo@tag` → `yo add user/repo@tag`.
3. Delete `yo.lock` and let `yo install` write a v2 lock.
