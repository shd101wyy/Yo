# `f(&x.*)` with `x : &T` into a `&T` parameter: should the canonical spelling be the bare `f(x)`?

**Kind:** design question

**Status:** OPEN. Filed 2026-11-15 by the v0.2.78 coordinator. It came up in the
maintainer's review of #1961, the deref text sweep.

## What

The deref text sweep (#1961) rewrote every `&x` of a reference binding in std and
src to `&x.*`. Before the retype, `&x` on a reference binding lent the referent.
Since VERDICTS-31 P3, `&x` on a reference binding is a `&&T`, and there is no
deref coercion, so `&x` into a `&T` slot is a type error naming `x`. The
migration therefore wrote the exact new meaning, the explicit reborrow `&x.*`,
and kept the author's `&`:

```yo ignore
// before #1961 (develop 82c6588a0, src/build_runner.yo)
owned_blocked.push(_dependency_failed(&node, results));
// after #1961
owned_blocked.push(_dependency_failed(&node.*, results));
```

When `x : &T` and the parameter is `&T`, the bare `f(x)` passes the same
reference (`.github/instructions/yo-syntax.instructions.md`: "`f(v)` into a
reference parameter ... stay[s] bare"). The two spellings should lower to the
same C. The tree now carries an upper bound of about 1,824 textual `&x.*`
arguments: 1,770 in 141 src files and 54 in 12 std files (develop
`713828658`, `git grep -E '[(, ]&[a-z_][a-z_0-9]*\.\*[,)]'`). Not all of them are
redundant:

- **`x : &T` into a `&T` parameter** is redundant. The bare `x` means the same.
- **`x : &mut T` into a `&T` parameter** is an explicit shared reborrow. Whether
  the bare `x` type-checks there under "nothing coerces" has not been checked.
- **`x` a `Box`/`Rc`/raw pointer, or a reference to one**: `&x.*` borrows the
  payload, a different value from `x`. It is not redundant.
- **A generic parameter**: a bare `x` into a by-value `T` instantiates `T := &U`
  and copies the reference. `&x.*` into `&T` lends `U`. These differ.

## Why `yo fmt` cannot do it

`yo fmt` parses and never evaluates. Telling the first row from the other three
needs the type of `x` and of the parameter slot, and only the evaluator has
those. So the rewrite belongs in `yo fix` (a structured repair) and, if wanted,
a `check`-time diagnostic, not the formatter.

## Options

1. **Keep `&x.*` everywhere.** It is uniform, it states every lend at the call
   site (the "every lend visible" preference behind no-deref-coercion,
   VERDICTS-31), and it costs nothing at run time. But the tree then has two
   spellings of the same call, the bare form already being legal.
2. **The bare `f(x)` is canonical for the redundant row; `&x.*` stays legal.**
   A one-shot `yo fix` rewrite sweeps std and src. A warning with a `yo fix`
   repair attached (like Clippy's `needless_borrow`) keeps new code canonical.
3. **Like 2, without the warning**: a one-shot sweep only, and new code is free
   to use either form.

## Recommendation

Option 2, after the deref flip (v0.2.79). By then the flip's own `--migrate
deref` re-run has finished with std and src, and bare `x` reads the new way
everywhere. Before the flip, std/src keep the exemption, under which a bare `x`
"still reads the old way". That is equivalent for a reference argument but
would make the rewrite depend on the exemption's reading.

- **Rule.** A reference binding passed to a parameter of the same reference
  kind is written bare. `&x.*` stays legal: it is the only spelling of a
  `&mut T` → `&T` reborrow until the bare form is shown to type-check there,
  and it is required whenever `.*` reaches a payload.
- **Mechanism.** The redundant row gets a warning (a new `W` code in the
  `yo explain` registry) carrying a `yo fix` repair. Then sweep std and src with
  `yo fix` once, after the flip PR lands. The repair fires only when the
  evaluator has proved `x : &T` and a `&T` slot; generic slots are never
  rewritten.
- **Gate.** `fixpoint_only.sh` must hold. The emitted C should be
  byte-identical on a sample of rewritten files. If it is not, that difference
  is a finding of its own.

Not v0.2.78: #1961 is merged and gated, and churning about 1,800 lines now
would cost a rebuild cycle on the release's critical path.
