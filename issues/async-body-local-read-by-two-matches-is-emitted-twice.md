# A local in an `io.async` `while` body, read by two `match`es, is emitted twice

**Status:** OPEN (found 2026-09-13, while writing §4.6's workspace member
expansion).
**Area:** codegen — the async state machine's local spilling.

## Symptom

The C compiler rejects the emitted program:

```
yo-out/aarch64-apple-darwin/bin/yo.c:2889392:16: error: redefinition of 'last_sep'
 2889392 |       __yo_t38 last_sep = sm->var_16564534;
         |                ^
yo-out/aarch64-apple-darwin/bin/yo.c:2889376:16: note: previous definition is here
 2889376 |       __yo_t38 last_sep = sm->var_16564534;
```

Both declarations read the SAME state-machine slot (`sm->var_16564534`), so the
value is right — the declaration is simply emitted once per reader instead of
once per binding.

`yo check` passes: the shape is legal Yo and the fault is in the emitted C.
`yo compile --skip-c-compiler` also passes, because it stops before the C
compiler. Only a full build shows it.

## Shape

Inside an `io.async` body, in a `while` body that also contains an `await`, a
local is bound once and then read by TWO separate `match` expressions:

```rust
while(i < patterns.len(), {
  pattern := patterns(i);
  last_sep := pattern.last_index_of(String.from("/"));      // bound once
  parent   := match(last_sep, .Some(ix) => …, .None => …);  // read 1
  leaf     := match(last_sep, .Some(ix) => …, .None => …);  // read 2
  if(leaf.contains("*"), {
    entries := e.io.await(_read_dir_task(parent, e.io), e); // the await
    …
  });
  i = (i + usize(1));
});
```

One reader emits fine. The await is what makes the body a state machine; without
it the whole thing is an ordinary C block and the duplicate cannot arise.

A minimal reproducer has not been reduced yet — the shape above is from
`src/build_runner.yo`'s `expand_workspace_members` as first written, and it is
recorded here verbatim so the reduction has a starting point.

## Worked around, not fixed

§4.6 lifts the split into a plain `fn` returning a small struct
(`_split_member_pattern`), so the async body binds nothing that two `match`es
read. That is better code anyway, but it is avoidance: the codegen defect is
still there for the next person who writes the natural form.

## Family

This is the same area as the fixed
`issues/fixed/nested-while-loops-in-one-async-body-*` work and the shapes listed
in `.github/skills/yo-async-effects/async-effects-recipes.md` under "io.async
body shapes". The distinguishing feature here is that nothing is nested and no
branch is dropped — a single local is simply DECLARED twice in one scope.
