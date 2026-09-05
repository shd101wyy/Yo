# `yo doc` truncates a multi-line `## Stability` marker to its first line — the badge renders a dangling half-sentence

**Status: FIXED 2026-09-05** — `module_stability` (`src/doc/builder.yo`) now COLLAPSES the whole section — blank lines dropped, remaining lines joined with one space — instead of reading only the first. Pinned by `tests/internal/doc_stability.test.yo`.

**Found**: 2026-09-04, during the std-API-audit re-measurement of the S5
stability-freeze mechanics (`plans/STD_API_AUDIT.md` §9). **Severity:** MEDIUM
(wrong value on a published surface): the freeze marker is the one machine-readable
signal that tells a consumer whether a std module is frozen, and for any marker
written on more than one line it is emitted **cut mid-clause**, in the JSON
`"stability"` key, the HTML badge and the Markdown note alike, with no warning.
`std/term.yo` — the module the audit points at as the reference — is affected today.

## Reproducer

`stab.yo`:

```rust
//! A tiny module.
//!
//! ## Stability
//!
//! unstable — new in v0.2.24; the API may still change while `std/cli`
//! adopts it. It becomes additive-only in the next release.
answer :: (fn() -> i32)(i32(42));
export(answer);
```

```
$ yo doc ./stab.yo --format json -o ./out        # yo 0.2.24
$ python3 -c "import json;print(json.load(open('out/doc.json'))['modules'][0]['stability'])"
unstable — new in v0.2.24; the API may still change while `std/cli`
```

Expected: the whole section —
`unstable — new in v0.2.24; the API may still change while \`std/cli\` adopts it. It becomes additive-only in the next release.`

Markdown is cut the same way (`yo doc ./stab.yo --format markdown`):

```
# stab

> Module path: `stab`

> **Stability: unstable — new in v0.2.24; the API may still change while `std/cli`** — stable modules only change additively; this one may still change.

A tiny module.
```

And so is the HTML badge (`yo doc ./stab.yo --format html`, `out/module/stab.html`):

```html
<div class="stability stability-unstable"><strong>Stability: unstable — new in v0.2.24; the API may still change while `std/cli`</strong> — stable modules only change additively; this one may still change.</div>
```

This is not hypothetical. `std/term.yo:6-9` carries exactly such a two-line marker,
so the shipped v0.2.24 bundle produces:

```
$ yo doc ./std/term.yo --format json -o /tmp/t
$ python3 -c "import json;print(json.load(open('/tmp/t/doc.json'))['modules'][0]['stability'])"
unstable — new in this release; the API may still change while `std/cli`
```

The dropped half — "adopts it. It becomes additive-only in the next release." — is
the half that states the actual promise.

## Root cause

`module_stability` keeps only the FIRST LINE of the section
(`src/doc/builder.yo:92-105`):

```rust
.Some(sec) => {
  first := match(sec.split(`\n`).get(usize(0)), .Some(l) => l, .None => sec);
  Option(String).Some(first.trim())
}
```

Its own doc comment (`src/doc/builder.yo:89-91`) states the rule — "the first line
of its `## Stability` doc section verbatim" — so this is deliberate, but nothing
anywhere enforces the one-line shape the rule assumes. `## Stability` is an ordinary
well-known section (`src/doc/sections.yo:29`) whose content is trimmed but otherwise
preserved whole (`sections.yo:55-103`), and the policy that authors follow
(`.github/instructions/yo-design.instructions.md:145-156`) shows a one-line template
without saying it is load-bearing. An author wrapping at the repo's 80-column house
width — which `std/term.yo` did — silently loses everything after the wrap.

The `Option(String)` that `module_stability` returns is stored on
`src/doc/model.yo:179` and consumed verbatim by all three renderers, so every output
channel inherits the truncation:

- JSON: `src/doc/render_json.yo:375` (`_obj_add_opt_str(… "stability", m.stability)`)
- HTML badge: `_render_module_content`, `src/doc/render_html.yo:1476-1483`
- Markdown note: `src/doc/render_markdown.yo:600-606`; index badge `:795-801`

Note that the FULL section text does survive in the module description (`doc`), so
HTML and Markdown pages print the complete marker again lower down the page — which
is why the truncation went unnoticed. A JSON consumer keyed on `"stability"`, and
anyone reading only the badge, sees the cut string.

### Second defect in the same three lines

`src/doc/render_html.yo:1480` derives the badge's CSS class from the marker's first
WORD:

```rust
level := match(st.split(` `).get(usize(0)), .Some(w) => w.to_lowercase(), .None => st.to_lowercase());
html.push_string(`<div class="stability stability-${_escape_html(level)}">…`);
```

Only `.stability-unstable` exists (`src/doc/render_html_assets.yo:244`), so a marker
that opens with any other word — `experimental`, `deprecated`, `incomplete` — emits a
`stability-<word>` class with no rule behind it and renders unstyled, again with no
warning. `src/doc/render_markdown.yo:795-799` derives its index badge the same way,
where an unexpected first word merely produces a misleading badge label.

## Fix

Two decisions — one in `src/doc/builder.yo`, one in `src/doc/render_html.yo`:

1. **Stop truncating.** Options:
   (a) join the section's lines with a single space and collapse runs of whitespace,
   so a wrapped marker reads as one sentence;
   (b) keep only the first SENTENCE (up to the first `. ` at top level);
   (c) keep the first line but reject a multi-line `## Stability` section with a hard
   error naming the file, so the mistake cannot ship.

   **Recommend (a)**, with (c)'s spirit kept as an assertion the other way: a marker
   is prose meant for one badge, and joining is the behaviour an author writing at
   80 columns expects. (b) silently drops text again — the same class of bug. Update
   the doc comment at `src/doc/builder.yo:89-91` and the policy template at
   `.github/instructions/yo-design.instructions.md:150-155` to say the section may
   wrap.

2. **Constrain the badge vocabulary.** `render_html.yo:1480` should map the first
   word through a closed set — `unstable`, `experimental`, `deprecated` — falling
   back to a generic `stability-other` class that `render_html_assets.yo` styles.
   Add the matching CSS rules. Whatever set is chosen must also be written into the
   policy at `yo-design.instructions.md:150-155`, which today names only `unstable`.

No workaround (re-wrapping `std/term.yo` onto one line) — that leaves the next
author to rediscover it.

## Regression test

`tests/internal/doc_render_markdown.test.yo` already pins the Markdown note
(`:614-630`); extend it with a module whose `stability` is a wrapped two-line marker
and assert the note contains the FULL text including the second line's words.

The extraction itself is untested and `module_stability` is not exported
(`src/doc/builder.yo:3089-3104` lists the module's exports; it is absent), so pinning
it needs either an export plus a case in a new `tests/internal/doc_builder.test.yo`,
or a `tests/internal/doc_render_json.test.yo` that goes through `build_doc_module`
and asserts the `"stability"` key round-trips whole. The HTML badge and the JSON key
have no test file at all today — see
`yo-doc-html-and-json-stability-rendering-is-exercised-by-no-test.md`.
