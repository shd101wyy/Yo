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

There is no package-manager install step. The only vendored dependencies are git
submodules:

```bash
$ git submodule update --init --recursive
```

Type-check the compiler sources (evaluator only, no codegen — this is the fast
iteration loop):

```bash
$ yo check ./src
```

Build the compiler from source. Always pass `--release`: at `-O0` the big
evaluator functions have multi-megabyte stack frames and deep compile-time
recursion exhausts the stack.

```bash
$ yo compile src/main.yo --release -o /tmp/yo-self-bin
```

> There is no watch-and-rebuild loop — re-run the `yo compile` above after a
> change.

Try the compiler you just built on a scratch program (`./tmp/` is gitignored —
put throwaway `.yo` files there):

```bash
$ /tmp/yo-self-bin compile ./tmp/fixme.yo --release -o /tmp/fixme && /tmp/fixme
```

Run the test suites with `yo test`:

```bash
$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail
$ yo test ./tests/internal --parallel 1   # the compiler's own tests
```

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
