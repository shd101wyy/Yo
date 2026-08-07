/* eslint-disable no-constant-condition */
import {
  addVariableToEnv,
  type Environment,
  type Frame,
  getVariablesFromEnv,
  updateExistingVariable,
  type Variable,
} from "./env";
import { formatErrorMessage, formatErrorMessages } from "./error";
import type { AwaitAnalysisResult } from "./evaluator/async/await-analysis-types";
import type { EvaluatorContext } from "./evaluator/context";
import type { EffectAnalysisResult } from "./evaluator/effects/effect-analysis-types";
import { evaluateExpression } from "./evaluator/exprs/expr";
import { generateExprFromCode } from "./parser";
import { type Token, TokenType } from "./token";
import { areTypesCompatible } from "./types/compatibility";
import type { FunctionType, StructType, Type } from "./types/definitions";
import { isSomeType } from "./types/guards";
import { typeContainsRcType, typeToString } from "./types/utils";
import {
  generateNewTempVariableName,
  generateVarialeId,
  isTempVariableName,
} from "./utils";
import {
  type ArrayValue,
  type ComptimeListValue,
  isTypeValue,
  type StructValue,
  type TraitValue,
  type TupleValue,
  type Value,
} from "./value";
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

/**
 * Unified compile-time element/field reference for mutation and pointer creation.
 * Used by assignment.ts for compile-time mutation (`arr(0) = value`) and by
 * ptr-fns.ts for compile-time pointer creation (`&(arr(0))`).
 */
export type ComptimeRef =
  | { kind: "array"; arrayValue: ArrayValue; index: number }
  | { kind: "comptime_list"; listValue: ComptimeListValue; index: number }
  | { kind: "struct"; structValue: StructValue; fieldIndex: number }
  | { kind: "tuple"; tupleValue: TupleValue; fieldIndex: number };

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

// eslint-disable-next-line no-shadow
export enum ExprTag {
  Atom = "Atom",
  FnCall = "FnCall",
}

export interface RuntimeDestructuring {
  label: string;
  type: Type;
  variableName: string;
}

/**
 * 'return' is used for both normal function return and ctl handler resume.
 * 'unwind' is used for ctl handler discontinue (early return from enclosing function).
 */
export type ControlFlowFlags = {
  return?: boolean;
  unwind?: boolean;
  break?: boolean;
  continue?: boolean;
};

/** Create a ControlFlowFlags with a single flag set */
export function controlFlowOf(
  kind: "return" | "unwind" | "break" | "continue"
): ControlFlowFlags {
  return { [kind]: true };
}

/** Check if controlFlow has a specific flag */
export function hasControlFlow(
  cf: ControlFlowFlags | undefined,
  kind: "return" | "unwind" | "break" | "continue"
): boolean {
  return cf?.[kind] === true;
}

/** Check if controlFlow has any flag set */
export function hasAnyControlFlow(cf: ControlFlowFlags | undefined): boolean {
  return (
    cf !== undefined &&
    (cf.return === true ||
      cf.unwind === true ||
      cf.break === true ||
      cf.continue === true)
  );
}

/** Merge multiple ControlFlowFlags into one (union of all flags) */
export function mergeControlFlows(flows: ControlFlowFlags[]): ControlFlowFlags {
  const result: ControlFlowFlags = {};
  for (const cf of flows) {
    if (cf.return) result.return = true;
    if (cf.unwind) result.unwind = true;
    if (cf.break) result.break = true;
    if (cf.continue) result.continue = true;
  }
  return result;
}

/** Convert ControlFlowFlags to a display string for error messages */
export function controlFlowToString(cf: ControlFlowFlags): string {
  const parts: string[] = [];
  if (cf.return) parts.push("return");
  if (cf.unwind) parts.push("unwind");
  if (cf.break) parts.push("break");
  if (cf.continue) parts.push("continue");
  return parts.join("+");
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
   * When a compile-time type needs to be converted to a different runtime type,
   * this field stores the target runtime type.
   * For example: string literal "hello" with type `comptime_str` converted to `str`
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
   * This is mainly for FnCall expressions.
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
   * Whether this expression carries control flow.
   * Multiple flags can be true simultaneously (e.g., a cond where some branches
   * return and others unwind).
   */
  controlFlow?: ControlFlowFlags;

  /**
   * For dyn() function calls, this contains the trait values that provide
   * the dynamic dispatch implementations. Used by C codegen to generate
   * vtables and method dispatch code.
   */
  dynCallTraitValues?: TraitValue[];

  /**
   * This is for codegen for the "cond"/"match" expressions.
   * If this is true, then it means the case has been executed, and we will perform code generation for it.
   * Otherwise, we won't perform code generation for it.
   */
  caseExecuted?: boolean;

  /**
   * For primitive type matching in match expressions.
   * If true, indicates this match expression matches on primitive types (integer, bool)
   * rather than enum types.
   */
  isPrimitiveMatch?: boolean;

  /**
   * For primitive pattern matching, stores the compile-time values of the patterns.
   * Used by codegen to generate C switch cases.
   * Example: For pattern `(1 | 2 | 3) => ...`, this would be [1, 2, 3]
   */
  primitivePatternValues?: (Value | undefined)[];

  /**
   * Doc comment for the expression.
   * Set during evaluation when the expression (e.g., a declaration) is preceded
   * by triple-slash or block doc comment tokens.
   */
  docComment?: string;

  /**
   * For closures that capture Rc variables, this contains expressions that
   * call ___dup on the captured variables. Used by C codegen to generate
   * proper Rc handling in closure ___dup methods.
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
   * Drop expressions for variables that are consumed later in the same scope.
   * They are only needed on early return/unwind paths before the consume point;
   * normal scope exit must not emit them because ownership has moved.
   */
  earlyReturnOnlyDeferredDropExpressions?: Expr[];

  /**
   * Drop expressions for RC-typed variables that are consumed by the return value
   * (ownership transfer). These drops are NOT needed at normal scope exit (the
   * value is moved), but ARE needed when unwind propagates through the function
   * (the return value is discarded, so the variable must be freed).
   */
  consumedVariableDropExpressions?: Expr[];

  /**
   * For async expressions, this contains the optional stack size configuration (runtime-known).
   * If undefined, the default stack size (16KB) is used.
   *
   * Example: For `async say("hello"), { stack_size: 1024 * 64 }`, this contains the evaluated expression `1024 * 64`
   */
  asyncStackSize?: Expr;

  /**
   * For async block expressions, this contains the C struct name for the state machine.
   * Used during C codegen to generate the correct type for functions returning Impl(Future(T)).
   *
   * Example: For an async block `async { return 42; }`, this would contain `_yof4ca7ba3_temp_7455_state_t`
   */
  asyncStateMachineStructName?: string;

  /**
   * For closure and async block expressions, this contains the capture struct type that holds all
   * captured variables from outer scope.
   * The capture struct has Rc functions (___drop, ___dup, ___dispose) auto-generated.
   *
   * Example: For `async { printf("%d", x); }` where `x: MyBox` is from outer scope,
   * this would contain a StructType with a single field `x: MyBox`.
   *
   * For closures without captures, this is undefined.
   */
  captureType?: StructType;

  /**
   * For async block expressions, this contains the await analysis result computed during
   * evaluation. This includes all await points and captured variables needed by the state machine.
   *
   * This is computed once in the evaluator and reused by the codegen stage to avoid redundant
   * tree walking and ensure consistency.
   *
   * Example: For `async { x := await(task1); y := await(task2); }`, this would contain
   * information about both await points and the variables x and y.
   */
  awaitAnalysis?: AwaitAnalysisResult;

  /**
   * For effectful function call expressions, this contains the effect analysis result.
   * It includes all ctl call points and captured variables needed by the effect state machine.
   *
   * This is computed during evaluation when a function with `using(ctl)` parameters
   * is specialized and its body contains calls to the ctl parameter.
   */
  effectAnalysis?: EffectAnalysisResult;

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

  /**
   * This is the orignal expr before evaluation. It shouldn't contain any $ data.
   * This is only used for `test` function for generating test function code in `main` function.
   */
  originalExpr?: Expr;

  /**
   * For expressions that reference a variable (identifiers), this stores the
   * Variable object itself. This is used for compile-time pointer creation
   * where we need access to the variable's value array wrapper.
   *
   * Example: For `x` in `&(x)`, this would contain the Variable object for `x`.
   */
  sourceVariable?: Variable;

  /**
   * Unified compile-time element/field reference for mutation and pointer creation.
   * Enables compile-time operations like `arr(0) = value`, `p(0) = value`, `&(arr(0))`.
   *
   * Discriminated by `kind`:
   * - `"array"`: Array/slice element — mutates `arrayValue.elements[index]`
   * - `"comptime_list"`: ComptimeList element — mutates `listValue.elements[index]`
   * - `"struct"`: Struct field via ComptimeIndex — mutates `structValue.fields[fieldIndex]`
   * - `"tuple"`: Tuple field via ComptimeIndex — mutates `tupleValue.fields[fieldIndex]`
   */
  comptimeRef?: ComptimeRef;

  /**
   * For Index trait dispatch expressions (value(i)), this stores the pointer type
   * returned by the Index.index() method before auto-deref. This allows &(value(i))
   * to skip the auto-deref and return the pointer directly.
   */
  indexTraitPtrType?: Type;

  /**
   * For Index trait dispatch, stores the specialized function type and value
   * of the index method. Used by codegen to emit the call.
   */
  indexMethodType?: FunctionType;
  indexMethodValue?: Value;

  /**
   * When true, this &(value(i)) expression uses the Index trait's returned pointer
   * directly (skipping the extra & wrapping). Used by codegen to emit the index
   * method call without dereferencing.
   */
  isIndexTraitAddressOf?: boolean;

  /**
   * When true, this `&(expr)` expression sits in a return slot — i.e. its
   * result is the value flowing out of the enclosing function (either as
   * the body's tail-expression or via an explicit `return(&(expr))`). When
   * the inner expression is a call returning `ref(T)`, the ref itself
   * is already the `T*` value the caller expects, so codegen forwards it
   * directly rather than spilling to a stack-local temp and taking its
   * address (which would be a UAF on return).
   *
   * Marked by the evaluator at the binding/return boundary; checked in
   * `src/codegen/exprs/ptr-fns.ts:generateAddressOf`.
   */
  isReturnSlot?: boolean;

  /**
   * For assignments that are purely compile-time (both LHS and RHS are compile-time known),
   * this flag indicates that no C code should be generated for this assignment.
   *
   * Example: For `p.* = i32(20)` where p is a compile-time pointer, this would be true.
   */
  isCompileTimeOnlyAssignment?: boolean;

  /**
   * True when this expression is a `->` or `=>` that defines an anonymous function or closure.
   * Used by expression traversal utilities to distinguish function-defining arrows
   * (which are new function boundaries and should not be recursed into) from
   * cond/match branch arrows (which are not function boundaries).
   */
  isAnonymousFunctionDefinition?: boolean;

  /**
   * For while loops with comptime-known terminating conditions and runtime bodies,
   * this contains the unrolled body expressions (one per iteration).
   * Used by codegen to emit the bodies sequentially instead of generating a C loop.
   *
   * Example: `i :: 0; while (i < 3), { printf("%d\n", i32(i)); i = (i + 1); };`
   * produces 3 unrolled body expressions, each with `i` bound to 0, 1, 2 respectively.
   */
  comptimeUnrolledBodies?: Expr[];
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

export type FnCallExpr = {
  // Parser stage
  tag: ExprTag.FnCall;
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
    case ExprTag.FnCall:
      return {
        ...expr,
        func: cloneExpr(expr.func),
        args: expr.args.map(cloneExpr),
        $: undefined, //  expr.$ ? { ...expr.$ } : undefined,
        // NOTE: We should unset the evaluated data here,
      };
  }
}

export type Expr = AtomExpr | FnCallExpr;

export function exprIsFunctionCall(expr: Expr | undefined): expr is FnCallExpr {
  return expr?.tag === ExprTag.FnCall;
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
  if (expr.tag !== ExprTag.FnCall) {
    return false;
  }
  if (expr.func.tag !== ExprTag.Atom) {
    return false;
  }
  const funcName = expr.func.token.value;

  return (
    expr.tag === ExprTag.FnCall &&
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

  if (expr1.tag === ExprTag.FnCall && expr2.tag === ExprTag.FnCall) {
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
  comptime: ["comptime" /*"@"*/],
  runtime: ["runtime"], // Force runtime evaluation, prevents CTFE
  ref: ["ref"], // Reference-semantics TYPE constructor: `ref(struct(…))` / `ref(enum(…))` (see plans/REF_REFERENCE_SEMANTICS.md). The old second-class-reference PARAMETER modifier moved to `inout` (below).
  inout: ["inout"], // Second-class reference PARAMETER modifier: `inout(name) : T`. In-out parameter (caller's storage, mutate in place). Cannot be returned; no local-binding form. (Renamed from `ref` — see plans/REF_REFERENCE_SEMANTICS.md.)

  // Type-parameter binder. Renamed from `generic` (plans/archive/FORALL_TO_GENERIC.md):
  // `generic`/`exists` (and `∀`/`∃`) are reserved for Dafny-style verification
  // quantifiers in `requires`/`ensures`, where they bind VALUES and take a
  // predicate — a different concept with a different shape. One keyword, one
  // concept. `∀` follows the quantifier and returns with verification.
  generic: ["generic"],
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
  ctl: ["ctl"], // Control function type — parallel to `fn`, may contain `unwind`
  unwind: ["unwind"],
  extern: ["extern"],
  cond: ["cond"],
  type: ["type"],
  match: ["match"],
  test: ["test"], // Test declaration for test runner
  atomic: ["atomic"],
  struct: ["struct"],
  newtype: ["newtype"],
  enum: ["enum"],
  union: ["union"],
  trait: ["trait"],
  impl: ["impl"],
  Impl: ["Impl"],
  begin: ["begin"],
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
  Iso: ["Iso"],

  Tuple: ["Tuple"],
  Array: ["Array"],
  Slice: ["Slice"],
  Future: ["Future"],
  Concrete: ["Concrete"],
  Type: ["Type"],
  Trait: ["Trait"],
  ComptimeList: ["ComptimeList"],

  // data values
  tuple: ["tuple"],
  array: ["array"],
  comptime_list: ["comptime_list"], // comptime_list
};

export const BuiltinFunctions = {
  // compile-time related functions
  comptime_expect_error: ["comptime_expect_error"],
  comptime_assert: ["comptime_assert"],
  comptime_print: ["comptime_print"],
  comptime_fn: ["comptime_fn"],

  // va_XX related function for variadic arguments
  // Only `va_start` needs to be handled here.
  va_start: ["va_start"],

  // Array related
  __yo_array_fill: ["__yo_array_fill"],

  typeof: ["typeof"],
  sizeof: ["sizeof"],
  alignof: ["alignof"],
  typeid: ["typeid"],
  downcast: ["downcast"],
  consume: ["consume"],
  unsafe: ["unsafe"],
  pragma: ["pragma"],
  macro_expand: ["macro_expand"],
  as: ["as"],
  the: ["the"],
  do: ["do"],
  rc: "rc", // Get the reference count of a Rc type

  __yo_thread_set_maximum_threads: ["__yo_thread_set_maximum_threads"],

  // Pointer related functions
  // Check std/data/primitives/ptr.yo
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

  // Slice related functions
  __yo_str_from_raw_parts: ["__yo_str_from_raw_parts"],
  __yo_str_len: ["__yo_str_len"],
  __yo_str_ptr: ["__yo_str_ptr"],
  __yo_str_byte: ["__yo_str_byte"],

  // Array indexing builtins (used by Index trait impls)
  __yo_array_index: ["__yo_array_index"],

  // Comptime array indexing builtins (used by ComptimeIndex trait impls)
  __yo_comptime_array_index: ["__yo_comptime_array_index"],

  // Type casting for primitives and pointers (generic form)
  __yo_as: ["__yo_as"], // expr related functions
  // __yo_expr_is_expr: ["__yo_expr_is_expr"],
  __yo_expr_is_atom: ["__yo_expr_is_atom"],
  __yo_expr_is_fn_call: ["__yo_expr_is_fn_call"],
  __yo_expr_get_callee: ["__yo_expr_get_callee"],
  __yo_expr_get_args: ["__yo_expr_get_args"],
  __yo_expr_to_string: ["__yo_expr_to_string"],
  __yo_expr_eq: ["__yo_expr_eq"],

  // expr_list related functions
  // __yo_expr_list_is_expr_list: ["__yo_expr_list_is_expr_list"],
  __yo_comptime_list_car: ["__yo_comptime_list_car"],
  __yo_comptime_list_cdr: ["__yo_comptime_list_cdr"],
  __yo_comptime_list_cons: ["__yo_comptime_list_cons"],
  __yo_comptime_list_append: ["__yo_comptime_list_append"],
  __yo_comptime_list_length: ["__yo_comptime_list_length"],
  __yo_comptime_list_element_type: ["__yo_comptime_list_element_type"],
  __yo_comptime_list_get: ["__yo_comptime_list_get"],
  __yo_comptime_list_index: ["__yo_comptime_list_index"],
  __yo_comptime_list_index_range: ["__yo_comptime_list_index_range"],
  __yo_comptime_list_index_range_inclusive: [
    "__yo_comptime_list_index_range_inclusive",
  ],

  // comptime_int related functions
  /// 2 args
  __yo_comptime_int_add: ["__yo_comptime_int_add"],
  __yo_comptime_int_sub: ["__yo_comptime_int_sub"],
  __yo_comptime_int_mul: ["__yo_comptime_int_mul"],
  __yo_comptime_int_div: ["__yo_comptime_int_div"],
  __yo_comptime_int_mod: ["__yo_comptime_int_mod"],
  __yo_comptime_int_eq: ["__yo_comptime_int_eq"],
  __yo_comptime_int_neq: ["__yo_comptime_int_neq"],
  __yo_comptime_int_lt: ["__yo_comptime_int_lt"],
  __yo_comptime_int_lte: ["__yo_comptime_int_lte"],
  __yo_comptime_int_gt: ["__yo_comptime_int_gt"],
  __yo_comptime_int_gte: ["__yo_comptime_int_gte"],
  __yo_comptime_int_bit_and: ["__yo_comptime_int_bit_and"], // Bitwise AND
  __yo_comptime_int_bit_or: ["__yo_comptime_int_bit_or"], // Bitwise OR
  __yo_comptime_int_bit_xor: ["__yo_comptime_int_bit_xor"], // Bitwise XOR
  __yo_comptime_int_shl: ["__yo_comptime_int_shl"], // Shift left
  __yo_comptime_int_shr: ["__yo_comptime_int_shr"], // Shift right
  // 1 arg
  __yo_comptime_int_neg: ["__yo_comptime_int_neg"],
  __yo_comptime_int_bit_not: ["__yo_comptime_int_bit_not"], // Bitwise NOT
  __yo_comptime_int_to_comptime_string: [
    "__yo_comptime_int_to_comptime_string",
  ],

  // comptime_float related functions
  /// 2 args
  __yo_comptime_float_add: ["__yo_comptime_float_add"],
  __yo_comptime_float_sub: ["__yo_comptime_float_sub"],
  __yo_comptime_float_mul: ["__yo_comptime_float_mul"],
  __yo_comptime_float_div: ["__yo_comptime_float_div"],
  __yo_comptime_float_eq: ["__yo_comptime_float_eq"],
  __yo_comptime_float_neq: ["__yo_comptime_float_neq"],
  __yo_comptime_float_lt: ["__yo_comptime_float_lt"],
  __yo_comptime_float_lte: ["__yo_comptime_float_lte"],
  __yo_comptime_float_gt: ["__yo_comptime_float_gt"],
  __yo_comptime_float_gte: ["__yo_comptime_float_gte"],
  // 1 arg
  __yo_comptime_float_neg: ["__yo_comptime_float_neg"],
  __yo_comptime_float_to_comptime_string: [
    "__yo_comptime_float_to_comptime_string",
  ],

  // Numeric type functions (u8, i8, u16, i16, u32, i32, u64, i64, usize, isize, f32, f64)
  // u8 functions
  __yo_comptime_u8_add: ["__yo_comptime_u8_add"],
  __yo_comptime_u8_sub: ["__yo_comptime_u8_sub"],
  __yo_comptime_u8_mul: ["__yo_comptime_u8_mul"],
  __yo_comptime_u8_div: ["__yo_comptime_u8_div"],
  __yo_comptime_u8_mod: ["__yo_comptime_u8_mod"],
  __yo_comptime_u8_eq: ["__yo_comptime_u8_eq"],
  __yo_comptime_u8_neq: ["__yo_comptime_u8_neq"],
  __yo_comptime_u8_lt: ["__yo_comptime_u8_lt"],
  __yo_comptime_u8_lte: ["__yo_comptime_u8_lte"],
  __yo_comptime_u8_gt: ["__yo_comptime_u8_gt"],
  __yo_comptime_u8_gte: ["__yo_comptime_u8_gte"],
  __yo_comptime_u8_neg: ["__yo_comptime_u8_neg"],
  __yo_comptime_u8_bit_and: ["__yo_comptime_u8_bit_and"],
  __yo_comptime_u8_bit_or: ["__yo_comptime_u8_bit_or"],
  __yo_comptime_u8_bit_xor: ["__yo_comptime_u8_bit_xor"],
  __yo_comptime_u8_bit_not: ["__yo_comptime_u8_bit_not"],
  __yo_comptime_u8_shl: ["__yo_comptime_u8_shl"],
  __yo_comptime_u8_shr: ["__yo_comptime_u8_shr"],
  __yo_comptime_u8_to_comptime_string: ["__yo_comptime_u8_to_comptime_string"],

  // i8 functions
  __yo_comptime_i8_add: ["__yo_comptime_i8_add"],
  __yo_comptime_i8_sub: ["__yo_comptime_i8_sub"],
  __yo_comptime_i8_mul: ["__yo_comptime_i8_mul"],
  __yo_comptime_i8_div: ["__yo_comptime_i8_div"],
  __yo_comptime_i8_mod: ["__yo_comptime_i8_mod"],
  __yo_comptime_i8_eq: ["__yo_comptime_i8_eq"],
  __yo_comptime_i8_neq: ["__yo_comptime_i8_neq"],
  __yo_comptime_i8_lt: ["__yo_comptime_i8_lt"],
  __yo_comptime_i8_lte: ["__yo_comptime_i8_lte"],
  __yo_comptime_i8_gt: ["__yo_comptime_i8_gt"],
  __yo_comptime_i8_gte: ["__yo_comptime_i8_gte"],
  __yo_comptime_i8_neg: ["__yo_comptime_i8_neg"],
  __yo_comptime_i8_bit_and: ["__yo_comptime_i8_bit_and"],
  __yo_comptime_i8_bit_or: ["__yo_comptime_i8_bit_or"],
  __yo_comptime_i8_bit_xor: ["__yo_comptime_i8_bit_xor"],
  __yo_comptime_i8_bit_not: ["__yo_comptime_i8_bit_not"],
  __yo_comptime_i8_shl: ["__yo_comptime_i8_shl"],
  __yo_comptime_i8_shr: ["__yo_comptime_i8_shr"],
  __yo_comptime_i8_to_comptime_string: ["__yo_comptime_i8_to_comptime_string"],

  // u16 functions
  __yo_comptime_u16_add: ["__yo_comptime_u16_add"],
  __yo_comptime_u16_sub: ["__yo_comptime_u16_sub"],
  __yo_comptime_u16_mul: ["__yo_comptime_u16_mul"],
  __yo_comptime_u16_div: ["__yo_comptime_u16_div"],
  __yo_comptime_u16_mod: ["__yo_comptime_u16_mod"],
  __yo_comptime_u16_eq: ["__yo_comptime_u16_eq"],
  __yo_comptime_u16_neq: ["__yo_comptime_u16_neq"],
  __yo_comptime_u16_lt: ["__yo_comptime_u16_lt"],
  __yo_comptime_u16_lte: ["__yo_comptime_u16_lte"],
  __yo_comptime_u16_gt: ["__yo_comptime_u16_gt"],
  __yo_comptime_u16_gte: ["__yo_comptime_u16_gte"],
  __yo_comptime_u16_neg: ["__yo_comptime_u16_neg"],
  __yo_comptime_u16_bit_and: ["__yo_comptime_u16_bit_and"],
  __yo_comptime_u16_bit_or: ["__yo_comptime_u16_bit_or"],
  __yo_comptime_u16_bit_xor: ["__yo_comptime_u16_bit_xor"],
  __yo_comptime_u16_bit_not: ["__yo_comptime_u16_bit_not"],
  __yo_comptime_u16_shl: ["__yo_comptime_u16_shl"],
  __yo_comptime_u16_shr: ["__yo_comptime_u16_shr"],
  __yo_comptime_u16_to_comptime_string: [
    "__yo_comptime_u16_to_comptime_string",
  ],

  // i16 functions
  __yo_comptime_i16_add: ["__yo_comptime_i16_add"],
  __yo_comptime_i16_sub: ["__yo_comptime_i16_sub"],
  __yo_comptime_i16_mul: ["__yo_comptime_i16_mul"],
  __yo_comptime_i16_div: ["__yo_comptime_i16_div"],
  __yo_comptime_i16_mod: ["__yo_comptime_i16_mod"],
  __yo_comptime_i16_eq: ["__yo_comptime_i16_eq"],
  __yo_comptime_i16_neq: ["__yo_comptime_i16_neq"],
  __yo_comptime_i16_lt: ["__yo_comptime_i16_lt"],
  __yo_comptime_i16_lte: ["__yo_comptime_i16_lte"],
  __yo_comptime_i16_gt: ["__yo_comptime_i16_gt"],
  __yo_comptime_i16_gte: ["__yo_comptime_i16_gte"],
  __yo_comptime_i16_neg: ["__yo_comptime_i16_neg"],
  __yo_comptime_i16_bit_and: ["__yo_comptime_i16_bit_and"],
  __yo_comptime_i16_bit_or: ["__yo_comptime_i16_bit_or"],
  __yo_comptime_i16_bit_xor: ["__yo_comptime_i16_bit_xor"],
  __yo_comptime_i16_bit_not: ["__yo_comptime_i16_bit_not"],
  __yo_comptime_i16_shl: ["__yo_comptime_i16_shl"],
  __yo_comptime_i16_shr: ["__yo_comptime_i16_shr"],
  __yo_comptime_i16_to_comptime_string: [
    "__yo_comptime_i16_to_comptime_string",
  ],

  // u32 functions
  __yo_comptime_u32_add: ["__yo_comptime_u32_add"],
  __yo_comptime_u32_sub: ["__yo_comptime_u32_sub"],
  __yo_comptime_u32_mul: ["__yo_comptime_u32_mul"],
  __yo_comptime_u32_div: ["__yo_comptime_u32_div"],
  __yo_comptime_u32_mod: ["__yo_comptime_u32_mod"],
  __yo_comptime_u32_eq: ["__yo_comptime_u32_eq"],
  __yo_comptime_u32_neq: ["__yo_comptime_u32_neq"],
  __yo_comptime_u32_lt: ["__yo_comptime_u32_lt"],
  __yo_comptime_u32_lte: ["__yo_comptime_u32_lte"],
  __yo_comptime_u32_gt: ["__yo_comptime_u32_gt"],
  __yo_comptime_u32_gte: ["__yo_comptime_u32_gte"],
  __yo_comptime_u32_neg: ["__yo_comptime_u32_neg"],
  __yo_comptime_u32_bit_and: ["__yo_comptime_u32_bit_and"],
  __yo_comptime_u32_bit_or: ["__yo_comptime_u32_bit_or"],
  __yo_comptime_u32_bit_xor: ["__yo_comptime_u32_bit_xor"],
  __yo_comptime_u32_bit_not: ["__yo_comptime_u32_bit_not"],
  __yo_comptime_u32_shl: ["__yo_comptime_u32_shl"],
  __yo_comptime_u32_shr: ["__yo_comptime_u32_shr"],
  __yo_comptime_u32_to_comptime_string: [
    "__yo_comptime_u32_to_comptime_string",
  ],

  // i32 functions
  __yo_comptime_i32_add: ["__yo_comptime_i32_add"],
  __yo_comptime_i32_sub: ["__yo_comptime_i32_sub"],
  __yo_comptime_i32_mul: ["__yo_comptime_i32_mul"],
  __yo_comptime_i32_div: ["__yo_comptime_i32_div"],
  __yo_comptime_i32_mod: ["__yo_comptime_i32_mod"],
  __yo_comptime_i32_eq: ["__yo_comptime_i32_eq"],
  __yo_comptime_i32_neq: ["__yo_comptime_i32_neq"],
  __yo_comptime_i32_lt: ["__yo_comptime_i32_lt"],
  __yo_comptime_i32_lte: ["__yo_comptime_i32_lte"],
  __yo_comptime_i32_gt: ["__yo_comptime_i32_gt"],
  __yo_comptime_i32_gte: ["__yo_comptime_i32_gte"],
  __yo_comptime_i32_neg: ["__yo_comptime_i32_neg"],
  __yo_comptime_i32_bit_and: ["__yo_comptime_i32_bit_and"],
  __yo_comptime_i32_bit_or: ["__yo_comptime_i32_bit_or"],
  __yo_comptime_i32_bit_xor: ["__yo_comptime_i32_bit_xor"],
  __yo_comptime_i32_bit_not: ["__yo_comptime_i32_bit_not"],
  __yo_comptime_i32_shl: ["__yo_comptime_i32_shl"],
  __yo_comptime_i32_shr: ["__yo_comptime_i32_shr"],
  __yo_comptime_i32_to_comptime_string: [
    "__yo_comptime_i32_to_comptime_string",
  ],

  // u64 functions
  __yo_comptime_u64_add: ["__yo_comptime_u64_add"],
  __yo_comptime_u64_sub: ["__yo_comptime_u64_sub"],
  __yo_comptime_u64_mul: ["__yo_comptime_u64_mul"],
  __yo_comptime_u64_div: ["__yo_comptime_u64_div"],
  __yo_comptime_u64_mod: ["__yo_comptime_u64_mod"],
  __yo_comptime_u64_eq: ["__yo_comptime_u64_eq"],
  __yo_comptime_u64_neq: ["__yo_comptime_u64_neq"],
  __yo_comptime_u64_lt: ["__yo_comptime_u64_lt"],
  __yo_comptime_u64_lte: ["__yo_comptime_u64_lte"],
  __yo_comptime_u64_gt: ["__yo_comptime_u64_gt"],
  __yo_comptime_u64_gte: ["__yo_comptime_u64_gte"],
  __yo_comptime_u64_neg: ["__yo_comptime_u64_neg"],
  __yo_comptime_u64_bit_and: ["__yo_comptime_u64_bit_and"],
  __yo_comptime_u64_bit_or: ["__yo_comptime_u64_bit_or"],
  __yo_comptime_u64_bit_xor: ["__yo_comptime_u64_bit_xor"],
  __yo_comptime_u64_bit_not: ["__yo_comptime_u64_bit_not"],
  __yo_comptime_u64_shl: ["__yo_comptime_u64_shl"],
  __yo_comptime_u64_shr: ["__yo_comptime_u64_shr"],
  __yo_comptime_u64_to_comptime_string: [
    "__yo_comptime_u64_to_comptime_string",
  ],

  // i64 functions
  __yo_comptime_i64_add: ["__yo_comptime_i64_add"],
  __yo_comptime_i64_sub: ["__yo_comptime_i64_sub"],
  __yo_comptime_i64_mul: ["__yo_comptime_i64_mul"],
  __yo_comptime_i64_div: ["__yo_comptime_i64_div"],
  __yo_comptime_i64_mod: ["__yo_comptime_i64_mod"],
  __yo_comptime_i64_eq: ["__yo_comptime_i64_eq"],
  __yo_comptime_i64_neq: ["__yo_comptime_i64_neq"],
  __yo_comptime_i64_lt: ["__yo_comptime_i64_lt"],
  __yo_comptime_i64_lte: ["__yo_comptime_i64_lte"],
  __yo_comptime_i64_gt: ["__yo_comptime_i64_gt"],
  __yo_comptime_i64_gte: ["__yo_comptime_i64_gte"],
  __yo_comptime_i64_neg: ["__yo_comptime_i64_neg"],
  __yo_comptime_i64_bit_and: ["__yo_comptime_i64_bit_and"],
  __yo_comptime_i64_bit_or: ["__yo_comptime_i64_bit_or"],
  __yo_comptime_i64_bit_xor: ["__yo_comptime_i64_bit_xor"],
  __yo_comptime_i64_bit_not: ["__yo_comptime_i64_bit_not"],
  __yo_comptime_i64_shl: ["__yo_comptime_i64_shl"],
  __yo_comptime_i64_shr: ["__yo_comptime_i64_shr"],
  __yo_comptime_i64_to_comptime_string: [
    "__yo_comptime_i64_to_comptime_string",
  ],

  // usize functions
  __yo_comptime_usize_add: ["__yo_comptime_usize_add"],
  __yo_comptime_usize_sub: ["__yo_comptime_usize_sub"],
  __yo_comptime_usize_mul: ["__yo_comptime_usize_mul"],
  __yo_comptime_usize_div: ["__yo_comptime_usize_div"],
  __yo_comptime_usize_mod: ["__yo_comptime_usize_mod"],
  __yo_comptime_usize_eq: ["__yo_comptime_usize_eq"],
  __yo_comptime_usize_neq: ["__yo_comptime_usize_neq"],
  __yo_comptime_usize_lt: ["__yo_comptime_usize_lt"],
  __yo_comptime_usize_lte: ["__yo_comptime_usize_lte"],
  __yo_comptime_usize_gt: ["__yo_comptime_usize_gt"],
  __yo_comptime_usize_gte: ["__yo_comptime_usize_gte"],
  __yo_comptime_usize_neg: ["__yo_comptime_usize_neg"],
  __yo_comptime_usize_bit_and: ["__yo_comptime_usize_bit_and"],
  __yo_comptime_usize_bit_or: ["__yo_comptime_usize_bit_or"],
  __yo_comptime_usize_bit_xor: ["__yo_comptime_usize_bit_xor"],
  __yo_comptime_usize_bit_not: ["__yo_comptime_usize_bit_not"],
  __yo_comptime_usize_shl: ["__yo_comptime_usize_shl"],
  __yo_comptime_usize_shr: ["__yo_comptime_usize_shr"],
  __yo_comptime_usize_to_comptime_string: [
    "__yo_comptime_usize_to_comptime_string",
  ],

  // isize functions
  __yo_comptime_isize_add: ["__yo_comptime_isize_add"],
  __yo_comptime_isize_sub: ["__yo_comptime_isize_sub"],
  __yo_comptime_isize_mul: ["__yo_comptime_isize_mul"],
  __yo_comptime_isize_div: ["__yo_comptime_isize_div"],
  __yo_comptime_isize_mod: ["__yo_comptime_isize_mod"],
  __yo_comptime_isize_eq: ["__yo_comptime_isize_eq"],
  __yo_comptime_isize_neq: ["__yo_comptime_isize_neq"],
  __yo_comptime_isize_lt: ["__yo_comptime_isize_lt"],
  __yo_comptime_isize_lte: ["__yo_comptime_isize_lte"],
  __yo_comptime_isize_gt: ["__yo_comptime_isize_gt"],
  __yo_comptime_isize_gte: ["__yo_comptime_isize_gte"],
  __yo_comptime_isize_neg: ["__yo_comptime_isize_neg"],
  __yo_comptime_isize_bit_and: ["__yo_comptime_isize_bit_and"],
  __yo_comptime_isize_bit_or: ["__yo_comptime_isize_bit_or"],
  __yo_comptime_isize_bit_xor: ["__yo_comptime_isize_bit_xor"],
  __yo_comptime_isize_bit_not: ["__yo_comptime_isize_bit_not"],
  __yo_comptime_isize_shl: ["__yo_comptime_isize_shl"],
  __yo_comptime_isize_shr: ["__yo_comptime_isize_shr"],
  __yo_comptime_isize_to_comptime_string: [
    "__yo_comptime_isize_to_comptime_string",
  ],

  // f32 functions
  __yo_comptime_f32_add: ["__yo_comptime_f32_add"],
  __yo_comptime_f32_sub: ["__yo_comptime_f32_sub"],
  __yo_comptime_f32_mul: ["__yo_comptime_f32_mul"],
  __yo_comptime_f32_div: ["__yo_comptime_f32_div"],
  __yo_comptime_f32_eq: ["__yo_comptime_f32_eq"],
  __yo_comptime_f32_neq: ["__yo_comptime_f32_neq"],
  __yo_comptime_f32_lt: ["__yo_comptime_f32_lt"],
  __yo_comptime_f32_lte: ["__yo_comptime_f32_lte"],
  __yo_comptime_f32_gt: ["__yo_comptime_f32_gt"],
  __yo_comptime_f32_gte: ["__yo_comptime_f32_gte"],
  __yo_comptime_f32_neg: ["__yo_comptime_f32_neg"],
  __yo_comptime_f32_to_comptime_string: [
    "__yo_comptime_f32_to_comptime_string",
  ],

  // f64 functions
  __yo_comptime_f64_add: ["__yo_comptime_f64_add"],
  __yo_comptime_f64_sub: ["__yo_comptime_f64_sub"],
  __yo_comptime_f64_mul: ["__yo_comptime_f64_mul"],
  __yo_comptime_f64_div: ["__yo_comptime_f64_div"],
  __yo_comptime_f64_eq: ["__yo_comptime_f64_eq"],
  __yo_comptime_f64_neq: ["__yo_comptime_f64_neq"],
  __yo_comptime_f64_lt: ["__yo_comptime_f64_lt"],
  __yo_comptime_f64_lte: ["__yo_comptime_f64_lte"],
  __yo_comptime_f64_gt: ["__yo_comptime_f64_gt"],
  __yo_comptime_f64_gte: ["__yo_comptime_f64_gte"],
  __yo_comptime_f64_neg: ["__yo_comptime_f64_neg"],
  __yo_comptime_f64_to_comptime_string: [
    "__yo_comptime_f64_to_comptime_string",
  ],

  // comptime_boolean related functions
  /// 2 args
  __yo_comptime_bool_and: ["__yo_comptime_bool_and"],
  __yo_comptime_bool_or: ["__yo_comptime_bool_or"],
  __yo_comptime_bool_eq: ["__yo_comptime_bool_eq"],
  __yo_comptime_bool_neq: ["__yo_comptime_bool_neq"],
  // 1 arg
  __yo_comptime_bool_not: ["__yo_comptime_bool_not"],
  __yo_comptime_bool_to_comptime_string: [
    "__yo_comptime_bool_to_comptime_string",
  ],

  // comptime_str related functions
  /// 2 args
  __yo_comptime_string_concat: ["__yo_comptime_string_concat"],
  __yo_comptime_string_eq: ["__yo_comptime_string_eq"],
  __yo_comptime_string_neq: ["__yo_comptime_string_neq"],
  __yo_comptime_string_lt: ["__yo_comptime_string_lt"],
  __yo_comptime_string_lte: ["__yo_comptime_string_lte"],
  __yo_comptime_string_gt: ["__yo_comptime_string_gt"],
  __yo_comptime_string_gte: ["__yo_comptime_string_gte"],
  // 1 arg
  __yo_comptime_string_length: ["__yo_comptime_string_length"],
  __yo_comptime_string_to_upper: ["__yo_comptime_string_to_upper"],
  __yo_comptime_string_to_lower: ["__yo_comptime_string_to_lower"],
  // 2-3 args (string, start, optional end)
  __yo_comptime_string_slice: ["__yo_comptime_string_slice"],

  // Comptime string indexing builtins (used by ComptimeIndex trait impls)
  __yo_comptime_string_index: ["__yo_comptime_string_index"],
  __yo_comptime_string_index_range: ["__yo_comptime_string_index_range"],
  __yo_comptime_string_index_range_inclusive: [
    "__yo_comptime_string_index_range_inclusive",
  ],

  // Type related functions
  __yo_type_to_comptime_string: ["__yo_type_to_comptime_string"],
  // __yo_type_is_type0: ["__yo_type_is_type0"],
  __yo_type_contains_rc_type: ["__yo_type_contains_rc_type"],
  __yo_type_can_form_rc_cycle: ["__yo_type_can_form_rc_cycle"],
  __yo_are_types_compatible: ["__yo_are_types_compatible"],
  __yo_are_types_equal: ["__yo_are_types_equal"],
  __yo_type_impls: ["__yo_type_impls"], // Check if a type implements a trait (e.g., Copy, Send)

  // Type reflection builtins
  __yo_type_get_info: ["__yo_type_get_info"],

  // comptime_eval builtin
  comptime_eval: ["comptime_eval"],

  // Derive traits builtin
  derive: ["derive"],
  derive_rule: ["derive_rule"],

  // comptime_str to Expr conversion
  __yo_comptime_string_to_expr: ["__yo_comptime_string_to_expr"],

  // Expr-based type iteration builtins (for derive rules)
  __yo_type_join_fields: ["__yo_type_join_fields"],
  __yo_type_map_variants: ["__yo_type_map_variants"],

  // Variale related functions
  __yo_var_print_info: ["__yo_var_print_info"],
  __yo_var_is_owning_the_rc_value: ["__yo_var_is_owning_the_rc_value"],
  __yo_var_has_other_aliases: ["__yo_var_has_other_aliases"],

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
  __yo_panic: ["__yo_panic"],

  // Rc/Gc related
  __yo_decr_rc: ["__yo_decr_rc"], // decrement the reference-counter (usize)
  __yo_incr_rc: ["__yo_incr_rc"], // increment the reference-counter (usize)
  __yo_decr_rc_atomic: ["__yo_decr_rc_atomic"], // atomic decrement for Iso types
  __yo_incr_rc_atomic: ["__yo_incr_rc_atomic"], // atomic increment for Iso types
  __yo_rc_own: ["__yo_rc_own"], // return the value itself, but set isOwningTheRcValue to be true. This is useful for implementing ___dup function.
  __yo_iso_extract: ["__yo_iso_extract"], // extract inner value from Iso(T), returns Option(T)
  __yo_iso_dispose: ["__yo_iso_dispose"], // dispose inner value of Iso if not extracted

  // Garbage collection for cycle detection
  __yo_gc_collect: ["__yo_gc_collect"], // manually trigger garbage collection
  __yo_gc_trace_child: ["__yo_gc_trace_child"], // per-value edge tracer (GcTracer.visit body)

  // Dynamic dispatch Rc functions
  __yo_dyn_drop: ["__yo_dyn_drop"], // drop the dyn object with wrapped object
  __yo_dyn_dup: ["__yo_dyn_dup"], // dup the dyn object with wrapped object

  // SomeType Rc functions - dispatch to resolvedConcreteType if available
  __yo_sometype_drop: ["__yo_sometype_drop"], // drop by dispatching to resolvedConcreteType
  __yo_sometype_dup: ["__yo_sometype_dup"], // dup by dispatching to resolvedConcreteType

  // Rc functions
  ___drop: ["___drop"], // drop the value; decrement the reference-counter if necessary, and call `dispose` if is_uniquely_owned
  ___dispose: ["___dispose"],
  ___dup: ["___dup"], // duplicate the value; increment the reference-counter if necessary
  dispose: ["dispose"], // Destructor to run when an object is dropped
  __yo_drop_array_element: ["__yo_drop_array_element"], // drop array element at index without borrowing
  __yo_dup_array_element: ["__yo_dup_array_element"], // dup array element at index without borrowing
  __yo_drop_tuple_element: ["__yo_drop_tuple_element"], // drop tuple element at index without borrowing
  __yo_dup_tuple_element: ["__yo_dup_tuple_element"], // dup tuple element at index without borrowing

  /// Others
  __yo_noop: ["__yo_noop"],
  __yo_return_self: ["__yo_return_self"],
  __yo_borrow_assert_unborrowed: ["__yo_borrow_assert_unborrowed"],
  __yo_ms_sleep: ["__yo_ms_sleep"],

  // Crypto random
  __yo_getrandom: ["__yo_getrandom"],
  __yo_arc4random_buf: ["__yo_arc4random_buf"],
  __yo_bcrypt_gen_random: ["__yo_bcrypt_gen_random"],
  __yo_getentropy: ["__yo_getentropy"],

  // MaybeUninit
  __yo_maybe_uninit_new: ["__yo_maybe_uninit_new"],
  __yo_maybe_uninit_as_ptr: ["__yo_maybe_uninit_as_ptr"],
  __yo_maybe_uninit_assume_init: ["__yo_maybe_uninit_assume_init"],

  // Process related functions
  __yo_process_platform: ["__yo_process_platform"], // returns process.platform as comptime_str
  __yo_process_arch: ["__yo_process_arch"], // returns process.arch as comptime_str
  __yo_pointer_size_bits: ["__yo_pointer_size_bits"], // returns target pointer size in bits (32 or 64) as comptime_int

  // Build system functions (compile-time only)
  __yo_build_executable: ["__yo_build_executable"],
  __yo_build_static_library: ["__yo_build_static_library"],
  __yo_build_shared_library: ["__yo_build_shared_library"],
  __yo_build_test: ["__yo_build_test"],
  __yo_build_run: ["__yo_build_run"],
  __yo_build_step: ["__yo_build_step"],
  __yo_build_step_depend_on: ["__yo_build_step_depend_on"],
  __yo_build_link: ["__yo_build_link"],
  __yo_build_link_system_library: ["__yo_build_link_system_library"],
  __yo_build_target_host: ["__yo_build_target_host"],
  __yo_build_target_parse: ["__yo_build_target_parse"],
  __yo_build_dependency: ["__yo_build_dependency"],
  __yo_build_path_dependency: ["__yo_build_path_dependency"],
  __yo_build_system_library: ["__yo_build_system_library"],
  __yo_build_option: ["__yo_build_option"],
  __yo_build_dep_artifact: ["__yo_build_dep_artifact"],
  __yo_build_module: ["__yo_build_module"],
  __yo_build_module_link: ["__yo_build_module_link"],
  __yo_build_add_import: ["__yo_build_add_import"],
  __yo_build_add_cflags: ["__yo_build_add_cflags"],
  __yo_build_dep_module: ["__yo_build_dep_module"],
  __yo_build_doc: ["__yo_build_doc"],

  // Inline assembly
  asm: ["asm"],
  global_asm: ["global_asm"],

  // Formal verification surface (plans/FORMAL_VERIFICATION.md, Phase 0).
  // Phase 0 evaluates these as no-op markers — they parse, type-check,
  // and (in later phases) lower to runtime asserts or proof obligations.
  requires: ["requires"],
  ensures: ["ensures"],
  invariant: ["invariant"],
  ghost: ["ghost"],
  ghost_fn: ["ghost_fn"],
  old: ["old"],
};

export function exprIsInfixOperatorFunctionCall(expr: Expr): boolean {
  return Boolean(
    expr.tag === "FnCall" &&
      expr.isInfix &&
      expr.func.tag === "Atom" &&
      expr.func.token.type === TokenType.Operator &&
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
    case "FnCall": {
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            let arg = exprToCompactString(expr.args[0]!);
            // Wrap arg in parens if it's a function call to prevent
            // reparsing ambiguity (e.g., .(#(x)) vs .#(x))
            if (exprIsFunctionCall(expr.args[0]!)) {
              arg = `(${arg})`;
            }
            printed = `${expr.func.token.value}${arg}`;
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
            // Wrap RHS in parens if it's a function call to prevent
            // reparsing ambiguity (e.g., self.(#(x)) vs self.#(x))
            if (exprIsFunctionCall(expr.args[1]!)) {
              rhs = `(${rhs})`;
            }
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
        expr.func.token.value === BuiltinKeywords.tuple[0]!
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
    case "FnCall": {
      // Handle special operators and dots
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            let arg = exprToPrettyString(expr.args[0]!, config);
            // Wrap arg in parens if it's a function call to prevent
            // reparsing ambiguity (e.g., .(#(x)) vs .#(x))
            if (exprIsFunctionCall(expr.args[0]!)) {
              arg = `(${arg})`;
            }
            return `${expr.func.token.value}${arg}`;
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
            if (exprIsFunctionCall(expr.args[1]!)) {
              rhs = `(${rhs})`;
            }
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
        expr.func.token.value === BuiltinKeywords.tuple[0]!
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

/**
 * Consume the temp variable that evaluateBeginExpression attached to a
 * match/cond case body.  The match/cond creates its own result variable, so
 * the case-body temp var is never emitted in C.  If left unconsumed it causes
 * a phantom drop.
 */
export function consumeCaseBodyTempVar(
  evaluatedBody: Expr,
  env: Environment
): Environment {
  const varName = evaluatedBody.$?.variableName;
  if (!varName) return env;
  if (!isTempVariableName(env.modulePath, varName)) return env;
  const vars = getVariablesFromEnv(env, varName);
  if (vars.length === 0) return env;
  const v = vars[vars.length - 1]!;
  if (v.consumedAtToken) return env;
  return updateExistingVariable(env, v, {
    ...v,
    consumedAtToken: evaluatedBody.token,
  });
}

export function attachTempVariableToExpr(
  expr: Expr,
  isOwningTheRcValue: boolean,
  isOwningTheSameRcValueAs?: Variable,
  /**
   * Phase B of plans/archive/ITERATOR_REDESIGN.md — set when the expression
   * is a call to a function whose return slot is `ref(T)`. The temp
   * variable created here will hold the raw `T*` returned by the C
   * function; the codegen reads `isRef` on the variable to emit
   * `T*` as the declared type and `(*name)` for atom reads.
   */
  isRef?: boolean
): void {
  if (!expr.$) {
    throw new Error(`Expected expression to be evaluated, but it is not:
${exprToString(expr)}`);
  }
  const { env, value, originType } = expr.$;
  const modulePath = env.modulePath;

  // For closure expressions, the surface `expr.$.type` is the closure's Fn
  // trait type (e.g. Impl(Fn(...))) which contains no RC-tracked fields. The
  // RC-owning thing the temp variable actually backs is the closure's
  // capture struct (which holds dup'd references to outer RC variables).
  // If we don't substitute the type here, the temp gets `isOwningTheRcValue:
  // false` and is never dropped at scope end -- leaking every captured RC
  // variable. Use the capture struct as the variable's type so drop codegen
  // dispatches to the capture struct's `___drop` (which decr_rc's each
  // captured field).
  const captureType = expr.$.captureType;
  const useCaptureType =
    !!captureType && typeContainsRcType(captureType) && isOwningTheRcValue;
  const type = useCaptureType ? captureType! : expr.$.type;

  // NOTE: For now let's make all the isOwningTheRcValue variable runtime-only
  // so the `object` value can only be used in runtime.
  // Actually, all C pointer related should be runtime-only.
  const _isOwningTheARCValue = isOwningTheRcValue && typeContainsRcType(type);

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
        Boolean(existingVariable.isOwningTheRcValue) === false
          ? false
          : _isOwningTheARCValue;
      const updatedVariable: Variable = {
        ...existingVariable,
        type,
        value: preservedIsOwningTheRefValue
          ? undefined
          : value
            ? [value]
            : undefined,
        isCompileTimeOnly: preservedIsOwningTheRefValue
          ? false
          : Boolean(value),
        isOwningTheRcValue: preservedIsOwningTheRefValue,
        isOwningTheSameRcValueAs,
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
        value: _isOwningTheARCValue ? undefined : value ? [value] : undefined,
        isCompileTimeOnly: _isOwningTheARCValue ? false : Boolean(value),
        initializedAtToken: expr.token,
        // A ref-yielding call's temp holds the raw `T*` returned by
        // the C function — it borrows, doesn't own. Skip RC tracking.
        isOwningTheRcValue: isRef ? false : _isOwningTheARCValue,
        isOwningTheSameRcValueAs,
        consumedAtToken: undefined,
        token: expr.token,
        isRef: isRef || undefined,
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
      value: _isOwningTheARCValue ? undefined : value ? [value] : undefined,
      isCompileTimeOnly: _isOwningTheARCValue ? false : Boolean(value),
      initializedAtToken: expr.token,
      // A ref-yielding call's temp holds the raw `T*` returned by the
      // C function — it borrows, doesn't own. Skip RC tracking.
      isOwningTheRcValue: isRef ? false : _isOwningTheARCValue,
      isOwningTheSameRcValueAs,
      consumedAtToken: undefined,
      token: expr.token,
      isRef: isRef || undefined,
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
      isOwningTheRcValue: boolean;
    }[][] = [[]];
    frameVariables.forEach((variable) => {
      matrix[0]!.push({
        consumedAtToken: variable.consumedAtToken,
        initializedAtToken: variable.initializedAtToken,
        type: variable.type,
        isOwningTheRcValue: variable.isOwningTheRcValue ?? false,
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
        // When a case body has more variables than the base env, the extra
        // variables may be temp variables that leaked to a shared begin-block
        // frame during condition or branch-body evaluation (e.g., when there is
        // no begin-block frame between the current function scope and a parent
        // begin-block frame). Adopt them into the base env so the merge can
        // proceed normally.
        if (caseEnvFrameVariables.length > frameVariables.length) {
          const extraVars = [...caseEnvFrameVariables].slice(
            frameVariables.length
          );
          const allExtraAreTemps = extraVars.every((v) =>
            isTempVariableName(env.modulePath, v.name)
          );
          if (allExtraAreTemps) {
            for (const extraVar of extraVars) {
              // Adopted temp variables from match/cond branches must NOT be
              // marked as owning RC values.  Only one branch runs at runtime,
              // and each branch already handles drops for its own locals.
              // Marking them as owning would cause a phantom drop in the
              // parent scope for a variable that was never declared in C.
              frameVariables.push({
                ...extraVar,
                isOwningTheRcValue: false,
              });
              matrix[0]!.push({
                consumedAtToken: undefined,
                initializedAtToken: extraVar.initializedAtToken,
                type: extraVar.type,
                isOwningTheRcValue: false,
              });
            }
            // Update the env frame with the adopted temp variables
            const newFrame = {
              ...frame,
              variables: [...frameVariables],
            };
            env = {
              ...env,
              frames: env.frames.map((f, idx) => (idx === i ? newFrame : f)),
            };
          } else {
            throw formatErrorMessages([
              {
                token: bodies[j]!.token,
                errorMessage: `Frame level ${i} has different number of values for different cases.`,
              },
            ]);
          }
        } else {
          throw formatErrorMessages([
            {
              token: bodies[j]!.token,
              errorMessage: `Frame level ${i} has different number of values for different cases.`,
            },
          ]);
        }
      }

      // Check if the variable names are the same
      for (let k = 0; k < frameVariables.length; k++) {
        const frameVariable = frameVariables[k]!;
        const caseEnvFrameValue = caseEnvFrameVariables[k]!;
        if (frameVariable.name !== caseEnvFrameValue.name) {
          // Allow mismatched names when both are temp variables at the same position.
          // Different branches may allocate temps with different counter suffixes
          // (e.g., _temp_24758 vs _temp_24759) but they represent the same slot.
          if (
            isTempVariableName(env.modulePath, frameVariable.name) &&
            isTempVariableName(env.modulePath, caseEnvFrameValue.name)
          ) {
            continue;
          }
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
          isOwningTheRcValue: variable.isOwningTheRcValue ?? false,
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
    for (let j = 0; j < cols; j++) {
      const variableName = frameVariables[j]!.name;
      const initializedAtTokens: (Token | undefined)[] = [];
      const isOwningTheRefValueAtTokens: (Token | undefined)[] = [];
      const consumedAtTokens: (Token | undefined)[] = [];
      const types: Type[] = [];
      for (let k = 1; k < rows; k++) {
        const caseEnv = caseEnvs[k - 1]!;
        const caseEnvFrameVariables = caseEnv.frames[frameLevel]!.variables;
        initializedAtTokens.push(matrix[k]![j]!.initializedAtToken);
        isOwningTheRefValueAtTokens.push(
          matrix[k]![j]!.isOwningTheRcValue
            ? caseEnvFrameVariables[j]!.token
            : undefined
        );
        consumedAtTokens.push(matrix[k]![j]!.consumedAtToken);
        types.push(matrix[k]![j]!.type);
      }

      // Check type compatibility across cases for initialized variables
      // This is for checking the code like:
      //
      //   arr : Array(i32, _);
      //   comptime_expect_error(
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
          !frameVariables[j]!.initializedAtToken
        ) {
          throw formatErrorMessages([
            {
              token: frameVariables[j]!.token,
              errorMessage: `Variable "${frameVariables[j]!.name}" might not be initialized in all cases.`,
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
        !frameVariables[j]!.initializedAtToken &&
        initializedAtTokens.every((u) => u)
      ) {
        const newVariable: Variable = {
          ...frameVariables[j]!,
          initializedAtToken: initializedAtTokens[0]!,
        };
        env = updateExistingVariable(env, frameVariables[j]!, newVariable);
        frameVariables[j] = newVariable;
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

      // Check consumedAtToken
      // case 1: If there is only one case and the variable is consumed in that case but not before,
      // mark it as consumed. This handles compile-time eliminated branches where only one path exists.
      // (Previously this was an error, but that was wrong - if there's only one branch,
      // the variable IS definitely consumed, there's no ambiguity)
      if (consumedAtTokens.length === 1) {
        if (!!consumedAtTokens[0] && !frameVariables[j]!.consumedAtToken) {
          const newVariable: Variable = {
            ...frameVariables[j]!,
            consumedAtToken: consumedAtTokens[0]!,
          };
          env = updateExistingVariable(env, frameVariables[j]!, newVariable);
          frameVariables[j] = newVariable;
        }
      }
      // case 2: Variable is not consumed before, but consumed in all cases
      else if (
        !frameVariables[j]!.consumedAtToken &&
        consumedAtTokens.every((u) => u)
      ) {
        const newVariable: Variable = {
          ...frameVariables[j]!,
          consumedAtToken: consumedAtTokens[0]!,
        };
        env = updateExistingVariable(env, frameVariables[j]!, newVariable);
        frameVariables[j] = newVariable;
      }
      // case 3: Some cases consume, some don't
      else {
        const consumed = consumedAtTokens.filter((u) => !!u);
        const notConsumed = consumedAtTokens.filter((u) => !u);
        if (consumed.length > 0 && notConsumed.length > 0) {
          throw formatErrorMessages(
            consumedAtTokens.map((token, index) => {
              return {
                errorMessage:
                  (index === 0
                    ? `Variable "${variableName}" is consumed in some cases but not in other cases:\n`
                    : "") + (token ? "Consumed here:" : "Not consumed here:"),
                token: token ?? bodies[index]!.token,
              };
            })
          );
        }
      }

      // Check isOwningTheRefValueAtTokens
      // Variable is not owning the Rc value outside, but the only case makes it owning.
      // case 1
      /*
      if (isOwningTheRefValueAtTokens.length === 1) {
        if (
          !frameVariables[i]!.isOwningTheRcValue &&
          isOwningTheRefValueAtTokens[0]
        ) {
          throw formatErrorMessages([
            {
              token: frameVariables[i]!.token,
              errorMessage: `Variable "${frameVariables[i]!.name}" might not be owning the Rc value in all cases.`,
            },
            {
              token: isOwningTheRefValueAtTokens[0]!,
              errorMessage: `Might be owning the Rc value here:`,
            },
          ]);
        }
      }
      // case 2
      // variable is not owning the Rc value outside, but all cases make it owning.
      else 
      */
      if (
        !frameVariables[j]!.isOwningTheRcValue &&
        isOwningTheRefValueAtTokens.every((u) => u)
      ) {
        const newVariable: Variable = {
          ...frameVariables[j]!,
          isOwningTheRcValue: true,
          isOwningTheSameRcValueAs: undefined,
        };
        env = updateExistingVariable(env, frameVariables[j]!, newVariable);
        frameVariables[j] = newVariable;
      }
      // case 3
      else if (frameVariables[j]!.isRef) {
        // inout(name) : T parameters are second-class references — the
        // slot always points to a valid caller-side Rc. Assignment in
        // some branches and not others is fine: assigning branches drop
        // the old value and write the new; non-assigning branches leave
        // the original intact. C-side, the pointer always dereferences
        // to a held Rc, regardless of which branch ran. So skip the
        // consistency check that applies to value-typed locals.
      } else {
        const isOwningTheRcValue = isOwningTheRefValueAtTokens.filter(
          (u) => !!u
        );
        const isNotOwningTheRefValue = isOwningTheRefValueAtTokens.filter(
          (u) => !u
        );
        if (
          isOwningTheRcValue.length > 0 &&
          isNotOwningTheRefValue.length > 0
        ) {
          throw formatErrorMessages(
            isOwningTheRefValueAtTokens.map((token, index) => {
              return {
                errorMessage:
                  (index === 0
                    ? `Variable "${variableName}" might be holding the Rc value in some cases but not holding the Rc value in other cases:\n`
                    : "") +
                  (token
                    ? "Might be owning the Rc value here:"
                    : "Might be not owning the Rc value here:"),
                token: token ?? bodies[index]!.token,
              };
            })
          );
        }
      }

      // Check for reassignment across branches
      // When a variable is reassigned in any branch, its ID changes (see assignment.ts)
      // We need to detect this and generate a new ID for the merged environment
      const originalVariableId = frameVariables[j]!.id;
      const variableIds: string[] = [];

      for (let k = 1; k < rows; k++) {
        const caseEnv = caseEnvs[k - 1]!;
        const caseEnvFrameVariables = caseEnv.frames[frameLevel]!.variables;
        const caseVariable = caseEnvFrameVariables[j]!;
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
          ...frameVariables[j]!,
          id: newVariableId,
          // Reset compile-time value since the variable was reassigned in a runtime branch;
          // the actual value is unknown at compile time after the branch merge.
          value: undefined,
          // Clear ownership tracking since the value may come from different sources
          isOwningTheSameRcValueAs: undefined,
        };
        env = updateExistingVariable(env, frameVariables[j]!, newVariable);
        frameVariables[j] = newVariable;
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
  funcExpr: FnCallExpr,
  newFuncExpr: FnCallExpr
): void {
  funcExpr.$ = newFuncExpr.$;
  funcExpr.args = newFuncExpr.args;
  funcExpr.func = newFuncExpr.func;
  funcExpr.isInfix = newFuncExpr.isInfix;
  funcExpr.tag = newFuncExpr.tag;
  funcExpr.token = newFuncExpr.token;
}

export function replaceFuncCallExprWithAtomExpr(
  funcExpr: FnCallExpr,
  newAtomExpr: AtomExpr
): void {
  // Convert function call to atom by changing its properties
  const atomExpr = funcExpr as unknown as AtomExpr;
  atomExpr.tag = newAtomExpr.tag;
  atomExpr.token = newAtomExpr.token;
  atomExpr.$ = newAtomExpr.$;

  // Clean up function call specific properties by setting them to undefined
  (funcExpr as Partial<FnCallExpr>).func = undefined;
  (funcExpr as Partial<FnCallExpr>).args = undefined;
  (funcExpr as Partial<FnCallExpr>).isInfix = undefined;
}

export function replaceExprWithFuncCallExpr(
  expr: Expr,
  newFuncExpr: FnCallExpr
): void {
  if (exprIsFunctionCall(expr)) {
    replaceFuncCallExprWithFuncCallExpr(expr, newFuncExpr);
  } else {
    // expr is atom;
    (expr as Expr).tag = newFuncExpr.tag;
    const funcExpr = expr as unknown as FnCallExpr;
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
    const errorMessage = `use of moved value: \`${nameOfVariableToConsume}\``;
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage: errorMessage,
      },
      {
        token: variableToConsume.consumedAtToken,
        errorMessage: `value moved here`,
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
 * Aliasing Stage 0 (issues/borrowed-arg-invalidated-by-aliased-container-mutation.md):
 * dup an RC-typed PROJECTION argument passed to a BORROWING parameter, keeping
 * the +1 in the CALLER.
 *
 * A field projection (`w.b`) evaluates to a non-owning temp — a view into
 * storage the callee may reassign through an aliased handle (`f(w, w.b)`
 * reassigning `w.b` in a loop frees the old value mid-call: the borrowed
 * parameter dangles). The dup materializes an owned +1 for the call; unlike
 * `setExprAsNeedsToCallDup` (the own-param path), the dup RESULT temp is left
 * OWNING and UNCONSUMED so the caller's normal scope-end drop releases it,
 * and the SOURCE binding is not consumed (a borrow stays usable).
 *
 * No-ops when the argument's temp already OWNS its value (an owned temp is
 * kept alive to scope end regardless — no aliasing hole) or when the value is
 * compile-time (inlined, no RC traffic).
 */
export function setExprAsNeedsToCallDupForBorrowedProjection(
  expr: Expr,
  context: EvaluatorContext
): void {
  if (!expr.$ || !expr.$.variableName) {
    return;
  }
  if (expr.$.value) {
    return;
  }
  if (!typeContainsRcType(expr.$.type)) {
    return;
  }
  const variableName = expr.$.variableName;
  const variables = getVariablesFromEnv(expr.$.env, variableName);
  const variable = variables.length
    ? variables[variables.length - 1]
    : undefined;
  if (!variable || variable.isOwningTheRcValue) {
    return;
  }
  const dupCallExpr = generateExprFromCode(
    `${BuiltinFunctions.___dup[0]!}(${variableName})`
  );
  const evaluatedDupCallExpr = evaluateExpression({
    expr: dupCallExpr,
    env: expr.$.env,
    context: { ...context, expectedType: undefined },
  }) as FnCallExpr;
  // Stamp the USE SITE's source token (same rationale as
  // setExprAsNeedsToCallDup below: the optimizer needs the real source
  // position, not the generated token).
  (
    evaluatedDupCallExpr as FnCallExpr & { __useSiteToken?: Token }
  ).__useSiteToken = expr.token;
  // evaluateDup marks its result temp NON-owning (the own-param contract —
  // the callee drops the transferred +1). Here the CALLER keeps the +1, so
  // flip the result temp back to OWNING: the enclosing scope's normal
  // scope-end drop is the balancing -1. (The dup/drop pair optimizer cannot
  // cancel this pair into a move: the dup targets the SOURCE temp, the drop
  // targets the dup RESULT temp — different variables.)
  const dupResultTempName = evaluatedDupCallExpr.$?.variableName;
  if (dupResultTempName) {
    const dupResultVars = getVariablesFromEnv(
      evaluatedDupCallExpr.$!.env,
      dupResultTempName
    );
    if (dupResultVars.length) {
      const dupResultVar = dupResultVars[dupResultVars.length - 1]!;
      if (!dupResultVar.isOwningTheRcValue) {
        evaluatedDupCallExpr.$!.env = updateExistingVariable(
          evaluatedDupCallExpr.$!.env,
          dupResultVar,
          { ...dupResultVar, isOwningTheRcValue: true }
        );
      }
    }
  }
  expr.$.deferredDupExpressions = [evaluatedDupCallExpr];
  expr.$.env = evaluatedDupCallExpr.$!.env;
}

/**
 * Aliasing Stage 1 (mutation summaries): the exact inverse of
 * `setExprAsNeedsToCallDupForBorrowedProjection`, applied when the callee
 * specialization is proven read-only — the borrowed projection cannot be
 * invalidated during the call, so the Stage-0 `+1` is elided. Removes the
 * deferred dup (codegen never emits it) and flips the dup result temp back
 * to NON-owning (the scope-end machinery emits no drop for it). The temp
 * variable itself stays declared in the frame — inert.
 *
 * `env` must be the CURRENT caller env (the temp may have been re-bound by
 * later argument processing); returns the updated env.
 */
export function removeBorrowedProjectionDupMark(
  expr: Expr,
  env: Environment
): Environment {
  const dups = expr.$?.deferredDupExpressions;
  if (!dups || dups.length !== 1) {
    return env;
  }
  const dupExpr = dups[0]!;
  expr.$!.deferredDupExpressions = undefined;
  const dupTempName = dupExpr.$?.variableName;
  if (!dupTempName) {
    return env;
  }
  const dupTempVars = getVariablesFromEnv(env, dupTempName);
  if (!dupTempVars.length) {
    return env;
  }
  const dupTempVar = dupTempVars[dupTempVars.length - 1]!;
  if (dupTempVar.isOwningTheRcValue) {
    env = updateExistingVariable(env, dupTempVar, {
      ...dupTempVar,
      isOwningTheRcValue: false,
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
    return; // No temp variable name — nothing to consume.
  }

  // If the expression has a compile-time known value, we normally skip dup/consumption.
  // However, if the expression has an owning RC temp variable, we must still consume it
  // to prevent the evaluator from generating a bogus drop for a variable that won't be
  // declared in the C output (compile-time values are inlined).
  if (expr.$.value) {
    const variableName = expr.$.variableName;
    let needsDupForNonOwningRcTemp = false;
    if (
      variableName &&
      isTempVariableName(expr.$.env.modulePath, variableName) &&
      typeContainsRcType(expr.$.type)
    ) {
      const variables = getVariablesFromEnv(expr.$.env, variableName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheRcValue && !variable.consumedAtToken) {
          expr.$.env = updateExistingVariable(expr.$.env, variable, {
            ...variable,
            consumedAtToken: expr.token,
          });
        }
        // Non-owning RC temp (e.g., index trait result): fall through to
        // generate dup instead of returning early. The codegen does NOT dup
        // inline for these, so the evaluator must handle it.
        if (!variable.isOwningTheRcValue) {
          needsDupForNonOwningRcTemp = true;
        }
      }
    }
    if (!needsDupForNonOwningRcTemp) {
      return;
    }
  }

  const variableName = expr.$.variableName;
  if (!variableName) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expression does not have a variable name to call ${BuiltinFunctions.___dup} on:\n${exprToString(expr)}`,
    });
  }

  if (typeContainsRcType(expr.$.type)) {
    // Check if the expr.variableName is holding the Rc value
    // if yes, then no need to call dup
    // We just need to set it as consumed
    if (isTempVariableName(expr.$.env.modulePath, variableName)) {
      if (exprIsAtom(expr) && expr.token.value !== variableName) {
        // Do nothing
        // We need to call ___dup on it
      } else {
        const variables = getVariablesFromEnv(expr.$.env, variableName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          if (variable.isOwningTheRcValue) {
            // Set the variable as consumed so we won't need to drop it later
            // This needs to happen even during validation
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

    // NOTE: The condition below is wrong.
    // Skip creating dup calls during function definition validation
    // We're only validating types, not executing code, so RC operations are not needed
    // if (context.isValidatingFunctionDefinition) {
    //   return;
    // }

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
    }) as FnCallExpr;

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

    // Stamp the USE SITE's source token on the dup expression. The dup
    // expr itself is built from generated code (auto-generated token, not
    // comparable with source tokens); the dup/drop optimizer needs the real
    // source position of the ownership transfer to record an accurate
    // consumedAtToken (see begin.ts — using the end-of-scope token instead
    // made early returns AFTER the transfer re-drop the moved value).
    (
      evaluatedDupCallExpr as FnCallExpr & { __useSiteToken?: Token }
    ).__useSiteToken = expr.token;

    expr.$.deferredDupExpressions = [evaluatedDupCallExpr];
    expr.$.env = evaluatedDupCallExpr.$!.env;
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
    const errorMessage = `use of moved value: \`${nameOfVariableToConsume}\``;
    throw formatErrorMessages([
      {
        token: expr.token,
        errorMessage,
      },
      {
        token: variableToConsume.consumedAtToken,
        errorMessage: `value moved here`,
      },
    ]);
  }
  // }
}
