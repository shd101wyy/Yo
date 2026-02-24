/**
 * effect-analysis-types.ts
 *
 * Type definitions for algebraic effect analysis.
 * Similar to await-analysis-types.ts but for ctl effect call points.
 *
 * This file should NOT import from expr.ts or other files that import from here.
 */

import type { Type } from "../../types/definitions";

/**
 * Information about a single ctl effect call point found in an effectful function.
 * Analogous to AwaitPoint for async/await.
 */
export interface EffectCallPoint {
  /**
   * The index of this effect call point (0-based)
   */
  index: number;

  /**
   * The ctl call expression itself (typed as unknown to avoid circular import)
   */
  expr: unknown;

  /**
   * The types of the arguments passed to the ctl operation (e.g., [String, String] for raise(msg, msg2))
   */
  operationArgTypes: Type[];

  /**
   * The return type of the ctl operation at the call site
   * (e.g., T which is i32 for raise : ctl(msg : String) -> T in safe_divide)
   */
  operationResultType: Type;

  /**
   * The variable that should receive the resumed value (if any)
   * This is the variable ID from the captured variables.
   */
  targetVariableId?: string;

  /**
   * Whether this effect call is inside a cond expression
   */
  isInsideCond?: boolean;

  /**
   * Whether this effect call is inside a while loop
   */
  isInsideWhile?: boolean;

  /**
   * The enclosing while loop expression (typed as unknown to avoid circular import).
   * Used by codegen to generate the while loop continuation logic in the SM.
   */
  enclosingWhileExpr?: unknown;

  /**
   * The number of nested while loops this effect call is inside.
   */
  whileNestingDepth?: number;

  /**
   * For sequential effect calls within the same cond/match branch,
   * this references the index of the first effect call point in that cond/match.
   */
  condBranchSourceIndex?: number;

  /**
   * Whether this effect call point needs its own cond_branch_X field
   * in the state machine struct.
   */
  needsOwnCondBranchField?: boolean;

  /**
   * Whether this is a transitive effect call — a call to a function that
   * itself has a matching `using` ctl parameter, rather than a direct call
   * to the ctl operation. The outer SM must re-yield when the inner SM yields.
   */
  isTransitiveEffectCall?: boolean;

  /**
   * Whether this transitive call is to a closure (Impl(Fn(...))) rather than
   * a regular function. Closure calls need special handling in the SM generation:
   * - closure_context must be set on the inner SM
   * - The inner SM info is looked up via implClosureCallMap
   */
  isTransitiveClosureCall?: boolean;

  /**
   * For multi-effect functions, identifies which effect this call point belongs to.
   * Index into the EffectAnalysisResult.effectHandlerInfos array.
   */
  effectIndex?: number;
}

/**
 * Information about a local variable that needs to persist across effect call points.
 *
 * Unlike async/await CapturedVariable, effect captured variables are always "local"
 * because effectful functions are regular functions (not closures). They don't capture
 * variables from an outer scope — function parameters are stored as separate fields in
 * the state machine struct.
 */
export interface EffectCapturedVariable {
  id: string;
  name: string;
  type: Type;
  isOwningTheSameRcValueAs: EffectCapturedVariable | undefined;
}

/**
 * Result of analyzing a function for ctl effect call points.
 * Analogous to AwaitAnalysisResult for async/await.
 */
export interface EffectAnalysisResult {
  /**
   * All effect call points found in the function, in order of appearance
   */
  effectCallPoints: EffectCallPoint[];

  /**
   * All local variables that need to be captured in the state machine
   */
  capturedVariables: EffectCapturedVariable[];

  /**
   * Whether this function contains any ctl effect calls
   */
  hasEffects: boolean;

  /**
   * Maps SSA-renamed variable IDs to their original/canonical IDs.
   */
  variableIdRemapping: Map<string, string>;

  /**
   * The name of the ctl parameter that is being called (e.g., "raise").
   * This is used to identify which implicit parameter provides the handler.
   */
  effectParameterName: string;

  /**
   * The type of the ctl parameter (the handler's full function type).
   */
  effectParameterType: Type;

  /**
   * For module-based effects, the path of field names from the module parameter
   * to the ctl field. Supports arbitrarily nested modules.
   * e.g., for `using(raise_mod : Raise)` where `Raise = module(raise : ctl(...))`,
   * effectParameterName is "raise_mod" and effectFieldPath is ["raise"].
   * For nested modules like `module(errors : module(raise : ctl(...)))`,
   * effectFieldPath would be ["errors", "raise"].
   */
  effectFieldPath?: string[];

  /**
   * The handler function value resolved from the given(...) variable at the call site.
   * Stored during specialization so the codegen can inline the handler body.
   * Typed as `unknown` to avoid circular imports with value types.
   */
  handlerValue?: unknown;

  /**
   * For multi-effect functions (multiple using(ctl) parameters), stores per-effect
   * handler info. Each entry corresponds to one ctl parameter.
   * When present, effectCallPoints have effectIndex pointing into this array.
   */
  effectHandlerInfos?: EffectHandlerInfo[];
}

/**
 * Per-effect handler information for multi-effect functions.
 */
export interface EffectHandlerInfo {
  effectParameterName: string;
  effectParameterType: Type;
  effectFieldPath?: string[];
  handlerValue?: unknown;
  operationArgTypes: Type[];
  operationResultType: Type;
}
