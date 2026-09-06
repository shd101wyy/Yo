# Handover — std API audit, the road to the freeze (post-v0.2.24, 2026-09-05)

**Supersedes `plans/HANDOVER_STD_AUDIT_NEXT.md`**, which was measured wrong in
eleven places. Every row below was RE-MEASURED against develop on 2026-09-04/05
by fifteen parallel agents, each of which read the tree and ran reproducers;
the load-bearing claims were then adversarially verified. Where this document
and the audit disagree with the old handover, this document is the one that was
checked.

---

## 0. The standing goal (unchanged)

> "Finish everything in plans/STD_API_AUDIT.md. Update related docs as you
> progress. Document and fix any surfaced bugs and issues. No workaround is
> allowed. Try to stabilize the std API and make it well designed. Feel free to
> admin merge PRs to save CI cycles. Feel free to cut patch release when
> needed."

Plus, from 2026-09-05: **"Feel free to prioritize tasks and adjust the std
APIs."** — API shape decisions are yours to make; say what you decided and why.

---

## 1. What the old handover got wrong

Correct these before trusting any plan built on it.

| Old claim | Truth |
| --- | --- |
| Item 16 `s6/version-cache-std-http` is "carried, blocked on Windows TLS" | **MERGED as #364** on 2026-09-02. `curl` is gone from `src/version_cache.yo`. |
| Freeze item 13 is "**BLOCKED**" by the enum-collision bug | Stale three ways: the bug was fixed (C46, #343), its doc is in `issues/fixed/`, and the deletion **already landed** (#374). `grep KeyNotFound` returns zero hits. |
| §4 lists the enum-collision doc as OPEN | It is in `issues/fixed/`. |
| Item 1: "`AnyError` downcast (`is(T)`/`as(T)`)" is missing | `downcast` exists **end to end** — builtin, `__yo_type_id` vtable tag, tests, and the compiler uses it itself (`src/error.yo:329`). Only the `is`/`as` sugar is absent. |
| Item 1: `derive_rule(Error, …)` will stop enums hand-writing `ToString` | False premise. `derive(ToString)` emits DEBUG text (`Type.Variant(f)`); every std error's `to_string` is human prose. The `Error()` half is 3 lines with ~zero payoff. |
| Item 8: `interval` needs an async iterator protocol | It does not. `std/fs/watch.yo:161` already ships the exact `next(io)`-awaitable shape. |
| Item 15: `std/http/server` and `std/fs/watch` "still need their marker" | Both have carried it since 2026-08-29. The real work is the opposite: **all four existing `unstable` markers expired four releases ago.** |
| Item 12: the `Thread.spawn` blocker "measured fixed-by-events" | False. The exact `join() -> T` shape still emits an undeclared C symbol at v0.2.24. |
| Item 5: hiding collections' pub fields "needs a visibility decision" | No decision needed — 5 of 8 collection modules already use the `_` convention. |
| §4: "~85 open issue docs" | 89 root docs, of which ~17 **declare themselves fixed** and were never moved. Real open ≈ 72. |
| Item 18: D4 PR 9 is real remaining work | Its std+src half (6 of 10 sites) is DONE. Only the vendor submodule half remains, and it is optional cleanup. |

**Queue items the old handover omitted entirely** (they are in the earlier
session diaries and the audit's own §4): the arity-validation-outside-the-swallow
gate, the **systematic registry arc**
(`issues/build-smoke-hangs-registry-perturbation.md`, OPEN), Windows stdin pipe
*writes*, `issues/s3-fs-wrappers-windows-semantics-audit.md`,
`plans/reference/LAZY_TOPLEVEL_BINDINGS.md` P0 (the forward-reference diagnostic), the D8
`env` module-merge, regex extras, O5 Formatter routing, `Dyn(Reader)` (unblocked
since C17), and the builtin-shadowing decision.

---

## 2. What landed this session

| PR | Change |
| --- | --- |
| **#413** | **Windows TLS via Schannel — D6 CLOSED.** No Yo-side change: the `__yo_tls_*` ABI is backend-agnostic, so it is a second C implementation behind `#if defined(_WIN32)`. Also removed the `SkipWindows` from the TLS and HTTP suites (that one pragma had been skipping *all* of `tests/http/http.test.yo` on Windows) after fixing the hollow green underneath them. |
| **#415** | **Comptime `u64`/`usize` above `i64.MAX` was computed SIGNED** — `u64.MAX / 2` folded to `0`, `u64.MAX > 1` to `false`. Runtime was correct, so folded and unfolded forms of the same expression disagreed. |
| **#414** | `parse_f64` rejected every 3- or 8-byte number (`1.5`, `100`, `1e3`); the four integer parsers wrapped on overflow. Blocked on #415, which is what its CI failure root-caused to. |

| **#416** | **HTTP field values per RFC 9112 §5** — the OWS after a colon is optional (`Content-Length:5` was unreadable), the name match was unanchored (`X-Content-Length` supplied the framing), and an unparseable `Content-Length` is now a typed error rather than "no body". Its two new tests were re-shaped to be DEADLINE-FREE: the server writes the response then trailing bytes and closes, so correct framing is a value comparison instead of a race. |
| **#418** | `std/path` records `..` instead of resolving it, and `Path` gains a real root (drive / UNC). |
| **#419** | `File.metadata()` fstats its descriptor; `read_dir` stats `DT_UNKNOWN` entries so walks stop going flat. |
| **#421** | **The stability freeze pass.** `module_stability` published only the FIRST SOURCE LINE of a `## Stability` section, so every wrapped marker was cut mid-clause in the JSON key, the HTML badge and the Markdown note alike. All four `unstable` markers had outlived the one-release window and were decided per module (`std/term`, `std/encoding/csv`, `std/http/server` FROZEN; `std/fs/watch` restated with the real Windows blocker); `std/spec/{refine,numeric}` gained markers — their EXPERIMENTAL banner was prose, so `yo doc` reported them as frozen std surface. |
| **#422** | **`Url.parse` validated no characters at all**, so a URL carrying a raw CRLF split the HTTP request it was fetched with — reachable from caller-supplied text and, via `Location`, from a remote server. Now a strict RFC 3986 §2 byte-set pre-scan (0/12 -> 12/12 rejections, over-rejection canary steady at 10/10). The scheme guard was separately tautological (tested `first`, not `ch`). BREAKING. |
| **#423** | `aligned_alloc` paired with `aligned_free` and the request made portable — on Windows the only reachable pairing corrupted the heap. |
| **#425** | **A `unit` field costs a byte in C**, so `sizeof` must count it — `malloc(n * sizeof(S))` under-allocated for every container of a unit-bearing aggregate. |
| **#426** | **The short-circuit chain leak, and the unrecorded drop behind it** (see below). |
| **#429** | **The trait predicate ignored a generic impl's marker where-clause** — `Type.impls(*NonSend, Send)` said `true`. The `Option`/`Eq` canary rejected two builds before the third stuck; parametric where-constraints stay a documented gap. |

### The two findings that matter most


1. **`comptime_assert` never fires inside a function body.**
   `comptime_assert(false)` is silently accepted in `main`, in a called `fn`,
   and in a `comptime` fn; only module level rejects it. A `test("…", { … })`
   body *is* a function body — so **all 1559 `comptime_assert` calls under
   `tests/`** (1064 in `tests/comptime.test.yo`) assert nothing. This is why the
   comptime signed-arithmetic bug survived.
   `issues/fixed/comptime-assert-never-fires-inside-a-function-body.md` carries the
   reproducer matrix and the fix shape (the C18/C19 flow-violation-channel
   route). **Budget for the fallout triage**: turning 1559 dormant assertions on
   will go red in places, and each red one is either a real bug or a stale
   assertion. Do not weaken assertions to get green.

2. **Windows system libraries live in four places.** Adding `-lsecur32
   -lcrypt32` to `src/main.yo` was not enough — a cross-emitted compiler is
   linked by CI's own clang line. Before adding any system library:
   `grep -rn 'lws2_32' .github/workflows/ scripts/ src/` and update every hit in
   the same commit. Recorded in
   `issues/installer-source-build-never-links-liburing.md`.

---

## 3. Working method that proved itself

- **Re-measure before executing.** Eleven of the old queue's rows were wrong.
  The measurement pass cost one round of parallel agents and saved far more.
- **A local gate beats a CI round trip.** `zig cc -target x86_64-windows-gnu`
  compiles and links emitted Windows C against MinGW headers with the same
  warning flags `src/main.yo` passes — ~40 s instead of ~50 min. The recipe is
  in `.github/instructions/c-codegen.instructions.md`.
- **Prove the test red first, and prove it is not vacuous.** Two separate
  traps hit this session: tests whose handler `unwind`s out of the body before
  the assertion (the live-TLS tests), and `comptime_assert` in a dead position.
  Both looked green.
- **Byte-identity is the right gate for an emitter refactor.** Extract the
  emitter's string literals, unescape, diff against `HEAD`: proves no target's C
  changed without a rebuild.

---

## 4. The defect backlog this session created

Fifteen measurement agents and fourteen filing agents produced **76 new
`issues/` docs**, every one with a reproducer that was RUN (or, where it is a
compile-time claim, `yo check`ed) against develop at `8d471c7df` on v0.2.24.
They are in `issues/` (root = open). By class:

- **memory-unsafety / crash (7)** — `sizeof` of an aggregate with a `unit` field
  disagrees with the emitted C struct, so `malloc(n * sizeof(S))`
  under-allocates (fixed in #425); `GlobalAllocator.aligned_alloc` is exported with no
  `aligned_free` (on Windows the only available pairing corrupts the heap) —
  **FIXED 2026-09-05, audit row C64**;
  a `Dyn` box's dispose is emitted with an EMPTY BODY, so every value boxed into
  a `Dyn` leaks — and `AnyError` is `Dyn(Error)`, so that is every thrown error;
  `derive(Eq)`/`Clone`/`Ord` over a fixed-size `Array` field passes `check`,
  links, and `abort()`s at runtime; `downcast` to a never-`dyn()`-wrapped value
  type emits invalid C; `punycode_encode` in the vendored markdown reads past
  its buffer.
- **wrong value (≈30)** — including two with a security face: `Url.parse`
  validates no characters at all, so a URL carrying a raw CRLF **splits the HTTP
  request** it is fetched with; and the HTTP header lookup was an unanchored
  substring match, so `X-Content-Length:` supplied the framing (fixed in #416).
  Also: eight RFC-3986 defects in redirect resolution, `Path.new` dropping a
  leading `..` and destroying the Windows UNC prefix, `File.from_fd().metadata()`
  returning the CWD's metadata, `readdir` mapping `DT_UNKNOWN` to
  `FileType.Other` so walks silently go flat (and `remove_dir_all` then calls
  `remove_file` on directories), `json_stringify` losing every number past 6
  significant digits, `toml_parse` returning `.Ok` with corrupted data for eight
  classes of legal TOML, `String.to_cstr` truncating at an interior NUL, and the
  LSP emitting rune columns where the protocol says UTF-16.
- **api lie (≈20)** — declared-and-never-enforced `ArgDef._required`, error
  variants no code path can produce, `std/cli`'s own documented example aborting
  on `--help`, `FunctionInfo.is_closure` hardcoded to `false`, `asm()` shipping
  none of the validation its manual promises.
- **papercut (≈19)** — including 194 documentation examples that show
  `:: import "path"` without parentheses, a form the parser rejects outright.

**Read `issues/` before starting any queue row** — several rows turn out to be
blocked on, or much larger than, what the row says, and the blocker is now
written down.

## 4b. Three defects found by VERIFYING other people's fixes

Worth calling out as a method, not just as bugs — each was invisible from the
change itself and only appeared under independent measurement.

1. **`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`.**
   The regression net added with #409 PASSES 3/3 under the compiler that still
   has the bug it was written for. It asserts only values; the leak verdict
   meant to fail it is disabled in every CI job (`YO_TEST_LEAK_VERDICT: "0"` ->
   `detect_leaks=0`), and `--sanitize address` on macOS emits a binary with ZERO
   `__asan` symbols. Fixed in #426 by making the leak a `Dispose` counter — an
   ordinary value assertion that works under the ratchet on every platform.
   **Treat every leak-shaped test in `tests/` as unverified until re-measured
   with `leaks --atExit`.**

2. **`issues/drop-bookkeeping-hangs-off-a-generator-return-value-that-is-empty-for-multi-line-drops.md`.**
   `_call_generate_expr(drop_expr, ...)` does not always RETURN the drop code —
   for an enum/`Option` target it lowers to a multi-line `switch` that
   `drop_dup.yo` writes DIRECTLY to the emitter, returning `""`. So the
   near-universal `if(drop_code.len() > usize(0), { ...emit...; record... })`
   emits the drop and skips the recording, leaving it emittable a second time.
   This is the double-drop that sank two prior attempts at the chain fix, and
   the answer to the "uninstrumented fourth emitter" in that record — there is
   no fourth emitter. Fixed in `and_or.yo`; **still live at `begin.yo:154` and
   `drop_dup.yo:895`.**

3. **`issues/comptime-str-passed-where-string-is-declared-emits-invalid-c.md`.**
   A `"..."` literal passed where `String` is declared passes `yo check` and
   then emits a C cast to a struct type. The C19 class.

**The method that produced all three:** build the fix, then measure it against
a compiler that predates it. A published release is a free before-oracle —
`yo` 0.2.24 predates #409 by four hours. Per-shape numbers beat a single
aggregate: the shape table is what showed #409 closed the two-operand family
and only HALVED chains.

## 5. What to do next, in order


1. ~~**Land the four PRs in flight**~~ **DONE** — #414, #415, #416 landed;
   #413 (Schannel) passed its Windows legs and is re-running after a rebase.
   **Cutting the patch release is still open**, and the release notes must call
   out FOUR breaking changes now, not two:
   - integer parsers reject overflow instead of wrapping (#414);
   - `Content-Length` parsing rejects what it used to accept (#416);
   - `Path` records `..` instead of resolving it (#418);
   - **`Url.parse` rejects raw spaces, raw non-ASCII and control bytes** (#422)
     — the one most likely to surface in existing code, because a space is the
     byte people forget to encode;
   - `sizeof(unit)` is now 1, not 0 (#425);
   - `std/term`, `std/encoding/csv` and `std/http/server` are FROZEN, so they
     may only change additively from here (#421).
2. **`comptime_assert` (issues/fixed/comptime-assert-never-fires-inside-a-function-body.md).**
   Nothing else on this list is worth much while the comptime suite verifies
   nothing. Measure the fallout first, then land the change and its triage
   together.
3. **The memory-unsafety seven.** They are small, independent, and each has a
   reproducer.
4. **The freeze inputs** (§9 of the audit): the `unstable` markers have all
   expired, `yo doc` truncates a multi-line marker to its first line, and the
   coverage read re-measures at **163 of 610** non-`sys`/`libc` exports never
   named under `tests/` — of which only 16 are genuinely risky. That triage is
   in `issues/`.
5. **The std rows** themselves, re-scoped per §1 above.
