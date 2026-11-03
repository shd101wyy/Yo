# `types_utils.test.yo`'s self-containing type test leaks the cycle it builds on purpose

**Severity:** S3: a local `yo test tests/internal/types_utils.test.yo`
reports 71/72 because one test fails the leak verdict. CI runs the internal
shards with `YO_TEST_LEAK_VERDICT=0`, so it never sees the failure. No
compiler code is involved: the test builds an `Rc` cycle on purpose and
never breaks it.

> Found 2026-11-04 while triaging a "71/72, one leak" report against the
> VBD flips. It is not a flip regression. The same test fails the same way
> before B8, with the n1d-base binary on a worktree of dd9ca178c (#1721): 70/71.

## Symptom

```text
  ✗ raw-ptr predicate: a type object that contains itself terminates
    Memory leak detected:
    ...
    SUMMARY: AddressSanitizer: 342 byte(s) leaked in 8 allocation(s).
```

Every block in the report is an `Indirect leak`: the `TypeValueNode.Struct`
node, its label and field lists, and their strings. Nothing outside the
cycle leaks.

## Cause

`_trp_looped_struct` writes the struct node into its own field list
through a raw pointer, so that `type_representation_contains_raw_ptr` has to
survive a self-containing type (its depth cap is what the test checks).
The node's `Rc` count can then never reach zero. The test drops `looped`
and `looped_ptr` without first removing the self-reference.

## Fix shape

At the end of the test, remove the inserted element again through the same
raw pointer, so the cycle breaks before the locals drop. One way is for
`_trp_looped_struct` to return the `SharedList` handle along with the node.
After that the file runs 72/72 under the local leak verdict.
