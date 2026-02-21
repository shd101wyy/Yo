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
   * The handler function value resolved from the given(...) variable at the call site.
   * Stored during specialization so the codegen can inline the handler body.
   * Typed as `unknown` to avoid circular imports with value types.
   */
  handlerValue?: unknown;
}
