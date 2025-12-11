/* eslint-disable no-constant-condition */
import {
  addVariableToEnv,
  Environment,
  Frame,
  getVariablesFromEnv,
  updateExistingVariable,
  Variable,
} from "./env";
import { formatErrorMessage, formatErrorMessages } from "./error";
import { EvaluatorContext } from "./evaluator/context";
import { evaluateExpression } from "./evaluator/exprs/expr";
import { generateExprFromCode } from "./parser";
import { Token, TokenType } from "./token";
import {
  areTypesCompatible,
  isSomeType,
  StructType,
  Type,
  typeContainsGcType,
  typeToString,
} from "./types";
import {
  generateNewTempVariableName,
  generateVarialeId,
  isTempVariableName,
} from "./utils";
import { isTypeValue, ModuleValue, Value } from "./value";
import { ValueTag } from "./value-tag";

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

export interface RuntimeDestructuring {
  label: string;
  type: Type;
  variableName: string;
}

export type ControlFlowKind = "return" | "break" | "continue";

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
   * When a compile-time type needs to be converted to a different runtime type,
   * this field stores the target runtime type.
   * For example: string literal "hello" with type compt_string converted to [u8]
   */
  convertedRuntimeType?: Type;
  /**
   * If this is given, then it means there is a temporary variable holding the value in the `env` above.
   */
  variableName?: string;

  /**
   * The type of the root object in a property access chain.
   * Used to determine mutability for nested property access and dereference.
   *
   * Examples:
   * - c.val.*   -> originType is the type of 'c'
   * - x.a.b.*   -> originType is the type of 'x'
   * - y.*       -> originType is the type of 'y'
   */
  originType?: Type;

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

  /**
   * This is mainly for FuncCall expressions.
   * It is used to record the runtime arguments passed to the function call in order.
   * This is useful for the codegen stage.
   */
  runtimeArgExprsInOrder?: Expr[];

  /**
   * This is for destructuring:
   *
   *   { x, y : another_y } := some_point;
   *
   * We only save the ones for runtime variables, which
   * will be used in the later on C code generation.
   */
  runtimeDestructurings?: RuntimeDestructuring[];

  /**
   * Whether this expression is:
   * 1. "return" from a function.
   * 2. "break" from a loop.
   * 3. "continue" from a loop.
   * 4. normal expression.
   */
  controlFlow?: ControlFlowKind;

  /**
   * For dyn() function calls, this contains the module values that provide
   * the dynamic dispatch implementations. Used by C codegen to generate
   * vtables and method dispatch code.
   */
  dynCallModuleValues?: ModuleValue[];

  /**
   * This is for codegen for the "cond"/"match" expressions.
   * If this is true, then it means the case has been executed, and we will perform code generation for it.
   * Otherwise, we won't perform code generation for it.
   */
  caseExecuted?: boolean;

  /**
   * Comment for the expression.
   */
  comment?: string;

  /**
   * For closures that capture Ref variables, this contains expressions that
   * call ___dup on the captured variables. Used by C codegen to generate
   * proper Ref handling in closure ___dup methods.
   *
   * Example: If a closure captures `x: MyBox`, this would contain the expression `x.___dup()`
   */
  deferredDupExpressions?: Expr[];

  /**
   * Contains expressions that call ___drop on variables that need cleanup.
   * Used to defer drop call generation to codegen phase instead of inserting
   * them directly into the AST during evaluation, preventing use-after-free errors.
   *
   * Example: If a variable `x: MyBox` needs dropping, this would contain the expression `___drop(x)`
   */
  deferredDropExpressions?: Expr[];

  /**
   * For async expressions, this contains the optional stack size configuration (runtime-known).
   * If undefined, the default stack size (16KB) is used.
   *
   * Example: For `async say("hello"), { stack_size: 1024 * 64 }`, this contains the evaluated expression `1024 * 64`
   */
  asyncStackSize?: Expr;

  /**
   * For closure and async block expressions, this contains the capture struct type that holds all
   * captured variables from outer scope.
   * The capture struct has Ref functions (___drop, ___dup, ___dispose) auto-generated.
   *
   * Example: For `async { printf("%d", x); }` where `x: MyBox` is from outer scope,
   * this would contain a StructType with a single field `x: MyBox`.
   *
   * For closures without captures, this is undefined.
   */
  captureType?: StructType;

  /**
   * For closure construction expressions (calling a closure type with a body),
   * this holds the FunctionValue that implements the closure body.
   * This is used during C code generation to find the function to call.
   *
   * Example: For `(fn(x: i32) => i32)(begin(return(x + 1)))`, this contains
   * the FunctionValue for the anonymous function implementation.
   */
  closureFunctionValue?: Value & { tag: ValueTag.Function };

  /**
   * For macro function calls (functions with isUnquote return type),
   * this holds the evaluated expanded expression.
   * Used by C codegen to generate code for the expanded form.
   *
   * Example: For `if(cond, thenBranch, elseBranch)` which expands to
   * `cond(cond => thenBranch, true => elseBranch)`, this contains the
   * evaluated cond(...) expression.
   */
  macroExpansion?: Expr;

  /**
   * For begin blocks, this contains the environment frame that was popped
   * after evaluating the block.
   *
   * Example: For `begin(x := MyBox(42); printf("%d", x.(*)))`, this contains
   * the frame with the variable `x` before it was popped.
   */
  poppedEnvFrame?: Frame;
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
      return {
        ...expr,
        $: undefined, //  expr.$ ? { ...expr.$ } : undefined
        // NOTE: We should unset the evaluated data here,
      };
    case ExprTag.FuncCall:
      return {
        ...expr,
        func: cloneExpr(expr.func),
        args: expr.args.map(cloneExpr),
        $: undefined, //  expr.$ ? { ...expr.$ } : undefined,
        // NOTE: We should unset the evaluated data here,
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

export function expectExprToHaveBeenEvaluated(
  expr: Expr,
  errorMessage?: string
) {
  if (expr.$ === undefined) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage:
        errorMessage ??
        `Expected expression to have been evaluated, but it has not been evaluated yet:\n${exprToString(
          expr
        )}`,
    });
  }
  return expr.$;
}

// Helper function to compare expressions structurally
export function exprsAreEqual(expr1: Expr, expr2: Expr): boolean {
  // Different expression types are never equal
  if (expr1.tag !== expr2.tag) {
    return false;
  }

  if (expr1.tag === ExprTag.Atom && expr2.tag === ExprTag.Atom) {
    // For atoms, compare the token values
    return expr1.token.value === expr2.token.value;
  }

  if (expr1.tag === ExprTag.FuncCall && expr2.tag === ExprTag.FuncCall) {
    // For function calls, compare the function and all arguments
    if (!exprsAreEqual(expr1.func, expr2.func)) {
      return false;
    }

    if (expr1.args.length !== expr2.args.length) {
      return false;
    }

    for (let i = 0; i < expr1.args.length; i++) {
      if (!exprsAreEqual(expr1.args[i]!, expr2.args[i]!)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

export const BuiltinKeywords = {
  compt: ["compt" /*"@"*/],
  ref: ["ref"], // Reference semantics for struct/enum

  forall: ["forall", "∀"],
  where: ["where"],
  // Exists: ["exists", "∃"],
  // In: ["in", "∈"],

  quote: ["quote", ":"],
  unquote: ["unquote", "#"], // QUESTION: ~ is actually bitwise not in C, should we pick another symbol?
  unquote_splicing: ["unquote_splicing", "...#"],

  return: ["return"],
  recur: ["recur"],
  fn: ["fn"],
  unsafe_fn: ["unsafe_fn"], // The function that skips the prohibitVoidType check
  extern: ["extern"],
  cond: ["cond"],
  type: ["type"],
  match: ["match"],
  test: ["test"], // Test declaration for test runner
  struct: ["struct"],
  object: ["object"],
  newtype: ["newtype"],
  enum: ["enum"],
  union: ["union"],
  module: ["module"],
  impl: ["impl"],
  Impl: ["Impl"],
  begin: ["begin"],
  module_begin: ["module_begin"],
  import: ["import"],
  export: ["export"],
  open: ["open"],
  // pass: ["paas"], // pass is the same as noop
  // drop: ["drop"],
  clone: ["clone", "%"], // IDEA: two circles and a slash perfectly represent clone!
  break: ["break"],
  continue: ["continue"],
  while: ["while"],
  if: ["if"],
  op_and: ["&&"],
  op_or: ["||"],
  not: ["not"],
  gensym: ["gensym"],

  // dynamic dispatch type
  dyn: ["dyn"],
  Dyn: ["Dyn"],

  // Fn trait (callable types)
  Fn: ["Fn"],

  // C related
  c_include: ["c_include"],

  // values
  undefined: ["undefined"],
  null: ["null"],
  true: ["true"],
  false: ["false"],

  // data types
  unique: ["unique", "^"],

  Ptr: ["*"],

  Tuple: ["Tuple"],
  Array: ["Array"],
  Slice: ["Slice"],
  Future: ["Future"],
  Type: ["Type"],
  Module: ["Module"],
  ComptList: ["ComptList"],

  // data values
  tuple: "tuple",
  array: "array",
  compt_list: "compt_list", // compt_list
};

export const BuiltinFunctions = {
  // compile-time related functions
  compt_expect_error: ["compt_expect_error"],
  compt_assert: ["compt_assert"],
  compt_print: ["compt_print"],
  // compt_codegen_inline: ["compt_codegen_inline"],

  // va_XX related function for variadic arguments
  // Only `va_start` needs to be handled here.
  va_start: ["va_start"],

  // Array related
  // ...

  typeof: ["typeof"],
  sizeof: ["sizeof"],
  alignof: ["alignof"],
  consume: ["consume"],
  macro_expand: ["macro_expand"],
  as: ["as"],
  the: ["the"],
  do: ["do"],

  // Async/await functions
  async: ["async"],
  await: ["await"],
  __yo_concurrency_set_maximum_threads: [
    "__yo_concurrency_set_maximum_threads",
  ],

  // Pointer related functions
  // Check std/data/primitives/ptr.yo
  __yo_ptr_cast: ["__yo_ptr_cast"],
  __yo_ptr_add: ["__yo_ptr_add"],
  __yo_ptr_sub: ["__yo_ptr_sub"],
  __yo_ptr_diff: ["__yo_ptr_diff"],
  __yo_ptr_eq: ["__yo_ptr_eq"],
  __yo_ptr_neq: ["__yo_ptr_neq"],
  __yo_ptr_lt: ["__yo_ptr_lt"],
  __yo_ptr_lte: ["__yo_ptr_lte"],
  __yo_ptr_gt: ["__yo_ptr_gt"],
  __yo_ptr_gte: ["__yo_ptr_gte"],
  __yo_address_of: ["&"],
  __yo_ptr_deref: ["__yo_ptr_deref"],
  __yo_ptr_set: ["__yo_ptr_set"],

  // Type casting for primitives (generic form)
  __yo_as: ["__yo_as"],

  // expr related functions
  // __yo_expr_is_expr: ["__yo_expr_is_expr"],
  __yo_expr_is_atom: ["__yo_expr_is_atom"],
  __yo_expr_is_fn_call: ["__yo_expr_is_fn_call"],
  __yo_expr_get_callee: ["__yo_expr_get_callee"],
  __yo_expr_get_args: ["__yo_expr_get_args"],
  __yo_expr_to_string: ["__yo_expr_to_string"],
  __yo_expr_eq: ["__yo_expr_eq"],

  // expr_list related functions
  // __yo_expr_list_is_expr_list: ["__yo_expr_list_is_expr_list"],
  __yo_compt_list_car: ["__yo_compt_list_car"],
  __yo_compt_list_cdr: ["__yo_compt_list_cdr"],
  __yo_compt_list_cons: ["__yo_compt_list_cons"],
  __yo_compt_list_append: ["__yo_compt_list_append"],
  __yo_compt_list_length: ["__yo_compt_list_length"],
  __yo_compt_list_element_type: ["__yo_compt_list_element_type"],

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
  // __yo_type_is_type0: ["__yo_type_is_type0"],
  __yo_type_contains_arc_type: ["__yo_type_contains_arc_type"],
  __yo_are_types_compatible: ["__yo_are_types_compatible"],
  __yo_type_impls: ["__yo_type_impls"], // Check if a type implements a module (e.g., Copy, Send)

  // Operator related functions
  /// Arithemtic
  __yo_op_add: ["__yo_op_add"], // +
  __yo_op_sub: ["__yo_op_sub"], // -
  __yo_op_mul: ["__yo_op_mul"], // *
  __yo_op_div: ["__yo_op_div"], // /
  __yo_op_mod: ["__yo_op_mod"], // %
  __yo_op_neg: ["__yo_op_neg"], // -

  /// Relational
  __yo_op_eq: ["__yo_op_eq"], // ==
  __yo_op_neq: ["__yo_op_neq"], // !=
  __yo_op_lt: ["__yo_op_lt"], // <
  __yo_op_lte: ["__yo_op_lte"], // <=
  __yo_op_gt: ["__yo_op_gt"], // >
  __yo_op_gte: ["__yo_op_gte"], // >=

  /// Logical
  __yo_op_not: ["__yo_op_not"], // !

  /// Bitwise
  __yo_op_bit_and: ["__yo_op_bit_and"], // &
  __yo_op_bit_or: ["__yo_op_bit_or"], // |
  __yo_op_bit_xor: ["__yo_op_bit_xor"], // ^
  __yo_op_bit_complement: ["__yo_op_bit_complement"], // ~
  __yo_op_bit_left_shift: ["__yo_op_bit_left_shift"], // <<
  __yo_op_bit_right_shift: ["__yo_op_bit_right_shift"], // >>

  // C language related
  c_include: ["c_include"],

  // Error handling
  panic: ["panic"],

  // Ref related
  is_uniquely_owned: ["is_unique_owned"], // Check if the value is uniquely owned
  __yo_decr_rc: ["__yo_decr_rc"], // decrement the reference-counter (usize)
  __yo_incr_rc: ["__yo_incr_rc"], // increment the reference-counter (usize)
  __yo_rc_own: ["__yo_rc_own"], // return the value itself, but set isOwningTheGcValue to be true. This is useful for implementing ___dup function.

  // Garbage collection for cycle detection
  __yo_gc_collect: ["__yo_gc_collect"], // manually trigger garbage collection

  // Dynamic dispatch Ref functions
  __yo_dyn_drop: ["__yo_dyn_drop"], // drop the dyn object with wrapped object
  __yo_dyn_dup: ["__yo_dyn_dup"], // dup the dyn object with wrapped object

  // Ref functions
  ___drop: ["___drop"], // drop the value; decrement the reference-counter if necessary, and call `dispose` if is_uniquely_owned
  ___dispose: ["___dispose"],
  ___dup: ["___dup"], // duplicate the value; increment the reference-counter if necessary
  dispose: ["dispose"], // Destructor to run when an object is dropped

  /// Others
  __yo_noop: ["__yo_noop"],
  __yo_return_self: ["__yo_return_self"],
  __yo_ms_sleep: ["__yo_ms_sleep"],
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

export interface ExprToStringConfig {
  prettyPrint?: boolean;
  indentSize?: number;
  maxLineLength?: number;
  indentLevel?: number;
}

export function exprToString(expr: Expr, config?: ExprToStringConfig): string {
  const defaultConfig: Required<ExprToStringConfig> = {
    prettyPrint: false,
    indentSize: 2,
    maxLineLength: 80,
    indentLevel: 0,
  };

  const finalConfig = { ...defaultConfig, ...config };

  if (finalConfig.prettyPrint) {
    return exprToPrettyString(expr, finalConfig);
  } else {
    return exprToCompactString(expr);
  }
}

function exprToCompactString(expr: Expr): string {
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
            printed = `${expr.func.token.value}${exprToCompactString(expr.args[0]!)}`;
          } else {
            printed = `${expr.func.token.value}(${exprToCompactString(expr.args[0]!)})`;
          }
          break;
        } else if (expr.args.length === 2 && expr.isInfix) {
          let lhs = exprToCompactString(expr.args[0]!);
          let rhs = exprToCompactString(expr.args[1]!);
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
          printed = `(${exprToCompactString(expr.args[0]!)},)`;
        } else {
          printed = `(${expr.args
            .map((arg) => {
              return exprToCompactString(arg);
            })
            .join(", ")
            .trim()})`;
        }
        break;
      }

      let func = exprToCompactString(expr.func);
      func =
        exprIsInfixOperatorFunctionCall(expr.func) ||
        exprIsAtomAndOperator(expr.func)
          ? `(${func})`
          : func;
      const args = expr.args
        .map((arg) => {
          return exprToCompactString(arg);
        })
        .join(", ")
        .trim();
      printed = `${func}(${args})`;
      break;
    }
  }

  return printed;
}

function exprToPrettyString(
  expr: Expr,
  config: Required<ExprToStringConfig>
): string {
  const indent = " ".repeat(config.indentLevel * config.indentSize);
  const nextConfig = { ...config, indentLevel: config.indentLevel + 1 };
  const nextIndent = " ".repeat(nextConfig.indentLevel * config.indentSize);

  switch (expr.tag) {
    case "Atom": {
      return expr.token.value;
    }
    case "FuncCall": {
      // Handle special operators and dots
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot ||
          expr.func.token.type === TokenType.BacktickIdentifier)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            return `${expr.func.token.value}${exprToPrettyString(expr.args[0]!, config)}`;
          } else {
            const arg = exprToPrettyString(expr.args[0]!, config);
            return `${expr.func.token.value}(${arg})`;
          }
        } else if (expr.args.length === 2 && expr.isInfix) {
          let lhs = exprToPrettyString(expr.args[0]!, config);
          let rhs = exprToPrettyString(expr.args[1]!, config);

          // Add parentheses if needed - since Yo has no operator precedence,
          // we need to be explicit about grouping
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
            return `(${lhs}.${rhs})`;
          } else {
            // For arrow operator and other infix operators, wrap the result in parentheses
            // to make grouping explicit when used as part of larger expressions
            const result = `${lhs} ${expr.func.token.value} ${rhs}`;
            return result;
          }
        }
      }

      // Handle tuple specially
      if (
        expr.func.tag === "Atom" &&
        expr.func.token.type === TokenType.Identifier &&
        expr.func.token.value === BuiltinKeywords.tuple
      ) {
        if (expr.args.length === 0) {
          return "()";
        } else if (expr.args.length === 1) {
          return `(${exprToPrettyString(expr.args[0]!, config)},)`;
        } else {
          const args = expr.args.map((arg) => exprToPrettyString(arg, config));
          const singleLine = `(${args.join(", ")})`;

          if (singleLine.length <= config.maxLineLength) {
            return singleLine;
          } else {
            return `(\n${nextIndent}${args.join(`,\n${nextIndent}`)}\n${indent})`;
          }
        }
      }

      // Handle special keywords that should be formatted nicely
      const funcName = expr.func.tag === "Atom" ? expr.func.token.value : null;
      const shouldFormatAsBlock =
        funcName &&
        [
          ...BuiltinKeywords.begin,
          ...BuiltinKeywords.cond,
          ...BuiltinKeywords.match,
          ...BuiltinKeywords.fn,
          ...BuiltinKeywords.if,
          ...BuiltinKeywords.while,
        ].includes(funcName);

      // Regular function call
      let func = exprToPrettyString(expr.func, config);
      func =
        exprIsInfixOperatorFunctionCall(expr.func) ||
        exprIsAtomAndOperator(expr.func)
          ? `(${func})`
          : func;

      if (expr.args.length === 0) {
        return `${func}()`;
      }

      // Try single line first for non-block constructs
      if (!shouldFormatAsBlock) {
        const args = expr.args.map((arg) => exprToPrettyString(arg, config));
        const singleLine = `${func}(${args.join(", ")})`;

        if (singleLine.length <= config.maxLineLength) {
          return singleLine;
        }
      }

      // Multi-line formatting
      if (shouldFormatAsBlock) {
        // Special formatting for block-like constructs
        if (funcName === BuiltinKeywords.begin[0]) {
          if (expr.args.length === 1) {
            const singleArg = exprToPrettyString(expr.args[0]!, config);
            if (
              singleArg.length <= config.maxLineLength &&
              !singleArg.includes("\n")
            ) {
              return `${func}(${singleArg})`;
            }
          }

          const formattedArgs = expr.args.map((arg) =>
            exprToPrettyString(arg, nextConfig)
          );
          return `${func}(\n${nextIndent}${formattedArgs.join(`,\n${nextIndent}`)}\n${indent})`;
        } else if (funcName === BuiltinKeywords.cond[0]) {
          // Format cond expressions nicely
          const formattedArgs = expr.args.map((arg) => {
            if (
              exprIsFunctionCall(arg) &&
              arg.isInfix &&
              exprIsFunctionCallOf(arg, "=>")
            ) {
              const condition = arg.args[0]!;
              const body = exprToPrettyString(arg.args[1]!, nextConfig);

              // Format condition - wrap infix operators in parentheses for clarity
              let conditionStr = exprToPrettyString(condition, config);
              if (
                exprIsFunctionCall(condition) &&
                condition.isInfix &&
                !exprIsFunctionCallOf(condition, "=>")
              ) {
                conditionStr = `(${conditionStr})`;
              }

              // If body is multi-line or long, format it properly
              if (body.includes("\n")) {
                // Body is already multi-line, indent it properly
                const bodyLines = body.split("\n");
                const indentedBody = bodyLines
                  .map((line, index) =>
                    index === 0 ? line : `${nextIndent}${line}`
                  )
                  .join("\n");
                return `${conditionStr} => ${indentedBody}`;
              } else {
                // Single line body
                return `${conditionStr} => ${body}`;
              }
            }
            return exprToPrettyString(arg, nextConfig);
          });
          return `${func}(\n${nextIndent}${formattedArgs.join(`,\n${nextIndent}`)}\n${indent})`;
        }
      }

      // Default multi-line function call
      const formattedArgs = expr.args.map((arg) =>
        exprToPrettyString(arg, nextConfig)
      );
      return `${func}(\n${nextIndent}${formattedArgs.join(`,\n${nextIndent}`)}\n${indent})`;
    }
  }

  // This should never be reached, but TypeScript requires a return
  return exprToCompactString(expr);
}

export function attachTempVariableToExpr(
  expr: Expr,
  isOwningTheGcValue: boolean,
  isOwningTheSameGcValueAs?: Variable
): void {
  if (!expr.$) {
    throw new Error(`Expected expression to be evaluated, but it is not:
${exprToString(expr)}`);
  }
  const { env, type, value, originType } = expr.$;
  const modulePath = env.modulePath;

  // NOTE: For now let's make all the isOwningTheGcValue variable runtime-only
  // so the `object` value can only be used in runtime.
  // Actually, all C pointer related should be runtime-only.
  const _isOwningTheARCValue = isOwningTheGcValue && typeContainsGcType(type);

  // Check if a temp variable already exists
  if (expr.$.variableName) {
    // Update the existing variable instead of creating a new one
    const existingVariables = getVariablesFromEnv(env, expr.$.variableName);
    if (existingVariables.length > 0) {
      const existingVariable = existingVariables[existingVariables.length - 1]!;
      // IMPORTANT: Preserve the existing variable's ownership if it's borrowed.
      // A borrowed parameter should NOT be upgraded to owning just because we're
      // attaching a temp variable to it. This is crucial for correct reference
      // counting - returning a borrowed parameter should generate a dup call.
      const preservedIsOwningTheRefValue =
        existingVariable.isOwningTheGcValue === false
          ? false
          : _isOwningTheARCValue;
      const updatedVariable: Variable = {
        ...existingVariable,
        type,
        value: preservedIsOwningTheRefValue ? undefined : value,
        isCompileTimeOnly: preservedIsOwningTheRefValue
          ? false
          : Boolean(value),
        isOwningTheGcValue: preservedIsOwningTheRefValue,
        isOwningTheSameGcValueAs,
      };
      expr.$.env = updateExistingVariable(
        env,
        existingVariable,
        updatedVariable
      );
      // Preserve the originType
      if (!originType) {
        expr.$.originType = type;
      }
      return;
    }
    // Variable name exists but not in current env - this can happen during overload
    // resolution when multiple env copies are created. Reuse the existing name
    // and add it to the current env instead of creating a new name.
    // This ensures consistency between the variable name stored in the expression
    // and the one added to the begin block frame for dropping.
    const { env: nextEnv } = addVariableToEnv({
      env,
      variable: {
        name: expr.$.variableName,
        type,
        value: _isOwningTheARCValue ? undefined : value,
        isCompileTimeOnly: _isOwningTheARCValue ? false : Boolean(value),
        initializedAtToken: expr.token,
        isOwningTheGcValue: _isOwningTheARCValue,
        isOwningTheSameGcValueAs,
        consumedAtToken: undefined,
        token: expr.token,
      },
      addToBeginBlockFrame: true,
    });
    // Preserve the originType
    if (!originType) {
      expr.$.originType = type;
    }
    expr.$.env = nextEnv;
    return;
  }

  // Create a new temp variable
  const tempVariableName = generateNewTempVariableName(modulePath);

  // Add temp variable to the environment at the nearest begin block frame.
  // This ensures temp variables are tracked at the begin block level and get
  // dropped when the begin block ends, not when a nested function call frame is popped.
  const { env: nextEnv } = addVariableToEnv({
    env,
    variable: {
      name: tempVariableName,
      type,
      value: _isOwningTheARCValue ? undefined : value,
      isCompileTimeOnly: _isOwningTheARCValue ? false : Boolean(value),
      initializedAtToken: expr.token,
      isOwningTheGcValue: _isOwningTheARCValue,
      isOwningTheSameGcValueAs,
      consumedAtToken: undefined,
      token: expr.token,
    },
    addToBeginBlockFrame: true,
  });

  expr.$.variableName = tempVariableName;
  // Preserve the originType - for function calls, the originType should be the return type
  // For other expressions, it should be inherited from the source
  if (!originType) {
    expr.$.originType = type; // If no originType was set, use the expression's own type
  }
  expr.$.env = nextEnv;
}

/**
 * Update `env` based on multiple envs in different cases.
 * @param env the base env, before entering cond/match cases.
 * @param bodies the bodies of the cases, not including the condition/case.
 * @param contexts the evaluation contexts for each body (optional).
 */
export function mergeAndCheckEnvs(
  env: Environment,
  bodies: Expr[]
): Environment {
  // console.log("env:");
  // printEnvVarNames(env);

  const maxFrameLevel = env.frames.length - 1;
  const caseEnvs: Environment[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    if (!body.$) {
      throw formatErrorMessages([
        {
          token: body.token,
          errorMessage: `Expected the body of the case to be evaluated, but it is not.`,
        },
      ]);
    }

    const caseEnv = body.$.env;
    // console.log("case env: ", i);
    // printEnvVarNames(caseEnv);
    caseEnvs.push(caseEnv);
  }

  // Check if the frame level is the same for all cases
  for (let i = 0; i < caseEnvs.length; i++) {
    const caseEnv = caseEnvs[i]!;
    // NOTE: I restored this
    // ~~right now each cond/match case will push new env frame
    // so it needs to - 2, instead of - 1.~~
    if (caseEnv.frames.length - 1 !== maxFrameLevel) {
      throw formatErrorMessages([
        {
          token: bodies[i]!.token,
          errorMessage: `Frame level is different for different cases.`,
        },
      ]);
    }
  }

  // Check each frame
  for (let i = 0; i <= maxFrameLevel; i++) {
    const frameLevel = i; // Store frame level for use in nested loops
    const frame = env.frames[i]!;
    const frameVariables = [...frame.variables];

    // Build the consumedAtToken matrix
    // that has 1 + caseEnvs.length rows
    // and frameVariables.length columns
    // each cell is consumedAtToken of the value
    const matrix: {
      consumedAtToken: Token | undefined;
      initializedAtToken: Token | undefined;
      type: Type;
      isOwningTheGcValue: boolean;
    }[][] = [[]];
    frameVariables.forEach((variable) => {
      matrix[0]!.push({
        consumedAtToken: variable.consumedAtToken,
        initializedAtToken: variable.initializedAtToken,
        type: variable.type,
        isOwningTheGcValue: variable.isOwningTheGcValue ?? false,
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
        throw formatErrorMessages([
          {
            token: bodies[j]!.token,
            errorMessage: `Frame level ${i} has different number of values for different cases.`,
          },
        ]);
      }

      // Check if the variable names are the same
      for (let k = 0; k < frameVariables.length; k++) {
        const frameVariable = frameVariables[k]!;
        const caseEnvFrameValue = caseEnvFrameVariables[k]!;
        if (frameVariable.name !== caseEnvFrameValue.name) {
          throw formatErrorMessages([
            {
              token: bodies[j]!.token,
              errorMessage: `Frame level ${i} has different variable names for different cases.`,
            },
          ]);
        }
      }

      // TODO: Check type, but I think it's unnecessary here.

      // Check the consumedAtToken
      matrix.push([]);
      caseEnvFrameVariables.forEach((variable) => {
        matrix[matrix.length - 1]!.push({
          consumedAtToken: variable.consumedAtToken,
          initializedAtToken: variable.initializedAtToken,
          type: variable.type,
          isOwningTheGcValue: variable.isOwningTheGcValue ?? false,
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
      const initializedAtTokens: (Token | undefined)[] = [];
      const isOwningTheRefValueAtTokens: (Token | undefined)[] = [];
      const types: Type[] = [];
      for (let j = 1; j < rows; j++) {
        const caseEnv = caseEnvs[j - 1]!;
        const caseEnvFrameVariables = caseEnv.frames[frameLevel]!.variables;
        initializedAtTokens.push(matrix[j]![i]!.initializedAtToken);
        isOwningTheRefValueAtTokens.push(
          matrix[j]![i]!.isOwningTheGcValue
            ? caseEnvFrameVariables[i]!.token
            : undefined
        );
        types.push(matrix[j]![i]!.type);
      }

      // Check type compatibility across cases for initialized variables
      // This is for checking the code like:
      //
      //   arr : Array(i32, _);
      //   compt_expect_error(
      //     cond(
      //       some_condition() => {arr = [1, 2, 3]; },
      //       true => { arr = [1, 2, 3, 4]; }
      //     )
      //   );
      const initializedCases = initializedAtTokens
        .map((token, index) => ({ token, index }))
        .filter(({ token }) => !!token);

      if (initializedCases.length > 1) {
        // Check if all initialized cases have compatible types
        const firstType = types[initializedCases[0]!.index]!;
        const firstCaseEnv = caseEnvs[initializedCases[0]!.index]!;

        for (let k = 1; k < initializedCases.length; k++) {
          const currentType = types[initializedCases[k]!.index]!;
          const currentCaseEnv = caseEnvs[initializedCases[k]!.index]!;

          // For SomeType (Impl(...)), check that resolvedConcreteType is compatible across branches.
          // This check must happen BEFORE the `firstType === currentType` optimization,
          // because the same SomeType variable may have different resolvedConcreteType in different branches.
          // Impl uses static dispatch, so the concrete capture type must be the same in all branches.
          // If different capture types are needed, the user should use Dyn(...) instead.
          if (isSomeType(firstType) && isSomeType(currentType)) {
            const firstConcreteType = firstType.resolvedConcreteType;
            const currentConcreteType = currentType.resolvedConcreteType;

            // If both have resolved concrete types, they must be compatible
            if (firstConcreteType && currentConcreteType) {
              if (
                !areTypesCompatible(
                  { type: firstConcreteType, env: firstCaseEnv },
                  { type: currentConcreteType, env: currentCaseEnv }
                )
              ) {
                throw formatErrorMessages([
                  {
                    token: bodies[initializedCases[0]!.index]!.token,
                    errorMessage: `Variable "${variableName}" has type Impl(...) but different concrete types across branches.
Impl(...) uses static dispatch and requires the same concrete type in all branches.
Consider using Dyn(...) for dynamic dispatch if different concrete types are needed.`,
                  },
                  {
                    token: initializedAtTokens[initializedCases[0]!.index]!,
                    errorMessage: `First branch has concrete type: ${typeToString(firstConcreteType)}`,
                  },
                  {
                    token: initializedAtTokens[initializedCases[k]!.index]!,
                    errorMessage: `Conflicting branch has concrete type: ${typeToString(currentConcreteType)}`,
                  },
                ]);
              }
            }
          }

          if (firstType === currentType) {
            continue;
          }

          if (
            !areTypesCompatible(
              { type: firstType, env: firstCaseEnv },
              { type: currentType, env: currentCaseEnv }
            )
          ) {
            throw formatErrorMessages([
              {
                token: bodies[initializedCases[0]!.index]!.token,
                errorMessage: `Variable "${variableName}" has incompatible types across different cases:`,
              },
              {
                token: initializedAtTokens[initializedCases[0]!.index]!,
                errorMessage: `First initialization: ${typeToString(firstType)}`,
              },
              {
                token: initializedAtTokens[initializedCases[k]!.index]!,
                errorMessage: `Conflicting initialization: ${typeToString(currentType)}`,
              },
            ]);
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
          throw formatErrorMessages([
            {
              token: frameVariables[i]!.token,
              errorMessage: `Variable "${frameVariables[i]!.name}" might not be initialized in all cases.`,
            },
            {
              token: initializedAtTokens[0]!,
              errorMessage: `Might be initialized here:`,
            },
          ]);
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
          throw formatErrorMessages(
            initializedAtTokens.map((token, index) => {
              return {
                errorMessage:
                  (index === 0
                    ? `Variable "${variableName}" might be initialized in some cases but not initialized in other cases:\n`
                    : "") +
                  (token
                    ? "Might be initialized here:"
                    : "Not initialized here:"),
                token: token ?? bodies[index]!.token,
              };
            })
          );
        }
      }

      // Check isOwningTheRefValueAtTokens
      // Variable is not owning the Ref value outside, but the only case makes it owning.
      // case 1
      /*
      if (isOwningTheRefValueAtTokens.length === 1) {
        if (
          !frameVariables[i]!.isOwningTheGcValue &&
          isOwningTheRefValueAtTokens[0]
        ) {
          throw formatErrorMessages([
            {
              token: frameVariables[i]!.token,
              errorMessage: `Variable "${frameVariables[i]!.name}" might not be owning the Ref value in all cases.`,
            },
            {
              token: isOwningTheRefValueAtTokens[0]!,
              errorMessage: `Might be owning the Ref value here:`,
            },
          ]);
        }
      }
      // case 2
      // variable is not owning the Ref value outside, but all cases make it owning.
      else 
      */
      if (
        !frameVariables[i]!.isOwningTheGcValue &&
        isOwningTheRefValueAtTokens.every((u) => u)
      ) {
        const newVariable: Variable = {
          ...frameVariables[i]!,
          isOwningTheGcValue: true,
          isOwningTheSameGcValueAs: undefined,
        };
        env = updateExistingVariable(env, frameVariables[i]!, newVariable);
        frameVariables[i] = newVariable;
      }
      // case 3
      else {
        const isOwningTheGcValue = isOwningTheRefValueAtTokens.filter(
          (u) => !!u
        );
        const isNotOwningTheRefValue = isOwningTheRefValueAtTokens.filter(
          (u) => !u
        );
        if (
          isOwningTheGcValue.length > 0 &&
          isNotOwningTheRefValue.length > 0
        ) {
          throw formatErrorMessages(
            isOwningTheRefValueAtTokens.map((token, index) => {
              return {
                errorMessage:
                  (index === 0
                    ? `Variable "${variableName}" might be holding the Ref value in some cases but not holding the Ref value in other cases:\n`
                    : "") +
                  (token
                    ? "Might be owning the Ref value here:"
                    : "Might be not owning the Ref value here:"),
                token: token ?? bodies[index]!.token,
              };
            })
          );
        }
      }

      // Check for reassignment across branches
      // When a variable is reassigned in any branch, its ID changes (see assignment.ts)
      // We need to detect this and generate a new ID for the merged environment
      const originalVariableId = frameVariables[i]!.id;
      const variableIds: string[] = [];

      for (let j = 1; j < rows; j++) {
        const caseEnv = caseEnvs[j - 1]!;
        const caseEnvFrameVariables = caseEnv.frames[frameLevel]!.variables;
        const caseVariable = caseEnvFrameVariables[i]!;
        variableIds.push(caseVariable.id);
      }

      // Check if any branch has a different variable ID (indicating reassignment)
      const hasReassignmentInSomeBranch = variableIds.some(
        (id) => id !== originalVariableId
      );

      if (hasReassignmentInSomeBranch) {
        // Generate a new ID for the merged environment to distinguish from pre-cond/match state
        // This ensures dup/drop optimization won't incorrectly match calls across the boundary
        const newVariableId = generateVarialeId(env.modulePath, variableName);

        const newVariable: Variable = {
          ...frameVariables[i]!,
          id: newVariableId,
          // Clear ownership tracking since the value may come from different sources
          isOwningTheSameGcValueAs: undefined,
        };
        env = updateExistingVariable(env, frameVariables[i]!, newVariable);
        frameVariables[i] = newVariable;
      }
    }
  }

  return env;
}

/**
 * NOTE: This function is used to replace the function call expression
 * It is intrusive and modifies the original expression.
 * @param funcExpr
 * @param newFuncExpr
 */
export function replaceFuncCallExprWithFuncCallExpr(
  funcExpr: FuncCallExpr,
  newFuncExpr: FuncCallExpr
): void {
  funcExpr.$ = newFuncExpr.$;
  funcExpr.args = newFuncExpr.args;
  funcExpr.func = newFuncExpr.func;
  funcExpr.isInfix = newFuncExpr.isInfix;
  funcExpr.tag = newFuncExpr.tag;
  funcExpr.token = newFuncExpr.token;
}

export function replaceFuncCallExprWithAtomExpr(
  funcExpr: FuncCallExpr,
  newAtomExpr: AtomExpr
): void {
  // Convert function call to atom by changing its properties
  const atomExpr = funcExpr as unknown as AtomExpr;
  atomExpr.tag = newAtomExpr.tag;
  atomExpr.token = newAtomExpr.token;
  atomExpr.$ = newAtomExpr.$;

  // Clean up function call specific properties by setting them to undefined
  (funcExpr as Partial<FuncCallExpr>).func = undefined;
  (funcExpr as Partial<FuncCallExpr>).args = undefined;
  (funcExpr as Partial<FuncCallExpr>).isInfix = undefined;
}

export function replaceExprWithFuncCallExpr(
  expr: Expr,
  newFuncExpr: FuncCallExpr
): void {
  if (exprIsFunctionCall(expr)) {
    replaceFuncCallExprWithFuncCallExpr(expr, newFuncExpr);
  } else {
    // expr is atom;
    (expr as Expr).tag = newFuncExpr.tag;
    const funcExpr = expr as unknown as FuncCallExpr;
    replaceFuncCallExprWithFuncCallExpr(funcExpr, newFuncExpr);
  }
}

export function replaceExprWithAtomExpr(
  expr: Expr,
  newAtomExpr: AtomExpr
): void {
  if (exprIsAtom(expr)) {
    // Replace atom with atom - just copy all properties
    expr.tag = newAtomExpr.tag;
    expr.token = newAtomExpr.token;
    expr.$ = newAtomExpr.$;
  } else {
    // Replace function call with atom - use the dedicated function
    replaceFuncCallExprWithAtomExpr(expr, newAtomExpr);
  }
}

export function setExprAsConsumed(
  expr: Expr,
  env: Environment,
  allowConsumeAgain: boolean = false
): Environment {
  // Check if it's dereferencing a pointer/reference to linear type value.
  // if (expr.$?.isAccessingProperty && isType0(typeOfType(expr.$.type))) {
  //   throw formatErrorMessages([
  //     {
  //       token: expr.token,
  //       errorMessage: `Cannot consume a property which is "Linear" value.`,
  //     },
  //   ]);
  // }

  // Don't consume type values - they should be reusable
  if (expr.$?.value && isTypeValue(expr.$?.value)) {
    return env;
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
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
      },
    ]);
  }

  const variableToConsume = variables[variables.length - 1]!;
  // Check if the variable is already consumed
  if (variableToConsume.consumedAtToken && !allowConsumeAgain) {
    const errorMessage = `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again (1).`;
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage: errorMessage,
      },
      {
        token: variableToConsume.consumedAtToken,
        errorMessage: `Previously consumed here:`,
      },
    ]);
  } else {
    // Set the variable as consumed
    env = updateExistingVariable(env, variableToConsume, {
      ...variableToConsume,
      consumedAtToken: expr.token,
    });
  }

  return env;
}

/**
 * @param expr
 * @param context
 * @returns
 */
export function setExprAsNeedsToCallDup(
  expr: Expr,
  context: EvaluatorContext
): void {
  if (!expr.$) {
    return;
  }

  if (!expr.$.variableName) {
    // If expr has no variableName, then we just ignore it for now.
    // For example, calling __yo_rc_own(...) function has no variableName.
    return;
  }

  if (typeContainsGcType(expr.$.type)) {
    const variableName = expr.$.variableName;

    // Check if the expr.variableName is holding the Ref value
    // if yes, then no need to call dup
    // We just need to set it as consumed
    if (isTempVariableName(expr.$.env.modulePath, variableName)) {
      if (exprIsAtom(expr) && expr.token.value !== variableName) {
        // Do nothing
        // We need to call ___dup on it
      } else {
        const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          if (variable.isOwningTheGcValue) {
            // Set the variable as consumed so we won't need to drop it later
            if (!variable.consumedAtToken) {
              expr.$.env = updateExistingVariable(expr.$.env, variable, {
                ...variable,
                consumedAtToken: expr.token,
              });
            }

            return;
          }
        }
      }
    }

    // Copy semantics: call dup to share ownership
    // replace this expr with ___dup(...)
    const dupCallExpr = generateExprFromCode(
      `${BuiltinFunctions.___dup[0]!}(${variableName})`
    );

    // console.trace(exprToString(dupCallExpr), expr.$.env.frames.length);
    // printEnvFrame(expr.$.env.frames[expr.$.env.frames.length - 1]!);
    const evaluatedDupCallExpr = evaluateExpression({
      expr: dupCallExpr,
      env: expr.$.env,
      // Don't pass expectedType when calling ___dup, as it refers to the outer expression's expected type,
      // not the expected type for the dup call itself. The dup call always returns the same type as its argument.
      context: { ...context, expectedType: undefined },
    }) as FuncCallExpr;

    if (evaluatedDupCallExpr.$?.variableName) {
      // Set the variable as consumed so we won't need to drop it later
      const variables = getVariablesFromEnv(
        evaluatedDupCallExpr.$.env,
        evaluatedDupCallExpr.$.variableName
      );
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (!variable.consumedAtToken) {
          evaluatedDupCallExpr.$.env = updateExistingVariable(
            evaluatedDupCallExpr.$.env,
            variable,
            {
              ...variable,
              consumedAtToken: evaluatedDupCallExpr.token,
            }
          );
        }
      }
    }

    expr.$.deferredDupExpressions = [evaluatedDupCallExpr];
    expr.$.env = evaluatedDupCallExpr.$!.env;
    // replaceExprWithFuncCallExpr(expr, evaluatedDupCallExpr);
  }
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
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage: `Variable "${nameOfVariableToConsume}" is not defined.`,
      },
    ]);
  }

  const variableToConsume = variables[variables.length - 1]!;
  // NOTE: We also allow Free value to be consumed now.
  // if (isLinearOrType0Type(typeOfType(variableToConsume.type))) {
  // Check if the variable is already consumed
  if (
    // isLinearOrType0Type(typeOfType(variableToConsume.type)) &&
    variableToConsume.consumedAtToken
  ) {
    const errorMessage = `Variable "${nameOfVariableToConsume}" is already consumed and cannot be used again (2).`;
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage,
      },
      {
        token: variableToConsume.consumedAtToken,
        errorMessage: `Previously consumed here:`,
      },
    ]);
  }
  // }
}
