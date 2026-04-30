#!/usr/bin/env python3
"""Comprehensive ExprId transformation for yo-self/ codebase."""

import re

BASE = "/Users/yiyiwang/Workspace/Yo/yo-self"

def read_file(path):
    with open(path, 'r') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w') as f:
        f.write(content)
    print(f"  Updated: {path}")

# ============================================================
# 1. EXPR.YO
# ============================================================
def transform_expr_yo():
    path = BASE + "/expr/expr.yo"
    c = read_file(path)

    # 1. Change enum definition: add id fields
    c = c.replace(
        "  Atom(token : Token),",
        "  Atom(id : ExprId, token : Token),"
    )
    c = c.replace(
        "  FnCall(func : Box(Self), args : ArrayList(Self), is_infix : bool, token : Token)",
        "  FnCall(id : ExprId, func : Box(Self), args : ArrayList(Self), is_infix : bool, token : Token)"
    )

    # 2. Insert ExprId :: usize; before the AstExpr doc comment
    c = c.replace(
        "/// An AST expression node.",
        "/// A stable identifier for an AST expression node. Assigned during parsing.\nExprId :: usize;\n\n/// An AST expression node."
    )

    # 3. Fix make_err_expr construction: .Atom(Token( -> .Atom(usize(0), Token(
    c = c.replace("  .Atom(Token(", "  .Atom(usize(0), Token(")

    # 4. Transform ALL remaining .Atom( and .FnCall( as patterns (they are all patterns now)
    c = c.replace(".Atom(", ".Atom(_, ")
    c = c.replace(".FnCall(", ".FnCall(_, ")

    # 5. Add ast_expr_id function after ast_expr_token function
    ast_expr_id_fn = """
/// Return the stable ExprId of an expression node.
ast_expr_id :: (fn(e : AstExpr) -> ExprId)(
  match(e,
    .Atom(id, _) => id,
    .FnCall(id, _, _, _, _) => id
  )
);
"""
    c = c.replace(
        "/// True if `e` is an Atom.",
        ast_expr_id_fn + "/// True if `e` is an Atom."
    )

    # 6. Update first export line: add ExprId,
    c = c.replace(
        "export AstExpr, BK_TUPLE,",
        "export AstExpr, ExprId, BK_TUPLE,"
    )

    # 7. Update second export line: add ast_expr_id,
    c = c.replace(
        "export make_err_expr, ast_expr_token, ast_expr_is_atom,",
        "export make_err_expr, ast_expr_token, ast_expr_id, ast_expr_is_atom,"
    )

    write_file(path, c)

# ============================================================
# 2. EXPR_INFO.YO
# ============================================================
def transform_expr_info_yo():
    path = BASE + "/expr/expr_info.yo"
    c = read_file(path)

    # 1. Add HashMap import after ArrayList import
    c = c.replace(
        '{ ArrayList } :: import "std/collections/array_list";',
        '{ ArrayList } :: import "std/collections/array_list";\n{ HashMap }   :: import "std/collections/hash_map";'
    )

    # 2. Change AstExpr import to include ExprId
    c = c.replace(
        '{ AstExpr }    :: import "./expr.yo";',
        '{ AstExpr, ExprId } :: import "./expr.yo";'
    )

    # 3. Remove the deferred note comment lines
    old_note = """//! * `ExprInfoTable` (HashMap side-table) and stable `ExprId` deferred to Phase 3,
//!   when the full evaluator pass is ported and a storage strategy is confirmed."""
    c = c.replace(old_note, "")

    # 4. Add ExprInfoTable and helpers BEFORE the exports section
    expr_info_table_code = """
// ---------------------------------------------------------------------------
// ExprInfoTable
// ---------------------------------------------------------------------------

/// Side-table storing evaluation results for each expression node.
/// Keys are ExprId values assigned during parsing.
/// Mirrors the TypeScript evaluator's inline `expr.$` mutation with an
/// immutable-AST equivalent.
ExprInfoTable :: newtype(data : HashMap(ExprId, ExprInfo));

/// Create a new empty ExprInfoTable.
expr_info_table_new :: (fn() -> ExprInfoTable)(
  ExprInfoTable(data: HashMap(ExprId, ExprInfo).new())
);

/// Store an ExprInfo for the given expression id.
expr_info_table_set :: (fn(table : *(ExprInfoTable), id : ExprId, info : ExprInfo) -> unit)(
  table.*.data.insert(id, info)
);

/// Retrieve the ExprInfo for the given expression id, or None.
expr_info_table_get :: (fn(table : *(ExprInfoTable), id : ExprId) -> Option(ExprInfo))(
  table.*.data.get(id)
);

"""
    c = c.replace(
        "// ---------------------------------------------------------------------------\n// Exports\n// ---------------------------------------------------------------------------",
        expr_info_table_code + "// ---------------------------------------------------------------------------\n// Exports\n// ---------------------------------------------------------------------------"
    )

    # 5. Update exports: add ExprInfoTable and helpers
    c = c.replace(
        "export ExprInfo, new_expr_info;",
        "export ExprInfo, new_expr_info;\nexport ExprInfoTable, expr_info_table_new, expr_info_table_set, expr_info_table_get;"
    )

    write_file(path, c)

# ============================================================
# 3. CONTEXT.YO
# ============================================================
def transform_context_yo():
    path = BASE + "/evaluator/context.yo"
    c = read_file(path)

    # 1. Update import from expr_info.yo: add ExprInfoTable, expr_info_table_new
    c = c.replace(
        '{ PathCollection, path_collection_new } :: import "../expr/expr_info.yo";',
        '{ PathCollection, path_collection_new, ExprInfoTable, expr_info_table_new } :: import "../expr/expr_info.yo";'
    )

    # 2. Add expr_info_table field at end of EvalContext object
    c = c.replace(
        "  /// Doc-comment lookup table (position key → comment text).\n  doc_comment_lookup                     : Option(HashMap(String, String))\n);",
        """  /// Doc-comment lookup table (position key → comment text).
  doc_comment_lookup                     : Option(HashMap(String, String)),

  /// Side-table for expression evaluation results (replaces TypeScript's `expr.$` mutation).
  expr_info_table                        : ExprInfoTable
);"""
    )

    # 3. Add expr_info_table initialization in eval_context_new
    c = c.replace(
        "    doc_comment_lookup:                          Option(HashMap(String, String)).None\n  )\n);",
        """    doc_comment_lookup:                          Option(HashMap(String, String)).None,
    expr_info_table:                             expr_info_table_new()
  )
);"""
    )

    write_file(path, c)

# ============================================================
# 4. PARSER.YO — complex line-by-line transformation
# ============================================================
def transform_parser_yo():
    path = BASE + "/parser/parser.yo"
    lines = read_file(path).splitlines(keepends=True)

    # Construction lines with self.alloc_id() (1-indexed)
    self_alloc_id_lines = {
        152, 427, 437, 438, 441, 520, 550, 638, 730,
        812, 849, 868, 884, 944, 949, 956, 976, 982,
        1075, 1085, 1139, 1149, 1164, 1235, 1266, 1267, 1268
    }
    # Construction lines with usize(0) (inside make_ts_call, no self)
    usize0_lines = {387, 388, 389}

    new_lines = []
    for i, line in enumerate(lines, 1):
        if i in self_alloc_id_lines:
            line = line.replace('.Atom(', '.Atom(self.alloc_id(), ')
            line = line.replace('.FnCall(', '.FnCall(self.alloc_id(), ')
        elif i in usize0_lines:
            line = line.replace('.Atom(', '.Atom(usize(0), ')
            line = line.replace('.FnCall(', '.FnCall(usize(0), ')
        else:
            # Apply pattern transformation for all remaining .Atom( and .FnCall(
            line = line.replace('.Atom(', '.Atom(_, ')
            line = line.replace('.FnCall(', '.FnCall(_, ')
        new_lines.append(line)

    c = ''.join(new_lines)

    # 4a. Add ExprId to import from ../expr/expr.yo
    c = c.replace(
        "  AstExpr, BK_TUPLE, BK_TUPLE_TYPE, BK_ARRAY, BK_SLICE, BK_ARRAY_VAL, BK_BEGIN, BK_IMPORT, BK_ANON_STRUCT,",
        "  AstExpr, ExprId, BK_TUPLE, BK_TUPLE_TYPE, BK_ARRAY, BK_SLICE, BK_ARRAY_VAL, BK_BEGIN, BK_IMPORT, BK_ANON_STRUCT,"
    )

    # 4b. Add next_expr_id field to Parser struct
    c = c.replace(
        "Parser :: struct(\n  input_string        : String,\n  module_path         : String,\n  tokens              : ArrayList(Token),\n  program             : ArrayList(AstExpr),\n  has_template_string : bool\n);",
        "Parser :: struct(\n  input_string        : String,\n  module_path         : String,\n  tokens              : ArrayList(Token),\n  program             : ArrayList(AstExpr),\n  has_template_string : bool,\n  next_expr_id        : usize\n);"
    )

    # 4c. Add next_expr_id initialization in Parser.new
    c = c.replace(
        "      has_template_string: false\n    )\n  }),",
        "      has_template_string: false,\n      next_expr_id:        usize(0)\n    )\n  }),"
    )

    # 4d. Add alloc_id method BEFORE make_syn_tok
    alloc_id_method = """  alloc_id : (fn(self : *(Self)) -> ExprId)({
    id := self.next_expr_id;
    self.next_expr_id = (self.next_expr_id + usize(1));
    id
  }),

  """
    c = c.replace(
        "  make_syn_tok : (fn(self : *(Self), kind : TokenKind, value : String) -> Token)(",
        alloc_id_method + "  make_syn_tok : (fn(self : *(Self), kind : TokenKind, value : String) -> Token)("
    )

    write_file(path, c)

# ============================================================
# 5. PURE PATTERN FILES (global .Atom( → .Atom(_, and .FnCall( → .FnCall(_,)
# ============================================================
def transform_pattern_file(path):
    c = read_file(path)
    c = c.replace('.Atom(', '.Atom(_, ')
    c = c.replace('.FnCall(', '.FnCall(_, ')
    write_file(path, c)

# ============================================================
# 6. CONSTRUCTION FILES (global .Atom( → .Atom(usize(0), etc.)
# ============================================================
def transform_construction_file(path):
    c = read_file(path)
    # Handle fully-qualified forms first
    c = c.replace('AstExpr.Atom(', 'AstExpr.Atom(usize(0), ')
    c = c.replace('AstExpr.FnCall(', 'AstExpr.FnCall(usize(0), ')
    # Then handle dot forms
    c = c.replace('.Atom(', '.Atom(usize(0), ')
    c = c.replace('.FnCall(', '.FnCall(usize(0), ')
    write_file(path, c)

# ============================================================
# 7. CREATE evaluator/exprs/expr.yo
# ============================================================
def create_evaluator_exprs_expr_yo():
    import os
    dir_path = BASE + "/evaluator/exprs"
    os.makedirs(dir_path, exist_ok=True)
    path = dir_path + "/expr.yo"
    content = '''//! evaluate_expression function pointer mechanism.
//!
//! Mirrors `src/evaluator/exprs/expr.ts` — 1:1 port.
//!
//! The function pointer avoids forward references between the dispatcher
//! (_expr.yo) and individual handlers that call back into it.

open import "std/string";
{ ArrayList } :: import "std/collections/array_list";

{ AstExpr, ExprId } :: import "../../expr/expr.yo";
{ ExprInfoTable }   :: import "../../expr/expr_info.yo";
{ Environment }     :: import "../../env/env.yo";
{ EvalContext }     :: import "../context.yo";

/// Function type for the main expression evaluator.
EvaluateExprFn :: fn(
  expr  : AstExpr,
  env   : Environment,
  ctx   : *(EvalContext)
) -> AstExpr;

/// Module-level function pointer — set once during evaluator initialization.
g_evaluate_expression : Option(EvaluateExprFn) = Option(EvaluateExprFn).None;

/// Set the global evaluate_expression function pointer.
/// Called once during evaluator initialization before any evaluation begins.
set_evaluate_expression_fn :: (fn(f : EvaluateExprFn) -> unit)(
  g_evaluate_expression = Option(EvaluateExprFn).Some(f)
);

/// Dispatch an expression through the registered evaluator.
/// Panics if the evaluator has not been initialized.
evaluate_expression :: (fn(
  expr : AstExpr,
  env  : Environment,
  ctx  : *(EvalContext)
) -> AstExpr)(
  match(g_evaluate_expression,
    .None    => panic("evaluate_expression called before set_evaluate_expression_fn"),
    .Some(f) => f(expr, env, ctx)
  )
);

export EvaluateExprFn;
export g_evaluate_expression, set_evaluate_expression_fn, evaluate_expression;
'''
    write_file(path, content)

# ============================================================
# RUN ALL TRANSFORMATIONS
# ============================================================

print("=== Transforming expr/expr.yo ===")
transform_expr_yo()

print("=== Transforming expr/expr_info.yo ===")
transform_expr_info_yo()

print("=== Transforming evaluator/context.yo ===")
transform_context_yo()

print("=== Transforming parser/parser.yo ===")
transform_parser_yo()

print("=== Transforming pure-pattern files ===")
for p in [
    BASE + "/evaluator/eval.yo",
    BASE + "/codegen/driver.yo",
    BASE + "/codegen/exprs.yo",
    BASE + "/evaluator/type_of.yo",
    BASE + "/evaluator/effects/effect_analysis.yo",
    BASE + "/evaluator/async/await_analysis.yo",
    BASE + "/evaluator/shared/suspension_analysis.yo",
    BASE + "/main.yo",
]:
    transform_pattern_file(p)

print("=== Transforming construction (test) files ===")
for p in [
    BASE + "/tests/eval.test.yo",
    BASE + "/tests/codegen.test.yo",
    BASE + "/tests/await_analysis.test.yo",
    BASE + "/tests/effect_analysis.test.yo",
    BASE + "/tests/await_analysis_types.test.yo",
    BASE + "/tests/effect_analysis_types.test.yo",
    BASE + "/tests/suspension_analysis.test.yo",
    BASE + "/tests/suspension_analysis_types.test.yo",
    BASE + "/tests/type_of.test.yo",
]:
    transform_construction_file(p)

print("=== Creating evaluator/exprs/expr.yo ===")
create_evaluator_exprs_expr_yo()

print("\nAll transformations complete!")
