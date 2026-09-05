# Handover — std API audit, the road to the freeze (post-v0.2.24, 2026-09-05)

**For the next agent picking up the std campaign.** Written at the v0.2.24
release point. Everything here was verified against `origin/develop` at
`0e218fed7` (the v0.2.24 version-bump commit) unless marked otherwise.

---

## 0. The standing goal (verbatim, from the maintainer)

> "Finish everything in plans/STD_API_AUDIT.md. Update related docs as you
> progress. Document and fix any surfaced bugs and issues. No workaround is
> allowed. Try to stabilize the std API and make it well designed. Feel free
> to admin merge PRs to save CI cycles. Feel free to cut patch release when
> needed."

Consequences you should internalize:

- **Bugs found along the way get FIXED, not routed around.** If a std task
  trips a compiler bug: file `issues/<name>.md` with the verbatim error, a
  minimal repro in `tmp/fixme.yo`, and root-cause analysis; fix the compiler;
  add a regression test that was RED before the fix. Three past sessions each
  closed a compiler bug *en route* to a std row (#398 → the match-arm drop
  leak [filed open, see §4]; #402 → the Windows ftruncate runtime bug;
  #406 → the generic-body import resolution rule in §6).
- **Admin merges are pre-authorized** (`gh pr merge N --admin --squash
  --delete-branch`) when CI is green — required checks take ~55 min otherwise.
- **Patch releases are pre-authorized.** Breaking std changes ship in ordinary
  v0.2.x patches (maintainer decision 2026-08-24 — "no minor release"), but
  every breaking change must be CALLED OUT in the release notes.

**Read first, in order:** `AGENTS.md` (root — the era table, commands,
pitfalls), `plans/STD_API_AUDIT.md` (the whole campaign state),
`.github/instructions/yo-design.instructions.md` + `yo-syntax.instructions.md`.
The three untracked session diaries `plans/HANDOVER_STD_AUDIT_2026-{08-30,
09-01,09-02}.md` carry the blow-by-blow history of the last two weeks
(§0a–§0m) — skim their lesson paragraphs; the load-bearing ones are
extracted into §6 below.

---

## 1. Where things stand right now

- **v0.2.24 published** (2026-09-04/05) from develop `16054559a` (the #406
  quick-wins merge), tagged on bump commit `0e218fed7`. It bundles: the
  string/fmt/fs/path/env audit closures (#398, #402, #406), the entire
  error-diagnostics overhaul P1–P3 (#399/#400/#403/#405 — rustc-shaped
  rendering, E-codes, bilingual `yo explain`, `--error-format human|short|json`,
  did-you-mean, panic locations, LSP typed channel), mimalloc v3.5.1 + the
  Windows seed-build path fix (#181), the `&&`/`||` first-operand and the
  Stage-0 balancing-drop leak fixes (#405/#403), and the unterminated-string
  lexer error. Release notes live on the GitHub release (drafted from
  `/tmp/v0.2.24-notes.md`).
- **Breaking changes shipped in v0.2.24** (already announced in its notes):
  `String.to_c_str` (malloc'd `*u8`) deleted → `to_cstr().ptr()`;
  `panic_dyn`/`assert_dyn` deleted (ToString-generic `panic`/`assert`
  subsume them); `replace_all` with an empty pattern now has Rust semantics
  (`"abc".replace_all("", "-")` == `"-a-b-c-"`); `DirEntry` gained a
  `parent : Path` field.
- **SEED_VERSION auto-bumped to v0.2.24** by the release pipeline (commit
  `78abb90ba`; the bump does NOT carry `[skip ci]`, so develop's Test run
  immediately exercises the new seed — run 33900306095, verify green, rerun
  the macos-26-intel leg if its runner cancels it; see §5.3). The shipped
  bundle was verified: `bin/yo --version` → `yo 0.2.24`, 13 assets, notes
  4.3 KB, `latest` pointer correct.
- The campaign's S0–S3 are essentially done; **S4 items and the two S5
  freeze inputs are what remain** (§2), plus a short list of OPEN compiler
  bugs (§4) and maintainer decisions (§5.4).
- Session worktree `/private/tmp/yo-str` was removed after the release (/tmp
  also gets swept by the OS — never rely on it surviving); the main workspace
  `/Users/yiyiwang/Workspace/Yo` was left on the long-merged branch
  `fix/second-cond-await-target` with untracked handover docs — **checkout
  develop there before working** (`git fetch && git checkout develop &&
  git pull`, plus `git submodule update vendor/mimalloc` — its pointer moved
  in #181 and drift shows as a dirty submodule).

## 1.1 Local toolchain facts (macOS, this machine)

- A `yo` must be on PATH for everything. The v0.2.24 bundle will be at
  `~/.cache/yo/versions/…` once `yo version install 0.2.24` runs, or extract
  the release tarball. Older verified seeds live under `/tmp/yo-v0223-check/`
  (v0.2.23) — /tmp is wiped on reboot, re-extract from GitHub Releases then.
- When using a bundle outside the repo: **`YO_STD=<bundle>/std` must be set**
  (or `--std-path`, but YO_STD behaves more consistently for import
  resolution; the test-runner/binary-tree interaction has its own issue doc,
  `issues/test-runner-std-path-shadowed-by-binary-tree-std.md`).
- Cross-emit smoke (no Windows box needed):
  `yo compile src/main.yo --std-path ./std --target x86_64-pc-windows-msvc`
  — this is the exact shape that caught #406's regression (§6, rule 1).
- Gates battery needs GNU timeout + homebrew bash:
  `S1=<built-binary> P=local bash scripts/bootstrap/gates_fast.sh`
  (stock bash 3.2 dies on `declare -A`).

---

## 2. The queue — what remains, in suggested order

> **The audit's own meta-rule: rows have repeatedly measured wrong.** Re-measure
> (grep the tree, run the tests) before executing any row, and correct the row
> in the same PR. Two rows are KNOWN stale right now: the §4 `io` row ("generic
> wrappers + bufio move remain" — D5's closeout 2026-09-02 says they landed;
> only buffered `lines()` remains, blocked on an async iterator protocol) and
> §7 P0 item 3 (same text). Fix those two rows opportunistically.

### Wave A — medium std rows, no blockers (each ≈ one PR)

1. **error/assert row** — the last pure-API row of the original trio:
   `AnyError` downcast (`is(T)`/`as(T)`), a `derive_rule(Error, …)` so error
   enums stop hand-writing `ToString` + `Error()`, and `Error.source`
   actually used for chaining (a `wrap`/`context` helper). The re-export
   narrowing half already landed (#406).
2. **testing `bench`** — `std/testing/bench.yo` currently returns
   avg/min/max only. Wanted: auto-calibration (pick N from a time budget),
   `black_box`, stddev/percentiles. (`assert_eq`/`assert_ne`/`assert_approx`
   are DONE.)
3. **url row** — percent-encode/decode integration (the codec EXISTS in
   `std/encoding/percent.yo`; wire it in), `query_pairs`/`SearchParams`,
   `join` (RFC 3986 §5), builder/setters. Note C33's http-redirect
   resolution already hand-rolls path resolution — `Url.join` should replace
   that and be the tested home for it.
4. **net row** — `incoming()` on listeners, UDP `connect` + typed
   `recv_from`, `parse_v6`, `SocketAddr.parse`, `Eq`/`Hash` on addr types,
   RFC 5952 V6 formatting.
5. **collections row** — `drain`; `HashSet` = `HashMap(T, unit)` to kill
   ~500 duplicated SwissTable lines; hide pub `ctrl/data/…` fields (needs a
   visibility decision — Yo's only mechanism is `export(...)`; see §5.4);
   `BTreeMap` → real B-tree with `range()` (recommended verdict: real B-tree,
   keep the name); add `BTreeSet`; `PriorityQueue` comparator ctor +
   DOCUMENT that it is a min-heap.
6. **cli row** — typed values, required enforcement, `--`, repeated opts,
   help-not-an-error. `std/term` (is_terminal/size/supports_color/raw mode)
   landed 2026-08-29; adopting it in std/cli's help coloring is part of this.
   Verdict already decided: keep minimal-but-correct in std.
7. **imm row** — iteration + `Index` where documented, dedupe the set pair,
   and mark the family `unstable` via the Stability doc section (§3 of the
   freeze, below) until it has real consumers.
8. **async row** — `interval` (the only missing combinator; `join_all`/
   `race`/`any`/`timeout`/channel/mutex all landed 2026-08-27).
9. **encoding row** — TOML is the P1 gap: floats/arrays/dates, serializer,
   derives; also give TOML a typed error per D1 (its `Result(_, String)` is
   the last stringly error). base32 is P2. CSV is DONE.

### Wave B — needs a decision or a small design first

10. **fs leftovers** — `OpenOptions` builder; Metadata: real `btime`
    (`STATX_BTIME`/`st_birthtime`/`CreationTime`), `permissions()`, stop
    `metadata` re-stat by path; walker lazy option; collapse the
    `_str`/`cstr` path-arg matrix behind an `AsPath`-style trait.
11. **path leftovers** — Windows separator in `to_string` (Path is
    POSIX-normalized today); revisit eager `..` normalization (symlink
    semantics — Rust normalizes lazily for a reason); decide `Path.new`
    fallibility (PathError was deleted in §6; `new` is currently infallible).
12. **thread row** — `Thread.spawn` result carry (`join() -> T`) is now an
    S4 item: its compiler blocker
    (`issues/fixed/spawn-closure-generic-captures-erased-to-void-ptr.md`)
    measured fixed-by-events 2026-08-28. **Panic propagation is NOT
    implementable at any layer** (panic lowers to `fprintf`+`abort()`; no
    unwinding) — do not fake a `join() -> Result(T, E)` that cannot observe
    a panic.

### Wave C — the S5 freeze inputs (§9 of the audit; the actual finish line)

13. **Dead public surface** — remaining decisions from the enum sweep:
    delete `HashMapError.KeyNotFound`/`HashSetError.ElementNotFound` (dead
    by design; lookups return `Option`). **BLOCKED** by
    `issues/structurally-identical-error-enums-in-two-generic-impls-collide.md`
    (deleting them makes the two enums structurally identical → collision;
    fix the compiler first). `std/allocator`'s `Layout`/`layout_of` were
    DECIDED KEEP 2026-08-29. (`DateTime.nanosecond` measured fine.)
14. **Coverage read** — ~183 exported names outside `std/sys`+`std/libc`
    are never named under `tests/`. Freeze requires a real read of these;
    `C34` (json_parse accepting `"<html>"` as `0`) is the cautionary tale.
    A name-grep overstates the gap — structural uses score zero — triage,
    don't grind.
15. **Freeze mechanics are DONE** (2026-08-29): a module's inner doc may end
    with `## Stability` (`unstable — new in vX.Y.Z; …`), carried by `yo doc`
    as `DocModule.stability`. Everything without the section is stable +
    additive-only. Use it for wave-A items that are genuinely new surface
    (the rule: new modules enter `unstable` for one release before
    freezing). `std/http/server` and `std/fs/watch` still need their marker
    (their own PRs, per the §9 note).

### Carried items sitting on branches / gates

16. **`s6/version-cache-std-http`** (remote branch exists, `0a523d514`): the
    P0+ curl→`std/http` swap for `src/version_cache.yo`, fully written. Its
    old seed gate (v0.2.20) is long satisfied, but it is **now blocked on
    Windows TLS**: the compiler must build on the windows legs, and OpenSSL
    isn't there (`plans/D6_TLS_PLAN.md` item 3). Rebase + land it as part of
    the Schannel work (17) or decide to platform-gate the import.
17. **Windows Schannel TLS** (D6 remainder) — OpenSSL-first landed; Windows
    has no TLS until a Schannel pass over `TlsStream`. Unblocks 16 and
    closes D6 entirely. This is the biggest single chunk left.
18. **D4 PR 9** — dedup the remaining hand-rolled UTF-8 decoders onto
    `std/encoding/utf8.yo`, incl. `vendor/markdown_yo` (needs companion
    upstream commits + submodule bump). **LSP UTF-16 position encoding**
    (D4 §5.4) is the other dangling D4 end: protocol-visible, wants a
    `positionEncoding` capability, builds on the rune↔byte helpers in
    `src/lsp/protocol.yo`.

### Explicitly blocked / deferred (do not grind on these)

- **buffered `lines()`** on the D5 Reader — needs an async iterator protocol
  (deliberately not faked). BufWriter's SYNC `Dispose` cannot await an async
  `Writer.write` — a structural constraint, not a bug (C12 note).
- **HTTP keep-alive** — deferred post-freeze (connection pooling).
- **`process` hide `raw`** — needs module-private visibility, a LANGUAGE
  feature (§5.4).
- **`gc.stats()`** — the runtime only exposes `__yo_gc_collect`/
  `__yo_gc_tracked_count`; real stats need new builtins. Deferred with
  rationale in the gc row.
- **`JsonValue.Object` index map** — only if profiling demands.
- **log pluggable writer sink** — needs a Writer-trait object in module
  state.
- Panic propagation (see 12).

---

## 3. What "done" looks like per change (the validation battery)

Copied from the working method of every landed PR; AGENTS.md has the full
command reference.

- Any `.yo` change: `yo fmt <file>` + `yo fmt --check` before commit (no
  pre-commit hook exists — it's on you).
- std change: `yo check ./std` (173/173 at #406) and `yo check ./src`
  (264/264) — the latter catches std-surface breakage in the compiler's own
  closure (e.g. the dropped `export(print)` was caught via comptime_print).
- Then the targeted suite files (`yo test ./tests/<area>.test.yo
  --parallel 1`), then the fast suite
  `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`
  (~30 min, M4) before pushing. tests/internal files are heavy (one at a
  time; macro_expansion needs 6.5 GB).
- Compiler/codegen change: ALSO `yo compile src/main.yo --skip-c-compiler`
  (~3 min; `check` is evaluator-only and passes over codegen restrictions),
  plus stage-2 self-compile (`yo-out compile src/main.yo --optimize 2`)
  before pushing — this was the #397 lesson (three fix designs shipped and
  broke the fixpoint because only stage-2 exercises a codegen change on the
  compiler itself).
- Windows-adjacent change: run the cross-emit smoke from §1.1.
- Deletion/change of exported surface: the "method lesson" — four call-site
  classes are structurally invisible to `check` (macro `quote` bodies,
  generic trait-impl bodies, generic helpers in the defining module, async
  closure bodies). Grep inside `quote(`, `impl(` and `io.async(` bodies by
  hand; gate on the FULL suite + a standalone program that exercises the
  changed declarations at runtime (a passing targeted test can be vacuous —
  the enum-collision was caught only by a standalone compile+RUN).
- Docs: user-visible surface gets both `docs/en-US/` and `docs/zh-CN/`.
- Update the audit row + any instructions/skills files in the SAME PR
  (`.github/skills/yo-syntax/syntax-cheatsheet.md`,
  `yo-core-patterns/core-patterns-cheatsheet.md`,
  `.github/instructions/*.instructions.md`) — the standing goal says
  "update related docs as you progress".

---

## 4. OPEN compiler bugs you may meet (filed, with docs)

Only C29 is still an OPEN row in the audit's §2; everything else here lives
as standalone issue docs. All are on develop; read the doc before touching.

- **C29 — generic call type variables re-resolve PER ARGUMENT**
  (`issues/generic-type-var-rebinds-per-argument.md`):
  `pair_same(generic(A), x : A, y : A)` accepts `(String, i32)`. Memory-safety
  face closed by C28's gate; wrong-value faces remain.
- **Match-arm `&&` RHS-temp drop leaks the arm's C scope**
  (`issues/match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md`): surfaced by
  #398's own tests. Three fix designs were tried and rejected; the correct
  fix needs emitter branch-scope tracking. Test authors work around it with
  begin-form arm bodies — the standing goal's "no workaround" makes this a
  real queue item, but budget it as a codegen project, not a std-row errand.
- **Structurally identical error enums in two generic impls collide**
  (`issues/structurally-identical-error-enums-in-two-generic-impls-collide.md`,
  repro in `issues/repros/`): blocks freeze item 13. Fixing this unlocks the
  KeyNotFound/ElementNotFound deletion.
- **Async tail match/return hangs the state machine**
  (`issues/async-tail-match-return-hangs-state-machine.md`): known hazard;
  sync-helper workaround documented in the glob-filter landing.
- **Iterator chain shared-stamp cross-Item pollution**
  (`issues/iterator-chain-shared-stamp-cross-item-pollution.md`): `.map(f)`
  chains at two Item types in one module.
- **`Variable.is_ref` family** —
  `issues/generic-trait-method-reads-primitive-inout-self-as-pointer.md`
  was the D3.9 blocker; D3.9 Hasher landed anyway (2026-08-28), but the
  underlying family bug is worth attacking as a group if it resurfaces.
- The long tail lives in `issues/` (~85 open docs). The `yo-self-*` prefixed
  ones are mostly older self-hosting-era filings — verify against current
  develop before believing them.

**Compiler-bug etiquette** (from AGENTS.md, proven repeatedly): document in
`issues/<name>.md` (verbatim error + minimal repro in `tmp/fixme.yo` + root
cause), fix in `src/`, verify repro compiles + full-tree error count drops,
move the doc to `issues/fixed/`, update references
(`grep -rn "issues/<name>.md"`). Always add the RED-first regression test to
`tests/`.

---

## 5. Process knowledge

### 5.1 CI shape

`test.yml` on PRs: ~26 checks. The `test (…)` matrix runs in two waves
(second wave starts when the first finishes — a "pending, 0s" check list is
normal). Slowest legs: `test-wasm32_emscripten` (~52 min), internal shards
(~45 min), `test (ubuntu-…)`. A docs-only diff takes the fast path (~4 min).
`gh pr checks <N>` is the poll command; rerun a whole run's failures with
`gh run rerun <id> --failed`.

### 5.2 Merging

Green PR → `gh pr merge N --admin --squash --delete-branch` (pre-authorized,
§0). After every merge, watch develop's post-merge Test run to conclusion —
required before any release (release.yml refuses to release a SHA whose Test
run isn't `success`).

### 5.3 The flaky mac legs (known, do not chase as regressions)

Two distinct flakes:

- **`test (macos-26-intel)` cancelled BY ITS RUNNER** (preemption, not test
  failure) — repeatedly (4+ times across 2026-09-02→09-04). Handling:
  `gh run rerun <run> --failed`; it has always passed on rerun. **Policy
  decision still pending with the maintainer** (drop the leg / different
  label / live with it) — see §5.4.
- **"Test spawn with multi-yield futures"** (tests/async_await.test.yo ~57)
  asserts STRICT round-robin interleaving of two spawned tasks; under runner
  load the assumption breaks ~once per many runs. Flaked on macos-26-intel
  2026-09-02 (#390's CI; passed on rerun, recorded in
  HANDOVER_STD_AUDIT_2026-09-02.md §0g) and on macos-latest 2026-09-04
  (run 33902170762, first full v0.2.24-seed run — passed on rerun). The test
  wants weakening to "both tasks complete and the total is right" or a
  documented scheduler-order guarantee; **file it properly when touched** —
  it has now flaked twice on two different mac legs.

### 5.4 Decisions to ask the maintainer about (do NOT decide alone)

1. macos-26-intel leg policy (§5.3).
2. Visibility for collections' pub `ctrl/data/…` fields and `process.raw`:
   today the only visibility mechanism is `export(...)` — hiding from
   importers needs either naming discipline or a real module-private
   visibility LANGUAGE feature (a much bigger project; there is an audit
   note that "go private has no language mechanism").
3. Scheduling the match-arm drop-leak codegen fix (§4) — days of emitter
  work, blocked on nothing but priority.
4. Whether the enum-collision compiler fix (unblocks freeze item 13) rides
  before the freeze or the deletion slips to post-freeze (deleting a public
  variant post-freeze is breaking — decide consciously).

### 5.5 Cutting a patch release (procedure, just executed for v0.2.24)

1. Develop's Test run green on the exact head SHA you will release.
2. `gh workflow run release.yml --ref develop -f bump=patch`.
3. The workflow: verifies green → pushes `chore: bump version to X.Y.Z
   [skip ci]` → builds seed bundles from the PREVIOUS release's compiler →
   creates a DRAFT release (stub body = last commit message) → publish job
   flips it public → pushes the SEED_VERSION bump (no `[skip ci]`).
4. While bundles build, set the real notes on the DRAFT:
   `gh release edit vX.Y.Z --notes-file <file>` — the publish job only
   PATCHes `draft=false`, it never touches the body. Match the house style
   of v0.2.23/v0.2.24 notes: sections Compiler fixes / Standard library /
   Breaking changes called out loudly.
5. Verify: release public + 13ish assets (5 bundle tarballs, portable-C
   .c.gz set, .vsix, …), `yo --version` from an extracted tarball, and the
   SEED_VERSION-bump commit's Test run green (rerun macos-26-intel if
   preempted). If a run dies midway: re-dispatch with `bump=none` (it
   resumes at the version already in src/version.yo).

### 5.6 Seed discipline (the yo-seed-gates-source-forms rule)

The seed (previous release's binary) must be able to compile the CURRENT
tree. New source forms (new externs, new lowering shapes) can only enter
`src/`/`std/` once a release CONTAINING the compiler support has become the
seed — typically one release of lag. This gated: the bufio consumer move
(v0.2.18), `sleep_blocking`'s body, the curl→std/http swap (v0.2.20 + the
Windows-TLS twist). SEED_VERSION lives in THREE workflows and is bumped
automatically at release (plans/backlog/SEED_VERSION_AUTOMATION.md). When a
PR "mysteriously" fails only in seed-driven CI jobs, check this first.

### 5.7 Worktrees & hygiene

The last three sessions used `/private/tmp/yo-str` (worktree on develop; now
removed — recreate one the same way when you want an isolated checkout).
`git worktree remove` it when done; remember `git submodule update
vendor/mimalloc` after checkouts (its pointer moved in #181 and drift shows
as a dirty submodule). Never commit the mimalloc drift unintentionally.
Keep `tmp/fixme.yo` for scratch (gitignored). After scripted file surgery,
structure-diff against develop — a python span-deletion once silently
swallowed String's FromIterator impl and only the WASI CI leg caught it.

---

## 6. Yo language facts that cost real time to learn (extracted)

**Rules that bit us (each verified by repro):**

1. **Generic method bodies re-specialize PER CALL SITE, and relative imports
   inside them resolve against the CALLER's directory.** Any import reachable
   from a generic body must be package-absolute (`import("std/libc/windows")`).
   Relative in-arm imports are fine in NON-generic module-level fns. The CI
   windows cross-emit leg catches violations; reproduce locally with
   `yo compile src/main.yo --std-path ./std --target x86_64-pc-windows-msvc`.
2. `extern("C")` declarations are NOT emitted — they rely on system headers
   in the emitted preamble. `c_include("<header>", ...decls)` (see
   `std/libc/stdio.yo`) both includes AND binds. Platform-gated module loads
   (comptime cond arms) keep platform-only headers out of other targets' C
   (e.g. `std/libc/darwin.yo`'s `<crt_externs.h>` is only imported from the
   Platform.Macos arm). `environ` is not exported by macOS headers —
   `_NSGetEnviron()` returns `char ***`, deref once.
3. Block bodies cannot START with `match(` / `cond(` / `unsafe(` — hoist a
   statement first. Typed assigns: `(x : T) = expr;`. Module-level fns:
   `name :: (fn…)`. `{ () }` is not a valid else-arm (use `()`).
   `comptime(T : Type)` doesn't parse — `comptime(T) : Type`. Trailing comma
   before `);` is rejected.
4. Tuples: TYPE `(A; B)` semicolons, VALUE `(a, b)` commas, access `p.0`.
   NO destructuring in match patterns. Pairs in collections use
   `IterPair(A, B)` (prelude struct `_0/_1`). Multi-generic where clauses:
   `where(K <: ToString, V <: ToString)` — the tuple form does NOT work.
5. `u8` does not implement `Pattern` — split on `rune(u32(n))`.
   `1e-12` float literals do not lex — write `f64(0.000000000001)`.
6. `__yo_panic` comptime-evaluates its message — an `.unwrap()` chain has no
   ExprInfo and is rejected; bind through a local (std/assert does).
7. `println`/`eprintln`/`print` come from `std/fmt` (no `io.println`).
   `join` is `separator.join(list)` (receiver-as-separator, Python style —
   documented KEEP).
8. `.Write` OpenMode is O_TRUNC (create-or-overwrite) — tests that set_len
   open `.ReadWrite`. Raw fd reads need a malloc'd `*u8` buffer (an
   ArrayList's length never advances).
9. Diagnostics: buffered `println` inside an exception handler is LOST when
   the assert panic aborts — use `eprintln` (stderr, unbuffered) or
   `panic(msg)`. An uncaught IoError unwind exits the test child with the
   ERRNO as rc (22 = EINVAL).
10. Windows runtime: files open FILE_FLAG_OVERLAPPED; UCRT `_chsize_s`'s
    extend path EINVALs there (shrink works) — use
    `SetFileInformationByHandle(FileEndOfFileInfo)` (see
    `src/codegen/async/runtime_io_windows.yo`).
11. comptime `str` parameters forward into extern variadic calls as C string
    literals (that's what powers `_snprintf_to_string`); comptime TYPE
    equality/dispatch (`T == i8`) is NOT supported.
12. An `ExprInfo.value` of `.None` = runtime value; `UnknownVal` = type
    known, value not. `yo compile` cannot run `*.test.yo` — extract to a
    standalone file with `main` + `export(main);`.
13. A "move" of a named local into a struct field is NOT a consumption in
    the evaluator; dup/drop cancellation is the optimizer's job
    (`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`) — missing
    drops in emitted C are optimizer bugs, and tree walks there must follow
    `ExprInfo.macro_expansion`.
14. Deep CTFE recursion at `-O0` can exhaust the 1 GiB main-worker stack
    (rc=139, no ASan output, deterministic depth threshold) — validate with
    `--release` or `YO_MAIN_STACK_MB=4096`. Don't chase heap corruption.
15. Export placement: an `export` referencing a label must come AFTER its
   declaration in module order; duplicate labels collide across the module
   (check `std/libc/unistd.yo` before declaring `environ` yourself).

---

## 7. Suggested first PR for the next agent

The **error/assert row** (queue item 1): pure std, no blockers, finishes the
original error/fmt/string trio, and its `derive(Error)` half exercises the
derive machinery that just stabilized. Alternatively the **stale-row fix +
testing bench** as a warm-up that teaches the release/merge loop. Start the
Schannel read (item 17) early in the background of wave A — it's the long
pole for closing D6 and landing the carried version_cache swap.
