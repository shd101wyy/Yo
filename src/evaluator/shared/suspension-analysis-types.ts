/**
 * suspension-analysis-types.ts
 *
 * Shared base type definitions for suspension-point analysis.
 * Both async/await (AwaitPoint) and algebraic effects (EffectCallPoint) are
 * forms of suspension points. This file defines the shared shape so the
 * tree-walking analysis can be written once.
 *
 * This file should NOT import from expr.ts or other files that import from here.
 */

import type { Type } from "../../types/definitions";

/**
 * Base interface for any suspension point (an await or an effect call).
 * System-specific fields live in AwaitPoint / EffectCallPoint which extend this.
 */
export interface SuspensionPoint {
  /** 0-based index of this suspension point in the analysis result */
  index: number;

  /** The suspension expression (typed as unknown to avoid circular import with expr.ts) */
  expr: unknown;

  /** The variable that should receive the result of resuming (if assigned via :=) */
  targetVariableId?: string;

  /** Whether this suspension is inside a cond expression */
  isInsideCond?: boolean;

  /**
   * True when this suspension's value is the BODY'S OWN RESULT — the await is
   * the final expression of the async block (`io.async((e) => e.io.await(f, e))`).
   * It has no target variable, so the linear-await "result is unused, skip
   * storage" optimization must NOT apply: the resume stores into
   * `sm->await_result_N` and the completion segment assigns it to `sm->result`.
   * Set by splitIntoStateSegments (codegen), not by the analysis.
   */
  isBodyResult?: boolean;

  /** Whether this suspension is inside a while loop */
  isInsideWhile?: boolean;

  /** The number of nested while loops this suspension is inside */
  whileNestingDepth?: number;

  /**
   * For sequential suspensions within the same cond/match branch,
   * references the index of the first suspension in that cond/match.
   */
  condBranchSourceIndex?: number;

  /** Whether this suspension needs its own cond_branch_X field in the state machine struct */
  needsOwnCondBranchField?: boolean;

  /**
   * The enclosing while loop expression (typed as unknown to avoid circular import).
   * Used by effect codegen to generate while loop continuation logic.
   */
  enclosingWhileExpr?: unknown;
}

/**
 * Information about a local variable that needs to persist across suspension points.
 * This is the shared base — async adds a `kind` field via CapturedVariable.
 */
export interface SuspensionCapturedVariable {
  id: string;
  name: string;
  type: Type;
  isOwningTheSameRcValueAs: SuspensionCapturedVariable | undefined;
}

/**
 * Base analysis result generic over the suspension point type.
 */
export interface SuspensionAnalysisResult<P extends SuspensionPoint> {
  suspensionPoints: P[];
  capturedVariables: SuspensionCapturedVariable[];
  hasSuspensions: boolean;
  variableIdRemapping: Map<string, string>;
}
