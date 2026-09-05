# `std/term`'s `unstable` marker is undatable, four releases past its window, and names an exit condition that never happened

**Found**: 2026-09-04, by the std-API-audit re-measurement of the `cli` row.
**Severity**: LOW (papercut), but it is a published stability promise on a
shipped module and it renders into `yo doc`. **Status**: OPEN.

## The marker

`std/term.yo:5-9`:

```rust
//!
//! ## Stability
//!
//! unstable — new in this release; the API may still change while `std/cli`
//! adopts it. It becomes additive-only in the next release.
```

Three things are wrong with it, and the third is the one that matters.

**1. "new in this release" is undatable.** Every sibling marker names a version:

```
std/encoding/csv.yo:21  unstable — new in v0.2.20; the API may still change until the next release.
std/http/server.yo:19   unstable — new in v0.2.20; the API may still change until the next release.
std/fs/watch.yo:29      unstable — new in v0.2.20; the API may still change until the next release (Windows delivery is an open issue).
```

and the policy's own template does too
(`.github/instructions/yo-design.instructions.md:150-155`:
`unstable — new in vX.Y.Z; the API may still change until the next release.`).
A reader of the rendered doc page cannot tell which release "this release" was.

**2. The one-release window has long expired.** `std/term` landed in
`4d4f14738` ("std/term: terminal facade …", PR #357) on **2026-08-29**, before
the `v0.2.20` tag dated 2026-08-30, and `git cat-file -e v0.2.20:std/term.yo`
confirms it shipped in that release. The current version is
`src/version.yo:22` → `CURRENT_YO_VERSION :: "0.2.24"`. So the module has now
shipped in v0.2.20, .21, .22, .23 and .24 still carrying a marker that promised
to expire after one release.

**3. The stated exit condition is unmet and cannot be reached passively.** The
marker's condition is *"while `std/cli` adopts it"*. `std/cli` does not import
`std/term` and never has:

```
$ grep -n import std/cli/arg_parser.yo
9://! { ArgParser } :: import "std/cli/arg_parser";
10://! { args } :: import "std/env";
19:open(import("../collections/array_list"));
20:open(import("../string"));
```

`grep -rn 'term|color|ansi' std/cli/` returns nothing — `std/cli` emits no
colour and has no stream-aware entry point to consult (`help_text`,
`std/cli/arg_parser.yo:229-354`, returns a `String` with no stream context). Nor
is there anything for it to adopt on the colour side: `std/term` has detection
only — `is_terminal` (`:29`), `size_of` (`:34`), `size`, `supports_color`,
`enter_raw_mode`/`restore_mode` — and no ANSI style vocabulary anywhere in
`std/`. So the marker gates its own expiry on work that is not scheduled, in a
module that has no ANSI vocabulary to hand over.

The policy this violates is explicit
(`.github/instructions/yo-design.instructions.md:150-155`):

> A NEW module enters as `unstable` for one release … `yo doc` renders the
> marker (HTML badge, `"stability"` in JSON, a note in Markdown); the audit's §7
> table records when a module was frozen. **Drop the section to freeze it.**

## Reproducer

Not a runtime defect — verified by reading the tree:

```
$ sed -n '5,9p' std/term.yo
$ git log --format='%h %ad %s' --date=short --diff-filter=A -- std/term.yo | tail -1
4d4f14738 2026-08-29 std/term: terminal facade — is_terminal, size, supports_color, raw mode (unstable) (#357)
$ git log -1 --format='%ad' --date=short v0.2.20
2026-08-30
$ git cat-file -e v0.2.20:std/term.yo && echo present
present
$ grep -n CURRENT_YO_VERSION src/version.yo
22:CURRENT_YO_VERSION :: "0.2.24";
```

## Fix

Decide the module's actual status and write it down. Two honest options:

- **(a) Freeze it.** Delete the `## Stability` section from `std/term.yo:5-9`.
  `std/term` becomes stable and additive-only, and a future colour vocabulary
  is an additive addition that needs no unstable window. Record the freeze in
  `plans/STD_API_AUDIT.md` §7.
- **(b) Restate it with a real reason and a real version.** Replace the text
  with the sibling wording and a condition that is actually reachable, e.g.
  `unstable — new in v0.2.20; no in-tree consumer yet, so the API may still
  change until one exercises it.`

**Recommend (a).** The module's surface is small, is exercised by its tests, and
the stated blocker — `std/cli` adoption — is not scheduled and is now known to
be a *new API in two modules* rather than a swap (`std/term` has no ANSI
vocabulary to adopt). Keeping a module unstable indefinitely on a condition
nobody owns is exactly the drift the one-release rule exists to prevent. If the
colour vocabulary is added later, it is additive and does not need the module
reopened.

**Do the same audit pass on the three siblings while there.**
`std/encoding/csv.yo:21`, `std/http/server.yo:19` and `std/fs/watch.yo:29` all
say "new in v0.2.20 … until the next release" and are equally four releases
past that window. `std/fs/watch` names a genuine open blocker (Windows
delivery) and can legitimately stay unstable with its text updated to say so;
the other two need a freeze/restate decision like `std/term`'s. All four are
the complete set — `grep -rln '## Stability' std/` returns exactly those four
files.

## Breaking change

No. Dropping the section is a promise being kept, not an API change. Note the
consequence: after the freeze, changes to `std/term` must be additive
(`.github/instructions/yo-design.instructions.md:149`), which is the point of
deciding deliberately rather than letting the marker rot.

## Regression test

No unit test can pin a doc marker's truthfulness. Two mechanical guards are
available and either would have caught this:

- Extend the `plans/STD_API_AUDIT.md` §7 table to record, per unstable module,
  the version it entered in — and add a CI check that fails when a module has
  carried `## Stability` across more than one release since that recorded
  version.
- At minimum, a grep gate that rejects the phrase `new in this release` in
  `std/**.yo`, since it is undatable by construction and the policy template
  requires `new in vX.Y.Z`.

Recommend the grep gate now (one line, catches the undatable spelling
immediately) and the §7 table check when the audit's stability section is next
touched.
