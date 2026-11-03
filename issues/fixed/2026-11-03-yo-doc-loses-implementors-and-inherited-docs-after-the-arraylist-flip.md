# `yo doc` loses trait implementors, trait-inherited docs and re-exported docs after the ArrayList flip

**Severity:** S2. On the B8 tree, `yo doc` silently produced worse documentation than develop. It reported no error, but every trait's implementor list was empty, no impl method inherited its trait's doc, and no re-exported type took its declaring module's docs. That is the regression `issues/fixed/yo-doc-drops-every-doc-comment-of-a-re-exported-type.md` fixed: 1554 of 3345 std members rendered bare.

Found 2026-11-03 by B8, while running `tests/internal/doc_reexport_docs.test.yo` on the B8 tip binary (`yo-tree-ae0436771`). Two of its three tests failed with exit 6, the failed `assert`s on the filled-in docs.

## Root cause

`build_cross_references` and its two sub-passes, `_inherit_trait_method_docs` and `_fill_re_exported_docs` (all in `src/doc/builder.yo`), took `modules : &ArrayList(DocModule)`. Each read a module with `modules.get_cloned(i)`, then wrote into that copy: `m.traits(tj) = …`, `ty.methods(fj) = …`, `m2.types(tj) = …`, and the implementor lists' `lst.push(…)`.

Before B8, the model's `ArrayList`s were `ref` handles, so a write through a copy's list reached the model. The code said so in its own comments ("the writes below reach the model through this copy's shared `ArrayList` handles"). Once `ArrayList` is a value, every one of those writes lands in a temporary and is dropped.

The same was true of `_fill_doc_fields_from` and `_fill_doc_variants_from`. They took `dst : &DocType` and wrote into a clone of its field and variant lists.

None of this is a compile error: each write targets a local. The cli-cases did not catch it either: every `doc-*` and `context-*` case passed on the broken tree, so none of their goldens exercises these three passes.

## Fix

The three passes take `modules : &mut ArrayList(DocModule)`. Each copy is now written back by index once its writes are done: `trait_implementors(i) = lst`, `m2.types(tj) = ty`/`t2`, `modules(mj) = m`/`m2`.

`_fill_doc_fields_from` and `_fill_doc_variants_from` take `dst : &mut DocType` and store the filled list back into `dst.fields` and `dst.variants`. `yo doc` (`src/doc_command.yo`) passes `&mut modules`.

## Test

`tests/internal/doc_reexport_docs.test.yo`:
- The existing re-export tests, "a re-exported type takes the declaring module's documentation" and "a module that documents its own re-export keeps what it wrote", failed on the B8 tip before this fix and pass after it.
- A new test covers the other two passes: "the cross-reference passes write back: a trait lists its implementors and a bare impl method takes the trait's doc". A trait in one module and its implementor in another come out of `build_cross_references` with `implementors == [Point]`, and the bare `show` method carries the trait's doc, attributed to `Show`.
