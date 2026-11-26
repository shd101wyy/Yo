# Yo syntax highlighting on GitHub (Linguist)

**Status:** BACKLOG (maintainer, 2026-11-26). Not started. Revisit when the
popularity numbers in "When to revisit" are met; until then GitHub shows `.yo`
files and ` ```yo ` blocks as plain text.

## Goal

GitHub highlights Yo source: `.yo` files in any repository, ` ```yo ` fenced
blocks in Markdown (READMEs, issues, PRs, `docs/`, `plans/`), and the
repository language bar counts Yo.

## How GitHub decides

GitHub's highlighting and language statistics come from
[Linguist](https://github.com/github-linguist/linguist). A language is
highlighted only when Linguist's `lib/linguist/languages.yml` lists it with a
TextMate grammar. As of 2026-11-26 no Linguist language claims the `.yo`
extension, so a `.yo` file is unknown and a ` ```yo ` block is rendered
unhighlighted.

[Overrides](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md)
(`.gitattributes`) only re-map files to a language Linguist already knows.
They cannot add Yo.

## Options

### A. Add Yo to Linguist (the real fix)

A PR to github-linguist/linguist that adds:

- a `languages.yml` entry: `Yo`, `type: programming`, `extensions: [".yo"]`,
  `tm_scope: source.yo`, `ace_mode: text`, a `color`, and a `language_id`
  from `script/update-ids`;
- the grammar as a submodule under `vendor/grammars/` (Linguist vendors each
  grammar from its own public repository);
- `samples/Yo/` with a few representative, real-world `.yo` files.

What we already have:

- `vscode-extension/syntaxes/yo.tmLanguage.json`, `scopeName: "source.yo"`,
  kept in sync with the lexer, parser and evaluator vocabulary.

Blocking requirement, Linguist's `CONTRIBUTING.md` ("We use GitHub's Search to
assess popularity"):

- at least **2,000 files** with the extension indexed in the last year,
  excluding forks (the count at the top of a GitHub code search for
  `path:*.yo`), for an extension that occurs many times per repository;
- a **reasonable distribution across unique `:user/:repo`** combinations,
  judged by clicking through random results.

Today nearly every `.yo` file on GitHub is in this repository and the example
repositories (markdown-yo, raylib-yo, tetris-yo, markdown-it-yo,
http-server-demo-yo), so a PR would fail the distribution test even if the
file count passes.

Open questions for when we do it:

1. **Grammar license.** Linguist accepts only grammars whose license
   `licensee` recognizes from its approved list. The repository is
   "Apache License v2.0 with LLVM Exceptions" (`LICENSE.md`); check that
   Linguist's license check accepts `Apache-2.0 WITH LLVM-exception`, or
   publish the grammar repository under plain Apache-2.0 or MIT.
2. **Grammar home.** Linguist pulls the grammar as a submodule. A small
   dedicated repository (the grammar plus its license, mirrored from
   `vscode-extension/syntaxes/` by a CI step) is cheaper for Linguist to vendor
   than this whole repository. Decide the mirror direction and who owns it.
3. **Extension conflicts.** Re-check that no language has claimed `.yo` in
   `languages.yml` since 2026-11-26. If one has, Linguist needs a heuristic
   (`lib/linguist/heuristics.yml`) that tells Yo apart, for example by
   `:: import("std/` or `export(main)`.
4. **Grammar quality bar.** GitHub highlights with the grammar as-is, through
   its own TextMate engine; spot-check `.{ }` records, backtick templates,
   `match` arms and `::` definitions on a real GitHub render (Linguist's
   `script/add-grammar` plus the `lightshow` preview).

### B. Override `.yo` to an existing language (stopgap, not recommended)

```text
*.yo linguist-language=Odin
```

Odin is the closest Linguist language (it also declares with `name :: …`). The
costs:

- highlighting is partial and sometimes wrong (records, templates, `match`);
- the repository language bar says Odin, not Yo;
- ` ```yo ` blocks in Markdown are unaffected, and they cannot be re-fenced as
  ` ```odin `: CI fmt-checks Markdown blocks by the `yo` tag.

Not adopted. If tried, do it on a parked branch and compare renders first.

## When to revisit

- A GitHub code search for `.yo` files (excluding forks) shows at least 2,000
  files indexed in the last year, spread across many users' repositories, not
  only `shd101wyy/*`.
- Or Linguist lowers its popularity bar.

## Steps when unblocked

1. Re-run the search and record the counts and a random sample of
   repositories in the PR (Linguist's PR template asks for the search URL).
2. Settle the license and grammar-home questions above; create the grammar
   repository if needed.
3. Fork Linguist; `script/add-grammar <grammar repo URL>`; add the
   `languages.yml` entry; `script/update-ids`; add `samples/Yo/`; run
   `bundle exec rake test`.
4. Open the PR; follow up on review.
5. After the next Linguist release reaches github.com (a few weeks), confirm
   highlighting on a `.yo` file and a ` ```yo ` block, and move this plan to
   `plans/archive/`.
