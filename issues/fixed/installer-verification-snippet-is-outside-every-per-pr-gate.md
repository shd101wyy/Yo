# Yo source embedded in scripts/workflows is outside every per-PR gate

**Status:** FIXED — `scripts/check-embedded-yo.sh`, wired as GATE 8 of
`scripts/bootstrap/gates_fast.sh`.

## Symptom

A user ran `bash scripts/install.sh` and the installer failed its own
verification step against the release it had just downloaded:

```
Installing Yo v0.2.30 for macos-arm64
Verifying (compiling a hello world)..
Verification FAILED. Compiler output:
error[E0401]: Variable "open" not found.
  --> /var/folders/.../hello.yo:1:1
  |
1 | open(import("std/fmt"));
  | ^^^^
help: did you mean "Send"?
The install is present but cannot compile. See the output above.
```

## What was actually wrong in that instance

Nothing in `develop`, in the `v0.2.30` tag, or in the published
`https://shd101wyy.github.io/Yo/install.sh`. All three already carry
`{ println } :: import("std/fmt");` — #530 ("remove the `open(...)` builtin")
converted the snippet with the rest of the tree, and the site copy is
regenerated from `scripts/install.sh` by `scripts/build_site.yo` on every
deploy. Verified:

```
$ git show v0.2.29:scripts/install.sh | grep -c 'open(import'   # 1
$ git show v0.2.30:scripts/install.sh | grep -c 'open(import'   # 0
$ curl -fsSL https://shd101wyy.github.io/Yo/install.sh | sed -n 865p
{ println } :: import("std/fmt");
```

The failing script was a **local checkout 99 commits behind `develop`**, on a
branch cut before #530. `install.sh` resolves and installs the *latest* release
regardless of its own age, so an old copy of the script hands an old hello
world to a new compiler.

## The real defect

Six Yo programs live INSIDE other files, and nothing checks them per-PR:

| program | host | when it is exercised today |
| --- | --- | --- |
| installer verification hello world | `scripts/install.sh` | `install-scripts.yml`, paths-filtered to that file |
| ditto, Windows | `scripts/install.ps1` | ditto |
| post-install smoke | `.github/workflows/install-scripts.yml` (POSIX leg) | that workflow only |
| ditto, Windows leg | same file | that workflow only |
| bundle smoke ×3 | `.github/workflows/release.yml` | **release time only** |

`yo check ./std` and `yo check ./src` cover the directories that hold `.yo`
files; the language suite covers `tests/`. None of them can see Yo source
embedded in a shell script, a PowerShell script or a YAML block scalar. And
`install-scripts.yml` is `paths`-filtered to the two installer files plus
itself, with a Monday 07:00 UTC schedule as the only other trigger.

So a language change that removes a form one of those snippets uses **lands
green on every required check**, and the breakage surfaces to a user at install
time — up to a week later — with a diagnostic that reads like a broken release.
#530 happened to edit `install.sh`, which is why it tripped the path filter and
was fixed there; a removal landed anywhere else would not have been.

`scripts/build_site.yo` is a seventh instance of the same class, and the
obvious mitigation does not work: `test.yml`'s `docs-site` job does compile it
on every PR, but **with the SEED compiler** (`env.SEED_VERSION`, with
`YO_STD=$GITHUB_WORKSPACE/std`). A seed by definition still accepts every form
it shipped with, so it cannot reject a form the tree just removed. That job
catches std API drift, not language removals. It is left as-is here: the file
is at least compiled somewhere, and `yo build`'s own bootstrap does not include
it.

## Fix

`scripts/check-embedded-yo.sh <path-to-yo> [workdir]`, run as GATE 8 of
`gates_fast.sh` (so: every PR via the `bootstrap-self-test` job, and locally):

1. **Extracts** each snippet from its host file — the `YOEOF` here-doc, the
   PowerShell `@' … '@` here-string, the YAML-indented here-docs (dedented),
   and `release.yml`'s `printf '%s\n' … > hello.yo` one-liners (re-run through
   the shell rather than re-parsing their quoting). Extraction, never a copy:
   a copy drifts, and drift is the failure being prevented.
2. Fails if an extraction yields **nothing**, so moving a marker cannot
   silently turn the gate vacuous.
3. **Compiles and runs** each with the tree compiler and asserts stdout equals
   the line its host file itself asserts (`Yo is installed`, `installed ok`,
   `hello from the yo seed`).
4. Asserts the two installers embed **identical** programs, and that
   `release.yml`'s three sites smoke identical programs.

Verified to catch the original regression — reintroducing
`open(import("std/fmt"));` in `scripts/install.sh` produces:

```
FAIL: scripts/install.sh verify snippet: does not compile
    error[E0401]: Variable "open" not found.
FAIL: install.sh and install.ps1 verify DIFFERENT programs
```

and a clean tree reports `EMBEDDED_YO: sites=7 failures=0`.

## Also changed

Both installers now name the stale-copy possibility when verification fails,
because the compiler output alone reads like a broken release:

```
If this copy of install.sh is older than v0.2.30, it may be compiling a hello
world that v0.2.30 no longer accepts. Re-fetch the installer and retry:
  curl -fsSL https://shd101wyy.github.io/Yo/install.sh | sh
```

That is the diagnosis that took a full debugging cycle to reach here.
