# Early `return` inside a nested arm emitted the scope-end drop of a LATER local through a same-named pattern variable

**Status: OPEN (2026-09-07). Not yet minimized — two direct reproduction attempts
compile and run correctly; the shape below is the one that failed, verbatim from
the branch's build log.** Worked around in `src/evaluator/effects/mutation_summary.yo`
by renaming the later local (`a` → `an`).

## Symptom (seed `yo 0.2.27` compiling `src/`, `yo build`)

```
yo.c:935587:25: error: member reference type '__yo_t6 *' is a pointer; did you mean to use '->'?
 935587 | __yo_decr_rc((void*)((a).mask));
yo.c:935587:26: error: no member named 'mask' in 'struct __yo_t6_struct'
```

emitted in the drop block of an early `return(())`, next to the drops of the
locals `cpt`, `cvt` and a temp that ARE in scope there.

## Shape

Inside one `impl` method body (`_MsP.strict_walk`), all within the same
`.FuncVal(fvd, _) => { … }` match-arm block:

```rust
(cpt : ArrayList(TypeValue)) = ArrayList(TypeValue).new();
(cvt : ArrayList(TypeValue)) = ArrayList(TypeValue).new();
match(callee_extern,
  .Some(en) => {
    (xi : usize) = usize(0);
    while(xi < args.len(), {
      match(args.get(xi), .Some(a) => match(_msp_arg_base_var(a, table), …), .None => ());
      xi = (xi + usize(1));
    });
    return(());              // <- drop block here contained `__yo_decr_rc((void*)((a).mask))`
  },
  .None => ()
);
touched := ArrayList(String).new();
a := _MsP.analyze(fid.clone(), fvd.*.body, table, touched);   // a value struct (mask : ref struct, ret : value struct)
if(a.mask.all, { …; return(()); });
```

`a` in the failing drop is the `AstExpr` pattern variable (`__yo_t6*`), but the
drop is the one scheduled for the LATER local `a` (`_MspAnalysis`, whose
`mask` field is an RC object). So the early-return drop list of the outer block
included a local declared after the return point, and codegen resolved its
name to the pattern variable in C scope.

Two attempts to minimize (a loop pattern `.Some(a)` + early return, then the
same nested in a match arm with a later struct-returning method call bound as
`a`) compile and run correctly on the same compiler, so a further ingredient
of the real shape (an `impl` method body, the `Option(Box(_))`-typed receiver,
the value-struct-with-RC-field return of a memoized method, …) is needed.
Start from the branch's `strict_walk` at the commit before the rename.
