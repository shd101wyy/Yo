# The seed emits `typedef // Unknown type: …` and only the musl/gcc leg notices — a latent trap for any PR that shifts emission order

**Status:** OPEN (blocked on a seed bump). **Found:** 2026-09-19, triaging the
`Static musl Linux bundle` failure on PR #773 (the `law` builtin).
**Severity:** a live seed defect that turns an ARBITRARY, innocent PR red, with
an error pointing at generated C that the PR did not cause. `develop` is one
emission-order shuffle away from the same failure.

## What happens

The pinned seed (`SEED_VERSION: v0.2.36`) predates #761 (`4ef01a66a`), which
fixed `get_type_string` returning a failure STRING that is then interpolated
into a declaration:

```c
typedef // Unknown type: MaybeUninit(Array(T : (Comptime), U))
```

The "type" is a **line comment**. It swallows the `;` and whatever declaration
follows it. The construction that produces the type is in `std/prelude.yo`
(the open-coded `MaybeUninit` loop).

## Why it is usually invisible

Two independent reasons, and both have to hold:

1. **Only this job compiles seed-emitted C with gcc.** Alpine's `build-base`
   supplies `cc` as GCC; every other Linux leg gets clang, which is invoked
   with `-w`.
2. **What gets swallowed decides whether it is fatal.** On `develop`'s current
   emission order the swallowed neighbour is a `struct`, which degrades to a
   harmless empty declaration. On PR #773 the new builtin's types shifted the
   order so the swallowed neighbour became a `typedef enum` — gcc then reports
   `duplicate 'typedef'` and the link step dies.

**The identical broken line, with the identical mangled name, is present in
the PASSING develop musl emits.** It is proven latent, not introduced.

So a PR that adds no `std/` code and no `MaybeUninit` can still be the one that
goes red, purely by perturbing emission order. That is the trap worth
recording: the failure names generated C in a file the author never touched.

## Fix

**Cut a release from `develop`** (which carries #761) so `SEED_VERSION` moves
past the defect; the release workflow rewrites the pin in all three workflows
itself. Then rebase any affected branch onto the bumped `develop`.

Not acceptable: `sed`-ing the line out of the generated C, disabling the job,
or adding a retry. Each hides a live defect that will resurface on a different
PR.

## Verification

With a bumped seed installed, the marker must be gone from the compiler's own
emit:

```bash
YO_MAIN_STACK_MB=4096 yo compile src/main.yo --optimize 2 --allocator mimalloc \
  --std-path ./std --emit-c --skip-c-compiler -o /tmp/yo-musl > /dev/null
grep -c '^typedef // Unknown type:' /tmp/yo-musl.c    # MUST be 0; it is 1 on the v0.2.36 seed
```

Red-first check that the oracle works at all, using the current seed:

```bash
yo compile issues/repros/newtype-typedef-over-unspecialized-array.yo --optimize 2 \
  --std-path ./std --emit-c --skip-c-compiler -o /tmp/r | grep -c 'Unknown type:'
```

## Adjacent: this failure is needlessly hard to read

The job's Stage 1 dumps the whole emitted C to stdout, so the log is ~230 MB,
`gh run view --log` truncates it **before** the failing step, and the step's
real error cannot be read the normal way — the step name has to be recovered
from the jobs API. Adding `> /dev/null` to that emit (which `release.yml`
already does at its equivalent steps) turns this from an investigation into one
command.
