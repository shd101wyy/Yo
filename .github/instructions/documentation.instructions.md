---
applyTo: "docs/**"
description: "Use when writing or editing documentation files. Covers bilingual requirements and code block formatting."
---
# Documentation Conventions

## Bilingual documentation

All documentation in `docs/` must exist in both languages:
- English: `docs/en-US/`
- Chinese: `docs/zh-CN/`

When creating or updating a doc, always update both versions.

## Code block language tag

Use ` ```rust ` (not ` ```yo `) for Yo language code blocks in Markdown files. Rust syntax highlighting renders better on GitHub.
