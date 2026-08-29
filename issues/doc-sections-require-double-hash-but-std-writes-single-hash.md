# `yo doc` recognizes only `## Section` headings, but std writes `# Examples` (70 sites) — those sections are never extracted

**Status: OPEN.** Found 2026-08-29 adding the `## Stability` module marker
(plans/STD_API_AUDIT.md §9 S5). **Severity:** LOW (rendering only): the text
still appears inside the description, but `# Examples` / `# Returns` /
`# Deprecated` written with a single `#` are not parsed as the well-known
sections (`src/doc/sections.yo` `is_section_heading_` requires `## `), so the
Examples/Deprecated banners and JSON fields are missing for most of std.

Counts (2026-08-29): 70 `//! # …` / `/// # …` headings vs 5 `## …` in `std/`.

## Fix options

1. Accept both `# ` and `## ` as section headings when the heading text is a
   well-known section name (`is_known_section`), keeping arbitrary `#`
   headings as description content.
2. Normalise std to `## `.

Option 1 is the robust one (users will write either); do 2 as well for
consistency. Regression test: `tests/internal/doc_sections.test.yo`.
