# The `yo context` command

`yo context` prints the **agent context pack**: the curated, language-only
guide that ships inside the `yo` binary's distribution. It is written for AI
coding agents — which have no Yo in pretraining — but it doubles as the
fastest orientation for humans too.

## What the pack contains

The pack is one markdown file, capped at 24 KB so it fits any model's
context window. It covers **language facts only**:

- the declaration forms and the brace rule (a `{ ... }` group is a record
  unless it has a `;`),
- the no-precedence rule (parenthesize every infix chain),
- control flow (`cond`, `match`, `if`), pattern matching, traits, impls,
  derives,
- ownership, failure (`Option`/`Result`/exceptions), async and effects,
- the toolchain loop (`yo check` after every edit, `yo test`, `yo fmt`).

It deliberately carries **no API listings** — APIs drift every release, and
the pack must not. API discovery is the job of `yo doc` (rendered
documentation) and the LSP; from v0.2.40 onward the `yo context` family
grows query modes over a generated std index (`plans/YO_CONTEXT.md`
phases C2–C5).

## Usage

```bash
yo context
```

Output starts with a citation header naming the toolchain version and the
pack revision, so an agent can cite what it read:

```text
yo 0.2.40 — pack-version: 1
# Yo — context pack for coding agents
...
```

## Where the pack is found

The lookup order mirrors `yo skills install`'s:

1. `$YO_CONTEXT_PACK` — an explicit path to the `context.md` file or its
   `pack` directory. **Authoritative**: when set, it is THE pack — an
   invalid value is a loud error, never a silent fallback (useful in CI,
   and how the cli-cases pin it);
2. beside the running executable, walking up ancestors — a release bundle
   unpacks to `bin/yo` + `std/` + `pack/`, so an installed toolchain always
   finds its own pack;
3. beside the working directory, walking up ancestors — running an
   installed `yo` from inside a Yo checkout finds the checkout's own
   `pack/`.

If nothing is found (a broken packaging), the command names the locations
it tried and exits 1.

The pack source of truth is `pack/context.md` in the compiler tree; the
release workflow copies it into every bundle, and the bundle smoke tests
assert that `yo context` answers from outside the checkout.
