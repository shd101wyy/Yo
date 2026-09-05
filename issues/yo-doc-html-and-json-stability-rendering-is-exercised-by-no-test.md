# The `## Stability` marker's HTML badge and JSON key are exercised by no test — only the Markdown note is pinned

**Found**: 2026-09-04, auditing the S5 stability-freeze mechanics
(`plans/STD_API_AUDIT.md` §9, recorded as DONE). **Severity:** LOW (coverage gap, no
runtime symptom of its own) — but it is why
`yo-doc-truncates-a-multi-line-stability-marker-to-its-first-line.md` has shipped
undetected in every release since v0.2.20, and by the audit's own C34 rule ("freezing an export no
test exercises is how a broken API becomes permanent",
`.github/instructions/yo-design.instructions.md:156`) the mechanism that IMPLEMENTS
the freeze should not be the untested part.

## What is and is not covered

The stability marker travels through five stages. Three of them have no test on the
stability path:

| Stage | Code | Test |
|---|---|---|
| section parsing | `src/doc/sections.yo:29`, `:39-47` | `tests/internal/doc_sections.test.yo:137`, `:153-157` — **covered** |
| extraction to `DocModule.stability` | `src/doc/builder.yo:92-105` (`module_stability`) | **none** |
| Markdown note + index badge | `src/doc/render_markdown.yo:600-606`, `:795-801` | `tests/internal/doc_render_markdown.test.yo:614-630` — **covered** |
| HTML badge | `_render_module_content`, `src/doc/render_html.yo:1476-1483` | **none** |
| JSON `"stability"` key | `src/doc/render_json.yo:375` | **none** |

Verifiable:

```
$ ls tests/internal/ | grep -i doc
doc_extractor.test.yo
doc_render_markdown.test.yo
doc_sections.test.yo

$ grep -rn "render_html\|render_json\|module_stability" tests/
(no output)
```

`tests/internal/doc_sections.test.yo:153-157` reaches only as far as
`parse_doc_comment(...).sections.get("stability")` — the raw section — so it cannot
see what `module_stability` does to it afterwards.

The HTML and JSON renderers themselves are not untested in general: the CLI corpus
runs both end to end against recorded golden trees
(`tests/cli-cases/doc-html/cmd`, `tests/cli-cases/doc-json/cmd`, scored by
`scripts/cli-diff-test.sh` against per-file content hashes in `expected_tree`). But
neither fixture module carries a `## Stability` section —
`grep -rn "Stability" tests/cli-cases/doc-*/` returns nothing — so the branch that
renders the badge and the key is never entered. The goldens would catch a change to
it only if a fixture exercised it.

## Consequence, concretely

`module_stability` keeps only the first line of the section
(`src/doc/builder.yo:99-103`). A wrapped two-line marker is therefore emitted cut
mid-clause in the JSON key and the HTML badge. `std/term.yo:6-9` has carried such a
marker since 2026-08-29 and every release since v0.2.20 has shipped the truncated
output. Nothing failed, because nothing looks.

Likewise `src/doc/render_html.yo:1480` derives the badge's CSS class from the
marker's first word while only `.stability-unstable` is defined
(`src/doc/render_html_assets.yo:244`); a marker opening with any other word renders
unstyled and no test would notice.

## Fix

1. **Pin the extraction.** `module_stability` is not exported — the export list at
   `src/doc/builder.yo:3089-3104` does not name it — so it cannot be called from
   `tests/internal/`. Either add it to that export list and test it directly, or
   test it through `build_doc_module`. Direct is cheaper and states the contract
   ("what does a multi-line section become?") most clearly; recommend exporting it.
2. **Add `tests/internal/doc_render_json.test.yo`**, mirroring the shape of
   `doc_render_markdown.test.yo`: build a `DocModule` with
   `stability : Option(String).Some(...)`, render through
   `render_doc_json_string` (`src/doc/render_json.yo:454-457`, the module's only
   export), parse the result and
   assert the `"stability"` key equals the whole marker; plus a second module with
   `.None` asserting the key is `null`.
3. **Add `tests/internal/doc_render_html.test.yo`** asserting that a marked module's
   page contains `class="stability stability-unstable"` and the full marker text,
   that an unmarked module's page contains no `class="stability`, and — once the
   class derivation is constrained (see
   `yo-doc-truncates-a-multi-line-stability-marker-to-its-first-line.md`) — that an
   unrecognized first word falls back to the generic class rather than inventing an
   unstyled one. Note that `src/doc/render_html.yo` exports only `render_doc_site`
   (`:1645-1647`), which takes an `output_dir` and writes a whole site to disk; the
   per-module page builder `_render_module_content` (`:1469-1471`) is private. Export it (as with
   `module_stability`) so the test can assert on the returned HTML string rather
   than shelling out and reading files back.
4. **Give one CLI fixture a `## Stability` section** — a two-line one, so the
   goldens pin the end-to-end text as well. Note the fixture trees are scanned by
   the CI `fmt` gate and their hashes live in `expected_tree`, so the case must be
   re-recorded with `scripts/cli-diff-test.sh --record` after the fixture changes.

These are `tests/internal/` files, which are heavy compiles: run them one at a time
with `--parallel 1`.
