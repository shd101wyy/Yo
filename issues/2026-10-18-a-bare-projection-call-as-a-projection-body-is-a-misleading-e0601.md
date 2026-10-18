# A bare projection call as a projection body is a misleading E0601

**Severity:** S3. The correct spelling compiles; only the diagnostic for the missing marker is wrong.

Filed 2026-10-18 while deciding `issues/retired/borrowed-for-over-user-defined-collections.md`. Found with a develop-built compiler (`29ceb209d` plus #1440's branch).

## Symptom

The repro is `issues/repros/2026-10-18-bare-projection-call-tail.yo`: a value collection whose `walk_elem` (`-> &mut i32`) forwards the inner list's projection without the call-site marker.

```yo ignore
walk_elem : (fn(self : &mut Self, cur : &usize) -> &mut i32)(self.items.walk_elem(cur)),
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "*(i32)"
```

With the marker, `(&mut self.items.walk_elem(cur))` (or the index form `&mut self.items(cur)`), the same program compiles and runs correctly.

## Expected

The error should name the fix, as E0914 does for arguments: "a `-> &mut T` body that forwards a projection lends it: write `&mut self.items.walk_elem(cur)`". It should not show the internal pointer type.

## Direction

Detect a projection-typed tail in a projection body whose marker is missing, and emit E0914-style help. Add a cli-case that pins the new message.
