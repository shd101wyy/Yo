/**
 * state-machine.ts
 *
 * Generates C code for async function state machines.
 */

import { Emitter } from "../../emitter";
import { getVariablesFromEnv, getVariablesFromEnvByFilter } from "../../env";
import type {
  AwaitAnalysisResult,
  AwaitPoint,
  CapturedVariable,
} from "../../evaluator/async/await-analysis";
import {
  isIoAsyncCall,
  isIoAwaitCall,
} from "../../evaluator/async/await-analysis";
import {
  extractFutureTraitFromType,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import { TokenType } from "../../token";
import {
  BuiltinKeywords,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import {
  exprContainsAwait,
  exprContainsWhileWithAwait,
} from "../../expr-traversal";
import type {
  DynType,
  SourceNamespaceType,
  SomeType,
  StructType,
  Type,
} from "../../types/definitions";
import {
  isConcreteTraitType,
  isDynType,
  isFunctionType,
  isSourceNamespaceType,
  isSomeType,
  isStructType,
  isUnitType,
} from "../../types/guards";
import { typeContainsRcType } from "../../types/utils";
import { isTempVariableName } from "../../utils";
import { isFunctionValue, isStructValue } from "../../value";
import {
  emitAsyncFutureCompletion,
  emitAsyncFutureEscape,
} from "../exprs/async-completion";
import { findBundleFieldName } from "../exprs/async";
import { getDupFunctionForType } from "../exprs/drop-dup";
import { generateExpr } from "../exprs/expr";
import type {
  CondBranchPostWhileData,
  FunctionGenerationContext,
} from "../functions/context";
import { sanitizeForCIdentifier, quoteCString } from "../utils";
import { getTypeString } from "../utils/index";
import {
  awaitIsWhileCondition,
  generateAwaitExpression,
  generateStateSegmentCode,
  splitIntoStateSegments,
} from "./state-code-gen";

// ---------------------------------------------------------------------------
// Cross-boundary variable analysis
// ---------------------------------------------------------------------------

/**
 * Collects all variable IDs referenced in an expression tree.
 * Skips nested io.async() bodies (they have their own state machines).
 */
function collectVariableRefsInExpr(
  expr: Expr,
  refs: Set<string>,
  variableIdRemapping: Map<string, string>
): void {
  if (!expr) return;

  switch (expr.tag) {
    case ExprTag.Atom:
      if (expr.$ && expr.token.type === TokenType.Identifier) {
        const varName = expr.token.value;
        const variables = getVariablesFromEnv(expr.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          if (variable && !variable.isCompileTimeOnly) {
            // Resolve SSA remapping
            const canonicalId =
              variableIdRemapping.get(variable.id) ?? variable.id;
            // Also resolve owner for RC borrowing
            const ownerId = variable.isOwningTheSameRcValueAs
              ? variable.isOwningTheSameRcValueAs.id
              : canonicalId;
            refs.add(ownerId);
          }
        }
      }
      break;

    case ExprTag.FnCall:
      // Skip nested async block bodies
      if (isIoAsyncCall(expr)) {
        // Still walk deferred dup expressions (capture references)
        if (expr.$?.deferredDupExpressions) {
          for (const dupExpr of expr.$.deferredDupExpressions) {
            collectVariableRefsInExpr(dupExpr, refs, variableIdRemapping);
          }
        }
        break;
      }

      collectVariableRefsInExpr(expr.func, refs, variableIdRemapping);
      for (const arg of expr.args) {
        collectVariableRefsInExpr(arg, refs, variableIdRemapping);
      }

      // Also walk deferred drop/dup expressions
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          collectVariableRefsInExpr(dropExpr, refs, variableIdRemapping);
        }
      }
      if (expr.$?.deferredDupExpressions) {
        for (const dupExpr of expr.$.deferredDupExpressions) {
          collectVariableRefsInExpr(dupExpr, refs, variableIdRemapping);
        }
      }
      break;
  }
}

/**
 * Determines which captured local variables cross await boundaries
 * (i.e., are referenced in more than one state segment).
 *
 * Variables that are only used within a single segment can be emitted as
 * C local variables in that segment's case block, reducing the state machine
 * struct size. This is the Yo equivalent of Rust's liveness-based generator
 * optimization.
 *
 * Returns a CrossBoundaryResult with the set of variable IDs that MUST be
 * stored in the struct (cross at least one await boundary), plus any temp
 * future variable aliases for Phase 1b deduplication.
 */
/**
 * Result of cross-boundary variable analysis.
 */
export interface CrossBoundaryResult {
  /** Variable IDs that must be stored as struct fields (cross await boundaries) */
  crossBoundaryIds: Set<string>;
  /**
   * Maps temp variable IDs to their corresponding await_future_N field name.
   * These temp vars hold the same future pointer as await_future_N but are
   * never written to in the SM struct — they exist only because the suspension
   * analysis captures them. The alias allows deferred drops to reference the
   * await_future field instead of a non-existent struct field.
   */
  awaitFutureTempVarAliases: Map<string, string>;
  /**
   * Phase 2: Maps each captured variable ID to the set of segment indices
   * where it is referenced. Used by overlapping storage analysis to determine
   * live ranges and compute slot assignments.
   */
  variableSegments: Map<string, Set<number>>;
}

export function computeCrossBoundaryVariables(
  bodyExpr: Expr,
  analysis: AwaitAnalysisResult
): CrossBoundaryResult {
  const { awaitPoints, capturedVariables, variableIdRemapping } = analysis;

  // If no await points, no variables cross boundaries
  if (awaitPoints.length === 0) {
    return {
      crossBoundaryIds: new Set(),
      awaitFutureTempVarAliases: new Map(),
      variableSegments: new Map(),
    };
  }

  // Identify which segments have branching await points (cond/while with await).
  // Variables found only in a branching segment must stay in the struct because
  // the cond/while continuation runs in a separate case block.
  const branchingAwaitSegmentIndices = new Set<number>();

  // Split body into segments (same function used by the resume code generator)
  const segments = splitIntoStateSegments(bodyExpr, awaitPoints);

  // Build the set of segment indices that have branching await points.
  // Variables that appear ONLY in such a segment must stay in the struct because
  // the cond/while continuation code runs in a separate case block (not in the
  // segment's case block), so C locals would be lost across the state transition.
  for (const segment of segments) {
    if (segment.awaitPoint?.isInsideCond || segment.awaitPoint?.isInsideWhile) {
      branchingAwaitSegmentIndices.add(segment.stateNumber);
    }
  }

  // For each segment, collect all variable IDs referenced in its expressions
  const variableSegments = new Map<string, Set<number>>();
  for (const segment of segments) {
    const refs = new Set<string>();
    for (const expr of segment.expressions) {
      collectVariableRefsInExpr(expr, refs, variableIdRemapping);
    }
    for (const varId of refs) {
      let varSegs = variableSegments.get(varId);
      if (!varSegs) {
        varSegs = new Set();
        variableSegments.set(varId, varSegs);
      }
      varSegs.add(segment.stateNumber);
    }
  }

  // Also walk the body-level deferred drop expressions — these run at the end
  // of the entire async block and reference variables that must be in the struct.
  const CLEANUP_SEGMENT = -1;
  if (bodyExpr.$?.deferredDropExpressions) {
    const bodyDropRefs = new Set<string>();
    for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
      collectVariableRefsInExpr(dropExpr, bodyDropRefs, variableIdRemapping);
    }
    for (const varId of bodyDropRefs) {
      let varSegs = variableSegments.get(varId);
      if (!varSegs) {
        varSegs = new Set();
        variableSegments.set(varId, varSegs);
      }
      varSegs.add(CLEANUP_SEGMENT);
    }
  }

  // A variable crosses a boundary if it appears in more than one segment.
  // CONSERVATIVE: If a variable is captured by the suspension analysis but our
  // walker didn't find it in any segment, keep it in the struct. This handles
  // temp variables referenced in deferred drop expressions that may not have
  // proper environment metadata in the expression tree.
  // Also: variables that ONLY appear in the cleanup segment (-1) must be in the
  // struct because cleanup code runs in the last segment and accesses sm->var_X.
  // Also: variables that appear in exactly 1 segment but that segment has a
  // branching await (cond/while) must stay in struct because the continuation
  // code runs in a separate case block.
  const crossBoundaryIds = new Set<string>();
  for (const v of capturedVariables) {
    if (v.kind === "outer") continue; // Outer vars are in __capture struct
    const segmentsUsed = variableSegments.get(v.id);
    if (!segmentsUsed) {
      // Not found in any segment — keep in struct (conservative)
      crossBoundaryIds.add(v.id);
    } else if (segmentsUsed.size > 1) {
      // Appears in multiple segments — cross-boundary
      crossBoundaryIds.add(v.id);
    } else if (segmentsUsed.has(CLEANUP_SEGMENT)) {
      // Only appears in cleanup segment — must be in struct
      crossBoundaryIds.add(v.id);
    } else {
      // Appears in exactly 1 numbered segment — check if that segment has a
      // branching await. If so, must stay in struct because the cond/while
      // continuation runs in a separate case block.
      const singleSegment = segmentsUsed.values().next().value as number;
      if (branchingAwaitSegmentIndices.has(singleSegment)) {
        crossBoundaryIds.add(v.id);
      }
      // else: segment-local in a non-branching segment — can be C local
    }
  }

  // Phase 1b: Identify temp variables that hold futures already stored in await_future_N.
  // For io.await(expr()) where expr() creates a temp variable, the suspension analysis
  // captures the temp var, but the codegen assigns the future to await_future_N.
  // The temp var struct field is never assigned (always NULL) — its deferred drops are no-ops.
  // We alias these temp vars to await_future_N so atom.ts redirects references
  // to the existing field, eliminating the redundant struct field.
  const awaitFutureTempVarAliases = new Map<string, string>();
  for (const ap of awaitPoints) {
    if (ap.futureVariableId !== undefined) continue; // Named variable — already aliased
    const awaitExpr = ap.expr as Expr;
    if (!exprIsFunctionCall(awaitExpr)) continue;
    const futureArg = awaitExpr.args[0];
    if (!futureArg) continue;
    const tempVarName = futureArg.$?.variableName;
    if (!tempVarName) continue;

    // Find the captured variable matching this temp var name.
    //
    // Match on the TYPE too, not just the name: an inline `io.async(...)`
    // produces two temps that can share the generated name — the closure's
    // CAPTURE STRUCT and the future itself. Only the future is stored in
    // await_future_N. Aliasing the capture struct instead made its deferred
    // drop run against that field, emitting a drop of a struct BY VALUE applied
    // to a state machine POINTER:
    //
    //   fn_..._id_40___drop((__yo_struct_..._id_28)(sm->await_future_1));
    //
    // which is not legal C. It showed up with two inline async closures over
    // the same local in one state machine.
    const capturedVar = capturedVariables.find(
      (v) =>
        v.kind === "local" &&
        (v.name === tempVarName || v.id === tempVarName) &&
        typeImplementsFuture(v.type)
    );
    if (capturedVar) {
      awaitFutureTempVarAliases.set(capturedVar.id, `await_future_${ap.index}`);
      // Remove from crossBoundaryIds if it was added
      crossBoundaryIds.delete(capturedVar.id);
    }
  }

  return { crossBoundaryIds, awaitFutureTempVarAliases, variableSegments };
}

/**
 * Information about an overlapping storage slot.
 * Multiple non-RC value-type variables with non-overlapping live ranges
 * can share a single struct field.
 */
export interface OverlappingSlot {
  /** The struct field name, e.g., "slot_0" */
  fieldName: string;
  /** The C type string for this slot */
  cType: string;
  /** Variable names sharing this slot (for comments) */
  variableNames: string[];
}

/**
 * Result of overlapping storage analysis (Phase 2).
 */
export interface OverlappingStorageResult {
  /** Maps variable IDs to their aliased slot field name */
  slotAliases: Map<string, string>;
  /** Slot field definitions for the struct */
  slots: OverlappingSlot[];
}

/**
 * Phase 2: Compute overlapping storage slots for cross-boundary variables.
 *
 * Variables of the same C type whose live ranges don't overlap can share
 * a single struct field. This uses greedy graph coloring per type group.
 *
 * Only non-RC value types are eligible — RC types have lifetimes extending
 * to function return (via deferred drops), making overlap rare and requiring
 * state-aware drop logic in the dispose function.
 */
export function computeOverlappingSlots(
  crossBoundaryIds: Set<string>,
  variableSegments: Map<string, Set<number>>,
  capturedVariables: CapturedVariable[],
  awaitFutureTempVarAliases: Map<string, string>,
  context: FunctionGenerationContext
): OverlappingStorageResult {
  const emptyResult: OverlappingStorageResult = {
    slotAliases: new Map(),
    slots: [],
  };

  // Filter to non-RC value types that are cross-boundary local variables
  const eligible = capturedVariables.filter(
    (v) =>
      v.kind === "local" &&
      crossBoundaryIds.has(v.id) &&
      !awaitFutureTempVarAliases.has(v.id) &&
      !typeContainsRcType(v.type)
  );

  if (eligible.length < 2) return emptyResult;

  // Build live ranges [min_segment, max_segment] for each eligible variable.
  // Exclude cleanup segment (-1) — non-RC types don't have deferred drops.
  const ranges = new Map<string, [number, number]>();
  for (const v of eligible) {
    const segs = variableSegments.get(v.id);
    if (!segs || segs.size === 0) continue;
    const numberedSegs = [...segs].filter((s) => s >= 0);
    if (numberedSegs.length === 0) continue;
    const min = Math.min(...numberedSegs);
    const max = Math.max(...numberedSegs);
    ranges.set(v.id, [min, max]);
  }

  if (ranges.size < 2) return emptyResult;

  // Group by C type — only same-type variables can share a slot
  const byType = new Map<string, string[]>();
  for (const [varId] of ranges) {
    const v = eligible.find((e) => e.id === varId);
    if (!v) continue;
    const cType = getTypeString(v.type, context);
    let group = byType.get(cType);
    if (!group) {
      group = [];
      byType.set(cType, group);
    }
    group.push(varId);
  }

  // For each type group with 2+ members, build interference graph and color
  const slotAliases = new Map<string, string>();
  const slots: OverlappingSlot[] = [];
  let nextSlotIndex = 0;

  for (const [cType, varIds] of byType) {
    if (varIds.length < 2) continue;

    // Build interference: two vars conflict if their ranges overlap
    const conflicts = new Map<string, Set<string>>();
    for (const id of varIds) conflicts.set(id, new Set());

    for (let i = 0; i < varIds.length; i++) {
      for (let j = i + 1; j < varIds.length; j++) {
        const [minA, maxA] = ranges.get(varIds[i]!)!;
        const [minB, maxB] = ranges.get(varIds[j]!)!;
        if (minA <= maxB && minB <= maxA) {
          conflicts.get(varIds[i]!)!.add(varIds[j]!);
          conflicts.get(varIds[j]!)!.add(varIds[i]!);
        }
      }
    }

    // Greedy graph coloring
    const colors = new Map<string, number>();
    for (const varId of varIds) {
      const usedColors = new Set<number>();
      for (const conflictId of conflicts.get(varId)!) {
        if (colors.has(conflictId)) {
          usedColors.add(colors.get(conflictId)!);
        }
      }
      let color = 0;
      while (usedColors.has(color)) color++;
      colors.set(varId, color);
    }

    // Group variables by color to find which ones actually share
    const colorToVars = new Map<number, string[]>();
    for (const [varId, color] of colors) {
      let group = colorToVars.get(color);
      if (!group) {
        group = [];
        colorToVars.set(color, group);
      }
      group.push(varId);
    }

    // Only create slot aliases for colors with 2+ variables (actual sharing)
    for (const [, groupVarIds] of colorToVars) {
      if (groupVarIds.length < 2) continue;
      const fieldName = `slot_${nextSlotIndex}`;
      const varNames = groupVarIds.map(
        (id) => eligible.find((v) => v.id === id)?.name ?? id
      );
      for (const varId of groupVarIds) {
        slotAliases.set(varId, fieldName);
      }
      slots.push({ fieldName, cType, variableNames: varNames });
      nextSlotIndex++;
    }
  }

  return { slotAliases, slots };
}

/**
 * Get the state machine field name for the Future being awaited.
 * Uses the captured Future variable instead of a separate await_future_X field.
 */
export function getFutureFieldName(
  awaitPoint: AwaitPoint,
  analysis: AwaitAnalysisResult
): string {
  if (awaitPoint.futureVariableId) {
    // Find the captured variable
    const capturedVar = analysis.capturedVariables.find(
      (v) => v.id === awaitPoint.futureVariableId
    );
    if (capturedVar) {
      // Use the captured variable's field name
      const fieldName =
        capturedVar.kind === "outer"
          ? capturedVar.name
          : `var_${capturedVar.id}`;
      return fieldName;
    }
  }

  // Fallback: If we can't find the variable (e.g., it's a pattern-bound variable from match),
  // use a dedicated await_future_{index} field
  return `await_future_${awaitPoint.index}`;
}

/**
 * Check if a future type is an Io future (__yo_io_future_t) rather than a state
 * machine future (from io.async). Io futures have a Concrete(...) trait and are
 * already submitted to io_uring at creation — they don't have __yo_resume_fn
 * and should not be "cold-started".
 *
 * Detection: Io futures (from Impl(Concrete(__yo_io_future_t), Future(i32)))
 * have their resolvedConcreteType set to an extern SomeType (the Concrete type).
 * State machine futures may also have resolvedConcreteType as a SomeType, but
 * it won't be extern.
 */
export function isIoFutureType(type: Type | undefined): boolean {
  if (!type || !isSomeType(type)) return false;
  // Check if the concrete type resolution came from a Concrete(...) trait
  // pointing to an extern C type like __yo_io_future_t. State machine futures
  // also have resolvedConcreteType set (from return-type resolution), but
  // their resolved type is never an extern type.
  if (
    type.resolvedConcreteType &&
    isSomeType(type.resolvedConcreteType) &&
    type.resolvedConcreteType.isExtern
  ) {
    return true;
  }
  // Also check requiredTraits directly (in case resolution hasn't stripped them)
  return type.requiredTraits.some((t) => isConcreteTraitType(t.traitType));
}

/**
 * Information about a generated state machine.
 */
export interface StateMachineInfo {
  /**
   * The C struct name for this state machine
   */
  structName: string;

  /**
   * The C function name for the resume function
   */
  resumeFunctionName: string;

  /**
   * Analysis result containing await points and captured variables
   */
  analysis: AwaitAnalysisResult;
}

/**
 * Generates the forward declaration for the resume function.
 */
export function generateResumeFunctionDeclaration(
  info: StateMachineInfo,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  emitter.emitDeclarationLine(
    `void ${info.resumeFunctionName}(${info.structName}* sm);`
  );
}

/**
 * Gets the C field name for a captured variable in a state machine struct.
 * This ensures consistent naming across struct definition and usage.
 */
export function getStateMachineFieldName(
  variableId: string,
  kind?: "outer" | "local",
  aliases?: Map<string, string>
): string {
  if (kind === "outer") {
    // Outer captured variables are accessed through __capture struct
    return `__capture.${sanitizeForCIdentifier(variableId)}`;
  }
  // Check aliases (Phase 1b temp future aliasing, Phase 2 overlapping slots)
  const alias = aliases?.get(variableId);
  if (alias) {
    return alias;
  }
  // Local variables use var_{id} naming
  return sanitizeForCIdentifier(`var_${variableId}`);
}

/**
 * Merges a new client's post-loop code into a while loop's single
 * condBranchPostWhileExprs slot. The slot has TWO legitimate clients — an
 * inner cond layer (routed by generateCondWithAwait) and the enclosing arm's
 * remaining code (routed by the chained-branch handler). Overwriting loses
 * the earlier layer; declining re-emits the later one at the TOP of the
 * loop's resume state, i.e. once per ITERATION — the enclosing arm's
 * scope-end drops then free a once-per-outer-iteration value on every inner
 * iteration (double-free). Merge instead: ONE expression sequence, existing
 * (inner) layer first, then the incoming (enclosing) layer — the consumer's
 * single pass splits at whichever await comes first in the merged sequence,
 * which is the correct split point. Drops merge the same way. The
 * sm->cond_branch_N guard can only test one field, so when the layers
 * disagree fall back to skipCondBranchCheck (sound: after_while_loop_N is
 * only reachable from the branch that ran the loop).
 */
export function mergeCondBranchPostWhileExprs(
  existing: CondBranchPostWhileData | undefined,
  incoming: CondBranchPostWhileData
): CondBranchPostWhileData {
  if (!existing) {
    return incoming;
  }
  const guardsDisagree =
    existing.branchIndex !== incoming.branchIndex ||
    existing.condBranchFieldIndex !== incoming.condBranchFieldIndex;
  const mergedDrops = [
    ...(existing.deferredDropExpressions ?? []),
    ...(incoming.deferredDropExpressions ?? []),
  ];
  return {
    branchIndex: existing.branchIndex,
    condBranchFieldIndex: existing.condBranchFieldIndex,
    exprs: [...existing.exprs, ...incoming.exprs],
    deferredDropExpressions: mergedDrops.length > 0 ? mergedDrops : undefined,
    skipCondBranchCheck:
      (existing.skipCondBranchCheck ?? false) ||
      (incoming.skipCondBranchCheck ?? false) ||
      guardsDisagree,
  };
}

/**
 * Generates the resume function implementation for an async block state machine.
 * This is the canonical implementation used for all async code (functions are just syntax sugar).
 */
export function generateAsyncBlockResumeFunction(
  bodyExpr: Expr,
  asyncBlockId: string,
  structName: string,
  resumeFunctionName: string,
  analysis: AwaitAnalysisResult,
  futureType: SomeType | DynType,
  captureType: StructType | undefined,
  context: FunctionGenerationContext,
  /**
   * Variable IDs that actually got a struct field. An await's target variable
   * is NOT among them when nothing ever reads it — the value never crosses a
   * state boundary, so no field is emitted for it. The extraction below has to
   * know that, or it writes to a member that does not exist.
   */
  crossBoundaryIds?: Set<string>
): string[] {
  const emitter = context.emitter;

  const futureTraitType = extractFutureTraitFromType(futureType)!;
  const childType = futureTraitType.isFuture.outputType;
  const isUnitResult = isUnitType(childType);

  // Clear asyncCondBranchInfo and asyncWhileLoopInfo for this async block to prevent
  // data from other async blocks (or outer scopes) from leaking in.
  // Each async block should only see its own branch/loop information.
  context.asyncCondBranchInfo = new Map();
  context.asyncWhileLoopInfo = new Map();

  // Initialize the while loop index counter for allocating unique indices
  // to outer while loops in nested while-with-await scenarios.
  // Indices 0..awaitPoints.length-1 are reserved for innermost while loops
  // (matching their await point indices). Outer while loops get indices starting
  // from awaitPoints.length.
  context.asyncNextWhileLoopIndex = analysis.awaitPoints.length;

  // Split the body into state segments
  const segments = splitIntoStateSegments(bodyExpr, analysis.awaitPoints);

  // Determine the body's last expression for async implicit return detection.
  // When a cond-with-await IS the body's last expression, non-await branches
  // should complete the Future immediately (they won't reach later segments).
  const bodyExprs =
    bodyExpr.tag === ExprTag.FnCall && exprIsFunctionCallOf(bodyExpr, "begin")
      ? bodyExpr.args
      : [bodyExpr];
  const bodyLastExpr =
    bodyExprs.length > 0 ? bodyExprs[bodyExprs.length - 1] : undefined;

  emitter.emitLine(`// Resume function for async block ${asyncBlockId}`);
  emitter.emitLine(`void ${resumeFunctionName}(${structName}* sm) {`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${asyncBlockId}_resume: state=%d\\n", sm->state);`
  );
  emitter.emitLine(
    `  int __yo_inline_budget = 32;  // bounded inline fast-path for sync-completed awaits`
  );
  emitter.emitLine(`  switch (sm->state) {`);

  // Generate code for each state segment
  const localVarDropCodes: string[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (!segment) continue;

    const stateNumber = segment.stateNumber;
    const isLastSegment = segmentIndex === segments.length - 1;

    // State case label
    emitter.emitLine(`
    state_${stateNumber}:`);

    emitter.emitLine(`    case ${stateNumber}: { // State ${stateNumber}`);
    emitter.emitLine(
      `      ASYNC_DEBUG("${asyncBlockId}: Entering state ${stateNumber}\\n");`
    );

    // If this is not the first state, extract the result from the previous await
    if (stateNumber > 0 && analysis.awaitPoints[stateNumber - 1]) {
      const prevAwait = analysis.awaitPoints[stateNumber - 1]!;
      const prevFutureFieldName = getFutureFieldName(prevAwait, analysis);

      // When previous await was inside a cond, the future may be NULL
      // (non-await branch was taken). Guard all result extraction and cond handling.
      if (prevAwait.isInsideCond) {
        emitter.emitLine(`      if (sm->${prevFutureFieldName} != NULL) {`);
      }

      // When the output type is an unresolved SomeType (e.g., generic(T) from
      // io.await evaluated with io=UnknownValue), treat it as unit.
      const isPrevAwaitResultUnit =
        isUnitType(prevAwait.resultType) ||
        (isSomeType(prevAwait.resultType) &&
          !(prevAwait.resultType as SomeType).resolvedConcreteType);

      // Always check if the awaited Future was aborted by an effect handler
      emitter.emitLine(`      // Check if the awaited Future was aborted`);
      emitter.emitLine(`      if (sm->${prevFutureFieldName}->state == -2) {`);
      // Drop the child future reference before propagating escape
      emitter.emitLine(
        `        __yo_decr_rc((void*)sm->${prevFutureFieldName});`
      );
      emitter.emitLine(`        sm->${prevFutureFieldName} = NULL;`);
      // Propagate the escape: mark this SM as escaped too
      emitAsyncFutureEscape({
        emitter,
        indent: "        ",
        debugLabel: asyncBlockId,
      });
      emitter.emitLine(`      }`);

      if (prevAwait && !isPrevAwaitResultUnit) {
        emitter.emitLine(
          `      // Extract result from await ${stateNumber - 1}`
        );
        emitter.emitLine(
          `      int state_before_read = sm->${prevFutureFieldName}->state;`
        );
        emitter.emitLine(
          `      ASYNC_DEBUG("${asyncBlockId}: Reading result from await ${stateNumber - 1}, state=%d\\n", state_before_read);`
        );

        // Phase 3 optimization: for linear (non-cond) awaits, skip the
        // intermediate await_result_N field and assign directly to the
        // target variable or skip entirely if result is unused.
        // A `while` whose CONDITION awaits reads `sm->await_result_N` to decide
        // whether to run another iteration, so it needs the field too — it has
        // no target variable to write the result into.
        const useAwaitResultField =
          !!prevAwait.isInsideCond ||
          awaitIsWhileCondition(prevAwait) ||
          // The body's own result (a standalone tail await): the completion
          // segment reads sm->await_result_N — see splitIntoStateSegments.
          !!prevAwait.isBodyResult;

        // Determine the assignment target:
        // - Linear await with target variable: write directly to sm->var_X
        // - Linear await without target: result is unused, skip storage
        // - Cond await: write to sm->await_result_N (used by branch continuations)
        let resultTarget: string | undefined;
        if (useAwaitResultField) {
          resultTarget = `sm->await_result_${stateNumber - 1}`;
        } else if (
          prevAwait.targetVariableId &&
          awaitTargetHasStructField(
            prevAwait.targetVariableId,
            crossBoundaryIds,
            context
          )
        ) {
          const fieldName = getStateMachineFieldName(
            prevAwait.targetVariableId,
            "local",
            context.stateMachineFieldAliases
          );
          resultTarget = `sm->${fieldName}`;
        }
        // else: result is unused — no need to store it at all

        if (resultTarget) {
          // If the result contains Rc-managed data, we need to dup it before copying
          // because the Future's dispose function will drop it, and we need our own reference
          if (typeContainsRcType(prevAwait.resultType)) {
            const dupFunctionName = getDupFunctionForType(
              prevAwait.resultType,
              context
            );
            if (dupFunctionName) {
              emitter.emitLine(
                `      ${resultTarget} = ${dupFunctionName}(sm->${prevFutureFieldName}->result);`
              );
            } else {
              emitter.emitLine(
                `      /* Warning: No ___dup function found for result type, shallow copy may cause use-after-free */`
              );
              emitter.emitLine(
                `      ${resultTarget} = sm->${prevFutureFieldName}->result;`
              );
            }
          } else {
            // For non-Rc types (primitives), simple copy is fine
            emitter.emitLine(
              `      ${resultTarget} = sm->${prevFutureFieldName}->result;`
            );
          }
        }

        // For cond awaits, also copy from await_result to the target variable
        if (useAwaitResultField && prevAwait.targetVariableId) {
          const fieldName = getStateMachineFieldName(
            prevAwait.targetVariableId,
            "local",
            context.stateMachineFieldAliases
          );
          emitter.emitLine(
            `      sm->${fieldName} = sm->await_result_${stateNumber - 1};`
          );
        }

        emitter.emitLine(``);
      }

      // If the awaited Future was a temporary stored in await_future_X, drop it now.
      // (Captured Future variables may outlive the await and are handled by normal drops.)
      // Since Futures are ref-counted, we use __yo_decr_rc instead of direct dispose.
      if (!prevAwait.futureVariableId) {
        const awaitExpr = prevAwait.expr as Expr;
        if (awaitExpr.tag === ExprTag.FnCall) {
          const futureArg = awaitExpr.args[0];
          const argFutureType = futureArg?.$?.type;
          if (
            argFutureType &&
            (isSomeType(argFutureType) || isDynType(argFutureType))
          ) {
            emitter.emitLine(
              `      if (sm->${prevFutureFieldName} != NULL) { __yo_decr_rc((void*)sm->${prevFutureFieldName}); sm->${prevFutureFieldName} = NULL; }`
            );
            emitter.emitLine(``);
          }
        }
      }

      // Check if this await was part of a cond expression
      // If so, we need to execute the remaining code from the chosen branch
      const functionContext = context as FunctionGenerationContext;
      if (prevAwait) {
        const condBranchData = functionContext.asyncCondBranchInfo?.get(
          prevAwait.index
        );
        if (condBranchData && condBranchData.branches.some((b) => b.hasAwait)) {
          // Use condBranchFieldIndex if set (for continuation states), otherwise use prevAwait.index
          const condBranchFieldIndex =
            condBranchData.condBranchFieldIndex ?? prevAwait.index;
          // condBranchFieldIndex === -1 means "unconditional" — nested cond
          // conflict where sm->cond_branch_N was overwritten by an inner cond.
          const skipCondBranchSwitch = condBranchFieldIndex === -1;
          emitter.emitLine(
            `      // Execute remaining code from chosen cond branch`
          );
          if (!skipCondBranchSwitch) {
            emitter.emitLine(
              `      switch (sm->cond_branch_${condBranchFieldIndex}) {`
            );
          }

          // Check if the current segment has an additional cond await point
          const hasAdditionalCondAwait =
            segment.awaitPoint?.isInsideCond ?? false;

          for (const branch of condBranchData.branches) {
            if (branch.hasAwait) {
              if (!skipCondBranchSwitch) {
                emitter.emitLine(`        case ${branch.index}: {`);
              }
              emitter.emitLine(
                `          ASYNC_DEBUG("${asyncBlockId}: Executing remaining code from branch ${branch.index}\\n");`
              );

              // Bind THIS branch's own await result. Several arms share one
              // await point (only one arm runs, so one suspension state
              // suffices), so the single pre-switch copy driven by
              // `prevAwait.targetVariableId` can only name one arm's binding —
              // every other arm read a zero-initialised field and the program
              // silently produced `false`/`0`. Skip the arm that the pre-switch
              // copy already covers, so it is not written twice.
              if (
                branch.awaitTargetVariableId &&
                branch.awaitTargetVariableId !== prevAwait.targetVariableId
              ) {
                // Only when the binding really is THIS await point's result. An
                // arm may contain a second await that suspends into a LATER
                // state; its binding is that state's business and has a
                // different type, so copying `await_result_N` into it emits an
                // invalid C assignment. Types agreeing is the check that tells
                // the two apart.
                const branchTargetVar = context.stateMachineVariables?.get(
                  branch.awaitTargetVariableId
                );
                const sameResultType =
                  branchTargetVar?.type !== undefined &&
                  getTypeString(branchTargetVar.type, context) ===
                    getTypeString(prevAwait.resultType, context);
                // …and the binding must really live in the state struct. A
                // segment-local that the SM optimization kept out of it has no
                // field to write ("no member named 'var_N' in struct").
                if (
                  sameResultType &&
                  awaitTargetHasStructField(
                    branch.awaitTargetVariableId,
                    crossBoundaryIds,
                    context
                  )
                ) {
                  const branchTargetField = getStateMachineFieldName(
                    branch.awaitTargetVariableId,
                    "local",
                    context.stateMachineFieldAliases
                  );
                  emitter.emitLine(
                    `          sm->${branchTargetField} = sm->await_result_${prevAwait.index};`
                  );
                }
              }

              // If there are remaining expressions, generate them
              if (branch.remainingExprs && branch.remainingExprs.length > 0) {
                // Set up state machine context for code generation
                const previousInStateMachineForBranch =
                  context.inAsyncStateMachine;
                const previousStateMachineVariablesForBranch =
                  context.stateMachineVariables;
                const previousVariableIdRemappingForBranch =
                  context.variableIdRemapping;
                const previousPendingDeferredDropsForBranch =
                  context.pendingDeferredDrops;

                context.inAsyncStateMachine = { futureType };
                context.variableIdRemapping = analysis.variableIdRemapping;
                // Set pending deferred drops so early returns in cond branches
                // can drop async block local variables.
                // Also include while loop body drops and cond branch drops when applicable.
                const whileLoopDataForDrops =
                  functionContext.asyncWhileLoopInfo?.get(prevAwait.index);
                context.pendingDeferredDrops = [
                  ...(branch.deferredDropExpressions ?? []),
                  ...(whileLoopDataForDrops?.bodyExpr.$
                    ?.deferredDropExpressions ?? []),
                  ...(bodyExpr.$?.deferredDropExpressions ?? []),
                ];
                // Combine outer captured variables and local variables
                const combinedVariables = new Map<string, CapturedVariable>();
                for (const v of analysis.capturedVariables) {
                  combinedVariables.set(v.id, v);
                }
                if (captureType) {
                  for (const field of captureType.fields) {
                    combinedVariables.set(field.label, {
                      id: field.label,
                      name: field.label,
                      type: field.type,
                      kind: "outer",
                      isOwningTheSameRcValueAs: undefined, // FIXME
                    });
                  }
                }
                context.stateMachineVariables = combinedVariables;

                // Generate remaining expressions, detecting additional awaits
                let foundAdditionalAwait = false;
                // The expression that carried the additional await. When it is
                // a suspending while loop, everything after it must run once
                // the loop EXITS, not on each of its resumes.
                let additionalAwaitExpr: Expr | undefined;
                const additionalRemainingExprs: Expr[] = [];

                // Determine assignment target for the last remaining expression
                // (used by match/cond with await where branch result != await result)
                const branchTargetAssignmentCode =
                  condBranchData.targetAssignmentCode;

                for (
                  let exprIdx = 0;
                  exprIdx < branch.remainingExprs.length;
                  exprIdx++
                ) {
                  const expr = branch.remainingExprs[exprIdx]!;
                  const isLastExpr =
                    exprIdx === branch.remainingExprs.length - 1;

                  if (foundAdditionalAwait) {
                    additionalRemainingExprs.push(expr);
                    continue;
                  }

                  // Check if this expression contains an additional await
                  if (hasAdditionalCondAwait && exprContainsAwait(expr)) {
                    foundAdditionalAwait = true;
                    additionalAwaitExpr = expr;
                    // Store the future for the next await point
                    generateRemainingExprFuture(
                      expr,
                      segment.awaitPoint!,
                      analysis,
                      "          ",
                      context
                    );
                    continue;
                  }

                  // Normal expression
                  const code = generateExpr(expr, "          ", context);
                  // The branch VALUE is usually materialized into a codegen
                  // temp, and generateExpr returns that temp's NAME — so the
                  // target assignment must win over the temp-reference skip,
                  // or the arm's value is computed and then discarded (the
                  // zeroed sm->result / target silently decoded as .None).
                  if (!code || !expr.$) {
                    // Skip
                  } else if (isLastExpr && branchTargetAssignmentCode) {
                    emitter.emitLine(
                      `          ${branchTargetAssignmentCode} = ${code};`
                    );
                  } else if (isTempVariableName(expr.$.env.modulePath, code)) {
                    // Skip bare temp references in statement position
                  } else {
                    emitter.emitLine(`          ${code};`);
                  }
                }

                // If this branch has no remaining expressions and there's a target,
                // assign from await_result (the await result IS the branch value)
                if (
                  branch.remainingExprs.length === 0 &&
                  branchTargetAssignmentCode
                ) {
                  emitter.emitLine(
                    `          ${branchTargetAssignmentCode} = sm->await_result_${prevAwait.index};`
                  );
                }

                if (foundAdditionalAwait && segment.awaitPoint) {
                  // Store continuation info for the next state
                  const nextIndex = segment.awaitPoint.index;
                  // A nested-branch await inside a while body must CARRY the
                  // while-loop chain: without this the final chained state has
                  // no whileLoopInfo entry, emits no loop-back, and completes
                  // the future after ONE iteration (the loop's own state
                  // looped back before the nested await ran, saw the stale
                  // condition, and exited — silently). See
                  // issues/async-while-nested-branch-await-exits-loop.md.
                  const enclosingWhile =
                    functionContext.asyncWhileLoopInfo?.get(prevAwait.index);
                  const existingNextWhile =
                    functionContext.asyncWhileLoopInfo?.get(nextIndex);
                  if (enclosingWhile && !existingNextWhile) {
                    functionContext.asyncWhileLoopInfo!.set(nextIndex, {
                      ...enclosingWhile,
                      whileLoopOriginIndex:
                        enclosingWhile.whileLoopOriginIndex ?? prevAwait.index,
                      isChainedAwait: true,
                    });
                  } else if (
                    enclosingWhile &&
                    existingNextWhile &&
                    !existingNextWhile.outerWhileLoop &&
                    (existingNextWhile.whileLoopOriginIndex ?? nextIndex) !==
                      (enclosingWhile.whileLoopOriginIndex ?? prevAwait.index)
                  ) {
                    // The slot is already claimed by a DIFFERENT loop: a nested
                    // while-with-await in this branch stored its own entry under
                    // the same await index. Overwriting it would lose the inner
                    // loop; skipping (what we used to do) loses US — the outer
                    // loop then gets no loop-back and no exit label, so its body
                    // runs once and the `goto after_while_loop_N` emitted by the
                    // transition code names a label nobody defines.
                    //
                    // Record this loop as the inner one's ENCLOSING loop instead.
                    // The state that finishes the inner loop then emits our
                    // remaining body, loop-back and exit label right after
                    // `after_while_loop_<inner>` — which is also the correct
                    // order, since our post-await body follows the nested loop.
                    existingNextWhile.outerWhileLoop = {
                      whileLoopIndex:
                        enclosingWhile.whileLoopOriginIndex ?? prevAwait.index,
                      conditionExpr: enclosingWhile.conditionExpr,
                      stepExpr: enclosingWhile.stepExpr,
                      bodyExpr: enclosingWhile.bodyExpr,
                      bodyExprsAfterAwait:
                        enclosingWhile.bodyExprsAfterAwait ?? [],
                    };
                    enclosingWhile.deferredToOuterWhileLoop = true;
                  }
                  // If the expression that carried the additional await IS a
                  // suspending while loop, this branch's remaining code sits
                  // AFTER that loop in the source. Chaining it would emit it at
                  // the TOP of the loop's resume state — i.e. on every
                  // iteration — so the branch's scope-end drops would free the
                  // locals (typically the very collection the loop iterates)
                  // during the first one: the condition then re-reads freed
                  // memory and the loop exits early. Defer it to the loop's
                  // post-exit slot instead, exactly as generateCondWithAwait
                  // already does when it can see the loop entry itself.
                  const nestedWhileForPostCode =
                    additionalAwaitExpr &&
                    exprContainsWhileWithAwait(additionalAwaitExpr)
                      ? functionContext.asyncWhileLoopInfo?.get(nextIndex)
                      : undefined;
                  let deferredToPostWhile = false;
                  if (
                    nestedWhileForPostCode &&
                    additionalRemainingExprs.length > 0
                  ) {
                    // The slot may already be claimed by an inner cond layer
                    // (generateCondWithAwait) — merge rather than decline;
                    // declining falls back to chaining, which emits this arm's
                    // scope-end drops at the top of the loop's resume state,
                    // once per iteration.
                    nestedWhileForPostCode.condBranchPostWhileExprs =
                      mergeCondBranchPostWhileExprs(
                        nestedWhileForPostCode.condBranchPostWhileExprs,
                        {
                          branchIndex: branch.index,
                          condBranchFieldIndex,
                          exprs: additionalRemainingExprs,
                          deferredDropExpressions:
                            branch.deferredDropExpressions,
                        }
                      );
                    deferredToPostWhile = true;
                  }

                  if (!functionContext.asyncCondBranchInfo) {
                    functionContext.asyncCondBranchInfo = new Map();
                  }
                  const existing =
                    functionContext.asyncCondBranchInfo.get(nextIndex);
                  if (deferredToPostWhile) {
                    // Already routed to the nested loop's post-exit slot above.
                  } else if (existing) {
                    // Entry already exists (from a nested cond's generateCondWithAwait).
                    // Chain the outer cond's remaining code as a separate layer.
                    if (!existing.chainedBranches) {
                      existing.chainedBranches = [];
                    }
                    existing.chainedBranches.push({
                      branches: [
                        {
                          index: branch.index,
                          value: branch.value,
                          hasAwait:
                            additionalRemainingExprs.length > 0 ||
                            additionalRemainingExprs.some((e) =>
                              exprContainsAwait(e)
                            ),
                          remainingExprs: additionalRemainingExprs,
                          deferredDropExpressions:
                            branch.deferredDropExpressions,
                        },
                      ],
                      condBranchFieldIndex: condBranchFieldIndex,
                    });
                  } else {
                    const newEntry = {
                      branches: [
                        {
                          index: branch.index,
                          value: branch.value,
                          hasAwait:
                            additionalRemainingExprs.length > 0 ||
                            additionalRemainingExprs.some((e) =>
                              exprContainsAwait(e)
                            ),
                          remainingExprs: additionalRemainingExprs,
                          deferredDropExpressions:
                            branch.deferredDropExpressions,
                        },
                      ],
                      condBranchFieldIndex: condBranchFieldIndex,
                    };
                    functionContext.asyncCondBranchInfo.set(
                      nextIndex,
                      newEntry
                    );
                  }
                } else {
                  // No more awaits - generate deferred drop expressions
                  // Filter out drops that reference temp variables not in state machine scope
                  if (branch.deferredDropExpressions) {
                    for (const dropExpr of branch.deferredDropExpressions) {
                      const dropCode = generateExpr(
                        dropExpr,
                        "          ",
                        context
                      );
                      // Skip drops that don't use state machine fields (sm->var_*)
                      // These are temp variables from the original scope that aren't accessible
                      if (dropCode && dropCode.includes("sm->")) {
                        emitter.emitLine(`          ${dropCode};`);
                      }
                    }
                  }
                }

                // Restore context
                context.inAsyncStateMachine = previousInStateMachineForBranch;
                context.stateMachineVariables =
                  previousStateMachineVariablesForBranch;
                context.variableIdRemapping =
                  previousVariableIdRemappingForBranch;
                context.pendingDeferredDrops =
                  previousPendingDeferredDropsForBranch;
              }

              if (!skipCondBranchSwitch) {
                emitter.emitLine(`          break;`);
                emitter.emitLine(`        }`);
              }
            }
          }

          if (!skipCondBranchSwitch) {
            emitter.emitLine(`      }`);
          }

          // Process chained branches (outer cond's remaining code after the
          // nested cond's switch). Placement depends on the layer's dispatch
          // field:
          //  - condBranchFieldIndex === prevAwait.index: the field was CLAIMED
          //    by the nested cond (its write overwrote the outer one), so its
          //    value cannot gate the layer — run it unconditionally, INSIDE
          //    the NULL guard (only drops-safe layers are chained this way;
          //    see the nestedClaimedDispatch diversion in state-code-gen.ts).
          //  - any other field: the layer belongs to an OUTER cond whose
          //    dispatch field is still reliable, and it must also run when
          //    THIS state's await was never submitted (the nested branch was
          //    not taken) — emitted AFTER the NULL guard closes; see below.
          if (condBranchData.chainedBranches) {
            for (const chainedLayer of condBranchData.chainedBranches) {
              if (chainedLayer.condBranchFieldIndex === prevAwait.index) {
                for (const chainedBranch of chainedLayer.branches) {
                  processChainedBranch(
                    chainedBranch,
                    chainedLayer.condBranchFieldIndex,
                    segment,
                    prevAwait,
                    analysis,
                    bodyExpr,
                    captureType,
                    futureType,
                    context
                  );
                }
              }
            }
          }

          // If the cond result is assigned to a variable, assign the await
          // result now — but ONLY when no branch-level destination was
          // registered: this copy is emitted AFTER the branch switch, so with
          // targetAssignmentCode present it would overwrite the branch value
          // (computed after the await) with the raw await result.
          if (
            condBranchData.targetVariableId &&
            !condBranchData.targetAssignmentCode
          ) {
            const fieldName = getStateMachineFieldName(
              condBranchData.targetVariableId,
              "local",
              context.stateMachineFieldAliases
            );
            emitter.emitLine(`      // Assign cond result to target variable`);
            emitter.emitLine(
              `      sm->${fieldName} = sm->await_result_${prevAwait.index};`
            );
          }
          // Note: targetAssignmentCode is handled inside each branch's remaining
          // expression generation (the last expression is assigned to the target)

          emitter.emitLine(``);
        }

        // Close the isInsideCond NULL guard
        if (prevAwait.isInsideCond) {
          emitter.emitLine(`      }`);
        }

        // Chained layers from an OUTER cond (field !== prevAwait.index): the
        // outer branch's remaining code must run even when THIS state's await
        // was never submitted (the nested branch was not taken), so it lives
        // OUTSIDE the NULL guard, gated on the outer cond's own dispatch
        // field. Branch codes start at 1 (allocCondBranchCodes), so the
        // calloc-zeroed field of a never-taken cond cannot match a case here.
        if (condBranchData?.chainedBranches) {
          for (const chainedLayer of condBranchData.chainedBranches) {
            if (chainedLayer.condBranchFieldIndex === prevAwait.index) {
              continue;
            }
            for (const chainedBranch of chainedLayer.branches) {
              if (
                !(
                  chainedBranch.hasAwait &&
                  chainedBranch.remainingExprs &&
                  chainedBranch.remainingExprs.length > 0
                )
              ) {
                continue;
              }
              emitter.emitLine(
                `      // Outer cond branch ${chainedBranch.index} remaining code (chained)`
              );
              emitter.emitLine(
                `      if (sm->cond_branch_${chainedLayer.condBranchFieldIndex} == ${chainedBranch.index}) {`
              );
              processChainedBranch(
                chainedBranch,
                chainedLayer.condBranchFieldIndex,
                segment,
                prevAwait,
                analysis,
                bodyExpr,
                captureType,
                futureType,
                context
              );
              emitter.emitLine(`      }`);
            }
          }
        }

        // Check if this await was part of a while loop
        // If so, we need to execute remaining body expressions, then re-evaluate the loop condition
        const whileLoopData = functionContext.asyncWhileLoopInfo?.get(
          prevAwait.index
        );
        if (whileLoopData?.conditionAwait) {
          // The loop's suspension point is its condition. `sm->await_result_N`
          // holds THIS iteration's answer, so the layout is:
          //   if (!result) leave the loop
          //   else { body; step; jump back to the state that stores the future }
          // Jumping back re-stores the future, which is what re-evaluates the
          // condition each iteration.
          emitWhileConditionAwaitResume(
            whileLoopData,
            prevAwait,
            analysis,
            captureType,
            futureType,
            asyncBlockId,
            context as FunctionGenerationContext,
            emitter
          );
        } else if (whileLoopData?.deferredToOuterWhileLoop) {
          // This loop handed its remaining body, loop-back and exit label to the
          // nested while-with-await that shares this await index. Emitting them
          // here would run our post-await body BEFORE the nested loop finishes
          // (and loop back before it ever runs a second iteration).
        } else if (whileLoopData) {
          // For chained awaits, use the original while loop's index for all
          // while_loop_N references (active flag, labels, loop-back state).
          const whileLoopActiveIndex =
            whileLoopData.whileLoopOriginIndex ?? prevAwait.index;

          emitter.emitLine(
            `      // Execute remaining code from while loop body and continue loop`
          );
          emitter.emitLine(
            `      if (sm->while_loop_${whileLoopActiveIndex}_active) {`
          );

          // Track whether the remaining expressions contain another await
          // that chains to the next state. If so, skip the loop-back code.
          // Pre-chained case: an await NESTED IN A BRANCH of this state's
          // cond switch stored the next await's future and FORWARDED this
          // while entry to the next state (see the enclosingWhile forward in
          // the branch loop above). Emitting a loop-back here would loop
          // BEFORE that await runs (and the branch's post-await code) — the
          // one-iteration silent exit. The not-taken runtime path reaches the
          // next state through the existing `await_future_N == NULL` else
          // (state transition), whose forwarded entry loops back correctly.
          let chainedToNextAwait =
            (segment.awaitPoint?.isInsideCond ?? false) &&
            (functionContext.asyncWhileLoopInfo?.has(
              segment.awaitPoint!.index
            ) ??
              false);

          // If there are remaining expressions after the await, generate them
          if (
            whileLoopData.bodyExprsAfterAwait &&
            whileLoopData.bodyExprsAfterAwait.length > 0
          ) {
            // Set up state machine context for code generation
            const previousInStateMachineForLoop = context.inAsyncStateMachine;
            const previousStateMachineVariablesForLoop =
              context.stateMachineVariables;
            const previousVariableIdRemappingForLoop =
              context.variableIdRemapping;
            const previousPendingDeferredDropsForLoop =
              context.pendingDeferredDrops;

            context.inAsyncStateMachine = { futureType };
            context.variableIdRemapping = analysis.variableIdRemapping;
            context.pendingDeferredDrops = [
              ...(whileLoopData.bodyExpr.$?.deferredDropExpressions ?? []),
              ...(bodyExpr.$?.deferredDropExpressions ?? []),
            ];

            // Combine outer captured variables and local variables
            const combinedVariables = new Map<string, CapturedVariable>();
            for (const v of analysis.capturedVariables) {
              combinedVariables.set(v.id, v);
            }
            if (captureType) {
              for (const field of captureType.fields) {
                combinedVariables.set(field.label, {
                  id: field.label,
                  name: field.label,
                  type: field.type,
                  kind: "outer",
                  isOwningTheSameRcValueAs: undefined, // FIXME
                });
              }
            }
            context.stateMachineVariables = combinedVariables;

            // Set up break/continue handling: in the state machine switch, plain "break"
            // and "continue" don't work as expected. We need goto instead.
            const previousSmWhileBreakInfo = context.smWhileBreakInfo;
            const previousSmWhileContinueInfo = context.smWhileContinueInfo;
            const previousSmWhileBodyDrops = context.smWhileBodyDrops;
            context.smWhileBreakInfo = {
              label: `after_while_loop_${whileLoopActiveIndex}`,
              activeIndex: whileLoopActiveIndex,
            };
            context.smWhileContinueInfo = {
              label: `while_loop_${whileLoopActiveIndex}_continue`,
            };
            context.smWhileBodyDrops = [
              ...(whileLoopData.bodyExpr.$?.deferredDropExpressions ?? []),
            ];

            // Generate the remaining expressions, detecting additional awaits
            for (
              let exprIdx = 0;
              exprIdx < whileLoopData.bodyExprsAfterAwait.length;
              exprIdx++
            ) {
              const expr = whileLoopData.bodyExprsAfterAwait[exprIdx]!;

              if (exprContainsAwait(expr) && segment.awaitPoint) {
                // This remaining expression contains another io.await.
                // Chain to the next state: set up the future and register
                // a new whileLoopInfo entry for the next resume state.
                generateRemainingExprFuture(
                  expr,
                  segment.awaitPoint,
                  analysis,
                  "        ",
                  context
                );

                // Collect remaining expressions after this await
                const furtherRemaining =
                  whileLoopData.bodyExprsAfterAwait.slice(exprIdx + 1);

                // Register whileLoopInfo for the next state to find
                functionContext.asyncWhileLoopInfo!.set(
                  segment.awaitPoint.index,
                  {
                    conditionExpr: whileLoopData.conditionExpr,
                    stepExpr: whileLoopData.stepExpr,
                    bodyExpr: whileLoopData.bodyExpr,
                    bodyExprsAfterAwait: furtherRemaining,
                    whileLoopOriginIndex: whileLoopActiveIndex,
                    isChainedAwait: true,
                    condBranchPostWhileExprs:
                      whileLoopData.condBranchPostWhileExprs,
                    outerWhileLoop: whileLoopData.outerWhileLoop,
                  }
                );

                chainedToNextAwait = true;
                break;
              }

              // Normal expression — generate as code
              const code = generateExpr(expr, "        ", context);
              // Skip empty code, expressions without metadata, and temp variable references
              if (
                !code ||
                !expr.$ ||
                isTempVariableName(expr.$.env.modulePath, code)
              ) {
                // Skip
              } else {
                emitter.emitLine(`        ${code};`);
              }
            }

            // Restore context
            context.smWhileBreakInfo = previousSmWhileBreakInfo;
            context.smWhileContinueInfo = previousSmWhileContinueInfo;
            context.smWhileBodyDrops = previousSmWhileBodyDrops;
            context.inAsyncStateMachine = previousInStateMachineForLoop;
            context.stateMachineVariables =
              previousStateMachineVariablesForLoop;
            context.variableIdRemapping = previousVariableIdRemappingForLoop;
            context.pendingDeferredDrops = previousPendingDeferredDropsForLoop;
          }

          if (chainedToNextAwait) {
            // Chained to next state for additional await in while body.
            // Close the while_loop_active block — the loop-back code (condition
            // check, goto) and the after_while_loop label will be generated by
            // the final chained state.
            emitter.emitLine(`      }`);
            emitter.emitLine(``);
          } else {
            // Normal (non-chained): generate continue label, condition check, loop-back

            // Label for continue to jump to (skip rest of body, re-evaluate condition)
            emitter.emitLine(
              `      while_loop_${whileLoopActiveIndex}_continue:`
            );

            // Drop while loop body locals before condition re-evaluation
            // Both normal fall-through and explicit 'continue' reach this label
            {
              const whileBodyDrops =
                whileLoopData.bodyExpr.$?.deferredDropExpressions ?? [];
              if (whileBodyDrops.length > 0) {
                const prevInSM = context.inAsyncStateMachine;
                const prevSMVars = context.stateMachineVariables;
                const prevVarRemap = context.variableIdRemapping;
                context.inAsyncStateMachine = { futureType };
                context.variableIdRemapping = analysis.variableIdRemapping;

                const dropCombinedVars = new Map<string, CapturedVariable>();
                for (const v of analysis.capturedVariables) {
                  dropCombinedVars.set(v.id, v);
                }
                if (captureType) {
                  for (const field of captureType.fields) {
                    dropCombinedVars.set(field.label, {
                      id: field.label,
                      name: field.label,
                      type: field.type,
                      kind: "outer",
                      isOwningTheSameRcValueAs: undefined,
                    });
                  }
                }
                context.stateMachineVariables = dropCombinedVars;

                for (const dropExpr of whileBodyDrops) {
                  const dropCode = generateExpr(dropExpr, "        ", context);
                  if (dropCode && dropCode.includes("sm->")) {
                    emitter.emitLine(`        ${dropCode};`);
                  }
                }

                context.inAsyncStateMachine = prevInSM;
                context.stateMachineVariables = prevSMVars;
                context.variableIdRemapping = prevVarRemap;
              }
            }

            // Re-evaluate the loop condition
            emitter.emitLine(
              `        ASYNC_DEBUG("${asyncBlockId}: Re-evaluating while loop condition\\n");`
            );

            // Clear declaredTempVars so re-generated condition/step expressions
            // can re-declare their temp variables (they're in a new C scope).
            const previousDeclaredTempVars = (
              context as FunctionGenerationContext
            ).declaredTempVars;
            (context as FunctionGenerationContext).declaredTempVars = undefined;

            // Generate step expression (3-arg while form) before condition
            // re-evaluation. Skip it when the step is where the await was: it
            // already ran in the previous state, and its remainder came through
            // as bodyExprsAfterAwait above.
            if (whileLoopData.stepExpr && !whileLoopData.stepAwait) {
              const previousInStateMachineForStep = context.inAsyncStateMachine;
              const previousStateMachineVariablesForStep =
                context.stateMachineVariables;
              const previousVariableIdRemappingForStep =
                context.variableIdRemapping;

              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;

              const combinedVariablesForStep = new Map<
                string,
                CapturedVariable
              >();
              for (const v of analysis.capturedVariables) {
                combinedVariablesForStep.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  combinedVariablesForStep.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = combinedVariablesForStep;

              const stepCode = generateExpr(
                whileLoopData.stepExpr,
                "        ",
                context
              );
              if (stepCode) {
                emitter.emitLine(`        ${stepCode};`);
              }

              context.inAsyncStateMachine = previousInStateMachineForStep;
              context.stateMachineVariables =
                previousStateMachineVariablesForStep;
              context.variableIdRemapping = previousVariableIdRemappingForStep;
            }

            // Set up state machine context for condition evaluation
            const previousInStateMachineForCond = context.inAsyncStateMachine;
            const previousStateMachineVariablesForCond =
              context.stateMachineVariables;
            const previousVariableIdRemappingForCond =
              context.variableIdRemapping;

            context.inAsyncStateMachine = { futureType };
            context.variableIdRemapping = analysis.variableIdRemapping;

            // Combine outer captured variables and local variables
            const combinedVariablesForCond = new Map<
              string,
              CapturedVariable
            >();
            for (const v of analysis.capturedVariables) {
              combinedVariablesForCond.set(v.id, v);
            }
            if (captureType) {
              for (const field of captureType.fields) {
                combinedVariablesForCond.set(field.label, {
                  id: field.label,
                  name: field.label,
                  type: field.type,
                  kind: "outer",
                  isOwningTheSameRcValueAs: undefined, // FIXME
                });
              }
            }
            context.stateMachineVariables = combinedVariablesForCond;

            // Generate condition check
            const condCode = generateExpr(
              whileLoopData.conditionExpr,
              "        ",
              context
            );

            // Restore context
            context.inAsyncStateMachine = previousInStateMachineForCond;
            context.stateMachineVariables =
              previousStateMachineVariablesForCond;
            context.variableIdRemapping = previousVariableIdRemappingForCond;

            // Restore declaredTempVars
            (context as FunctionGenerationContext).declaredTempVars =
              previousDeclaredTempVars;

            emitter.emitLine(`        if (!(${condCode})) {`);
            emitter.emitLine(
              `          sm->while_loop_${whileLoopActiveIndex}_active = false;`
            );
            emitter.emitLine(
              `          ASYNC_DEBUG("${asyncBlockId}: While loop condition false, exiting loop\\n");`
            );
            emitter.emitLine(`        } else {`);
            emitter.emitLine(
              `          ASYNC_DEBUG("${asyncBlockId}: While loop condition true, continuing iteration\\n");`
            );

            // Transition back to the state where the while loop started
            const whileLoopStateNumber = whileLoopActiveIndex;
            emitter.emitLine(
              `          // Loop back by transitioning to while loop state`
            );
            emitter.emitLine(`          sm->state = ${whileLoopStateNumber};`);
            emitter.emitLine(
              `          goto while_loop_${whileLoopStateNumber}_start;`
            );

            emitter.emitLine(`        }`);
            emitter.emitLine(`      }`);

            emitter.emitLine(``);
            // Add label for code after while loop (for break to jump to)
            emitter.emitLine(`      after_while_loop_${whileLoopActiveIndex}:`);
          }

          // Emit post-while-loop expressions from enclosing cond branch.
          // These were deferred from the "remaining code from chosen cond branch"
          // handler because they must only execute once (after the while loop
          // exits), not on every state machine resume.
          // Skip for chained states — the final state handles post-while code.
          if (!chainedToNextAwait && whileLoopData.condBranchPostWhileExprs) {
            const postWhileData = whileLoopData.condBranchPostWhileExprs;
            const pwCondField = postWhileData.condBranchFieldIndex;
            const pwBranchIdx = postWhileData.branchIndex;
            if (postWhileData.skipCondBranchCheck) {
              // Nested cond conflict: sm->cond_branch_N was overwritten by an
              // inner cond, so the guard check would always fail. Skip it —
              // after_while_loop_N is only reachable from the correct branch.
              emitter.emitLine(
                `      // Execute post-while-loop code from cond branch (unconditional)`
              );
              emitter.emitLine(`      {`);
            } else {
              emitter.emitLine(
                `      // Execute post-while-loop code from cond branch`
              );
              emitter.emitLine(
                `      if (sm->cond_branch_${pwCondField} == ${pwBranchIdx}) {`
              );
            }

            // Set up state machine context for code generation
            const prevInSMPW = context.inAsyncStateMachine;
            const prevSMVarsPW = context.stateMachineVariables;
            const prevVarRemapPW = context.variableIdRemapping;
            const prevPendingDropsPW = context.pendingDeferredDrops;

            context.inAsyncStateMachine = { futureType };
            context.variableIdRemapping = analysis.variableIdRemapping;
            context.pendingDeferredDrops = [
              ...(bodyExpr.$?.deferredDropExpressions ?? []),
            ];

            const combinedVarsPW = new Map<string, CapturedVariable>();
            for (const v of analysis.capturedVariables) {
              combinedVarsPW.set(v.id, v);
            }
            if (captureType) {
              for (const field of captureType.fields) {
                combinedVarsPW.set(field.label, {
                  id: field.label,
                  name: field.label,
                  type: field.type,
                  kind: "outer",
                  isOwningTheSameRcValueAs: undefined,
                });
              }
            }
            context.stateMachineVariables = combinedVarsPW;

            const hasNextAwait = segment.awaitPoint != null;
            let foundPostWhileAwait = false;
            const additionalRemainingExprs: Expr[] = [];

            for (let pwIdx = 0; pwIdx < postWhileData.exprs.length; pwIdx++) {
              const expr = postWhileData.exprs[pwIdx]!;

              if (foundPostWhileAwait) {
                additionalRemainingExprs.push(expr);
                continue;
              }

              if (hasNextAwait && exprContainsAwait(expr)) {
                foundPostWhileAwait = true;
                generateRemainingExprFuture(
                  expr,
                  segment.awaitPoint!,
                  analysis,
                  "        ",
                  context
                );
                continue;
              }

              // Normal expression
              const code = generateExpr(expr, "        ", context);
              if (
                !code ||
                !expr.$ ||
                isTempVariableName(expr.$.env.modulePath, code)
              ) {
                // Skip
              } else {
                emitter.emitLine(`        ${code};`);
              }
            }

            // Chain remaining expressions after the await to the next state
            if (foundPostWhileAwait && segment.awaitPoint) {
              const nextIndex = segment.awaitPoint.index;
              if (!functionContext.asyncCondBranchInfo) {
                functionContext.asyncCondBranchInfo = new Map();
              }
              // When skipCondBranchCheck is set, use -1 as condBranchFieldIndex
              // to signal the next state to execute unconditionally.
              const chainedCondField = postWhileData.skipCondBranchCheck
                ? -1
                : postWhileData.condBranchFieldIndex;
              const existing =
                functionContext.asyncCondBranchInfo.get(nextIndex);
              if (existing) {
                // Entry already exists — chain as additional layer
                if (!existing.chainedBranches) {
                  existing.chainedBranches = [];
                }
                existing.chainedBranches.push({
                  branches: [
                    {
                      index: postWhileData.branchIndex,
                      value: postWhileData.exprs[0]!,
                      hasAwait:
                        additionalRemainingExprs.length > 0 ||
                        additionalRemainingExprs.some((e) =>
                          exprContainsAwait(e)
                        ),
                      remainingExprs: additionalRemainingExprs,
                      deferredDropExpressions:
                        postWhileData.deferredDropExpressions,
                    },
                  ],
                  condBranchFieldIndex: chainedCondField,
                });
              } else {
                functionContext.asyncCondBranchInfo.set(nextIndex, {
                  branches: [
                    {
                      index: postWhileData.branchIndex,
                      value: postWhileData.exprs[0]!,
                      hasAwait:
                        additionalRemainingExprs.length > 0 ||
                        additionalRemainingExprs.some((e) =>
                          exprContainsAwait(e)
                        ),
                      remainingExprs: additionalRemainingExprs,
                      deferredDropExpressions:
                        postWhileData.deferredDropExpressions,
                    },
                  ],
                  condBranchFieldIndex: chainedCondField,
                });
              }
            }

            // If no additional await, generate deferred drops
            if (!foundPostWhileAwait && postWhileData.deferredDropExpressions) {
              for (const dropExpr of postWhileData.deferredDropExpressions) {
                const dropCode = generateExpr(dropExpr, "        ", context);
                if (dropCode && dropCode.includes("sm->")) {
                  emitter.emitLine(`        ${dropCode};`);
                }
              }
            }

            emitter.emitLine(`      }`);

            // Restore context
            context.inAsyncStateMachine = prevInSMPW;
            context.stateMachineVariables = prevSMVarsPW;
            context.variableIdRemapping = prevVarRemapPW;
            context.pendingDeferredDrops = prevPendingDropsPW;
          }

          // Handle outer while loop continuation (for nested while-with-await)
          if (whileLoopData.outerWhileLoop) {
            const outerWhile = whileLoopData.outerWhileLoop;
            const outerIndex = outerWhile.whileLoopIndex;

            emitter.emitLine(
              `      // Execute remaining code from outer while loop body`
            );
            emitter.emitLine(
              `      if (sm->while_loop_${outerIndex}_active) {`
            );

            // Generate the outer while's remaining body expressions
            if (outerWhile.bodyExprsAfterAwait.length > 0) {
              const prevInSMOuter = context.inAsyncStateMachine;
              const prevSMVarsOuter = context.stateMachineVariables;
              const prevVarRemapOuter = context.variableIdRemapping;
              const prevPendingDropsOuter = context.pendingDeferredDrops;

              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;
              context.pendingDeferredDrops = [
                ...(outerWhile.bodyExpr.$?.deferredDropExpressions ?? []),
                ...(bodyExpr.$?.deferredDropExpressions ?? []),
              ];

              const outerCombinedVars = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                outerCombinedVars.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  outerCombinedVars.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = outerCombinedVars;

              const prevBreakInfoOuter = context.smWhileBreakInfo;
              const prevContinueInfoOuter = context.smWhileContinueInfo;
              const prevBodyDropsOuter = context.smWhileBodyDrops;
              context.smWhileBreakInfo = {
                label: `after_while_loop_${outerIndex}`,
                activeIndex: outerIndex,
              };
              context.smWhileContinueInfo = {
                label: `while_loop_${outerIndex}_continue`,
              };
              context.smWhileBodyDrops = [
                ...(outerWhile.bodyExpr.$?.deferredDropExpressions ?? []),
              ];

              for (const expr of outerWhile.bodyExprsAfterAwait) {
                const code = generateExpr(expr, "        ", context);
                if (
                  !code ||
                  !expr.$ ||
                  isTempVariableName(expr.$.env.modulePath, code)
                ) {
                  // Skip
                } else {
                  emitter.emitLine(`        ${code};`);
                }
              }

              context.smWhileBreakInfo = prevBreakInfoOuter;
              context.smWhileContinueInfo = prevContinueInfoOuter;
              context.smWhileBodyDrops = prevBodyDropsOuter;
              context.inAsyncStateMachine = prevInSMOuter;
              context.stateMachineVariables = prevSMVarsOuter;
              context.variableIdRemapping = prevVarRemapOuter;
              context.pendingDeferredDrops = prevPendingDropsOuter;
            }

            // Label for outer while continue
            emitter.emitLine(`      while_loop_${outerIndex}_continue:`);

            // Drop outer while body locals before condition re-evaluation
            {
              const outerDrops =
                outerWhile.bodyExpr.$?.deferredDropExpressions ?? [];
              if (outerDrops.length > 0) {
                const prevInSM2 = context.inAsyncStateMachine;
                const prevSMVars2 = context.stateMachineVariables;
                const prevVarRemap2 = context.variableIdRemapping;
                context.inAsyncStateMachine = { futureType };
                context.variableIdRemapping = analysis.variableIdRemapping;

                const dropVars2 = new Map<string, CapturedVariable>();
                for (const v of analysis.capturedVariables) {
                  dropVars2.set(v.id, v);
                }
                if (captureType) {
                  for (const field of captureType.fields) {
                    dropVars2.set(field.label, {
                      id: field.label,
                      name: field.label,
                      type: field.type,
                      kind: "outer",
                      isOwningTheSameRcValueAs: undefined,
                    });
                  }
                }
                context.stateMachineVariables = dropVars2;

                for (const dropExpr of outerDrops) {
                  const dropCode = generateExpr(dropExpr, "        ", context);
                  if (dropCode && dropCode.includes("sm->")) {
                    emitter.emitLine(`        ${dropCode};`);
                  }
                }

                context.inAsyncStateMachine = prevInSM2;
                context.stateMachineVariables = prevSMVars2;
                context.variableIdRemapping = prevVarRemap2;
              }
            }

            // Re-evaluate outer while condition
            // Clear declaredTempVars so re-generated condition/step expressions
            // can re-declare their temp variables (they're in a new C scope).
            const prevDeclaredTempVarsOuter = (
              context as FunctionGenerationContext
            ).declaredTempVars;
            (context as FunctionGenerationContext).declaredTempVars = undefined;

            // Generate outer while step expression first (3-arg while form)
            if (outerWhile.stepExpr) {
              const prevInSMStep = context.inAsyncStateMachine;
              const prevSMVarsStep = context.stateMachineVariables;
              const prevVarRemapStep = context.variableIdRemapping;
              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;

              const stepVars = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                stepVars.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  stepVars.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = stepVars;

              const outerStepCode = generateExpr(
                outerWhile.stepExpr,
                "        ",
                context
              );
              if (outerStepCode) {
                emitter.emitLine(`        ${outerStepCode};`);
              }

              context.inAsyncStateMachine = prevInSMStep;
              context.stateMachineVariables = prevSMVarsStep;
              context.variableIdRemapping = prevVarRemapStep;
            }
            {
              const prevInSM3 = context.inAsyncStateMachine;
              const prevSMVars3 = context.stateMachineVariables;
              const prevVarRemap3 = context.variableIdRemapping;
              context.inAsyncStateMachine = { futureType };
              context.variableIdRemapping = analysis.variableIdRemapping;

              const condVars3 = new Map<string, CapturedVariable>();
              for (const v of analysis.capturedVariables) {
                condVars3.set(v.id, v);
              }
              if (captureType) {
                for (const field of captureType.fields) {
                  condVars3.set(field.label, {
                    id: field.label,
                    name: field.label,
                    type: field.type,
                    kind: "outer",
                    isOwningTheSameRcValueAs: undefined,
                  });
                }
              }
              context.stateMachineVariables = condVars3;

              const outerCondCode = generateExpr(
                outerWhile.conditionExpr,
                "        ",
                context
              );

              context.inAsyncStateMachine = prevInSM3;
              context.stateMachineVariables = prevSMVars3;
              context.variableIdRemapping = prevVarRemap3;

              emitter.emitLine(`        if (!(${outerCondCode})) {`);
              emitter.emitLine(
                `          sm->while_loop_${outerIndex}_active = false;`
              );
              emitter.emitLine(`        } else {`);
              emitter.emitLine(`          sm->state = ${prevAwait.index};`);
              emitter.emitLine(
                `          goto while_loop_${outerIndex}_start;`
              );
              emitter.emitLine(`        }`);
            }

            // Restore declaredTempVars
            (context as FunctionGenerationContext).declaredTempVars =
              prevDeclaredTempVarsOuter;

            emitter.emitLine(`      }`);
            emitter.emitLine(``);
            emitter.emitLine(`      after_while_loop_${outerIndex}:`);
          }
        }
      }
    }

    // Set up state machine context
    const previousInStateMachine = context.inAsyncStateMachine;
    const previousStateMachineVariables = context.stateMachineVariables;
    const previousVariableIdRemapping = context.variableIdRemapping;

    context.inAsyncStateMachine = { futureType };
    context.variableIdRemapping = analysis.variableIdRemapping;
    // Combine outer captured variables and local variables into stateMachineVariables
    // This allows generateAtom to find all variables that should be accessed via sm->
    const combinedVariables = new Map<string, CapturedVariable>();

    // Add local variables from the analysis
    for (const v of analysis.capturedVariables) {
      combinedVariables.set(v.id, v);
    }

    // Add outer captured variables from the capture struct
    // We create synthetic entries with the variable name as the ID
    // Access will be through sm->__capture.varName
    if (captureType) {
      for (const field of captureType.fields) {
        combinedVariables.set(field.label, {
          id: field.label, // Use label as ID
          name: field.label,
          type: field.type,
          kind: "outer",
          isOwningTheSameRcValueAs: undefined,
        });
      }
    }

    context.stateMachineVariables = combinedVariables;

    // Set pending deferred drops from the body expression
    // These need to be generated when the async function completes early (e.g., from a cond branch)
    const previousPendingDeferredDrops = context.pendingDeferredDrops;
    context.pendingDeferredDrops = [
      ...(bodyExpr.$?.deferredDropExpressions ?? []),
    ];

    // Generate the code for this segment
    // For the last segment, we need to capture the final expression's value
    const isLastSegmentWithResult =
      isLastSegment && !isUnitResult && segment.expressions.length > 0;

    // When a segment's last expression IS the body's implicit return AND it's
    // a cond/match with await, set asyncBodyReturnExpr so that non-await
    // branches can emit Future completion code directly.
    const segmentLastExpr =
      segment.expressions.length > 0
        ? segment.expressions[segment.expressions.length - 1]
        : undefined;
    const previousAsyncBodyReturnExpr = context.asyncBodyReturnExpr;
    if (
      !isUnitResult &&
      segmentLastExpr &&
      bodyLastExpr &&
      segmentLastExpr === bodyLastExpr &&
      segment.awaitPoint
    ) {
      context.asyncBodyReturnExpr = segmentLastExpr;
    } else {
      context.asyncBodyReturnExpr = undefined;
    }

    generateStateSegmentCode(
      segment,
      "      ",
      context,
      isLastSegmentWithResult
    );

    // Restore
    context.asyncBodyReturnExpr = previousAsyncBodyReturnExpr;

    // Restore pending deferred drops
    context.pendingDeferredDrops = previousPendingDeferredDrops;

    emitter.emitLine(``);

    if (segment.awaitPoint) {
      // Restore previous context before await logic
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;

      // This segment ends with an await - generate the suspension logic
      const nextState = stateNumber + 1;

      {
        // === SINGLE AWAIT POINT ===
        const futureFieldName = getFutureFieldName(
          segment.awaitPoint,
          analysis
        );

        // Determine if the future is an Io future (__yo_io_future_t) which is
        // already submitted to io_uring and doesn't have __yo_resume_fn.
        const awaitExprForTypeCheck = segment.awaitPoint.expr as {
          args?: Expr[];
        };
        const futureExprForTypeCheck = awaitExprForTypeCheck.args?.[0];
        const isIoFuture = isIoFutureType(futureExprForTypeCheck?.$?.type);

        // If this await is inside a cond expression, the future may not be set
        // (the non-await branch was taken). Guard the await logic with a NULL check.
        const isInsideCond = segment.awaitPoint?.isInsideCond;
        if (isInsideCond) {
          emitter.emitLine(
            `      // Only await if the cond branch with await was taken`
          );
          emitter.emitLine(`      if (sm->${futureFieldName} != NULL) {`);
        }

        // If this await is inside a while loop, wrap the await logic in a check for loop active flag.
        // Only do this for the direct while-loop-await (the one that generated while_loop_N_start),
        // not for nested awaits inside cond branches within the while loop.
        const isInsideWhile = segment.awaitPoint?.isInsideWhile;
        const whileLoopInfoForAwait = isInsideWhile
          ? (context as FunctionGenerationContext).asyncWhileLoopInfo?.get(
              segment.awaitPoint.index
            )
          : undefined;
        if (isInsideWhile && whileLoopInfoForAwait) {
          // For chained awaits, use the original while loop's index
          const whileLoopIndex =
            whileLoopInfoForAwait.whileLoopOriginIndex ??
            segment.awaitPoint.index;
          emitter.emitLine(
            `      // Only await if while loop is still active (not broken)`
          );
          emitter.emitLine(
            `      if (sm->while_loop_${whileLoopIndex}_active) {`
          );
        }

        emitter.emitLine(`      // Transition to next state after await`);
        emitter.emitLine(`      sm->state = ${nextState};`);
        emitter.emitLine(``);
        emitter.emitLine(`      // Check if future is ready`);
        emitter.emitLine(
          `      int future_state = sm->${futureFieldName}->state;`
        );
        emitter.emitLine(
          `      if (future_state == -1 || future_state == -2) {  // -1 = completed, -2 = aborted`
        );
        emitter.emitLine(
          `        // Already complete — bounded inline fast-path to avoid scheduler round-trip`
        );
        emitter.emitLine(`        if (__yo_inline_budget > 0) {`);
        emitter.emitLine(`          __yo_inline_budget--;`);
        emitter.emitLine(`          goto state_${nextState};`);
        emitter.emitLine(`        }`);
        emitter.emitLine(
          `        // Budget exhausted — yield once for fairness (microtask yield)`
        );
        emitter.emitLine(
          `        __yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
        );
        emitter.emitLine(`        return;`);
        emitter.emitLine(`      }`);
        emitter.emitLine(``);
        // Cold future: start it via stored resume function pointer
        // Io futures (__yo_io_future_t) are already submitted to io_uring and don't
        // have __yo_resume_fn — skip cold-start for them.
        if (!isIoFuture) {
          // SM futures need an extra ref because the SM future's own completion
          // code calls __yo_decr_rc on itself. Io futures don't — their completion
          // handler (__yo_io_process_cqe) doesn't decrement, so the single RC=1
          // from allocation is sufficient.
          emitter.emitLine(
            `      // Future not complete — take event loop reference and start if cold`
          );
          emitter.emitLine(
            `      __yo_incr_rc((void*)sm->${futureFieldName});  // event loop reference`
          );
        } else {
          emitter.emitLine(
            `      // Io future: no extra ref needed (completion handler does not decr_rc)`
          );
        }
        if (!isIoFuture) {
          emitter.emitLine(
            `      if (future_state == 0) {  // 0 = cold (not started)`
          );
          // Inject effect handler values into capture struct before cold-starting
          emitEffectInjectionForSM(
            segment.awaitPoint.expr as FnCallExpr,
            `sm->${futureFieldName}`,
            "        ",
            context
          );
          emitter.emitLine(
            `        // Cold future — start it via stored resume function pointer`
          );
          emitter.emitLine(
            `        sm->${futureFieldName}->__yo_resume_fn((void*)sm->${futureFieldName});`
          );
          emitter.emitLine(``);
          emitter.emitLine(
            `        // Re-check: may have completed synchronously`
          );
          emitter.emitLine(
            `        future_state = sm->${futureFieldName}->state;`
          );
          emitter.emitLine(
            `        if (future_state == -1 || future_state == -2) {`
          );
          emitter.emitLine(
            `          // Completed or aborted synchronously — yield for fairness`
          );
          emitter.emitLine(
            `          __yo_async_spawn_task((void (*)(void*))${resumeFunctionName}, (void*)sm);`
          );
          emitter.emitLine(`          return;`);
          emitter.emitLine(`        }`);
          emitter.emitLine(`      }`);
        }
        emitter.emitLine(``);
        // Register continuation directly on the future (type-specific access)
        emitter.emitLine(
          `      // Still pending — register continuation and suspend`
        );
        emitter.emitLine(
          `      sm->${futureFieldName}->continuation_fn = (void (*)(void*))${resumeFunctionName};`
        );
        emitter.emitLine(
          `      sm->${futureFieldName}->continuation_sm = (void*)sm;`
        );
        emitter.emitLine(`      return;`);

        if (isInsideWhile && whileLoopInfoForAwait) {
          // For chained awaits, use the original while loop's index for the label
          const whileLoopIndex =
            whileLoopInfoForAwait.whileLoopOriginIndex ??
            segment.awaitPoint.index;
          // Add else branch to jump to code after while loop when broken
          emitter.emitLine(`      } else {`);
          emitter.emitLine(
            `        // While loop was broken, jump to code after loop`
          );
          emitter.emitLine(`        goto after_while_loop_${whileLoopIndex};`);
          emitter.emitLine(`      }`);
        }

        if (isInsideCond) {
          emitter.emitLine(`      } else {`);
          emitter.emitLine(
            `        // Non-await cond branch was taken, skip directly to next state`
          );
          emitter.emitLine(`        sm->state = ${nextState};`);
          emitter.emitLine(`        goto state_${nextState};`);
          emitter.emitLine(`      }`);
        }
      } // end of single await block
    } else if (isLastSegment) {
      // Last segment - complete the Future
      const hasReturnStatement = segment.expressions.some((expr: Expr) =>
        exprContainsReturn(expr)
      );

      if (!hasReturnStatement) {
        // Generate deferred drops for the body expression before completing the Future
        // Keep state machine context active for this
        if (bodyExpr.$?.deferredDropExpressions) {
          // Use a temp emitter to capture ALL drop output (some drops emit directly)
          const tempEmitter = new Emitter();
          const originalEmitter = context.emitter;
          context.emitter = tempEmitter;

          for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
            const dropCode = generateExpr(dropExpr, "", context);
            if (dropCode) {
              tempEmitter.emitLine(`${dropCode};`);
            }
          }

          context.emitter = originalEmitter;

          // Extract lines from temp emitter and emit to real emitter + collect for dispose
          const capturedCode = tempEmitter.print().trim();
          if (capturedCode) {
            emitter.emitLine(`      // Drop local variables before completion`);
            for (const line of capturedCode.split("\n")) {
              const trimmed = line.trim();
              if (trimmed) {
                emitter.emitLine(`      ${trimmed}`);
                localVarDropCodes.push(trimmed);
              }
            }
            emitter.emitLine(``);
          }
        }

        emitter.emitLine(`      // Final state - complete the Future`);

        emitAsyncFutureCompletion({
          emitter,
          indent: "      ",
          debugLabel: `Future %p completed`,
        });
      }

      // Restore previous context after final state
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;
    } else {
      // Restore previous context for non-await, non-final segments
      context.inAsyncStateMachine = previousInStateMachine;
      context.stateMachineVariables = previousStateMachineVariables;
      context.variableIdRemapping = previousVariableIdRemapping;
    }

    emitter.emitLine(`    }`);
  }

  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);

  return localVarDropCodes;
}

/**
 * Emits ONE chained branch's remaining code (an outer cond's code that runs
 * after a nested cond/match claimed the same await point). Shared by the two
 * placements in generateAsyncBlockResumeFunction: inside the isInsideCond
 * NULL guard (dispatch-claimed layers, run unconditionally) and after it
 * (outer-field layers, gated on the outer cond's own dispatch field).
 */
function processChainedBranch(
  chainedBranch: {
    index: number;
    value: Expr;
    hasAwait: boolean;
    remainingExprs?: Expr[];
    deferredDropExpressions?: Expr[];
  },
  chainedLayerFieldIndex: number,
  segment: { awaitPoint: AwaitPoint | null },
  prevAwait: AwaitPoint,
  analysis: AwaitAnalysisResult,
  bodyExpr: Expr,
  captureType: StructType | undefined,
  futureType: SomeType | DynType,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const functionContext = context;
  if (
    chainedBranch.hasAwait &&
    chainedBranch.remainingExprs &&
    chainedBranch.remainingExprs.length > 0
  ) {
    // Set up state machine context for code generation
    const previousInStateMachineForChained = context.inAsyncStateMachine;
    const previousStateMachineVariablesForChained =
      context.stateMachineVariables;
    const previousVariableIdRemappingForChained = context.variableIdRemapping;
    const previousPendingDeferredDropsForChained = context.pendingDeferredDrops;

    context.inAsyncStateMachine = { futureType };
    context.variableIdRemapping = analysis.variableIdRemapping;
    const whileLoopDataForChainedDrops =
      functionContext.asyncWhileLoopInfo?.get(prevAwait.index);
    context.pendingDeferredDrops = [
      ...(chainedBranch.deferredDropExpressions ?? []),
      ...(whileLoopDataForChainedDrops?.bodyExpr.$?.deferredDropExpressions ??
        []),
      ...(bodyExpr.$?.deferredDropExpressions ?? []),
    ];
    const combinedVariablesChained = new Map<string, CapturedVariable>();
    for (const v of analysis.capturedVariables) {
      combinedVariablesChained.set(v.id, v);
    }
    if (captureType) {
      for (const field of captureType.fields) {
        combinedVariablesChained.set(field.label, {
          id: field.label,
          name: field.label,
          type: field.type,
          kind: "outer",
          isOwningTheSameRcValueAs: undefined,
        });
      }
    }
    context.stateMachineVariables = combinedVariablesChained;

    const hasAdditionalCondAwaitChained =
      segment.awaitPoint?.isInsideCond ?? false;
    let foundAdditionalAwaitChained = false;
    const additionalRemainingExprsChained: Expr[] = [];

    for (const expr of chainedBranch.remainingExprs) {
      if (foundAdditionalAwaitChained) {
        additionalRemainingExprsChained.push(expr);
        continue;
      }

      if (hasAdditionalCondAwaitChained && exprContainsAwait(expr)) {
        foundAdditionalAwaitChained = true;
        generateRemainingExprFuture(
          expr,
          segment.awaitPoint!,
          analysis,
          "      ",
          context
        );
        continue;
      }

      const code = generateExpr(expr, "      ", context);
      if (!code || !expr.$ || isTempVariableName(expr.$.env.modulePath, code)) {
        // Skip
      } else {
        emitter.emitLine(`      ${code};`);
      }
    }

    if (foundAdditionalAwaitChained && segment.awaitPoint) {
      const nextIndex = segment.awaitPoint.index;
      if (!functionContext.asyncCondBranchInfo) {
        functionContext.asyncCondBranchInfo = new Map();
      }
      const existingChained =
        functionContext.asyncCondBranchInfo.get(nextIndex);
      if (existingChained) {
        if (!existingChained.chainedBranches) {
          existingChained.chainedBranches = [];
        }
        existingChained.chainedBranches.push({
          branches: [
            {
              index: chainedBranch.index,
              value: chainedBranch.value,
              hasAwait:
                additionalRemainingExprsChained.length > 0 ||
                additionalRemainingExprsChained.some((e) =>
                  exprContainsAwait(e)
                ),
              remainingExprs: additionalRemainingExprsChained,
              deferredDropExpressions: chainedBranch.deferredDropExpressions,
            },
          ],
          condBranchFieldIndex: chainedLayerFieldIndex,
        });
      } else {
        functionContext.asyncCondBranchInfo.set(nextIndex, {
          branches: [
            {
              index: chainedBranch.index,
              value: chainedBranch.value,
              hasAwait:
                additionalRemainingExprsChained.length > 0 ||
                additionalRemainingExprsChained.some((e) =>
                  exprContainsAwait(e)
                ),
              remainingExprs: additionalRemainingExprsChained,
              deferredDropExpressions: chainedBranch.deferredDropExpressions,
            },
          ],
          condBranchFieldIndex: chainedLayerFieldIndex,
        });
      }
    } else {
      if (chainedBranch.deferredDropExpressions) {
        for (const dropExpr of chainedBranch.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, "      ", context);
          if (dropCode && dropCode.includes("sm->")) {
            emitter.emitLine(`      ${dropCode};`);
          }
        }
      }
    }

    context.inAsyncStateMachine = previousInStateMachineForChained;
    context.stateMachineVariables = previousStateMachineVariablesForChained;
    context.variableIdRemapping = previousVariableIdRemappingForChained;
    context.pendingDeferredDrops = previousPendingDeferredDropsForChained;
  }
}

/**
 * Generates code to store the future from an await expression found in cond branch remaining expressions.
 * This handles the case where a cond branch has multiple sequential awaits.
 */
function generateRemainingExprFuture(
  expr: Expr,
  awaitPoint: AwaitPoint,
  analysis: AwaitAnalysisResult,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const futureFieldName = getFutureFieldName(awaitPoint, analysis);

  // Handle: varName := await(futureExpr)
  if (expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, ":=")) {
    const valueExpr = expr.args[1];
    if (
      valueExpr &&
      valueExpr.tag === ExprTag.FnCall &&
      isIoAwaitCall(valueExpr)
    ) {
      const futureExpr = valueExpr.args[0];
      if (futureExpr) {
        const futureCode = generateExpr(futureExpr, indent, context);
        emitter.emitLine(
          `${indent}// Store Future for additional await in cond branch`
        );
        emitter.emitLine(`${indent}sm->${futureFieldName} = ${futureCode};`);
      }
    }
    return;
  }

  // Handle: io.await(futureExpr)
  if (expr.tag === ExprTag.FnCall && isIoAwaitCall(expr)) {
    const futureExpr = expr.args[0];
    if (futureExpr) {
      const futureCode = generateExpr(futureExpr, indent, context);
      emitter.emitLine(
        `${indent}// Store Future for additional await in cond branch`
      );
      emitter.emitLine(`${indent}sm->${futureFieldName} = ${futureCode};`);
    }
    return;
  }

  // Handle: if(cond, { await ... }) - `if` is a macro over `cond`; its branch
  // structure only exists in the expansion, so route through that (otherwise
  // this falls through to the warning below and the await's future is never
  // stored — the branch is then silently skipped at runtime).
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.if) &&
    expr.$?.macroExpansion
  ) {
    generateAwaitExpression(
      expr.$.macroExpansion,
      awaitPoint,
      0,
      indent,
      context
    );
    return;
  }

  // Handle: cond(... => { await ... }, ...) - nested cond with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: match(... => { await ... }, ...) - nested match with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: while ... { await ... } - while loop with await in body
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.while)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  // Handle: begin block that contains an await somewhere inside
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.begin)
  ) {
    generateAwaitExpression(expr, awaitPoint, 0, indent, context);
    return;
  }

  emitter.emitLine(
    `${indent}// Warning: unhandled await pattern in remaining expressions`
  );
}

/**
 * Recursively checks if an expression contains a return statement.
 * Handles both bare `return` atoms and `return(value)` function calls,
 * and recurses into begin blocks, cond branches, etc.
 */
function exprContainsReturn(expr: Expr): boolean {
  // Bare `return` atom (no return value)
  if (exprIsAtomOf(expr, "return")) {
    return true;
  }
  // `return(value)` function call
  if (exprIsFunctionCallOf(expr, "return")) {
    return true;
  }
  // Recurse into begin blocks, cond branches, etc.
  if (expr.tag === ExprTag.FnCall) {
    for (const arg of expr.args) {
      if (exprContainsReturn(arg)) {
        return true;
      }
    }
  }
  return false;
}

function usesGenericFutureInterface(
  futureType: Type,
  context: FunctionGenerationContext
): boolean {
  if (!isSomeType(futureType) || !typeImplementsFuture(futureType)) {
    return false;
  }
  if (context.types[futureType.id]) {
    return false;
  }
  if (futureType.resolvedConcreteType) {
    if (
      isSomeType(futureType.resolvedConcreteType) &&
      context.types[futureType.resolvedConcreteType.id]
    ) {
      return false;
    }
    if (isStructType(futureType.resolvedConcreteType)) {
      const captureStructId = futureType.resolvedConcreteType.id;
      for (const entry of Object.values(context.types)) {
        if (
          isSomeType(entry.type) &&
          typeImplementsFuture(entry.type) &&
          entry.type.resolvedConcreteType &&
          isStructType(entry.type.resolvedConcreteType) &&
          entry.type.resolvedConcreteType.id === captureStructId
        ) {
          return false;
        }
      }
    }
  }
  return !!extractFutureTraitFromType(futureType);
}

function emitFutureEffectInjectionLine(
  futureType: Type,
  futureAccess: string,
  fieldLabel: string,
  memberCode: string,
  indent: string,
  context: FunctionGenerationContext
): void {
  if (usesGenericFutureInterface(futureType, context)) {
    context.emitter.emitLine(
      `${indent}if (${futureAccess}->__yo_set_effect_fn) ${futureAccess}->__yo_set_effect_fn((void*)${futureAccess}, ${quoteCString(fieldLabel)}, (void*)${memberCode});`
    );
    return;
  }
  context.emitter.emitLine(
    `${indent}${futureAccess}->__capture.${fieldLabel} = (void*)${memberCode};`
  );
}

/**
 * Generate effect injection code for io.await inside state machines.
 */
function emitEffectInjectionForSM(
  awaitExpr: FnCallExpr,
  futureAccess: string,
  indent: string,
  context: FunctionGenerationContext
): void {
  const futureArg = awaitExpr.args?.[0];
  if (!futureArg?.$?.type) return;

  const futureTraitType = extractFutureTraitFromType(futureArg.$.type);
  const effect = futureTraitType?.isFuture.effect;
  if (!effect) return;

  // Resolve the effect bundle from the surrounding state-machine scope.
  // `using(...)` is gone in explicit-effects, so there is no per-call-site
  // arg list to consult; injection always comes from the active SM env.
  if (isFunctionType(effect.type)) {
    if (effect.type.forallParameters.length > 0) return;
    const handlerCode = resolveEffectFieldFromSMScope(
      effect.label,
      context,
      awaitExpr
    );
    if (handlerCode) {
      emitFutureEffectInjectionLine(
        futureArg.$.type,
        futureAccess,
        effect.label,
        handlerCode,
        indent,
        context
      );
    }
  } else if (isSourceNamespaceType(effect.type) || isStructType(effect.type)) {
    // Phase 7 (SM-internal counterpart): when the awaited future's effect
    // is a struct bundle (e.g. `IoExn`), forward the outer SM's bundle
    // field (the closure's `e` param, stored at `sm->var_<id>_<param>`)
    // into the inner future's SM via its
    // `set_effect("__bundle", &outer_bundle)` callback. The matching
    // set_effect impl on the inner SM copies the struct into its own
    // bundle field. See src/codegen/exprs/async.ts:findBundleFieldName.
    //
    // We don't go through `generateExpr(awaitExpr.args[1])` because the
    // atom-resolution in atom.ts doesn't always rewrite the bundle atom
    // to its SM-level field name from the callsite of an io.await call
    // tree — looking up via the outer SM's variable map directly is
    // both more reliable and avoids generating a temporary copy.
    const outerBundleField = findBundleFieldName(
      futureTraitType,
      context.stateMachineVariables,
      context.stateMachineFieldAliases
    );
    if (outerBundleField) {
      context.emitter.emitLine(
        `${indent}if (${futureAccess}->__yo_set_effect_fn) ${futureAccess}->__yo_set_effect_fn((void*)${futureAccess}, "__bundle", (void*)&sm->${outerBundleField});`
      );
      return;
    }
    emitEffectRecordInjectionForSM(
      effect.type,
      futureArg.$.type,
      futureAccess,
      indent,
      undefined,
      context,
      awaitExpr
    );
  }
}

function emitEffectRecordInjectionForSM(
  sourceNamespaceType: SourceNamespaceType | StructType,
  futureType: Type,
  futureAccess: string,
  indent: string,
  usingArgValue: import("../../value").Value | undefined,
  context: FunctionGenerationContext,
  expr: FnCallExpr
): void {
  for (const field of sourceNamespaceType.fields) {
    if (!isFunctionType(field.type)) continue;
    let memberCode: string | undefined;

    // Inside SM: member is captured in state machine variables
    if (context.stateMachineVariables) {
      for (const [, capturedVar] of context.stateMachineVariables) {
        if (capturedVar.name === field.label && capturedVar.kind === "outer") {
          memberCode = `sm->__capture.${field.label}`;
          break;
        }
      }
    }

    // Resolve from explicit using arg's effect record value
    if (!memberCode && usingArgValue && isStructValue(usingArgValue)) {
      const fieldIndex = sourceNamespaceType.fields.indexOf(field);
      const memberValue = usingArgValue.fields[fieldIndex];
      if (memberValue && isFunctionValue(memberValue)) {
        const funcEntry = context.functions[memberValue.funcId];
        if (funcEntry) {
          memberCode = funcEntry.cName;
        }
      }
    }

    // Resolve from caller's evidence params (transitive forwarding)
    if (!memberCode && context.currentEvidenceParams) {
      for (const ep of context.currentEvidenceParams.values()) {
        if (ep.fieldLabel === field.label) {
          memberCode = ep.cParamName;
          break;
        }
      }
    }

    // Resolve from given bindings in the call environment
    if (!memberCode) {
      const callEnv = expr.$?.env ?? expr.func.$?.env;
      if (callEnv) {
        const implicitVars = getVariablesFromEnvByFilter(
          callEnv,
          (_v) => true /* removed isImplicit check — Phase 2 */
        );
        // Iterate in reverse to get the innermost (most-recently bound) given binding,
        // since getVariablesFromEnvByFilter returns outermost-first.
        for (let i = implicitVars.length - 1; i >= 0; i--) {
          const v = implicitVars[i]!;
          const val = v.value?.[v.value.length - 1];
          if (val && isStructValue(val)) {
            const fieldIdx = val.type.fields.findIndex(
              (f) => f.label === field.label
            );
            if (fieldIdx >= 0) {
              const fieldVal = val.fields[fieldIdx];
              if (fieldVal && isFunctionValue(fieldVal)) {
                const cName = context.functions[fieldVal.funcId]?.cName;
                if (cName) {
                  memberCode = cName;
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (memberCode) {
      emitFutureEffectInjectionLine(
        futureType,
        futureAccess,
        field.label,
        memberCode,
        indent,
        context
      );
    }
  }
}

function resolveEffectFieldFromSMScope(
  fieldLabel: string,
  context: FunctionGenerationContext,
  _expr: FnCallExpr
): string | undefined {
  // Check caller's evidence params
  if (context.currentEvidenceParams) {
    for (const ep of context.currentEvidenceParams.values()) {
      if (ep.fieldLabel === fieldLabel) {
        return ep.cParamName;
      }
    }
  }
  // Check SM capture variables
  if (context.stateMachineVariables) {
    for (const [, capturedVar] of context.stateMachineVariables) {
      if (capturedVar.name === fieldLabel && capturedVar.kind === "outer") {
        return `sm->__capture.${fieldLabel}`;
      }
    }
  }
  return undefined;
}

/**
 * Emits the resume state for a `while` whose suspension point is its CONDITION
 * (`while(io.await(f, io), body)` / `while(io.await(f, io), step, body)`).
 *
 * A body await splits the loop into "before" and "after" halves. A condition
 * await cannot be split that way: the condition is re-evaluated every
 * iteration, so it is the whole loop that has to cycle through the state.
 *
 * `sm->await_result_N` holds THIS iteration's answer when this state runs, so:
 *
 *     if (!result) { leave the loop }
 *     else { body; step; goto while_start }
 *
 * and `while_start` (back in the state that set up the loop) stores the future
 * again — which is exactly what re-evaluates the condition for the next
 * iteration.
 */
function emitWhileConditionAwaitResume(
  whileLoopData: NonNullable<
    ReturnType<
      NonNullable<FunctionGenerationContext["asyncWhileLoopInfo"]>["get"]
    >
  >,
  prevAwait: AwaitPoint,
  analysis: AwaitAnalysisResult,
  captureType: StructType | undefined,
  futureType: SomeType | DynType,
  asyncBlockId: string,
  context: FunctionGenerationContext,
  emitter: FunctionGenerationContext["emitter"]
): void {
  const loopIndex = prevAwait.index;

  emitter.emitLine(
    `      // While loop whose condition awaits — result is this iteration's test`
  );
  emitter.emitLine(`      if (sm->while_loop_${loopIndex}_active) {`);
  emitter.emitLine(`        if (!(sm->await_result_${loopIndex})) {`);
  emitter.emitLine(`          sm->while_loop_${loopIndex}_active = false;`);
  emitter.emitLine(
    `          ASYNC_DEBUG("${asyncBlockId}: While condition false, exiting loop\\n");`
  );
  emitter.emitLine(`        } else {`);

  // Body and step run here, in the state where the condition result is known.
  const previousInStateMachine = context.inAsyncStateMachine;
  const previousStateMachineVariables = context.stateMachineVariables;
  const previousVariableIdRemapping = context.variableIdRemapping;
  const previousPendingDeferredDrops = context.pendingDeferredDrops;
  const previousBreakInfo = context.smWhileBreakInfo;
  const previousContinueInfo = context.smWhileContinueInfo;

  context.inAsyncStateMachine = { futureType };
  context.variableIdRemapping = analysis.variableIdRemapping;
  context.pendingDeferredDrops = [];
  // `break` leaves the loop; `continue` jumps back to the condition store,
  // which is also where a normal iteration ends — so both are plain gotos.
  context.smWhileBreakInfo = {
    label: `after_while_loop_${loopIndex}`,
    activeIndex: loopIndex,
  };
  context.smWhileContinueInfo = {
    label: `while_loop_${loopIndex}_start`,
    emitDropsBeforeGoto: true,
  };

  const combinedVariables = new Map<string, CapturedVariable>();
  for (const v of analysis.capturedVariables) {
    combinedVariables.set(v.id, v);
  }
  if (captureType) {
    for (const field of captureType.fields) {
      combinedVariables.set(field.label, {
        id: field.label,
        name: field.label,
        type: field.type,
        kind: "outer",
        isOwningTheSameRcValueAs: undefined,
      });
    }
  }
  context.stateMachineVariables = combinedVariables;

  const emitExprList = (expr: Expr | undefined): void => {
    if (!expr) return;
    const list =
      expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, "begin")
        ? expr.args
        : [expr];
    for (const sub of list) {
      const code = generateExpr(sub, "          ", context);
      if (!code || !sub.$ || isTempVariableName(sub.$.env.modulePath, code)) {
        continue;
      }
      emitter.emitLine(`          ${code};`);
    }
  };

  emitExprList(whileLoopData.bodyExpr);
  emitExprList(whileLoopData.stepExpr);

  context.inAsyncStateMachine = previousInStateMachine;
  context.stateMachineVariables = previousStateMachineVariables;
  context.variableIdRemapping = previousVariableIdRemapping;
  context.pendingDeferredDrops = previousPendingDeferredDrops;
  context.smWhileBreakInfo = previousBreakInfo;
  context.smWhileContinueInfo = previousContinueInfo;

  emitter.emitLine(
    `          // Loop back: re-store the condition's future for the next iteration`
  );
  emitter.emitLine(`          sm->state = ${loopIndex};`);
  emitter.emitLine(`          goto while_loop_${loopIndex}_start;`);
  emitter.emitLine(`        }`);
  emitter.emitLine(`      }`);
  emitter.emitLine(``);
  emitter.emitLine(`      after_while_loop_${loopIndex}:`);
  emitter.emitLine(``);
}

/**
 * Whether an await's target variable has a state machine struct field.
 *
 * A target that nothing ever reads does not cross a state boundary, so no field
 * is emitted for it (`emitAsyncBlockStructDefinition` filters local variables by
 * `crossBoundaryIds`). Storing the result into `sm-><field>` anyway produced
 * `error: no member named 'var_..._v'` — the result is simply unused, and
 * skipping the store is what the linear-await path already does when there is no
 * target at all.
 *
 * Aliased ids still have storage (an `await_future_N` or an overlapping slot),
 * so they count as present.
 */
function awaitTargetHasStructField(
  targetVariableId: string,
  crossBoundaryIds: Set<string> | undefined,
  context: FunctionGenerationContext
): boolean {
  // No analysis available — keep the previous unconditional behaviour.
  if (!crossBoundaryIds) return true;
  if (crossBoundaryIds.has(targetVariableId)) return true;
  return context.stateMachineFieldAliases?.has(targetVariableId) ?? false;
}
