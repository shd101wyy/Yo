# `BufWriter` reflushes forever under the self-hosted compiler (unbased cond-branch index)

**Status: FIXED** 2026-08-09 (`yo-self/codegen/async/state_code_gen.yo`).
Self-hosted compiler only — the reference compiler was always correct.

Reproducer:
[`repros/yoself-post-while-cond-branch-index-unbased.yo`](repros/yoself-post-while-cond-branch-index-unbased.yo)
— 16 bytes through an 8-byte `BufWriter`:

```
$ ./yo-cli compile … -o a.out && ./a.out
content: abcdefghijklmnop            # exit 0

$ /tmp/yo-self compile … -o a.out && timeout 20 ./a.out
                                     # no output, exit 124, 75 MB written
```

**It does not fail — it never stops.** The program writes the same 8 bytes for as
long as you let it. In the temp directory this reached **3.9 GB** before it was
noticed, and it is what made the `bufio` battery time out (rc=124) in
`gates_fast.sh` GATE 1.

## How it presented, and the trap in that

The first visible symptom was `tests/sys/bufio.test.yo` failing under the
**reference** compiler with SIGABRT, which looks like a reference-compiler
regression. It was not:

- a background self-hosted `bufio` run was in the write loop at the same time,
  growing the shared temp file (`$TMPDIR/yo_bufio_auto_flush.txt`);
- the reference run truncates that path on open, writes 16 bytes, then reads it
  back — and read whatever the other process had appended by then;
- so `content == "abcdefghijklmnop"` failed, and `assert` aborted.

Deleting the stale file made the reference test pass immediately. The lesson is
the one already in AGENTS.md — **never run two test processes over the same
directory at once** — with a sharper edge: they collide through `$TMPDIR`, not
just through the repo, and the victim looks like the culprit.

## Root cause

`std/sys/bufio/buf_writer.yo`'s `_flush_inner` is:

```rust
cond(
  (self._buf.len() > usize(0)) => {
    while(runtime(…), { … io.await(IO_file.write(…), io) … });
    self._buf = ArrayList(u8).with_capacity(self._capacity);   // post-while-loop
  },
  true => ()
);
```

The reset is emitted into the resume function guarded by the branch that ran:

```c
after_while_loop_0:
if (sm->cond_branch_0 == 0) {                 // <- self-hosted
  sm->__capture.self->_buf = …;
}
```

but the branch had recorded itself as `2`:

```c
sm->cond_branch_0 = 2;
```

so the reset never ran, `space` stayed `0`, and the writer flushed the same full
buffer on every iteration of `write`'s outer loop, forever.

The mismatch came from `allocCondBranchCodes` — the per-function base that makes
dispatch codes unique across sibling/nested conds (added with the
[nested-match-arm cluster](fixed/async-await-in-nested-match-arms.md)). One of the
two `_attach_cond_branch_post_while` call sites passed the RAW branch index while
the emission beside it wrote `cond_branch_base + ci`:

```rust
em.emit_string_line(`…sm->cond_branch_${idx_s} = ${(cond_branch_base + ci).to_string()};`);
…
_attach_cond_branch_post_while(ci, …);        // <- BUG: unbased
```

The other call site (line 1857) already passed `cond_branch_base + fi`, and
`src/codegen/async/state-code-gen.ts:1203` passes `condBranchBase + i`. One
missed addition.

## Fix

Pass the based index, matching its sibling and the reference:

```rust
_attach_cond_branch_post_while(cond_branch_base + ci, …);
```

## Regression coverage

`tests/sys/bufio.test.yo` ("BufWriter with small buffer flushes automatically")
already covers it and is in the `gates_fast.sh` GATE 1 battery, which runs the
language suite under the SELF-HOSTED binary. The bug was caught by that gate as a
1200 s timeout; it is only opaque because a hang reports as `rc=124` rather than
naming a test.
