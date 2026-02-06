/**
 * await-analysis-types.ts
 *
 * Type definitions for await analysis, separated to avoid circular dependencies.
 * This file should NOT import from expr.ts or other files that import from here.
 */

import type { Type } from "../../types/definitions";

/**
 * Information about a single await expression found in an async function.
 */
export interface AwaitPoint {
  /**
   * The index of this await point (0-based)
   */
  index: number;

  /**
   * The await expression itself (typed as unknown to avoid circular import with expr.ts)
   */
  expr: unknown;

  /**
   * The type of the value being awaited (the T in Future(T))
   */
  resultType: Type;

  /**
   * The full Future type being awaited (Impl Future(T) or similar)
   * This is stored to help codegen determine the correct C type for await_future_X fields
   */
  futureType?: Type;

  /**
   * The variable that should receive the await result (if any)
   * This is the variable ID from the captured variables
   */
  targetVariableId?: string;

  /**
   * The variable ID of the Future being awaited
   * This is used to reference the captured Future variable instead of creating a separate await_future_X field
   */
  futureVariableId?: string;

  /**
   * Whether this await is inside a cond expression
   * If true, the state machine needs a cond_branch_X field to track which branch was taken
   */
  isInsideCond?: boolean;

  /**
   * Whether this await is inside a while loop
   * If true, the state machine needs a while_loop_X_active field to track loop state
   */
  isInsideWhile?: boolean;
}

/**
 * Information about a local variable that needs to persist across await points.
 */
export interface CapturedVariable {
  /**
   * The unique ID of the variable
   */
  id: string;

  /**
   * The name of the variable
   */
  name: string;

  /**
   * The type of the variable
   */
  type: Type;

  /**
   * The kind of variable being captured
   * - "local": A variable defined in the async function body (uses var_{id} field naming)
   * - "outer": A variable captured from outer scope (uses variable name as field name)
   */
  kind: "local" | "outer";

  /**
   * If this variable is borrowing an Rc value from another variable,
   * this field holds a reference to the owner variable.
   * This is used to resolve temporary variable names in deferred drops.
   */
  isOwningTheSameRcValueAs: CapturedVariable | undefined;
}

/**
 * Result of analyzing an async function for await points.
 */
export interface AwaitAnalysisResult {
  /**
   * All await points found in the function, in order of appearance
   */
  awaitPoints: AwaitPoint[];

  /**
   * All local variables that need to be captured in the state machine
   */
  capturedVariables: CapturedVariable[];

  /**
   * Whether this function contains any await expressions
   */
  hasAwaits: boolean;
}
