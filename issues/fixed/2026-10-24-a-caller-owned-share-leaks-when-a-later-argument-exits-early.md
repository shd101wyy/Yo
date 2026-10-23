# A caller-owned share leaks when a later argument of the same call exits early

**Severity:** S1 — an unbounded leak in accepted safe code: every `return`, `break`, `continue` or unwind taken inside a later argument keeps the borrowed `Rc`/`Arc` cell (and its payload) alive forever.

**Status:** FIXED 2026-10-24 (branch `fix/s1-rc-receiver-alive`). Found by the review of that branch's
receiver keep-alive fix
(`issues/fixed/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.md`).

## Reproducer

`--std-path ./std --optimize 2 --sanitize address --allocator system`:

```yo ignore
W :: struct(s : String);
impl(W, peek2 : (fn(self : &Self, n : i32, act : &Impl(Fn() -> unit)) -> unit)({
  act();
  println(&self.s);
}));
f :: (fn(hs : &ArrayList(Rc(W)), o : Option(i32)) -> unit)({
  hs(usize(0)).peek2(match(o, .Some(v) => v, .None => return(())), () => { println("in"); });
});
// f(&hs, .None) leaks the cell, the W and its String
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
```

The same leak follows from `break`/`continue` (`cond((i == 3) => break, true => i)` as the later argument),
an unwind out of a may-unwind call in a later argument, and a `return` in an `io.async` body.

## Root cause

Aliasing Stage 0 gives a borrowed projection a caller-owned +1 for the call
(`set_expr_as_needs_to_call_dup_for_borrowed_projection`, `src/evaluator/utils.yo`). The dup is emitted where
the argument is evaluated, and its balancing `___drop` rides the CALL node's `deferred_drop_expressions`,
flushed right after the call. The temp is consumed at the dup on purpose, so the multi-exit drop machinery never
releases it on a non-exclusive path. That made the post-call flush the only release, and an exit inside a later
argument skips it:

```c
_tmp6595 = __yo_incr_rc(_tmp1525);
switch (o.tag) { case SOME: ...; case NONE: return; }   /* the share is never released */
peek2(_tmp6595->_u42_, ...);
__yo_decr_rc(_tmp6595);
```

Before the receiver fix, the hole was limited to a copyable value-field projection (`x.r.peek2(<return>, …)` on a
`String` payload). The receiver fix put the share on every handle reached through an `Rc` element or field
(`hs(i).m(…)`, `fs(i).r.m(…)`), so code that was leak-free on develop started leaking.

## Fix

The balancing drop is marked (`mark_call_scoped_share_drop`, `src/expr_info.yo`). While codegen generates a call
that carries one, the drop is on `context.pending_deferred_drops` (`_generate_expr`,
`src/codegen/exprs/generation.yo`). The pending list is what every exit already flushes: `return`, a task's early
completion, the unwind escape check, and `break`/`continue` through the loop baseline. The usual filters (move,
env, initialized-after) do not apply to this temp, because it is consumed at the dup by design. So each exit keeps
the drop exactly when the dup's C declaration is in an open block (`_keep_pending_drop` in `return.yo`, and
`_emit_loop_body_drops_before_exit` plus the task's bare-`return` path in `atom.yo`).

What this produces at each kind of exit:
- **An exit before the dup** (an earlier argument): nothing is released.
- **A loop inside the argument:** its `break` stays inside the argument, because that loop's baseline is taken
  after the drop was pushed.
- **A `return` inside a closure argument:** it belongs to another function body, so the caller's share is not
  touched.
- **After the post-call flush:** the emitted-once guard keeps the drop from firing a second time.

## Tests

`tests/rc.test.yo`:
- "an exit from a later argument releases the share a receiver took through an Rc" covers `return`, `break`,
  `continue`, an unwind, an `Rc` field of an element, and a task's `return`. It counts the payload's destructions,
  so on the pre-fix binary it fails deterministically.
- "an exit inside a later argument or its closure keeps the receiver's share" guards against over-release.
