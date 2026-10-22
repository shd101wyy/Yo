# `yo fix --migrate explicit-copy` keys every parameter of a module alike

**Severity:** S3. The migration lists copies it could rewrite and gives the wrong reason: a write to, or a raw pointer from, any parameter in a module counts as one for every parameter in that module. Nothing is wrongly rewritten, but the listing gives the B1 reviewer a false hand edit.

> Found 2026-10-23 while checking a minor finding of the adversarial review
> of `fix/explicit-copy-s1-tool-defects`. The reviewer saw a copy out of a
> `ref`-struct parameter listed as "a raw pointer into its source is taken"
> in a program that takes no pointer from it. The defect predates that
> branch.

## Symptom

`issues/repros/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
VEntry :: struct(yes : ArrayList(i32), no : ArrayList(i32));
plain :: (fn(entry : VEntry) -> usize)({
  x := entry.yes;
  x.len()
});
bump :: (fn(other : &mut ArrayList(i32)) -> unit)({
  other.push(i32(1));
});
main :: (fn() -> unit)(());
export(main);
```

`yo fix <file> --migrate explicit-copy --dry-run` prints
`` `(entry.yes)` is copied and its source is written afterwards `` and
inserts nothing. Nothing writes `entry`. The write is to `bump`'s `other`.
Replace `bump` with a `main` that takes a pointer from an unrelated local
(`q := ArrayList(i32).new(); r := q.ptr();`), or that only constructs a
`VEntry`. The same site is then listed as "a raw pointer into its source is
taken". Remove both and the site is cloned, which is the expected result.

## Root cause

The migration identifies a variable by `_ic_decl_key` (`src/evaluator/utils.yo`).
That key is the module and byte offset of the variable's declaration token.
A parameter is bound with a synthetic token, though:
`_build_def_time_body_env` (`src/evaluator/calls/function_type.yo`) passes
`synthetic_token(&pn, &caller_env.module_path.*)` to `bind_parameter`.
`synthetic_token` (`src/env.yo`) gives every such token byte offset 0. So
every parameter in a module, and every other binding made with a synthetic
token there, has the key `<module>:0`. The guard therefore lists a copy out of
one parameter when another one is written (`record_copy_write`) or has a
pointer taken (`record_copy_pointer`). It also follows another parameter's
flows (`_decl_written_after`).

All of these collisions make the guard list more sites, never fewer, so no
rewrite is wrong. But the B1 listing over-reports parameter-rooted sites, and
it gives them a reason that sends the reviewer to the wrong hand edit.

The flow-following guard
(`issues/fixed/2026-10-23-explicit-copy-migration-misses-a-write-through-a-local-the-copy-was-moved-into.md`)
widens the effect. Two `src/` sites that it used to insert are now listed as
"its source is written afterwards". Both are copies out of a `&String`
parameter that nothing writes: `bytes := s` in `_is_plain_c_identifier`
(`src/codegen/exprs/downcast.yo:273`) and `g_traverse_visit_expr = expr`
(`src/codegen/functions/constructors.yo:325`). A minimal form:

```yo
{ String } :: import("std/string");
peek :: (fn(s : &String) -> usize)({
  bytes := s;
  bytes.len()
});
grow :: (fn(p : &String) -> String)({
  mut(local) := p;
  local.push_str("x");
  local
});
main :: (fn() -> unit)(());
export(main);
```

Before the flow guard, `bytes := s` was inserted. With it, the site is listed
as "its source is written afterwards". The store of `p` into `local`, which
is written later, is recorded as a flow from the shared key, and `s` has that
key too.

## Direction

Key a parameter by its declaration in the signature, not by its synthetic
token. Either bind it with the parameter's real name token, which the
fn-type AST carries, or have the migration's recorders map a parameter
`Variable` to a key built from its function's definition and its index.
`synthetic_token` is interned and on the call-trial hot path (its doc
measures ~486 M calls per self-compile), so the fix must not make it mint a
token per binding.
