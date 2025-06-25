/* eslint-disable no-constant-condition */
import {
  addVariableToEnv,
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
  Variable,
} from "./env";
import { formatErrorMessage, formatErrorMessages } from "./error";
import { Token, TokenType } from "./token";
import { isFreeType, isLinearOrType0Type, Type, typeOfType } from "./types";
import { generateNewTempVariableName } from "./utils";
import { Value } from "./value";

/**
 * Eg:
 *
 * x      has path ["x"]
 * x.a    has path ["x", "a"]
 * &(x.a) has path ["x", "a"]
 * arr(some_index) has path ["arr"] as `some_index` is runtime known.
 *
 */
export type Path = string[];
export type PathCollection = Path[];

/*
 * Check if `path1` contains `path2`.
 * For example:
 *   pathContainsPath(["x"], ["x", "a"]) => false
 *   pathContainsPath(["x", "a"], ["x"]) => true
 *   pathContainsPath(["x", "a"], ["x", "a"]) => true
 *   pathContainsPath(["x", "a"], ["y"]) => false
 */
export function pathContainsPath(path1: Path, path2: Path): boolean {
  if (path1.length < path2.length) {
    return false;
  }
  for (let i = 0; i < path2.length; i++) {
    if (path1[i] !== path2[i]) {
      return false;
    }
  }
  return true;
}

export function pathCollectionConflictsWithPathCollection(
  collection1: PathCollection,
  collection2: PathCollection
): boolean {
  // If any path in collection1 conflicts with any path in collection2, then they conflict.
  for (const path1 of collection1) {
    for (const path2 of collection2) {
      if (pathConflictsWithPath(path1, path2)) {
        return true;
      }
    }
  }
  return false;
}

export function pathConflictsWithPath(path1: Path, path2: Path): boolean {
  // If the first path is a prefix of the second path, then they conflict.
  if (pathContainsPath(path2, path1)) {
    return true;
  }
  // If the second path is a prefix of the first path, then they conflict.
  if (pathContainsPath(path1, path2)) {
    return true;
  }
  return false;
}

export enum ExprTag {
  Atom = "Atom",
  FuncCall = "FuncCall",
}

export interface EvaluatedExprData {
  /**
   * The environment after the expression has been evaluated.
   */
  env: Environment;
  /**
   * The type of the expression after the evaluation.
   */
  type: Type;
  /**
   * The value of the expression.
   * If it's undefined, then it means it's a runtime value.
   */
  value?: Value;
  /**
   * If this is given, then it means there is a temporary variable holding the value in the `env` above.
   */
  variableName?: string;
  /**
   * Check if the value returned from the expression is mutable.
   * For exampe:
   * mut(x) := 12;
   * y = x; // Expression `x` here is mutable.
   */
  isMutable: boolean;

  /**
   * For example, the expression below is accessing property:
   *   p.*
   * `p.*` is an expression whose `isAccessingProperty` is true.
   */
  isAccessingProperty?: boolean;

  /**
   * The path collection of the expression.
   */
  pathCollection: PathCollection;
}

export type AtomExpr = {
  // Parser stage
  tag: ExprTag.Atom;
  token: Token;

  // Evaluator stage
  /**
   * If it's undefined, then the expression has not been evaluated yet.
   */
  $?: EvaluatedExprData | undefined;
};

export type FuncCallExpr = {
  // Parser stage
  tag: ExprTag.FuncCall;
  func: Expr;
  args: Expr[];
  isInfix?: boolean;
  token: Token;

  // Evaluator stage
  /**
   * If it's undefined, then the expression has not been evaluated yet.
   */
  $?: EvaluatedExprData | undefined;
};

export function cloneExpr(expr: Expr): Expr {
  switch (expr.tag) {
    case ExprTag.Atom:
      return { ...expr, $: expr.$ ? { ...expr.$ } : undefined };
    case ExprTag.FuncCall:
      return {
        ...expr,
        func: cloneExpr(expr.func),
        args: expr.args.map(cloneExpr),
        $: expr.$ ? { ...expr.$ } : undefined,
      };
  }
}

export function cloneExprWithoutEvaluatedData(expr: Expr): Expr {
  switch (expr.tag) {
    case ExprTag.Atom:
      return { ...expr, $: undefined };
    case ExprTag.FuncCall:
      return {
        ...expr,
        func: cloneExprWithoutEvaluatedData(expr.func),
        args: expr.args.map(cloneExprWithoutEvaluatedData),
        $: undefined,
      };
  }
}

export type Expr = AtomExpr | FuncCallExpr;

export function exprIsFunctionCall(
  expr: Expr | undefined
): expr is FuncCallExpr {
  return expr?.tag === ExprTag.FuncCall;
}
export function exprIsAtom(expr: Expr | undefined): expr is AtomExpr {
  return expr?.tag === ExprTag.Atom;
}

export function exprIsAtomOf(expr: Expr, values: string | string[]): boolean {
  return (
    expr.tag === ExprTag.Atom &&
    (typeof values === "string"
      ? expr.token.value === values
      : values.includes(expr.token.value))
  );
}

export function exprIsAtomAndOperator(expr: Expr): boolean {
  return expr.tag === ExprTag.Atom && expr.token.type === TokenType.Operator;
}

export function exprIsFunctionCallOf(
  expr: Expr,
  funcNames: string | string[],
  argumentCount?: number
): boolean {
  if (expr.tag !== ExprTag.FuncCall) {
    return false;
  }
  if (expr.func.tag !== ExprTag.Atom) {
    return false;
  }
  let funcName = expr.func.token.value;
  if (expr.func.token.type === TokenType.BacktickIdentifier) {
    funcName = funcName.slice(1, -1); // Remove backticks
  }

  return (
    expr.tag === ExprTag.FuncCall &&
    expr.func.tag === ExprTag.Atom &&
    (typeof funcNames === "string"
      ? funcName === funcNames
      : funcNames.includes(funcName)) &&
    (argumentCount === undefined || expr.args.length === argumentCount)
  );
}

export function expectExprToBeFunctionCallOf(
  expr: Expr,
  expectedFunctionName: string | string[],
  expectedArgCount?: number
) {
  if (!exprIsFunctionCall(expr)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected function call, got atom:\n${exprToString(expr)}`,
    });
  }
  if (!exprIsFunctionCallOf(expr, expectedFunctionName)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected function call of ${Array.isArray(expectedFunctionName) ? expectedFunctionName.map((fn) => `"${fn}"`).join(" or ") : `"${expectedFunctionName}"`}, got:\n${exprToString(expr)}`,
    });
  }

  if (expectedArgCount !== undefined && expr.args.length !== expectedArgCount) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected ${expectedArgCount} arguments, got ${expr.args.length}:\n${exprToString(
        expr
      )}`,
    });
  }
}

export const BuiltinKeywords = {
  compt: ["compt", "@"],
  mut: ["mut", "!"],
  implicit: ["implicit", "?"],

  forall: ["forall", "∀"],
  // Exists: ["exists", "∃"],
  // Where: ["where", "∋"],
  // In: ["in", "∈"],

  quote: ["quote", ":"],
  unquote: ["unquote", "#"], // QUESTION: ~ is actually bitwise not in C, should we pick another symbol?
  unquote_splicing: ["unquote_splicing", "...#"],

  recur: ["recur"],
  fn: ["fn"],
  extern: ["extern"],
  cond: ["cond"],
  type: ["type"],
  match: ["match"],
  struct: ["struct"],
  enum: ["enum"],
  union: ["union"],
  module: ["module"],
  begin: ["begin"],
  module_begin: ["module_begin"],
  import: ["import"],
  export: ["export"],
  borrow: ["borrow"],
  open: ["open"],
  // pass: ["paas"], // pass is the same as noop
  drop: ["drop"],
  clone: ["clone", "%"], // IDEA: two circles and a slash perfectly represent clone!
  break: ["break"],
  continue: ["continue"],
  while: ["while"],
  for: ["for"],
  if: ["if"],
  and: ["and"],
  or: ["or"],
  not: ["not"],
  gensym: ["gensym"],

  // values
  undefined: ["undefined"],
  null: ["null"],
  true: ["true"],
  false: ["false"],

  // data types
  // LinearPtr: ["^"],     // <= deprecated
  // MutLinearPtr: ["^!"], // <= deprecated
  Ptr: ["*"],
  MutPtr: ["*!"],
  Ref: ["&"],
  MutRef: ["&!"],
  Rc: ["$"], // Everthing comes with a cost.
  Tuple: ["Tuple"],
  Array: ["Array"],
  Free: ["Free"],
  Linear: ["Linear"],
  Type: ["Type"],
  Module: ["Module"],
  anyopaque: ["anyopaque"], // Any opaque type, which is not known at compile time.

  // data values
  tuple: "tuple",
  array: "array",
  expr_list: "expr_list", // expr_list
};

export const BuiltinFunctions = {
  __yo_are_types_compatible: ["__yo_are_types_compatible"],
  compt_expect_error: ["compt_expect_error"],
  typeof: ["typeof"],
  sizeof: ["sizeof"],
  // consume: ["consume"],
  compt_assert: ["compt_assert"],
  macro_expand: ["macro_expand"],
  as: ["as"],

  // expr related functions
  // __yo_expr_is_expr: ["__yo_expr_is_expr"],
  __yo_expr_is_atom: ["__yo_expr_is_atom"],
  __yo_expr_is_fn_call: ["__yo_expr_is_fn_call"],
  __yo_expr_get_callee: ["__yo_expr_get_callee"],
  __yo_expr_get_args: ["__yo_expr_get_args"],
  __yo_expr_to_string: ["__yo_expr_to_string"],

  // expr_list related functions
  // __yo_expr_list_is_expr_list: ["__yo_expr_list_is_expr_list"],
  __yo_expr_list_car: ["__yo_expr_list_car"],
  __yo_expr_list_cdr: ["__yo_expr_list_cdr"],
  __yo_expr_list_cons: ["__yo_expr_list_cons"],
  __yo_expr_list_append: ["__yo_expr_list_append"],
  __yo_expr_list_length: ["__yo_expr_list_length"],

  // compt_int related functions
  /// 2 args
  __yo_compt_int_add: ["__yo_compt_int_add"],
  __yo_compt_int_sub: ["__yo_compt_int_sub"],
  __yo_compt_int_mul: ["__yo_compt_int_mul"],
  __yo_compt_int_div: ["__yo_compt_int_div"],
  __yo_compt_int_mod: ["__yo_compt_int_mod"],
  __yo_compt_int_eq: ["__yo_compt_int_eq"],
  __yo_compt_int_neq: ["__yo_compt_int_neq"],
  __yo_compt_int_lt: ["__yo_compt_int_lt"],
  __yo_compt_int_lte: ["__yo_compt_int_lte"],
  __yo_compt_int_gt: ["__yo_compt_int_gt"],
  __yo_compt_int_gte: ["__yo_compt_int_gte"],
  __yo_compt_int_as: ["__yo_compt_int_as"], // Convert to a different integer type
  // 1 arg
  __yo_compt_int_neg: ["__yo_compt_int_neg"],
  __yo_compt_int_to_float: ["__yo_compt_int_to_float"],
  __yo_compt_int_to_string: ["__yo_compt_int_to_string"],

  // compt_float related functions
  /// 2 args
  __yo_compt_float_add: ["__yo_compt_float_add"],
  __yo_compt_float_sub: ["__yo_compt_float_sub"],
  __yo_compt_float_mul: ["__yo_compt_float_mul"],
  __yo_compt_float_div: ["__yo_compt_float_div"],
  __yo_compt_float_eq: ["__yo_compt_float_eq"],
  __yo_compt_float_neq: ["__yo_compt_float_neq"],
  __yo_compt_float_lt: ["__yo_compt_float_lt"],
  __yo_compt_float_lte: ["__yo_compt_float_lte"],
  __yo_compt_float_gt: ["__yo_compt_float_gt"],
  __yo_compt_float_gte: ["__yo_compt_float_gte"],
  __yo_compt_float_as: ["__yo_compt_float_as"], // Convert to a different float type
  // 1 arg
  __yo_compt_float_neg: ["__yo_compt_float_neg"],
  __yo_compt_float_to_int: ["__yo_compt_float_to_int"],
  __yo_compt_float_to_string: ["__yo_compt_float_to_string"],

  // Numeric type functions (u8, i8, u16, i16, u32, i32, u64, i64, usize, isize, f32, f64)
  // u8 functions
  __yo_u8_add: ["__yo_u8_add"],
  __yo_u8_sub: ["__yo_u8_sub"],
  __yo_u8_mul: ["__yo_u8_mul"],
  __yo_u8_div: ["__yo_u8_div"],
  __yo_u8_mod: ["__yo_u8_mod"],
  __yo_u8_eq: ["__yo_u8_eq"],
  __yo_u8_neq: ["__yo_u8_neq"],
  __yo_u8_lt: ["__yo_u8_lt"],
  __yo_u8_lte: ["__yo_u8_lte"],
  __yo_u8_gt: ["__yo_u8_gt"],
  __yo_u8_gte: ["__yo_u8_gte"],
  __yo_u8_neg: ["__yo_u8_neg"],
  __yo_u8_to_string: ["__yo_u8_to_string"],
  __yo_u8_as: ["__yo_u8_as"], // Convert to a different number type

  // i8 functions
  __yo_i8_add: ["__yo_i8_add"],
  __yo_i8_sub: ["__yo_i8_sub"],
  __yo_i8_mul: ["__yo_i8_mul"],
  __yo_i8_div: ["__yo_i8_div"],
  __yo_i8_mod: ["__yo_i8_mod"],
  __yo_i8_eq: ["__yo_i8_eq"],
  __yo_i8_neq: ["__yo_i8_neq"],
  __yo_i8_lt: ["__yo_i8_lt"],
  __yo_i8_lte: ["__yo_i8_lte"],
  __yo_i8_gt: ["__yo_i8_gt"],
  __yo_i8_gte: ["__yo_i8_gte"],
  __yo_i8_neg: ["__yo_i8_neg"],
  __yo_i8_to_string: ["__yo_i8_to_string"],
  __yo_i8_as: ["__yo_i8_as"], // Convert to a different number type

  // u16 functions
  __yo_u16_add: ["__yo_u16_add"],
  __yo_u16_sub: ["__yo_u16_sub"],
  __yo_u16_mul: ["__yo_u16_mul"],
  __yo_u16_div: ["__yo_u16_div"],
  __yo_u16_mod: ["__yo_u16_mod"],
  __yo_u16_eq: ["__yo_u16_eq"],
  __yo_u16_neq: ["__yo_u16_neq"],
  __yo_u16_lt: ["__yo_u16_lt"],
  __yo_u16_lte: ["__yo_u16_lte"],
  __yo_u16_gt: ["__yo_u16_gt"],
  __yo_u16_gte: ["__yo_u16_gte"],
  __yo_u16_neg: ["__yo_u16_neg"],
  __yo_u16_to_string: ["__yo_u16_to_string"],
  __yo_u16_as: ["__yo_u16_as"], // Convert to a different number type

  // i16 functions
  __yo_i16_add: ["__yo_i16_add"],
  __yo_i16_sub: ["__yo_i16_sub"],
  __yo_i16_mul: ["__yo_i16_mul"],
  __yo_i16_div: ["__yo_i16_div"],
  __yo_i16_mod: ["__yo_i16_mod"],
  __yo_i16_eq: ["__yo_i16_eq"],
  __yo_i16_neq: ["__yo_i16_neq"],
  __yo_i16_lt: ["__yo_i16_lt"],
  __yo_i16_lte: ["__yo_i16_lte"],
  __yo_i16_gt: ["__yo_i16_gt"],
  __yo_i16_gte: ["__yo_i16_gte"],
  __yo_i16_neg: ["__yo_i16_neg"],
  __yo_i16_to_string: ["__yo_i16_to_string"],
  __yo_i16_as: ["__yo_i16_as"], // Convert to a different number type

  // u32 functions
  __yo_u32_add: ["__yo_u32_add"],
  __yo_u32_sub: ["__yo_u32_sub"],
  __yo_u32_mul: ["__yo_u32_mul"],
  __yo_u32_div: ["__yo_u32_div"],
  __yo_u32_mod: ["__yo_u32_mod"],
  __yo_u32_eq: ["__yo_u32_eq"],
  __yo_u32_neq: ["__yo_u32_neq"],
  __yo_u32_lt: ["__yo_u32_lt"],
  __yo_u32_lte: ["__yo_u32_lte"],
  __yo_u32_gt: ["__yo_u32_gt"],
  __yo_u32_gte: ["__yo_u32_gte"],
  __yo_u32_neg: ["__yo_u32_neg"],
  __yo_u32_to_string: ["__yo_u32_to_string"],
  __yo_u32_as: ["__yo_u32_as"], // Convert to a different number type

  // i32 functions
  __yo_i32_add: ["__yo_i32_add"],
  __yo_i32_sub: ["__yo_i32_sub"],
  __yo_i32_mul: ["__yo_i32_mul"],
  __yo_i32_div: ["__yo_i32_div"],
  __yo_i32_mod: ["__yo_i32_mod"],
  __yo_i32_eq: ["__yo_i32_eq"],
  __yo_i32_neq: ["__yo_i32_neq"],
  __yo_i32_lt: ["__yo_i32_lt"],
  __yo_i32_lte: ["__yo_i32_lte"],
  __yo_i32_gt: ["__yo_i32_gt"],
  __yo_i32_gte: ["__yo_i32_gte"],
  __yo_i32_neg: ["__yo_i32_neg"],
  __yo_i32_to_string: ["__yo_i32_to_string"],
  __yo_i32_as: ["__yo_i32_as"], // Convert to a different number type

  // u64 functions
  __yo_u64_add: ["__yo_u64_add"],
  __yo_u64_sub: ["__yo_u64_sub"],
  __yo_u64_mul: ["__yo_u64_mul"],
  __yo_u64_div: ["__yo_u64_div"],
  __yo_u64_mod: ["__yo_u64_mod"],
  __yo_u64_eq: ["__yo_u64_eq"],
  __yo_u64_neq: ["__yo_u64_neq"],
  __yo_u64_lt: ["__yo_u64_lt"],
  __yo_u64_lte: ["__yo_u64_lte"],
  __yo_u64_gt: ["__yo_u64_gt"],
  __yo_u64_gte: ["__yo_u64_gte"],
  __yo_u64_neg: ["__yo_u64_neg"],
  __yo_u64_to_string: ["__yo_u64_to_string"],
  __yo_u64_as: ["__yo_u64_as"], // Convert to a different number type

  // i64 functions
  __yo_i64_add: ["__yo_i64_add"],
  __yo_i64_sub: ["__yo_i64_sub"],
  __yo_i64_mul: ["__yo_i64_mul"],
  __yo_i64_div: ["__yo_i64_div"],
  __yo_i64_mod: ["__yo_i64_mod"],
  __yo_i64_eq: ["__yo_i64_eq"],
  __yo_i64_neq: ["__yo_i64_neq"],
  __yo_i64_lt: ["__yo_i64_lt"],
  __yo_i64_lte: ["__yo_i64_lte"],
  __yo_i64_gt: ["__yo_i64_gt"],
  __yo_i64_gte: ["__yo_i64_gte"],
  __yo_i64_neg: ["__yo_i64_neg"],
  __yo_i64_to_string: ["__yo_i64_to_string"],
  __yo_i64_as: ["__yo_i64_as"], // Convert to a different number type

  // usize functions
  __yo_usize_add: ["__yo_usize_add"],
  __yo_usize_sub: ["__yo_usize_sub"],
  __yo_usize_mul: ["__yo_usize_mul"],
  __yo_usize_div: ["__yo_usize_div"],
  __yo_usize_mod: ["__yo_usize_mod"],
  __yo_usize_eq: ["__yo_usize_eq"],
  __yo_usize_neq: ["__yo_usize_neq"],
  __yo_usize_lt: ["__yo_usize_lt"],
  __yo_usize_lte: ["__yo_usize_lte"],
  __yo_usize_gt: ["__yo_usize_gt"],
  __yo_usize_gte: ["__yo_usize_gte"],
  __yo_usize_neg: ["__yo_usize_neg"],
  __yo_usize_to_string: ["__yo_usize_to_string"],
  __yo_usize_as: ["__yo_usize_as"], // Convert to a different number type

  // isize functions
  __yo_isize_add: ["__yo_isize_add"],
  __yo_isize_sub: ["__yo_isize_sub"],
  __yo_isize_mul: ["__yo_isize_mul"],
  __yo_isize_div: ["__yo_isize_div"],
  __yo_isize_mod: ["__yo_isize_mod"],
  __yo_isize_eq: ["__yo_isize_eq"],
  __yo_isize_neq: ["__yo_isize_neq"],
  __yo_isize_lt: ["__yo_isize_lt"],
  __yo_isize_lte: ["__yo_isize_lte"],
  __yo_isize_gt: ["__yo_isize_gt"],
  __yo_isize_gte: ["__yo_isize_gte"],
  __yo_isize_neg: ["__yo_isize_neg"],
  __yo_isize_to_string: ["__yo_isize_to_string"],
  __yo_isize_as: ["__yo_isize_as"], // Convert to a different number type

  // f32 functions
  __yo_f32_add: ["__yo_f32_add"],
  __yo_f32_sub: ["__yo_f32_sub"],
  __yo_f32_mul: ["__yo_f32_mul"],
  __yo_f32_div: ["__yo_f32_div"],
  __yo_f32_eq: ["__yo_f32_eq"],
  __yo_f32_neq: ["__yo_f32_neq"],
  __yo_f32_lt: ["__yo_f32_lt"],
  __yo_f32_lte: ["__yo_f32_lte"],
  __yo_f32_gt: ["__yo_f32_gt"],
  __yo_f32_gte: ["__yo_f32_gte"],
  __yo_f32_neg: ["__yo_f32_neg"],
  __yo_f32_to_string: ["__yo_f32_to_string"],
  __yo_f32_as: ["__yo_f32_as"], // Convert to a different number type

  // f64 functions
  __yo_f64_add: ["__yo_f64_add"],
  __yo_f64_sub: ["__yo_f64_sub"],
  __yo_f64_mul: ["__yo_f64_mul"],
  __yo_f64_div: ["__yo_f64_div"],
  __yo_f64_eq: ["__yo_f64_eq"],
  __yo_f64_neq: ["__yo_f64_neq"],
  __yo_f64_lt: ["__yo_f64_lt"],
  __yo_f64_lte: ["__yo_f64_lte"],
  __yo_f64_gt: ["__yo_f64_gt"],
  __yo_f64_gte: ["__yo_f64_gte"],
  __yo_f64_neg: ["__yo_f64_neg"],
  __yo_f64_to_string: ["__yo_f64_to_string"],
  __yo_f64_as: ["__yo_f64_as"], // Convert to a different number type

  // compt_boolean related functions
  /// 2 args
  __yo_compt_boolean_and: ["__yo_compt_boolean_and"],
  __yo_compt_boolean_or: ["__yo_compt_boolean_or"],
  __yo_compt_boolean_eq: ["__yo_compt_boolean_eq"],
  __yo_compt_boolean_neq: ["__yo_compt_boolean_neq"],
  // 1 arg
  __yo_compt_boolean_not: ["__yo_compt_boolean_not"],
  __yo_compt_boolean_to_string: ["__yo_compt_boolean_to_string"],

  // compt_string related functions
  /// 2 args
  __yo_compt_string_concat: ["__yo_compt_string_concat"],
  __yo_compt_string_eq: ["__yo_compt_string_eq"],
  __yo_compt_string_neq: ["__yo_compt_string_neq"],
  __yo_compt_string_lt: ["__yo_compt_string_lt"],
  __yo_compt_string_lte: ["__yo_compt_string_lte"],
  __yo_compt_string_gt: ["__yo_compt_string_gt"],
  __yo_compt_string_gte: ["__yo_compt_string_gte"],
  // 1 arg
  __yo_compt_string_length: ["__yo_compt_string_length"],
  __yo_compt_string_to_upper: ["__yo_compt_string_to_upper"],
  __yo_compt_string_to_lower: ["__yo_compt_string_to_lower"],
  // 2-3 args (string, start, optional end)
  __yo_compt_string_slice: ["__yo_compt_string_slice"],

  // Type related functions
  __yo_type_to_string: ["__yo_type_to_string"],
  __yo_type_is_linear: ["__yo_type_is_linear"],
  __yo_type_is_free: ["__yo_type_is_free"],
  __yo_type_is_type0: ["__yo_type_is_type0"],
  __yo_type_contains_reference: ["__yo_type_contains_reference"],
};

export function exprIsInfixOperatorFunctionCall(expr: Expr): boolean {
  return Boolean(
    expr.tag === "FuncCall" &&
      expr.isInfix &&
      expr.func.tag === "Atom" &&
      (expr.func.token.type === TokenType.Operator ||
        expr.func.token.type === TokenType.BacktickIdentifier) &&
      expr.args.length === 2
  );
}

export function exprToString(expr: Expr): string {
  let printed = "";
  switch (expr.tag) {
    case "Atom": {
      printed = expr.token.value;
      break;
    }
    case "FuncCall": {
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot ||
          expr.func.token.type === TokenType.BacktickIdentifier)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            printed = `${expr.func.token.value}${exprToString(expr.args[0]!)}`;
          } else {
            printed = `${expr.func.token.value}(${exprToString(expr.args[0]!)})`;
          }
          break;
        } else if (expr.args.length === 2 && expr.isInfix) {
          let lhs = exprToString(expr.args[0]!);
          let rhs = exprToString(expr.args[1]!);
          lhs =
            exprIsInfixOperatorFunctionCall(expr.args[0]!) ||
            exprIsAtomAndOperator(expr.args[0]!)
              ? `(${lhs})`
              : lhs;
          rhs =
            exprIsInfixOperatorFunctionCall(expr.args[1]!) ||
            exprIsAtomAndOperator(expr.args[1]!)
              ? `(${rhs})`
              : rhs;
          if (expr.func.token.value === ".") {
            printed = `(${lhs}.${rhs})`;
          } else {
            printed = `${lhs} ${expr.func.token.value} ${rhs}`;
          }
          break;
        }
      }
      if (
        expr.func.tag === "Atom" &&
        expr.func.token.type === TokenType.Identifier &&
        expr.func.token.value === BuiltinKeywords.tuple
      ) {
        if (expr.args.length === 1) {
          printed = `(${exprToString(expr.args[0]!)},)`;
        } else {
          printed = `(${expr.args
            .map((arg) => {
              return exprToString(arg);
            })
            .join(", ")
            .trim()})`;
        }
        break;
      }

      let func = exprToString(expr.func);
      func =
        exprIsInfixOperatorFunctionCall(expr.func) ||
        exprIsAtomAndOperator(expr.func)
          ? `(${func})`
          : func;
      const args = expr.args
        .map((arg) => {
          return exprToString(arg);
        })
        .join(", ")
        .trim();
      printed = `${func}(${args})`;
      break;
    }
  }

  return printed;
}

export function attachTempVariableToExpr(expr: Expr): void {
  if (!expr.$) {
    throw new Error(`Expected expression to be evaluated, but it is not:
${exprToString(expr)}`);
  }
  const { env, type, value, isMutable } = expr.$;
  const modulePath = env.modulePath;
  const tempVariableName = generateNewTempVariableName(modulePath);

  // Add temp variable to the environment
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: tempVariableName,
      type,
      value,
      isMutable,
      isCompileTimeOnly: Boolean(value),
      isImplicit: false,
      initializedAtToken: expr.token,
      consumedAtToken: undefined,
      token: expr.token,
    },
  });

  expr.$.variableName = tempVariableName;
  expr.$.env = nextEnv;
}

export function setExprAsConsumed(expr: Expr, env: Environment): Environment {
  // Check if it's dereferencing a pointer/reference to linear type value.
  if (
    expr.$?.isAccessingProperty &&
    isLinearOrType0Type(typeOfType(expr.$.type))
  ) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Cannot consume a property which is "Linear" value.`,
        },
      ],
    });
  }

  const nameOfVariableToConsume = expr.$?.variableName;
  if (!nameOfVariableToConsume) {
    return env;
    /*
    throw formatErrorMessages({
      modulePath: env.modulePath,
      inputString: env.inputString,
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Failed to consume the expression as it is not a variable or does not have a temporary variable name.`,
        },
      ],
    });
    */
  }

  const variables = getVariablesFromEnv(env, nameOfVariableToConsume);
  if (variables.length === 0) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
        },
      ],
    });
  }

  const variableToConsume = variables[variables.length - 1]!;
  if (isLinearOrType0Type(typeOfType(variableToConsume.type))) {
    // Check if the variable is already consumed
    if (variableToConsume.consumedAtToken) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: expr.token,
            errorMessage: `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again.`,
          },
          {
            token: variableToConsume.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }

    // Set the variable as consumed
    env = updateExistingVariable(env, variableToConsume, {
      ...variableToConsume,
      consumedAtToken: expr.token,
    });
  }
  return env;
}

/**
 *
 * Require the given "expr" is not consumed,
 * if it is consumed, then throw an error.
 */
export function requireExprNotConsumed(expr: Expr, env: Environment): void {
  const nameOfVariableToConsume = expr.$?.variableName;
  if (!nameOfVariableToConsume) {
    return;
  }

  const variables = getVariablesFromEnv(env, nameOfVariableToConsume);
  if (variables.length === 0) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
        },
      ],
    });
  }

  const variableToConsume = variables[variables.length - 1]!;
  // NOTE: We also allow Free value to be consumed now.
  // if (isLinearOrType0Type(typeOfType(variableToConsume.type))) {
  // Check if the variable is already consumed
  if (variableToConsume.consumedAtToken) {
    throw formatErrorMessages({
      tokenAndErrorList: [
        {
          token: expr.token,
          errorMessage: `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again.`,
        },
        {
          token: variableToConsume.consumedAtToken,
          errorMessage: `Previously consumed here:`,
        },
      ],
    });
  }
  // }
}

/**
 * Update `env` based on multiple envs in different cases.
 * @param env the base env, before entering cond/match cases.
 * @param bodies the bodies of the cases, not including the condition/case.
 */
export function mergeAndCheckEnvs(
  env: Environment,
  bodies: Expr[]
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // tempVariableName: string
): Environment {
  const maxFrameLevel = env.frames.length - 1;
  const caseEnvs: Environment[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    if (!body.$) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: body.token,
            errorMessage: `Expected the body of the case to be evaluated, but it is not.`,
          },
        ],
      });
    }

    const caseEnv = body.$.env;
    caseEnvs.push(caseEnv);
  }

  // Check if the frame level is the same for all cases
  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i]!;
    // right now each cond/match case will push new env frame
    // so it needs to - 2, instead of - 1.
    if (caseEnv.frames.length - 2 !== maxFrameLevel) {
      throw formatErrorMessages({
        tokenAndErrorList: [
          {
            token: bodies[i]!.token,
            errorMessage: `Frame level is different for different cases.`,
          },
        ],
      });
    }
  }

  // Check each frame
  for (let i = 0; i <= maxFrameLevel; i++) {
    const frame = env.frames[i]!;
    const frameVariables = [...frame.variables];

    // Build the consumedAtToken matrix
    // that has 1 + caseEnvs.length rows
    // and frameVariables.length columns
    // each cell is consumedAtToken of the value
    const matrix: {
      consumedAtToken: Token | undefined;
      initializedAtToken: Token | undefined;
    }[][] = [[]];
    frameVariables.forEach((variale) => {
      matrix[0]!.push({
        consumedAtToken: variale.consumedAtToken,
        initializedAtToken: variale.initializedAtToken,
      });
    });

    for (let j = 0; j < caseEnvs.length; j++) {
      const caseEnv = caseEnvs[j]!;
      const caseEnvFrame = caseEnv.frames[i]!;
      const caseEnvFrameVariables = caseEnvFrame.variables;

      // Check if the number of variables is the same
      if (
        i !== maxFrameLevel &&
        frameVariables.length !== caseEnvFrameVariables.length
      ) {
        throw formatErrorMessages({
          tokenAndErrorList: [
            {
              token: bodies[j]!.token,
              errorMessage: `Frame level ${i} has different number of values for different cases.`,
            },
          ],
        });
      }

      // Check if the variable names are the same
      for (let k = 0; k < frameVariables.length; k++) {
        const frameVariable = frameVariables[k]!;
        const caseEnvFrameValue = caseEnvFrameVariables[k]!;
        if (frameVariable.name !== caseEnvFrameValue.name) {
          throw formatErrorMessages({
            tokenAndErrorList: [
              {
                token: bodies[j]!.token,
                errorMessage: `Frame level ${i} has different variable names for different cases.`,
              },
            ],
          });
        }
      }

      // TODO: Check type, but I think it's unnecessary here.

      // Check the consumedAtToken
      matrix.push([]);
      caseEnvFrameVariables.forEach((variable) => {
        matrix[matrix.length - 1]!.push({
          consumedAtToken: variable.consumedAtToken,
          initializedAtToken: variable.initializedAtToken,
        });
      });
    }

    // Check the matrix column to make sure that
    // for each variable:
    // 1. If there is only one case, and it's not consumed in env, but consumed in the case, then throw error.
    // 2. If have consumed in all cases, then set it as consumed in env.
    // 3. If some are consumed in some cases, then throw error.
    const rows = matrix.length;
    const cols = matrix[0]!.length;
    for (let i = 0; i < cols; i++) {
      const variableName = frameVariables[i]!.name;
      const consumedAtTokens: (Token | undefined)[] = [];
      const initializedAtTokens: (Token | undefined)[] = [];
      for (let j = 1; j < rows; j++) {
        consumedAtTokens.push(matrix[j]![i]!.consumedAtToken);
        initializedAtTokens.push(matrix[j]![i]!.initializedAtToken);
      }

      // Check the "Free" values.
      // If any case consumed (used) the "Free" value, then we set it as consumed in env.
      if (isFreeType(typeOfType(frameVariables[i]!.type))) {
        const consumed = consumedAtTokens.filter((t) => !!t) as Token[];
        if (consumed.length > 0) {
          const newVariable: Variable = {
            ...frameVariables[i]!,
            consumedAtToken: consumedAtTokens[0],
          };
          env = updateExistingVariable(env, frameVariables[i]!, newVariable);
          frameVariables[i] = newVariable;
        }
      } else {
        // consumedAtToken
        // case 1
        if (consumedAtTokens.length === 1) {
          if (!!consumedAtTokens[0] && !frameVariables[i]!.consumedAtToken) {
            /*
          throw formatErrorMessages({
            tokenAndErrorList: [
              {
                token: frameVariables[i]!.token,
                errorMessage: `Variable "${variableName}" might not be consumed in all cases:`,
              },
              {
                token: tokens[0],
                errorMessage: `Might be consumed here:`,
              },
            ],
          });
          */
            // RAII, call "drop" on variable if it is not consumed.
            const newVariable: Variable = {
              ...frameVariables[i]!,
              consumedAtToken: consumedAtTokens[0],
            };
            env = updateExistingVariable(env, frameVariables[i]!, newVariable);
            frameVariables[i] = newVariable;
          }
        }
        // case 2
        else if (consumedAtTokens.every((t) => !!t)) {
          const newVariable: Variable = {
            ...frameVariables[i]!,
            consumedAtToken: consumedAtTokens[0],
          };
          env = updateExistingVariable(env, frameVariables[i]!, newVariable);
          frameVariables[i] = newVariable;
        }
        // case 3
        else {
          const consumed = consumedAtTokens.filter((t) => !!t) as Token[];
          const notConsumed = consumedAtTokens.filter((t) => !t);
          if (consumed.length > 0 && notConsumed.length > 0) {
            /*
          throw formatErrorMessages({
            errorMessage: `Variable "${variableName}" might be consumed in some cases but not consumed in other cases:\n`,
            tokenAndErrorList: consumedAtTokens.map((token, index) => {
              return {
                errorMessage: token
                  ? "Might be consumed here:"
                  : "Not consumed here:",
                token: token ?? bodies[index]!.token,
              };
            }),
          });
          */

            // RAII, call "drop" on variable if it is not consumed.
            const newVariable: Variable = {
              ...frameVariables[i]!,
              consumedAtToken: consumed[0],
            };
            env = updateExistingVariable(env, frameVariables[i]!, newVariable);
            frameVariables[i] = newVariable;
          }
        }
      }

      // Check initializedAtToken
      // case 1
      if (initializedAtTokens.length === 1) {
        if (
          !!initializedAtTokens[0] &&
          !frameVariables[i]!.initializedAtToken
        ) {
          throw formatErrorMessages({
            tokenAndErrorList: [
              {
                token: frameVariables[i]!.token,
                errorMessage: `Variable "${frameVariables[i]!.name}" might not be initialized in all cases.`,
              },
              {
                token: initializedAtTokens[0]!,
                errorMessage: `Might be initialized here:`,
              },
            ],
          });
        }
      }
      // case 2
      // variable is undefined outside, but all cases make it defined.
      else if (
        !frameVariables[i]!.initializedAtToken &&
        initializedAtTokens.every((u) => u)
      ) {
        const newVariable: Variable = {
          ...frameVariables[i]!,
          initializedAtToken: initializedAtTokens[0]!,
        };
        env = updateExistingVariable(env, frameVariables[i]!, newVariable);
        frameVariables[i] = newVariable;
      }
      // case 3
      else {
        const initialized = initializedAtTokens.filter((u) => !!u);
        const notInitialized = initializedAtTokens.filter((u) => !u);
        if (initialized.length > 0 && notInitialized.length > 0) {
          throw formatErrorMessages({
            errorMessage: `Variable "${variableName}" might be initialized in some cases but not initialized in other cases:\n`,
            tokenAndErrorList: initializedAtTokens.map((token, index) => {
              return {
                errorMessage: token
                  ? "Might be initialized here:"
                  : "Not initialized here:",
                token: token ?? bodies[index]!.token,
              };
            }),
          });
        }
      }
    }
  }

  return env;
}
