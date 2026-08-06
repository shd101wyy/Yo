# yo-self: recursive-enum element retain lost — 3 stacked shell/dup gaps (json value-loss)

**Status: FIXED** (this commit). Flips `tests/encoding/json.test.yo` (28/35 → 35/35).

## Symptom

`json_parse("[\"abc\"]")` / `{"k": "v"}` parsed structurally but every STRING
payload inside a container came back EMPTY (`items(0).as_str() == ""`), while
keys (ArrayList(String)) and numbers survived. Minimal repro (57 lines, no
std/json): a recursive impl method pushing `.Ok(.Str(s))` results into
`ArrayList(Self)` — `tests/codegen-bootstrap/recursive_enum_element_retain.yo`
(pre-fix `s0=[]`, post-fix `s0=[abc]` = TS).

Probe ledger (instrumented /tmp copy of std/encoding/json.yo): the value is
intact PRE-PUSH and POST-PUSH — it dies when the recur-call's Result temp
drops, because the element retain was never emitted.

## Roots (three stacked — each masked the next)

1. **Ctor-arg deferred dup suppressed as undeclared**
   (`codegen/exprs/drop_dup.yo`). TS declares the arg's temp FIRST
   (`assignment.ts:184-199`, `other-fn-call.ts:2277-2292`) so the dup
   references a declared local; yo-self's shared `emit_deferred_dup_or_code`
   lacked that step, and `generate_deferred_dup_expressions`' undeclared-temp
   gate silently dropped the dup (e.g. `return(.Some(values(i)))` — the
   json-object `.get` UAF, rc=137). FIX: declare-first inside the shared
   helper (with the TS `rhsIsClosureConstruction` guard); the previous
   commit's assignment-local helper is subsumed and removed.

2. **`type_contains_rc_type` read the recursive-Self SHELL as RC-free**
   (`types/utils.yo`). The specialized `ArrayList(JV).push`'s `value` param
   type is the value-copied shell (empty variants) → contains-rc = false →
   `set_expr_as_needs_to_call_dup` skipped the element retain entirely
   (exactly the historical "one EvalValue push retained, its twin didn't").
   FIX: resolve shells at `_type_contains_rc_inner` entry (fifth
   shell-consumption site).

3. **Dup/drop emitters walked the shell's EMPTY variant list**
   (`codegen/exprs/drop_dup.yo`). With (2) fixed the dup EMITS — as
   `switch (temp.tag) { default: break; }` — zero arms, a silent no-op +1.
   FIX: resolve shells at `generate_dup_code_for_value` /
   `generate_drop_code_for_value` entry (sixth site).

## The pattern (now 6 sites)

Under yo-self's value semantics, ANY consumer that walks a struct's fields or
an enum's variants may receive a recursive-`Self` SHELL (empty lists) and
silently compute a wrong "nothing here" answer. TS never sees shells (type
objects shared by identity). Sites fixed so far: eval-match, codegen
type-emission, type_key, get_size_of_type/get_alignment_of_type,
type_contains_rc_type, generate_dup/drop_code_for_value. **Any new
field/variant walker must resolve shells first** (`resolve_enum_shell` /
`resolve_struct_shell` from types/creators.yo).

## Verification

- Repros: /tmp/json_min2 (s0=[abc]), /tmp/json_obj2 (name=[test], was rc=137),
  /tmp/json_obj5 (n0=42, s0=[abc]).
- json.test.yo 35/35 (was 28/35); recursive_enum 4/4, http 9/9,
  ref_field_borrow 11/11 hold.
- codegen-bootstrap diff-test PASS 137 DIFF 2 (pre-existing), std 153/153,
  12-file spot set, STRICT_FIXPOINT — see commit.
