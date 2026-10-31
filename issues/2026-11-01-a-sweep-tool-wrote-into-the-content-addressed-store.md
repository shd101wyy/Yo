# A sweep/migration tool wrote into the content-addressed store, outside its worktree

**Severity:** S2 — one machine's shared cache silently altered; every project compiling against the mutated entry built wrong code until the bytes were restored by hand (the damage itself is S1-class while it stands — see `issues/fixed/2026-11-01-a-mutated-store-entry-is-reused-by-install-locked.md` — but the defect here is a tool's write discipline, bounded to this box and repairable).

## What happened

At ~04:47 on 2026-11-01, an accessor-migration tool run by an agent rewrote a file inside a PRESENT store entry instead of a copy in its own worktree:

```text
~/.cache/yo/store/sha256/0f767e63487753442dd53d7106d4bc65e4721885080b560a295815f5931e8fdd/src/inline/link.yo
-         (maybe_ref : Option(Reference)) = state.*.env.references.get(&label);
+         (maybe_ref : Option(Reference)) = state.*.env.references.get_cloned(&label);
```

(the markdown-yo v0.2.22 dependency of the Yo compiler itself). The mutation broke `yo compile src/main.yo` on clean checkouts of every develop tip with a deterministic E0610 `No method "clone" on Reference` (`issues/2026-10-31-a-clean-develop-tip-cannot-raw-compile-src-main-yo-e0610-through-the-inline-dep.md`), sent the #1702/#1703 window down a false regression bisect, and cost the evening's B8 critical path. The culprit tool is being identified; this doc records the incident class either way.

## Why it is possible at all

- The store (`~/.cache/yo/store/sha256/<integrity>/…`) is named by content hash but is ORDINARY writable disk. Nothing enforces the read-only contract the naming implies.
- Nothing DETECTED the write: `yo install --locked` reused the entry without re-hashing (the companion issue, fixed same day).
- The repo's own agent rules bound tools to their worktrees, but the cache sits outside every worktree and inside every tool's reach — an accessor-migration sweep that walks "all .yo files under $HOME" pattern-matched the store too.

## Recommendation

1. Every sweep/migration tool must enumerate ONLY its worktree (explicit project paths), never a home-directory walk. A `.yo` file under `~/.cache/yo/store/` belongs to a locked dependency: migrating it changes what every project on the machine compiles, without any project's consent or review.
2. Hard bars worth filing separately if the maintainer wants them: a `yo cache verify` walk that reports entries not hashing to their name, and landing store trees read-only (chmod a-w) so a stray writer fails loudly instead of silently.
3. `yo fix <path>` and friends already refuse paths outside the project; the same guard belongs in whatever sweep scaffolding the culprit tool used.
