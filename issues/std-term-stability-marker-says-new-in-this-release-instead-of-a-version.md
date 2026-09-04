# `std/term`'s stability marker says "new in this release" — a floating reference that has been wrong in four shipped releases

**Found**: 2026-09-04, taking the inventory of `## Stability` markers across `std/`
for the S5 freeze (`plans/STD_API_AUDIT.md` §9). **Severity:** LOW-MEDIUM (published
API lie, and it disables the policy's own expiry rule): the marker rendered on the
docs for v0.2.21, v0.2.22, v0.2.23 and v0.2.24 tells every reader that `std/term` is
"new in this release" when it shipped in v0.2.20.

## What is wrong

`std/term.yo:6-9`:

```rust
//! ## Stability
//!
//! unstable — new in this release; the API may still change while `std/cli`
//! adopts it. It becomes additive-only in the next release.
```

The stability policy at `.github/instructions/yo-design.instructions.md:150-153`
mandates a version, not a deictic:

```
//! ## Stability
//! unstable — new in vX.Y.Z; the API may still change until the next release.
```

The other three markers in the tree comply — `std/encoding/csv.yo:21`,
`std/http/server.yo:19` and `std/fs/watch.yo:29` all say "new in v0.2.20".
`std/term.yo` is the only one that does not.

`std/term.yo` was introduced by commit `4d4f14738` ("std/term: terminal facade …",
#357) on 2026-08-29, before the v0.2.20 version bump `8eb50275d` (2026-08-30), so
`git tag --contains 4d4f14738` starts at **v0.2.20**. The text has never been edited
since. The bundle currently installed on this machine still carries it verbatim
(`~/.local/lib/yo/v0.2.24/std/term.yo:6-9`), so `yo doc` on any release since
v0.2.21 renders a badge whose claim is false:

```
$ yo doc ./std/term.yo --format json -o /tmp/t
$ python3 -c "import json;print(json.load(open('/tmp/t/doc.json'))['modules'][0]['stability'])"
unstable — new in this release; the API may still change while `std/cli`
```

(the mid-clause cut is a separate defect — see
`yo-doc-truncates-a-multi-line-stability-marker-to-its-first-line.md`).

## Why the wording matters beyond the badge

The policy grants a new module exactly **one release** of instability
(`yo-design.instructions.md:150-155`, "unstable for one release … Drop the section to
freeze it"). Whether a marker has expired is decided by comparing the version it
names against the current one. A marker that names no version cannot be checked at
all — not by a reader, not by a reviewer, and not by any future lint. That is the
mechanism by which the expiry went unnoticed for four releases: all four markers in
`std/` name v0.2.20 (or, here, nothing), the current release is v0.2.24, and every
one of them is four releases past its window with nothing having flagged it.

The self-referential phrasing is also unfixable-in-place by design: it is true only
in the release where it is written and becomes false in every later one, so it can
never be correct in a shipped bundle for more than one release.

## Root cause

An author-side content error at `std/term.yo:8`, introduced with the module in
`4d4f14738`, in a channel that nothing validates. The extraction path
(`src/doc/builder.yo:92-105`) takes the section's text verbatim and the renderers
print it; no code inspects the marker's shape, so a deictic passes exactly as a
version does.

## Fix

Two parts, and the first has a decision in it.

1. **Decide `std/term`'s freeze status and write the answer, not a floating one.**
   The module shipped in v0.2.20 and its window closed at v0.2.21. Options:
   (a) freeze it — delete the `## Stability` section entirely, which is the policy's
   own instruction ("Drop the section to freeze it") and the right call for a module
   that is functionally complete;
   (b) extend the window explicitly, re-dating the marker to
   `unstable — new in v0.2.20, still unstable as of v0.2.24; …` with a stated reason.

   **Recommend (a)** unless `std/cli`'s adoption is genuinely still moving the API,
   in which case (b) with the reason spelled out. Whichever is chosen, record it in
   the `plans/STD_API_AUDIT.md` §7 "when frozen" table the policy at
   `yo-design.instructions.md:155` promises — that table does not exist yet
   (`grep -n 'frozen' plans/STD_API_AUDIT.md` finds no such record).

   The same decision is owed for the other three expired markers
   (`std/encoding/csv.yo`, `std/http/server.yo`, `std/fs/watch.yo`); `std/fs/watch`
   and the unmarked `std/crypto/tls.yo` are the two that arguably should stay
   unstable, both because they are platform-incomplete rather than new —
   `std/fs/watch.yo:29` already says "Windows delivery is an open issue" and
   `std/crypto/tls.yo:7-8` says "Windows is not covered yet (Schannel …)". That
   means the marker's vocabulary needs widening from "new" to "new or incomplete"
   at `yo-design.instructions.md:150-155`.

2. **Make the shape checkable.** Add a lint that rejects a `## Stability` section
   whose first line does not name a version matching `v[0-9]+\.[0-9]+\.[0-9]+`, and
   that reports a marker naming a version older than the current one as expired.
   The natural home is the naming/policy checker (`src/naming_checker.yo`) or a std
   test that walks `std/**.yo`; it needs the current version, which
   `src/version.yo` already discovers. Without this, the next marker written with
   "this release" ships the same way.

No workaround (silently re-dating the text to v0.2.24) — that restates a freeze
decision as a newness claim, and starts a fresh one-release clock on a module that
has already been shipping for four.

## Regression test

`tests/std_export_coverage.test.yo` is the existing std-policy test file (its header
is literally "S5 stability freeze"); the shape check belongs there or in a sibling:
walk every `std/**.yo`, and for each file carrying a `## Stability` section assert
its first line matches the versioned template and that the version it names is the
current one. That single assertion is what would have caught both this defect and the
four-release expiry.
