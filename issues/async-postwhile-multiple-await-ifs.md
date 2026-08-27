# Two separate awaiting `if` blocks after a cond, inside an async while loop, emit an undeclared `cond_branch_N` slot

**Found**: 2026-08-28 building `std/crypto/tls`'s read pump (branch
`d6/tls-stream`). **Status**: OPEN — std uses ONE post-cond awaiting `if`
(the shape that works); recorded so the second-`if` shape is fixed rather
than rediscovered.

## Shape

Inside an `io.async` body, a `while` loop whose body is:

```rust
while(!(settled), {
  rc := <sync call>;
  (act : int) = int(0);
  cond( ... => { act = int(1); }, ... => { act = int(2); }, ... );
  if(act == int(1), { e.io.await(a, e); e.io.await(b, e); ... });  // block 1
  if(act == int(2), { e.io.await(c, e); });                        // block 2
});
```

emitted (with a co-located FTT elsewhere in the same module — see Caveat) C
referencing `sm->cond_branch_1` where the state struct has no such member:

```c
if (((sm->var_191529) == (((int)(2))))) {
  sm->cond_branch_1 = 9;         // ← undeclared member
  ...await machinery...
```

`error: no member named 'cond_branch_1'`.

## Workaround (what std does)

Collapse to a SINGLE post-cond awaiting `if` with the divergence handled by
a plain flag inside it — the handshake/write pumps' proven shape:

```rust
if(act > int(0), {
  e.io.await(flush, e);
  (got : usize) = usize(1);
  if(act == int(1), { got = e.io.await(feed, e); });
  cond((got == usize(0)) => { ... }, true => ());
});
```

## Caveat

This surfaced alongside a placeholder-driven FTT in the same module (a
`*(void)("")` post-throw arm that did not transpile; fixed separately by
removing the placeholder). An FTT stub replaces a whole function body, which
can corrupt a shared state-struct's field set — so it is possible this
`cond_branch_1` error was a downstream artifact of that FTT rather than an
independent bug. A clean minimal repro (the two-await-if shape WITHOUT any
co-located FTT) was not distilled; distilling one is the first step of the
fix, and if it compiles, close this as FTT-cascade noise.
