# A method call on a local declared `(d : &Dyn(A, B)) = dyn(&v)` finds no method

**Severity:** S3 — a reference-kind Dyn bound to an annotated `&Dyn` local cannot be called through; a `&Dyn` parameter or an unannotated binding works.

Found while building decision 49 S1d (`dyn(&v)`). The annotated local keeps the type `&Dyn(...)` verbatim, and method dispatch on a receiver whose type is `Reference(DynT)` does not look through the reference:

```yo ignore
(d : &Dyn(Speak, Twice)) = dyn(&c);
d.twice();   // E0610: No method "twice" on &dyn(Speak + Twice)
```

Passing the call straight into a `&Dyn` parameter (`f(dyn(&c))`) works, and `d.speak()` through that parameter dispatches.

Also: the same annotated form with `size_of_val(d)` works, and a C `(&(<fat literal>))` initializer is emitted for the local (an `&` of the by-value fat struct); the local borrow path (`_generate_inout_local_binding`) handles the unannotated `d := dyn(&c)` form.

Not fixed in S1d; the tests use parameters.
