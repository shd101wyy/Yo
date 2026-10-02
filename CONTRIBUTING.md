# Contributing to Yo

The `Yo` compiler is **self-hosted**: it is written in Yo and lives in
[`src/`](./src/). Building it needs an already-installed `yo` binary
(get one from the [install script](./README.md#install-script-recommended)) plus
a C compiler.

Yo is primarily developed on the Steam Deck LCD (Linux). The compiler currently transpiles Yo to C; to produce
machine code you must have a C compiler (for example `gcc`, `clang`, `zig`, `emcc`, etc).

Please install [nix](https://nixos.org/download.html) and [direnv](https://direnv.net/) before proceeding.

The dev environment is defined in [shell.nix](./shell.nix). You can also manually install the dependencies listed in the file.

## Setup

```bash
$ cd Yo
$ direnv allow . # Run this command to activate the nix shell.
                 # You only need to run it once.
```

The only vendored dependency is `vendor/mimalloc`, a git submodule:

```bash
$ git submodule update --init --recursive
```

The compiler's one Yo dependency, `markdown_yo` (the Markdown renderer behind
`yo doc --format html`), is declared in the repo-root `yo.toml` and fetched by
Yo's own package manager:

```bash
$ yo install
```

Type-check the compiler sources (evaluator only, no codegen). Run this first,
before any longer command:

```bash
$ yo check ./src
```

For repeated edits, keep one checker resident instead of re-running the cold
check. It re-checks only the definitions you changed:

```bash
$ yo check ./src --watch
```

`check` does not run codegen, so it cannot see the async state-machine rules
enforced there. If you touch async code, also run the front half of a compile
(about 3 minutes):

```bash
$ yo compile src/main.yo --skip-c-compiler
```

Build the compiler from source with its own build file,
[`build.yo`](./build.yo). The binary lands in `yo-out/<target>/bin/yo`:

```bash
$ yo build --std-path ./std
```

`--std-path ./std` compiles against this checkout's standard library; without
it the installed `yo` uses the std it ships with. `build.yo` already builds
with `--optimize 2`. Keep that setting whenever you compile the compiler by
hand. At `-O0` the big evaluator functions have multi-megabyte stack frames,
and deep compile-time recursion exhausts the stack. (`--release` was removed;
it was exactly `--optimize 2`.) With a v0.2.43 or later `yo`, the build fits
on an 8 GB machine: about 4.3 GiB peak, C compiler included. `yo build --watch`
rebuilds in-process on every change.

Try the compiler you just built on a scratch program (`./tmp/` is gitignored —
put throwaway `.yo` files there):

```bash
$ yo-out/<target>/bin/yo compile ./tmp/fixme.yo --optimize 2 -o /tmp/fixme && /tmp/fixme
```

Run the test suites with `yo test`:

```bash
# The fast language suite (what `yo build test` runs). Both excludes matter.
$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail
# The standard library's own tests.
$ yo test ./std --bail
# The compiler's own tests. Each file compiles the whole compiler, so run
# them ONE FILE AT A TIME; the whole directory takes over an hour.
$ yo test ./tests/internal/parser.test.yo --parallel 1
```

Before you open a PR:

- run `yo fmt` on every `.yo` file you created or changed (`yo fmt --check`
  verifies; there is no pre-commit hook);
- give every bug you fix an entry in [`issues/`](./issues/) and a test in
  `tests/` that fails before the fix and passes after;
- write user docs in both [`docs/en-US/`](./docs/en-US/) and
  [`docs/zh-CN/`](./docs/zh-CN/).

## LLM and AI-agent contributions are welcome

**Yo is designed to be written by language models**, so contributions produced
with an LLM are welcome here rather than merely tolerated. There is no
disclosure requirement and no separate review track.

What we ask is the same thing we ask of any contributor: **understand the change
you are proposing, and verify it.** A patch nobody can explain is a problem
whether a person or a model wrote it. Concretely, before opening a PR:

- run `yo check ./src` — the fast evaluator-only loop;
- run the tests that cover what you touched (see below), not just the fast ones;
- state what you actually ran in the PR description, including anything that
  failed or that you skipped.

The repository is set up for this. [`AGENTS.md`](./AGENTS.md) is the entry point
an agent should read first; `.github/instructions/` holds per-area rules (C
codegen, debugging, testing, language design, syntax); and `.github/skills/`
ships reusable skill packs. Keeping those current is itself a valued
contribution — if you learn something about Yo the hard way, write it down
there.

## Licensing of contributions

Yo is licensed under the [Apache License 2.0 with LLVM Exceptions](./LICENSE.md)
(`Apache-2.0 WITH LLVM-exception`). Contributions are accepted under that same
license — by opening a pull request you agree that your contribution may be
distributed under it.

There is no CLA to sign, and copyright in your contribution stays yours. What
is asked instead is a Developer Certificate of Origin sign-off: add a
`Signed-off-by` line to each commit, which `git commit -s` does for you.

```
Signed-off-by: Your Name <your.email@example.com>
```

That line is an assertion that you wrote the patch, or otherwise have the right
to submit it under this project's license — the full text is at
<https://developercertificate.org/>. It exists so the project's provenance
stays checkable in the git history alone, which is what makes a future
license decision possible without tracking every contributor down.

If you are running an AI agent, sign off in your own name: the certificate is
about your right to submit the work, not about who or what typed it.
