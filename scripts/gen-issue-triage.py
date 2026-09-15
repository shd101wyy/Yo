#!/usr/bin/env python3
"""Regenerate issues/TRIAGE.md -- a categorised index of the open issue docs.

Run from the repo root:  python3 scripts/gen-issue-triage.py

The MECHANICAL parts (areas, counts, self-reported status, whether a runnable
reproducer exists) are derived from the tree every run. The CURATED parts --
the caveats, and the "confirmed still reproducing" list -- are constants below
and carry the date they were established; update them deliberately.

TRIAGE.md is generated. Edit this script, not the output, or it rots the way
the 149 stale issue references repaired on 2026-09-14 did.
"""
import os, re, collections

AREAS = [
    ("CI/Release/Build", r"^(ci-|release-|build-|version-install|installer-|windows-images|test-matrix|d6-schannel|liburing|the-published-windows|http-limits-test|leak-regression-tests|seed-|v0\.2\.23|fixpoint-|retired-windows|std-s1|emscripten-heap|manifest-package|yo-lock-records)"),
    ("Async / effects", r"^(async-|io-await|io-async|unwind|nested-value-match|a-module-global|pending-io|yield-|sync-main|with-lock|closure-argument-inside|impl-fn-param-captured|spawn-|a-closure-typed-slot|command-stdin|linux-udp|windows-1ms|windows-async|a-ref-value-passed|a-while-in-a-match-arm|impl-method-self-receiver|a-bodyless-http|a-captured-closure)"),
    ("Codegen / emitted C", r"(emits-invalid-c|emitted-c-|^ftt-|^c-include|^cinclude|^dead-yo-stat|^no-volatile|^thread-spawn|^swallowed-closure|^self-hosted-debug|^drop-bookkeeping|^wasm-|^rc-value-copied|^a-box-over|^address-of-a-parameter|^bare-fn-type-param|^asm-documented|^match-arm-and-or|^assign-to-by-value)"),
    ("Evaluator / types", r"^(generic-|dyn-|derive|comptime-|associated-constant|method-call-on-a|equality-operator|module-level-control|mutual-recursion|forward-referenced|annotated-local|blanket-|self-trait|err-expr-id|ctfe-memo|builtin-name|assignment-to-call|anonymous-module|varbound|calling-an-io-param|a-generic-function|iterator-chain|same-operator-chain|unit-zst|where-bound|env-sharing|arraylist-private|borrowed-arg|function-info|comments-preceding)"),
    ("Std library", r"^(std-|stddoc-|http-|url-|ipaddr-|path-|json-|cli-|crypto-|utf16-|unicode-|writer-|hash-|bench-|tempfile-|file-|read-dir-|sys-|walker-|thread-safety|udpsocket|make-sockaddr|string-to-cstr|stringerror|httpmethod|error-source|float-to-string|redirect-|network-path|empty-path|s3-fs|tls-and-datetime|random-f64|blanket-into-iter)"),
    ("Tooling (fmt/doc/lsp)", r"^(yo-fmt|fmt-|yo-doc|doc-|diagnostic-|collection-|template-string|nested-backtick|std-doc-examples|user-facing-async|test-runner-std-path|fixed-async-cond-dispatch-doc)"),
    ("Self-hosting legacy", r"^(yo-self|yoself|self-built|self-hosted-emit|compiler-holds|debug-probe|desugar-token|ts-evaluator|emitted-c-flipped)"),
    ("Vendor (markdown_yo)", r"^vendor-"),
]
ORDER = [a for a, _ in AREAS] + ["Other"]

# Curated 2026-09-14: repro executed AND its output read.
#
# VERDICT DISCIPLINE, learned the hard way on this corpus -- an exit code is a
# proxy and is wrong in BOTH directions here:
#   * exit 0 does not mean pass. `main`'s return value is DISCARDED
#     (issues/main-return-value-is-discarded-...), so 8 reproducers that compute
#     a 0/1 status always exit 0. Most others print evidence and exit 0 anyway.
#   * a non-zero exit does not mean fail. unicode-escape-accepts-non-hex-digits
#     scores COMPILE_FAIL *because its fix works* -- the program is supposed to
#     be rejected now, and the honest score is the diagnostic TEXT.
# So a row is listed below only when its OUTPUT was read against the doc's claim.
CONFIRMED = {
    "stddoc-coll-float-modulo-emits-invalid-c.md": "invalid C: `%` applied to two doubles",
    "stddoc-coll-imm-vec-dedup-leaks-rc-elements.md": "`disposed: 0 (expected 3)`",
    "stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md": "both arms are `.Err(String)`; nothing distinguishes help from error",
    "stddoc-io-arg-parser-positionals-are-never-required.md": "a missing required arg still parses `Ok`",
    "stddoc-io-json-parse-string-accepts-raw-control-bytes.md": "raw control bytes accepted inside a string",
}
# Curated 2026-09-14: verified STILL OPEN by reading the current source (the
# doc's described defect is still present). Distinct from CONFIRMED, which ran
# the reproducer; these were adjudicated by code reading alone.
SOURCE_VERIFIED_OPEN = {
    "stringerror-indexoutofbounds-is-declared-but-no-string-api-can-return-it.md": "the variant is declared at std/string/string.yo:68 with no producer in the module",
    "stddoc-str-string-builder-clear-drops-capacity.md": "`clear` still does `self._buf = ArrayList(u8).new()`, discarding the buffer; ArrayList.clear retains capacity and is the one-line fix",
    "float-to-string-is-platform-dependent-for-non-finite-values.md": "std/fmt/to_string.yo still routes non-finite through %g and says so in its own module doc",
    "make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md": "std/sys/tcp.yo:188 still documents the failure as unreported",
    "bench-with-zero-iterations-returns-min-ns-greater-than-max-ns.md": "min_ns still seeded to i64::MAX with no zero-iteration guard; bench_auto can never pass 0, so a guard is safe",
    "derive-body-field-name-collides-with-a-builtin-type.md": "still fails: derive body renders a field named `unit` as the builtin type",
}
# Curated 2026-09-14: subject no longer exists (the TS compiler died in P2.5).
RETIRE = {
    "ts-evaluator-slow-compile-of-nested-tostring-calls.md": "subject is the DELETED TypeScript evaluator",
    "emitted-c-include-order-differs-ts-vs-self.md": "a TS-vs-self byte-parity divergence; there is only one compiler now",
}

def area(fn):
    for name, rx in AREAS:
        if re.search(rx, fn):
            return name
    return "Other"

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    idir = os.path.join(root, "issues")
    rows = []
    for f in sorted(os.listdir(idir)):
        if not f.endswith(".md") or f in ("README.md", "TRIAGE.md"):
            continue
        txt = open(os.path.join(idir, f), encoding="utf-8", errors="replace").read()
        m = re.search(r"\*\*Status:?\*\*:?\s*([^\n.*]{2,45})", txt[:2500])
        status = m.group(1).strip() if m else ""
        repro = any(os.path.exists(os.path.join(root, p))
                    for p in re.findall(r"issues/repros/[A-Za-z0-9._/-]+\.yo", txt))
        rows.append((area(f), f, status, repro, len(txt)))

    by = collections.OrderedDict((k, []) for k in ORDER)
    for r in rows:
        by[r[0]].append(r)
    out = []
    W = out.append
    W("# `issues/` triage index — open docs, categorised\n")
    W(f"**Generated** by `scripts/gen-issue-triage.py` over the {len(rows)} open docs in")
    W("`issues/` root. A NAVIGATION aid, not a source of truth: each doc stays")
    W("authoritative about itself. Regenerate rather than hand-edit.\n")
    W("""## How to read this

Three things are worth knowing before trusting any row.

1. **A doc's own `Status:` header is a claim, not a verdict.** The 2026-09-14
   pass closed 20 docs whose headers already said FIXED and which had been
   counted as open for months — each verified against the tree first. Treat the
   Status column as "what the doc says about itself".

2. **A repro that exits 0 has not necessarily passed.** Most repros here PRINT
   evidence and exit 0 regardless, so the exit code says the program ran, not
   that the bug is gone. The `Repro` column means only that a reproducer exists.
   Rows under **Confirmed still reproducing** are the ones whose OUTPUT was read.

3. **An expected-value table inside a doc is also a claim.** Two were wrong on
   2026-09-14 — a weekday row, and a "largest valid code point". Derive
   expectations independently, from a spec or a second algorithm, before pinning
   them in a regression test; otherwise red-then-green certifies a wrong answer.

## Counts by area
""")
    W("| Area | Open docs | Has repro |")
    W("| --- | ---: | ---: |")
    for k in ORDER:
        rs = by[k]
        if rs:
            W(f"| {k} | {len(rs)} | {sum(1 for r in rs if r[3])} |")
    W(f"| **Total** | **{len(rows)}** | **{sum(1 for r in rows if r[3])}** |")
    names = {r[1] for r in rows}
    W("\n## Cross-cutting buckets\n")
    W("### Confirmed still reproducing (output read, 2026-09-14)\n")
    W("Ready to work on — the defect was observed, not inferred.\n")
    for f, ev in CONFIRMED.items():
        if f in names:
            W(f"- [`{f}`](./{f}) — {ev}")
    W("\n### Verified still open, by reading the current source\n")
    W("Adjudicated by code reading rather than by running a reproducer — the")
    W("defect the doc describes is still present, so these are safe to pick up.\n")
    for f, ev in SOURCE_VERIFIED_OPEN.items():
        if f in names:
            W(f"- [`{f}`](./{f}) — {ev}")
    W("\n### Retirement candidates — subject no longer exists\n")
    W("The TypeScript compiler was deleted in P2.5. A doc whose SUBJECT is that")
    W("compiler, or whose content is a TS-vs-self divergence, cannot be acted on.\n")
    for f, why in RETIRE.items():
        if f in names:
            W(f"- [`{f}`](./{f}) — {why}")
    W("\n### Duplication — six of the docs once counted as open were not\n")
    W("""Two distinct mechanisms, both invisible to a "does the cited path resolve"
check, and both found on 2026-09-14:

1. **Same name, two directories** (3 docs). A fixing commit COPIED instead of
   MOVING, leaving a stale OPEN snapshot in root beside the FIXED copy.
   `scripts/check-issue-refs.sh` now asserts this cannot happen.
2. **Different name, same defect** (3 pairs: IPv6 RFC 5952, the release-gate
   fast path, IPv4 parse / UdpSocket.send). Fix titles are written from the
   FIXER's point of view — past tense, often consolidating two defects into one
   file — while the original is the REPORTER's, present tense, one defect each.
   No filename check sees that; a title-similarity scan of open docs against
   `fixed/` and `retired/` does, and finding one is usually a sign the code
   already contains the prescribed fix, so READ THE SOURCE before implementing
   any "suggested fix".
""")
    W("\n### Twenty closed docs still carry an OPEN status line\n")
    W("""`scripts/check-issue-refs.sh` now reports these. A doc under `fixed/` or
`retired/` whose `**Status**` line still reads a bare OPEN is either a stale
header or a live bug hiding in the closed pile, and nothing else here can see
the difference — several contradict themselves outright, carrying a `FIXED`
banner at the top and an `OPEN` status line below it.

**Do not bulk-rewrite these headers.** Each needs the same treatment as any
other status claim: check the code. Of the three examined on 2026-09-15, one was
a live-looking blocker (`an ArrayList(Waker)` tracer said to be blocking the
channel rewrite) that turned out to be FIXED — but only reading
`std/async/channel.yo`, and finding the waiter queues present and the 1 ms tick
gone, established that. Rewriting the header to match the directory would have
been the same error as trusting a Status header in the first place, just
pointing the other way.
""")
    W("\n### Reference integrity\n")
    W("`scripts/check-issue-refs.sh` asserts every cited `issues/**` path resolves.")
    W("Run it on the MERGE RESULT, not on a branch: a concurrent move reads as a")
    W("stale reference there, and 'repairing' it reverts someone else's work.\n")
    W("### Largest docs (usually clusters, not single defects)\n")
    for r in sorted(rows, key=lambda r: -r[4])[:8]:
        W(f"- [`{r[1]}`](./{r[1]}) — {r[4]//1000} KB")
    W("\n---\n\n## By area\n")
    for k in ORDER:
        rs = by[k]
        if not rs:
            continue
        W(f"\n### {k} ({len(rs)})\n")
        W("| Doc | Status (self-reported) | Repro |")
        W("| --- | --- | --- |")
        for r in sorted(rs, key=lambda x: x[1]):
            W(f"| [`{r[1]}`](./{r[1]}) | {r[2][:60] if r[2] else '—'} | {'yes' if r[3] else '—'} |")
    open(os.path.join(idir, "TRIAGE.md"), "w").write("\n".join(out) + "\n")
    print(f"issues/TRIAGE.md regenerated: {len(rows)} open docs")

if __name__ == "__main__":
    main()
