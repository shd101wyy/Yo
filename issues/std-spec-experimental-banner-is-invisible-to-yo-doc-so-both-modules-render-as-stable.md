# `std/spec`'s EXPERIMENTAL banner is prose, not a `## Stability` section — `yo doc` reports both modules as stable

**Found**: 2026-09-04, taking the inventory of stability markers across `std/` for
the S5 freeze. **Severity:** MEDIUM (published API lie): `std/spec/refine` and
`std/spec/numeric` are Phase 0 identity stubs whose own doc says "Expect ANY change
here, including removal", yet `yo doc` emits `"stability": null` for both — the same
value it emits for `std/string`. Every consumer keyed on the stability channel
therefore classifies them as frozen std surface, which is the exact opposite of the
truth.

## Reproducer

```
$ yo doc ./std/spec --format json -o /tmp/spec        # yo 0.2.24
$ python3 -c "
import json
d = json.load(open('/tmp/spec/doc.json'))
for m in d['modules']:
    print(m['name'], '-> stability =', repr(m.get('stability')))"
numeric -> stability = None
refine -> stability = None

$ yo doc ./std/spec --format html -o /tmp/spechtml
$ grep -c 'class="stability' /tmp/spechtml/module/refine.html /tmp/spechtml/module/numeric.html
/tmp/spechtml/module/refine.html:0
/tmp/spechtml/module/numeric.html:0
```

Expected: a non-null stability marker and a rendered badge on both modules, saying
these are not covered by the std stability promise.

For contrast, `std/term.yo` — which writes the same kind of warning under a
`## Stability` heading — does produce one:

```
$ yo doc ./std/term.yo --format json -o /tmp/t
$ python3 -c "import json;print(json.load(open('/tmp/t/doc.json'))['modules'][0]['stability'])"
unstable — new in this release; the API may still change while `std/cli`
```

## Root cause

The banner is written as ordinary module-doc prose with no heading —
`std/spec/refine.yo:19-23` and `std/spec/numeric.yo:6-10`:

```rust
//!
//! **EXPERIMENTAL — not covered by the std stability promise** (audit spec/
//! verdict: FREEZE AS DOC). These are Phase 0 identity stubs from
//! plans/backlog/FORMAL_VERIFICATION.md; refinement predicates arrive with the
//! Phase 2+ verifier. Expect ANY change here, including removal.
```

`is_section_heading_` (`src/doc/sections.yo:39-47`) recognizes only `## <anything>`
and `# <well-known-name>`, so this text is filed as description, not as the
`stability` section. `module_stability` (`src/doc/builder.yo:92-105`) then looks up
`parse_doc_comment(text).sections.get("stability")`, finds nothing, and returns
`.None`. That `.None` propagates into `DocModule.stability`
(`src/doc/model.yo:179`) and every renderer skips its marker branch on it:
`src/doc/render_json.yo:375` (`_obj_add_opt_str` emits `null`),
`_render_module_content` at `src/doc/render_html.yo:1476-1483`
(`.None => ()`, no badge),
`src/doc/render_markdown.yo:600-606` (no note) and `:795-801` (no index badge).

The text is still visible on the rendered HTML and Markdown pages, inside the module
description — which is why the gap was not noticed. It is invisible in exactly the
place a tool looks. `plans/STD_API_AUDIT.md:540` records the `spec/` row as
"**DONE 2026-09-04**: both files carry an EXPERIMENTAL / not-covered-by-the-stability-promise
banner", so the audit believes this row is closed while `doc.json` says these modules
are stable.

The deeper defect is that one policy now has two mechanisms. The stability policy at
`.github/instructions/yo-design.instructions.md:145-156` defines exactly one — "every
`std` module is **stable** unless its module doc carries a `## Stability` section" —
and `std/spec` opts out of the promise through a channel that definition does not
know about. Anything that audits the freeze from `doc.json`, or any future lint over
`## Stability` sections, will silently get the wrong answer for these two modules.

## Fix

Give `std/spec/refine.yo` and `std/spec/numeric.yo` a real `## Stability` section,
keeping the existing prose as its content:

```rust
//! ## Stability
//!
//! experimental — not covered by the std stability promise. These are Phase 0
//! identity stubs from plans/backlog/FORMAL_VERIFICATION.md; refinement predicates
//! arrive with the Phase 2+ verifier. Expect ANY change here, including removal.
```

That requires two supporting changes, because today's marker vocabulary assumes
"unstable because NEW, for one release":

1. **Widen the vocabulary in the policy.** `yo-design.instructions.md:150-155`
   documents only `unstable — new in vX.Y.Z`. It must also define a
   never-frozen class (`experimental`) that has no expiry, so that a future
   expiry lint does not flag `std/spec` every release. State plainly that
   `experimental` modules are excluded from the additive-only promise
   indefinitely.
2. **Style the new badge.** `src/doc/render_html.yo:1480` derives the badge class
   from the marker's first word and only `.stability-unstable` is defined
   (`src/doc/render_html_assets.yo:244`), so an `experimental` marker would render
   an unstyled `stability-experimental` div. Add the rule — or fix the class
   derivation as recommended in
   `yo-doc-truncates-a-multi-line-stability-marker-to-its-first-line.md`.

Note also that the section must be written on one line, or joined by the fix in that
same issue, or it will be truncated mid-clause.

Then correct the `spec/` row at `plans/STD_API_AUDIT.md:540` to name the mechanism
actually used.

No workaround (teaching `parse_doc_comment` to sniff for the word "EXPERIMENTAL" in
description prose) — that adds a third mechanism to a policy that needs one.

## Regression test

`tests/std_export_coverage.test.yo` (its header is "S5 stability freeze") is the
right home for a policy assertion: for every `std/**.yo` file, if its module doc
mentions the stability promise then it must carry a `## Stability` section. Pair it
with the extraction-side case described in
`yo-doc-html-and-json-stability-rendering-is-exercised-by-no-test.md` so the
`"stability"` key is pinned for both a marked and an unmarked module.
