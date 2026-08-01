#!/usr/bin/env python3
"""Port TS's union-construction emission (src/codegen/exprs/other-fn-call.ts:2468-2521).

    python3 scratchpad/apply_union_construction.py
    ./yo-cli fmt yo-self/codegen/exprs/other_fn_call.yo
    ./yo-cli check ./yo-self | tail -1      # expect 295/305

yo-self emits union DECLARATIONS (codegen/types/generation.yo
`generate_union_declaration`) but has no arm for CONSTRUCTING one, so
`SomeUnion(x : 12)` fell all the way through `generate_other_function_call` to
the generic fallback and became `// Failed to transpile SomeUnion(x : 12)` —
invalid C, and the whole batch RED. Measured: a 4-line test with nothing but a
union literal and a field read is `rc=1` under yo-self and GREEN under TS. This
is tests/basic.test.yo arm 14 ("Test 'union'"), an independent second defect in
that file alongside the arm-12 `_`-literal root.

TS emits exactly `(<cName>){ .<label> = <value> }` for the single named argument
("union is supposed to have only one member initialized"), declaring a temp when
`expr.$.variableName` is set. The arm sits right after the value-struct/closure
arms, which is where this one goes.

Field naming: `sanitize_for_c_identifier(label, false)` — matching
`generate_union_declaration` (codegen/types/generation.yo:215), which is what the
compound literal has to agree with. TS uses `getVariableNameForCodegen` there,
but yo-self's union DECLARATION uses the sanitizer, and the two must match.
"""
import sys

P = "yo-self/codegen/exprs/other_fn_call.yo"

IMPORT_OLD = ('{ is_reference_struct_type, is_reference_enum_type, is_function_type, is_unit_type, '
              'is_array_type, is_dyn_type, is_struct_type, is_enum_type, is_fn_trait_type, is_some_type } '
              ':: import("../../types/guards.yo");')
IMPORT_NEW = ('{ is_reference_struct_type, is_reference_enum_type, is_function_type, is_unit_type, '
              'is_array_type, is_dyn_type, is_struct_type, is_enum_type, is_union_type, is_fn_trait_type, '
              'is_some_type } :: import("../../types/guards.yo");')

ANCHOR = "        // Value-struct / newtype constructor call with RUNTIME field args.\n"

BLOCK = """        // Union constructor call: exactly ONE named member is initialised, so
        // `SomeUnion(x : 12)` emits `(cName){ .x = 12 }`. Mirrors
        // other-fn-call.ts:2468-2521 (`isUnionType(functionValue.value)`),
        // including its "union is supposed to have only one member
        // initialized" shape and its temp-variable declaration. Without this
        // arm the call fell through to the generic fallback and emitted
        // `// Failed to transpile SomeUnion(x : 12)` — yo-self could declare a
        // union but never construct one (tests/basic.test.yo arm 14).
        if(is_union_type(wrapped), {
          u_cname := match(context.base.get_type_c_name(type_key(wrapped.clone())),.Some(cn) => cn,.None => String.from("__yo_unknown_union"));
          u_args := match(expr,.FnCall(_, _, a, _, _) => a,.Atom(_, _) => ArrayList(AstExpr).new());
          match(
            u_args.get(usize(0)),
            .Some(u_arg) => if(ast_expr_is_fn_call_of(u_arg, ":", Option(usize).Some(usize(2))), {
              u_pair := match(u_arg,.FnCall(_, _, pa, _, _) => pa,.Atom(_, _) => ArrayList(AstExpr).new());
              u_label_e := match(u_pair.get(usize(0)),.Some(le) => le,.None => make_err_expr());
              u_field_e := match(u_pair.get(usize(1)),.Some(fe) => fe,.None => make_err_expr());
              if(ast_expr_is_atom(u_label_e), {
                u_label := ast_expr_token(u_label_e).value;
                u_code := emit_deferred_dup_or_code(u_field_e, _call_generate_expr(u_field_e, indent.clone(), context), indent.clone(), context);
                u_value := String.from("(");
                u_value.push_string(u_cname.clone());
                u_value.push_str("){ .");
                u_value.push_string(sanitize_for_c_identifier(u_label, false));
                u_value.push_str(" = ");
                u_value.push_string(u_code);
                u_value.push_str(" }");
                match(
                  ei.variable_name,
                  .Some(u_tv) => {
                    u_decl := indent.clone();
                    u_decl.push_string(get_variable_type_string(ei.ty, u_tv.clone(), context.base));
                    u_decl.push_str(" = ");
                    u_decl.push_string(u_value);
                    u_decl.push_str(";");
                    u_em := context.base.emitter;
                    u_em.emit_string_line(u_decl);
                    return(Option(String).Some(u_tv));
                  },
                  .None => return(Option(String).Some(u_value))
                );
              });
            }),
            .None => ()
          );
        });
"""

s = open(P).read()
if IMPORT_OLD not in s:
    sys.exit("guards import anchor missing")
if s.count(ANCHOR) != 1:
    sys.exit(f"value-struct anchor count = {s.count(ANCHOR)}, expected 1")
s = s.replace(IMPORT_OLD, IMPORT_NEW, 1)
s = s.replace(ANCHOR, BLOCK + ANCHOR, 1)
open(P, "w").write(s)
print(f"patched {P}")
