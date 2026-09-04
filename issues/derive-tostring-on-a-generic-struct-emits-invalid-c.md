# `derive(ToString)` on a generic struct emits invalid C (`&(self.field)` on a pointer)

**Status:** OPEN
**Found:** 2026-08-25, completeness-checking the fix for
issues/fixed/derive-rules-name-types-through-a-display-renderer.md — i.e. asking
which OTHER derive rules break on a generic struct.
**Severity:** medium. Hard C error, so it is loud, not silent.

## Symptom

```rust
TSBox :: (fn(comptime(T) : Type) -> comptime(Type))(struct(value : T));
derive(generic(T), TSBox(T), where(T <: ToString), ToString);

TSBox(i32)(i32(5)).to_string();
```

```
error: member reference type '__yo_t9 *' (aka 'struct __yo_t9_struct *') is a pointer;
       did you mean to use '->'?
 1875 |   __yo_t4 _file____User_temp_5830 = yo_id_4896((&(self.value)));
      |                                                   ~~~~^
      |                                                       ->
```

`derive(ToString)` on a NON-generic struct is fine (`Plain(5)`), so genericity is
the trigger.

## Root cause

The emitted C takes the address of a field on an `inout(self)` receiver without
dereferencing it: `&(self.value)` where `self` is `__yo_t9*`. It must be
`&(self->value)`.

That is the `Variable.is_ref` channel again — the same family as
issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md (#258) and
issues/generic-trait-method-reads-primitive-inout-self-as-pointer.md — but a
third distinct site: the ADDRESS-OF-A-FIELD path rather than a plain scalar read.
It is why `derive(Clone)` on a generic struct is fine after its own fix while
this one still fails: Clone's body reads fields as values, ToString's takes their
address to pass them on to the nested `to_string`.

Note this is NOT the display-renderer bug. That one is also present here but is
harmless: `type_name` lands inside a STRING LITERAL, so a generic struct would
merely PRINT `<struct:struct_yo_id_N>(5)` instead of `TSBox(5)` once the C error
is fixed. Both halves need fixing for the output to be right, and they are
independent.

## Reproducer

`issues/repros/derive-tostring-generic-struct.yo`

## Suggested order

Fix with the sibling `inout(self)` pointer bugs — all three are the same channel
and a single repair to the ref-ness propagation may cover them. Add a
`derive(ToString)`-on-a-generic-struct case to `tests/derive.test.yo` at that
point; the existing generic-derive coverage there is Eq/Clone/Default only,
which is exactly why this went unnoticed.
