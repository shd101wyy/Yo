/**
 * await-analysis-types.ts
 *
 * Type definitions for await analysis, separated to avoid circular dependencies.
 * This file should NOT import from expr.ts or other files that import from here.
 *
 * AwaitPoint extends the shared SuspensionPoint base with async-specific fields.
 */

import type { Type } from "../../types/definitions";
import type {
  SuspensionCapturedVariable,
  SuspensionPoint,
} from "../shared/suspension-analysis-types";

/**
 * Information about a single await expression found in an async function.
 * Extends SuspensionPoint with async-specific fields (futureType, etc.).
 */
export interface AwaitPoint extends SuspensionPoint {
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
   * The variable ID of the Future being awaited
   * This is used to reference the captured Future variable instead of creating a separate await_future_X field
   */
  futureVariableId?: string;
}

/**
 * Information about a local variable that needs to persist across await points.
 * Extends SuspensionCapturedVariable with a `kind` discriminator.
 */
export interface CapturedVariable extends SuspensionCapturedVariable {
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

  /**
   * Maps SSA-renamed variable IDs to their original/canonical IDs.
   * When a variable is reassigned inside an async block, the evaluator creates
   * a new SSA variable ID. This remapping allows the codegen to resolve all
   * versions of a variable to the same state machine struct field, which is
   * essential for loops where the condition and body must reference the same field.
   */
  variableIdRemapping: Map<string, string>;
}
