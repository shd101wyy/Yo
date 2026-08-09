/**
 * state-code-gen.ts
 *
 * Generates code for each state segment in an async state machine.
 * Splits the function body at await points and generates C code for each segment.
 */

import { getVariablesFromEnv } from "../../env";
import type { AwaitPoint } from "../../evaluator/async/await-analysis";
import {
  isIoAsyncCall,
  isIoAwaitCall,
} from "../../evaluator/async/await-analysis";
import { extractTargetVariableId } from "../../evaluator/shared/suspension-analysis";
import {
  BuiltinKeywords,
  ExprTag,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type Expr,
} from "../../expr";
import { exprContainsAwait } from "../../expr-traversal";
import { TokenType } from "../../token";
import type { EnumType } from "../../types/definitions";
import { isEnumType, isUnitType } from "../../types/guards";
import { isTempVariableName } from "../../utils";
import { isBooleanValue } from "../../value";
import { emitAsyncFutureCompletion } from "../exprs/async-completion";
import { generateComptimeValue } from "../exprs/comptime-value";
import { generateExpr } from "../exprs/expr";
import type { FunctionGenerationContext } from "../functions/context";
import {
  containsSuspensionExpr,
  splitBodyAtSuspensionPoints,
} from "../shared/suspension-codegen";
import { getStateMachineFieldName } from "./state-machine";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  getTypeString,
  sanitizeForCIdentifier,
} from "../utils";

/**
 * Represents a code segment between await points.
 */
export interface StateSegment {
  /**
   * The state number this segment represents
   */
  stateNumber: number;

  /**
   * Expressions to execute in this state (before the await/return)
   */
  expressions: Expr[];

  /**
   * The await point at the end of this segment (null for final segment)
   */
  awaitPoint: AwaitPoint | null;

  /**
   * Set when this segment's await sits in a position the body cannot be SPLIT
   * at — a `cond`/`if` condition, or a `match` scrutinee. The enclosing
   * expression has been moved to the NEXT segment; this segment only stores the
   * future.
   */
  storeFutureForAwait?: AwaitPoint;

  /**
   * Set on the segment that RECEIVED such an expression. While generating this
   * segment, the await stands for `sm->await_result_<index>`, which the state
   * prologue has already filled in.
   */
  hoistedAwaitPoint?: AwaitPoint;
}

/**
 * Splits a function body into segments at await points.
 * Each segment contains the expressions to execute before reaching the next await.
 *
 * Thin wrapper around the shared `splitBodyAtSuspensionPoints`, mapping
 * the generic `suspensionPoint` field to the async-specific `awaitPoint`.
 */
export function splitIntoStateSegments(
  body: Expr,
  awaitPoints: AwaitPoint[]
): StateSegment[] {
  const shared = splitBodyAtSuspensionPoints(body, awaitPoints, {
    shouldSkipBody: isIoAsyncCall,
    handleReturnStatements: true,
    handleSequentialSuspensions: true,
  });

  const segments = shared.map((seg) => ({
    stateNumber: seg.stateNumber,
    expressions: seg.expressions,
    awaitPoint: seg.suspensionPoint,
  }));

  // When the last segment has an awaitPoint (e.g., the body is a single cond
  // with an await in one branch), we need an additional completion segment.
  // Without it, the state machine has no state to transition to after the await
  // completes or when the non-await cond branch is taken.
  if (
    segments.length > 0 &&
    segments[segments.length - 1]!.awaitPoint !== null
  ) {
    segments.push({
      stateNumber: segments.length,
      expressions: [],
      awaitPoint: null,
    });
  }

  hoistNonSplittableAwaits(segments);

  return segments;
}

/**
 * Moves expressions whose await sits in a non-splittable position into the next
 * segment.
 *
 * A branch-body await can end a state: everything before it runs, the state
 * suspends, the rest of the branch resumes in the next state. An await in a
 * `cond`/`if` CONDITION or a `match` SCRUTINEE cannot, because it is evaluated
 * before any branch is chosen — there is no "before" and "after" to split into.
 *
 * The equivalent is to hoist it across the state boundary, which is exactly what
 * the hand-written form does:
 *
 *     ready := io.await(f, io);      // state N ends here
 *     cond(ready => ..., true => ...) // state N+1
 *
 * So: leave the await point on segment N (its future store and state transition
 * are unchanged), and move the enclosing expression to the front of segment N+1,
 * where `sm->await_result_N` is live and stands in for the await.
 */
function hoistNonSplittableAwaits(segments: StateSegment[]): void {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const awaitPoint = segment.awaitPoint;
    if (!awaitPoint || segment.expressions.length === 0) {
      continue;
    }

    const lastIndex = segment.expressions.length - 1;
    const enclosing = segment.expressions[lastIndex]!;
    if (!awaitIsInNonSplittablePosition(enclosing, awaitPoint)) {
      continue;
    }

    const next = segments[i + 1];
    if (!next) {
      continue;
    }

    segment.expressions.splice(lastIndex, 1);
    segment.storeFutureForAwait = awaitPoint;
    next.expressions.unshift(enclosing);
    next.hoistedAwaitPoint = awaitPoint;
  }
}

/**
 * True when `awaitPoint`'s await sits somewhere in `expr` that the state
 * machine cannot split at: a `cond`/`if` branch condition, or a `match`
 * scrutinee.
 */
function awaitIsInNonSplittablePosition(
  expr: Expr,
  awaitPoint: AwaitPoint
): boolean {
  if (expr.tag !== ExprTag.FnCall) {
    return false;
  }

  if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return awaitIsInFirstCondPosition(expr, awaitPoint);
  }

  // `if` is a macro over `cond` — its condition only becomes visible there.
  // An `if` condition is always the first branch, so it always hoists.
  if (
    exprIsFunctionCallOf(expr, BuiltinKeywords.if) &&
    expr.$?.macroExpansion
  ) {
    return awaitIsInFirstCondPosition(expr.$.macroExpansion, awaitPoint);
  }

  if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    // The scrutinee is evaluated exactly once, before any arm, so hoisting it
    // is always exact — subject to the same "must BE the await" limit above.
    return exprIsBareAwait(expr.args[0], awaitPoint);
  }

  return false;
}

/**
 * Checks if an expression tree contains a specific await expression.
 * Skips nested async blocks (their awaits belong to the inner state machine).
 *
 * Thin wrapper around the shared `containsSuspensionExpr`.
 */
export function containsAwaitExpr(expr: Expr, awaitExpr: Expr): boolean {
  return containsSuspensionExpr(expr, awaitExpr, isIoAsyncCall);
}

/**
 * Generates C code for a state segment.
 * This handles code generation differently for state machine context:
 * - Variable assignments go to sm->var_xxx
 * - Await expressions trigger state transitions
 */
export function generateStateSegmentCode(
  segment: StateSegment,
  indent: string,
  context: FunctionGenerationContext,
  captureLastExprResult: boolean = false
): void {
  // This segment received an expression whose await was hoisted out of a
  // non-splittable position. `sm->await_result_N` is live here, so the await
  // node stands for that value — see generateAwait (codegen/exprs/await.ts),
  // which without this emits "" and produces `sm->var_N = ;`.
  const hoisted = segment.hoistedAwaitPoint;
  let previousSubstitution: string | undefined;
  let hadSubstitution = false;
  if (hoisted) {
    if (!context.awaitResultSubstitutions) {
      context.awaitResultSubstitutions = new Map();
    }
    const awaitExpr = hoisted.expr as Expr;
    hadSubstitution = context.awaitResultSubstitutions.has(awaitExpr);
    previousSubstitution = context.awaitResultSubstitutions.get(awaitExpr);
    context.awaitResultSubstitutions.set(
      awaitExpr,
      `sm->await_result_${hoisted.index}`
    );
  }

  try {
    generateStateSegmentExpressions(
      segment,
      indent,
      context,
      captureLastExprResult
    );
  } finally {
    if (hoisted) {
      const awaitExpr = hoisted.expr as Expr;
      if (hadSubstitution) {
        context.awaitResultSubstitutions!.set(awaitExpr, previousSubstitution!);
      } else {
        context.awaitResultSubstitutions!.delete(awaitExpr);
      }
    }
  }

  // This segment's await was hoisted: the enclosing expression moved to the
  // next segment, so nothing above emitted the future store. Emit it here —
  // the state transition the caller appends still needs `await_future_N`.
  if (segment.storeFutureForAwait) {
    emitHoistedAwaitFutureStore(segment.storeFutureForAwait, indent, context);
  }
}

function generateStateSegmentExpressions(
  segment: StateSegment,
  indent: string,
  context: FunctionGenerationContext,
  captureLastExprResult: boolean
): void {
  const emitter = context.emitter;

  for (let i = 0; i < segment.expressions.length; i++) {
    const expr = segment.expressions[i]!;
    const isLastExpr = i === segment.expressions.length - 1;

    // Check if this expression contains the await for this segment
    const isAwaitExpr =
      segment.awaitPoint &&
      containsAwaitExpr(expr, segment.awaitPoint.expr as Expr);

    // Also check if this is a while/cond/match that contains await (even if it's not THE await expr)
    const isWhileOrCondWithAwait =
      segment.awaitPoint &&
      expr.tag === ExprTag.FnCall &&
      (exprIsFunctionCallOf(expr, BuiltinKeywords.while) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.cond) ||
        exprIsFunctionCallOf(expr, BuiltinKeywords.match)) &&
      exprContainsAwait(expr);

    if ((isAwaitExpr || isWhileOrCondWithAwait) && segment.awaitPoint) {
      // This expression contains an await - handle specially
      generateAwaitExpression(
        expr,
        segment.awaitPoint,
        segment.stateNumber,
        indent,
        context
      );
    } else if (isLastExpr && captureLastExprResult) {
      // Last expression in final segment - capture its value in sm->result
      // For value-type Futures, the result field is directly in the state machine struct
      const code = generateExpr(expr, indent, context);
      if (code) {
        emitter.emitLine(`${indent}// Store final expression result`);
        emitter.emitLine(`${indent}sm->result = ${code};`);
      }
    } else {
      // Regular expression - generate normally
      const code = generateExpr(expr, indent, context);
      // Skip empty code, expressions without metadata, and temp variable references
      if (!code || !expr.$ || isTempVariableName(expr.$.env.modulePath, code)) {
        // Skip
      } else {
        emitter.emitLine(`${indent}${code};`);
      }
    }
  }
}

/**
 * Generates code for an expression containing an await.
 * This handles the await specially by:
 * 1. Generating code up to the await
 * 2. Calling the async function and storing the Future
 * 3. Checking if the Future is ready and either continuing or yielding
 */
export function generateAwaitExpression(
  expr: Expr,
  awaitPoint: AwaitPoint,
  _stateNumber: number,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Check if this is a standalone await expression: io.await(futureExpr)
  if (expr.tag === ExprTag.FnCall && isIoAwaitCall(expr)) {
    // This is a standalone await: io.await(futureExpr)
    const futureExpr = expr.args[0];

    if (!futureExpr) {
      emitter.emitLine(`${indent}// Error: await without argument`);
      return;
    }

    // If this await doesn't have a futureVariableId (e.g., pattern-matched variable),
    // we need to store the Future value into await_future_X field
    if (awaitPoint.futureVariableId === undefined) {
      const futureCode = generateExpr(futureExpr, indent, context);
      emitter.emitLine(
        `${indent}// Store pattern-matched Future for await ${awaitPoint.index}`
      );
      emitter.emitLine(
        `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
      );
    } else {
      // The future is already stored in a state machine variable field
      emitter.emitLine(
        `${indent}// Prepare for await (future already stored in state machine variable)`
      );
    }

    return;
  }

  // Handle assignment with await: varName := await(futureExpr)
  if (expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, ":=")) {
    // This is an assignment
    const varNameExpr = expr.args[0];
    const valueExpr = expr.args[1];

    if (!varNameExpr || !valueExpr) {
      emitter.emitLine(`${indent}// Error: Invalid assignment expression`);
      return;
    }

    // Check if the value is an await expression
    if (valueExpr.tag === ExprTag.FnCall && isIoAwaitCall(valueExpr)) {
      // This is: varName := await(futureExpr)
      const futureExpr = valueExpr.args[0];

      if (!futureExpr) {
        emitter.emitLine(`${indent}// Error: await without argument`);
        return;
      }

      // Get the variable name
      const varName = varNameExpr.token?.value;
      if (!varName || !varNameExpr.$) {
        emitter.emitLine(`${indent}// Error: Invalid variable name`);
        return;
      }

      // If this await doesn't have a futureVariableId (e.g., awaiting a function call result),
      // we need to store the Future value into await_future_X field
      if (awaitPoint.futureVariableId === undefined) {
        const futureCode = generateExpr(futureExpr, indent, context);
        emitter.emitLine(
          `${indent}// Store Future for await (variable: ${varName})`
        );
        emitter.emitLine(
          `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
        );
      } else {
        // The future is already stored in a state machine variable field
        emitter.emitLine(
          `${indent}// Store Future for await (variable: ${varName}) - future already in state machine`
        );
      }

      return;
    }

    // Check if the value is a cond with await in branches
    if (
      valueExpr.tag === ExprTag.FnCall &&
      exprIsFunctionCallOf(valueExpr, BuiltinKeywords.cond)
    ) {
      // This is: varName := cond(... await ...)
      // Get the variable ID for the target variable
      let targetVarId: string | undefined;
      if (
        varNameExpr.tag === ExprTag.Atom &&
        varNameExpr.token.type === TokenType.Identifier &&
        varNameExpr.$
      ) {
        const varName = varNameExpr.token.value;
        const variables = getVariablesFromEnv(varNameExpr.$.env, varName);
        if (variables.length > 0) {
          targetVarId = variables[variables.length - 1]!.id;
        }
      }
      // First generate the cond (which will store future in await_future_X)
      generateCondWithAwait(
        valueExpr,
        awaitPoint,
        indent,
        context,
        targetVarId
      );
      return;
    }

    // Check if the value is a match with await in branches
    if (
      valueExpr.tag === ExprTag.FnCall &&
      exprIsFunctionCallOf(valueExpr, BuiltinKeywords.match)
    ) {
      // This is: varName := match(... await ...)
      // Get the variable ID for the target variable
      let targetVarId: string | undefined;
      if (
        varNameExpr.tag === ExprTag.Atom &&
        varNameExpr.token.type === TokenType.Identifier &&
        varNameExpr.$
      ) {
        const varName = varNameExpr.token.value;
        const variables = getVariablesFromEnv(varNameExpr.$.env, varName);
        if (variables.length > 0) {
          targetVarId = variables[variables.length - 1]!.id;
        }
      }
      // First generate the match (which will store future in await_future_X)
      generateMatchWithAwait(
        valueExpr,
        awaitPoint,
        indent,
        context,
        targetVarId
      );
      return;
    }
  }

  // Handle assignment with cond/match containing await: target = cond/match(... await ...)
  if (expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, "=")) {
    const targetExpr = expr.args[0];
    const valueExpr = expr.args[1];

    if (targetExpr && valueExpr) {
      if (
        valueExpr.tag === ExprTag.FnCall &&
        exprIsFunctionCallOf(valueExpr, BuiltinKeywords.cond)
      ) {
        const targetCode = generateExpr(targetExpr, indent, context);
        generateCondWithAwait(
          valueExpr,
          awaitPoint,
          indent,
          context,
          undefined,
          targetCode || undefined
        );
        return;
      }

      if (
        valueExpr.tag === ExprTag.FnCall &&
        exprIsFunctionCallOf(valueExpr, BuiltinKeywords.match)
      ) {
        const targetCode = generateExpr(targetExpr, indent, context);
        generateMatchWithAwait(
          valueExpr,
          awaitPoint,
          indent,
          context,
          undefined,
          targetCode || undefined
        );
        return;
      }
    }
  }

  // Handle cond expression with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
  ) {
    generateCondWithAwait(expr, awaitPoint, indent, context);
    return;
  }

  // Handle match expression with await in branches
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.match)
  ) {
    generateMatchWithAwait(expr, awaitPoint, indent, context);
    return;
  }

  // Handle while loop with await in body
  if (
    expr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.while)
  ) {
    generateWhileWithAwait(expr, awaitPoint, indent, context);
    return;
  }

  // `if` is a macro over `cond`; the branch structure only becomes visible in
  // its expansion, so retry there before giving up. Without this an `await`
  // under an `if` gets no state transition at all, even though `cond` — which
  // is all an `if` is — is fully supported.
  //
  // Only recurse when the await is in a branch VALUE. In CONDITION position the
  // `cond` handler cannot split it either, so fall through to the hoist below
  // and keep reporting against the `if` the user actually wrote.
  if (
    expr.$?.macroExpansion &&
    !awaitIsInCondPosition(expr.$.macroExpansion, awaitPoint)
  ) {
    generateAwaitExpression(
      expr.$.macroExpansion,
      awaitPoint,
      _stateNumber,
      indent,
      context
    );
    return;
  }

  // Nothing here can generate a correct state transition for this shape. The
  // caller unconditionally emits the await machinery next (reading
  // `sm->await_future_N`), and only the handlers above ever assign that field —
  // so returning quietly produces a NULL dereference at runtime. Fail loudly
  // instead: a compile error is always better than a segfaulting binary.
  throw new Error(unsupportedAwaitMessage(expr, awaitPoint));
}

/**
 * Emits the future store for an await hoisted out of a non-splittable position.
 *
 * The enclosing expression now lives in the next segment, so this segment ends
 * with just the store — the state transition the caller appends reads
 * `sm->await_future_N` exactly as it would for any other await.
 */
function emitHoistedAwaitFutureStore(
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  emitter.emitLine(
    `${indent}// Await in non-splittable position (cond/if condition, or match`
  );
  emitter.emitLine(
    `${indent}// scrutinee) — store the future; the enclosing expression runs in`
  );
  emitter.emitLine(
    `${indent}// the next state, reading await_result_${awaitPoint.index}.`
  );

  if (awaitPoint.futureVariableId !== undefined) {
    // Already held by a state machine variable field.
    return;
  }

  const awaitExpr = awaitPoint.expr as Expr;
  if (awaitExpr.tag !== ExprTag.FnCall) {
    return;
  }
  const futureExpr = awaitExpr.args[0];
  if (!futureExpr) {
    return;
  }

  const futureCode = generateExpr(futureExpr, indent, context);
  emitter.emitLine(
    `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
  );
}

/**
 * True when the await sits in the condition of the FIRST branch of `condExpr`.
 *
 * Only the first condition can be hoisted into the previous state. `cond`
 * evaluates its conditions lazily, in order, so hoisting a LATER condition
 * would evaluate its await even when an earlier branch matches — a silent
 * change of meaning (and of side effects), not just of timing. The first
 * condition is always evaluated, so hoisting it is exact.
 *
 * `condExpr` must be a `cond` — for an `if`, pass its `$.macroExpansion`.
 */
function awaitIsInFirstCondPosition(
  condExpr: Expr,
  awaitPoint: AwaitPoint
): boolean {
  if (
    condExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(condExpr, BuiltinKeywords.cond)
  ) {
    return false;
  }

  const firstPair = condExpr.args[0];
  if (
    !firstPair ||
    firstPair.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(firstPair, "=>")
  ) {
    return false;
  }

  // The await must BE the condition, not merely appear inside it. Substituting
  // the extracted result into a larger expression (`!(io.await(f, io))`) makes
  // codegen ask for helper specialisations the collection pass never saw, so
  // the C references undeclared functions. Awaits nested inside a larger
  // expression are unsupported everywhere — `b := !(io.await(f, io))` fails the
  // same way — so this is a general limit, not one this hoist introduces.
  const condition = firstPair.args[0];
  return exprIsBareAwait(condition, awaitPoint);
}

/**
 * True when `expr` IS this await point's `io.await(...)` call, ignoring the
 * single-expression `begin` wrappers the evaluator puts around `cond`
 * conditions and `match` scrutinees.
 *
 * "Is", not "contains": substituting the extracted result into a LARGER
 * expression (`!(io.await(f, io))`) asks codegen for helper specialisations the
 * collection pass never saw, and the C then calls undeclared functions. Awaits
 * nested inside a bigger expression are unsupported everywhere — plain
 * `b := !(io.await(f, io))` fails the same way — so this is a pre-existing
 * limit, not one the hoist introduces.
 */
export function exprIsBareAwait(
  expr: Expr | undefined,
  awaitPoint: AwaitPoint
): boolean {
  let current = expr;
  while (
    current &&
    current.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(current, BuiltinKeywords.begin) &&
    current.args.length === 1
  ) {
    current = current.args[0];
  }
  return (
    current !== undefined &&
    isIoAwaitCall(current) &&
    containsAwaitExpr(current, awaitPoint.expr as Expr)
  );
}

/**
 * True when `awaitPoint`'s await sits in a branch CONDITION of `condExpr`
 * (rather than in a branch value, which is what the splitter supports).
 *
 * `condExpr` must be a `cond` — for an `if`, pass its `$.macroExpansion`.
 */
function awaitIsInCondPosition(
  condExpr: Expr,
  awaitPoint: AwaitPoint
): boolean {
  if (
    condExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(condExpr, BuiltinKeywords.cond)
  ) {
    return false;
  }

  for (const pairExpr of condExpr.args) {
    if (
      pairExpr.tag !== ExprTag.FnCall ||
      !exprIsFunctionCallOf(pairExpr, "=>")
    ) {
      continue;
    }
    const condition = pairExpr.args[0];
    if (condition && containsAwaitExpr(condition, awaitPoint.expr as Expr)) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the diagnostic for an await that appears in a position the async state
 * machine cannot split at.
 *
 * Two distinct causes, with two different fixes, so they get two messages:
 *
 *  - CONDITION position — `if(io.await(f, io), ...)`, `cond(io.await(f, io) => ...)`,
 *    `match(io.await(f, io), ...)`. Splitting here needs a state per condition,
 *    which the state machine does not model. Fix: hoist into a local.
 *  - `if` BODY — `if(c, { io.await(f, io) })`. `if` is a macro over `cond`, and
 *    only `cond` carries the branch structure the splitter needs. Fix: write the
 *    `cond` directly (which is fully supported, in both compilers).
 */
function unsupportedAwaitMessage(expr: Expr, awaitPoint: AwaitPoint): string {
  const funcName =
    expr.tag === ExprTag.FnCall && expr.func.tag === ExprTag.Atom
      ? expr.func.token?.value
      : undefined;

  const token =
    (expr.tag === ExprTag.FnCall ? expr.func.token : expr.token) ??
    (awaitPoint.expr as Expr).token;
  const where = token
    ? `${token.modulePath}:${token.position.row + 1}:${token.position.column + 1}: `
    : "";

  const isIf = exprIsFunctionCallOf(expr, BuiltinKeywords.if);

  // For an `if`, the branch structure lives in the `cond` it expands to — read
  // it only to tell "await in the condition" from "await in a body", which need
  // different fixes. Nothing is generated from the expansion.
  const inConditionalPosition = isIf
    ? expr.$?.macroExpansion !== undefined &&
      awaitIsInCondPosition(expr.$.macroExpansion, awaitPoint)
    : awaitIsInCondPosition(expr, awaitPoint) ||
      exprIsFunctionCallOf(expr, BuiltinKeywords.match);

  if (inConditionalPosition) {
    // An await that IS the first condition (or a `match` scrutinee) is hoisted
    // into the previous state and never reaches here. What is left is an await
    // that is nested inside a condition, or one in a later `cond` branch.
    return (
      `${where}\`io.await\` in a \`${funcName}\` condition inside an ` +
      `\`io.async\` block must BE the first condition — it cannot be nested ` +
      `inside a larger expression, and it cannot be in a later branch.\n` +
      `A later branch's condition is only evaluated if the earlier ones fail, ` +
      `so hoisting it would await even when an earlier branch matches.\n` +
      `Bind it to a local first:\n` +
      `    ready := io.await(f, io);\n` +
      `    ${isIf ? "if(!(ready), { ... })" : "cond(c1 => ..., !(ready) => ..., true => ...)"}\n` +
      `(note this evaluates the await unconditionally, which is why the ` +
      `compiler will not do it for you).`
    );
  }

  if (isIf) {
    return (
      `${where}\`io.await\` is not supported inside an \`if\` body within an ` +
      `\`io.async\` block.\n` +
      `\`if\` is a macro over \`cond\`, and only \`cond\` carries the branch ` +
      `structure the state machine splits on. Write the \`cond\` directly:\n` +
      `    cond(\n` +
      `      c => { io.await(f, io); },\n` +
      `      true => ()\n` +
      `    );`
    );
  }

  return (
    `${where}\`io.await\` is not supported in this position inside an ` +
    `\`io.async\` block (expression: ${expr.tag}` +
    `${funcName ? `, function: \`${funcName}\`` : ""}).\n` +
    `Hoist it into a local first: \`result := io.await(f, io);\``
  );
}

/**
 * The variable a cond/match ARM binds its own `io.await` result to — the `a` in
 * `.Ok(_) => { a := io.await(f, io); … }`.
 *
 * Several arms collapse onto ONE await point (only one arm can run, so one
 * suspension state suffices), and the await point carries a single
 * `targetVariableId`. That is fine for the arm the analysis happened to visit
 * first and WRONG for every other one: their bindings were never assigned from
 * `sm->await_result_N` and read a zero-initialised struct field. The C compiled
 * and the program ran — it simply produced `false`/`0`.
 *
 * Mirrors `extractTargetVariableId`'s contract: the target only exists when the
 * await call is the direct RHS of a `:=`. Does not descend into a nested
 * `io.async` body — those awaits belong to that block's own state machine.
 */
function findBranchAwaitTargetVariableId(expr: Expr): string | undefined {
  let found: string | undefined;
  const visit = (e: Expr): void => {
    if (found !== undefined || e.tag !== ExprTag.FnCall) return;
    if (isIoAsyncCall(e)) return;
    if (exprIsFunctionCallOf(e, ":=")) {
      const rhs = e.args[1];
      if (rhs && rhs.tag === ExprTag.FnCall && isIoAwaitCall(rhs)) {
        const id = extractTargetVariableId(e);
        if (id !== undefined) {
          found = id;
          return;
        }
      }
    }
    if (e.func) visit(e.func);
    for (const arg of e.args) visit(arg);
  };
  visit(expr);
  return found;
}

/**
 * Allocate `count` DISTINCT `sm->cond_branch_N` dispatch codes for one
 * `cond`/`match` that contains an await.
 *
 * The code used to be the arm's own index (`0`, `1`, …). Every `cond`/`match`
 * that awaits under the same await point shares ONE
 * `asyncCondBranchInfo` entry and therefore one resume `switch`, so two sibling
 * or nested matches both numbering their arms from 0 emitted `case 0:` twice
 * and `case 1:` three times — C rejects the function outright ("duplicate case
 * value"). It takes an OUTER match whose arms each contain an inner match with
 * an await to trigger, which is why it stayed invisible until `build`/`fetch`/
 * `install` were wired to a subcommand (plans/P1_CLI_PARITY.md §1).
 *
 * Handing every arm a code unique within the function makes the writer
 * (`sm->cond_branch_N = <code>`) and the reader (`case <code>:`) agree while
 * keeping distinct matches distinguishable at runtime.
 */
function allocCondBranchCodes(
  context: FunctionGenerationContext,
  count: number
): number {
  const base = context.condBranchCaseSeq ?? 0;
  context.condBranchCaseSeq = base + Math.max(count, 1);
  return base;
}

/**
 * Generates async-aware code for a cond expression containing await in branches.
 * Strategy:
 * 1. Evaluate conditions and determine which branch to take
 * 2. Store which branch was chosen in state machine (for continuation in next state)
 * 3. Spawn the Future from that branch
 * 4. In next state, extract result and execute remaining code from chosen branch
 */
function generateCondWithAwait(
  condExpr: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext,
  targetVariableId?: string, // Variable that receives the cond result
  targetAssignmentCode?: string // C code for assignment target (for `= (target, cond(...))`)
): void {
  const emitter = context.emitter;
  // Dispatch codes unique within this function — see allocCondBranchCodes.
  const condBranchBase = allocCondBranchCodes(
    context,
    condExpr.tag === ExprTag.FnCall ? condExpr.args.length : 1
  );

  // Type guard - condExpr should be a FnCall
  if (
    condExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(condExpr, BuiltinKeywords.cond)
  ) {
    emitter.emitLine(`${indent}// Error: Expected cond expression`);
    return;
  }

  // cond is represented as: cond(cond1 => value1, cond2 => value2, ...)
  // Each arg is a pair created with =>
  const args = condExpr.args;
  if (args.length === 0) {
    emitter.emitLine(`${indent}// Error: cond must have at least one branch`);
    return;
  }

  // An await in a branch CONDITION is not split here — it is hoisted into the
  // previous state by `hoistNonSplittableAwaits`, so by the time this runs the
  // condition reads `sm->await_result_N` and looks like any other condition.
  // Reaching here with one still in place means the hoist did not fire, and
  // generating on would emit an empty operand (`tmp = ;`).
  if (
    awaitIsInCondPosition(condExpr, awaitPoint) &&
    !context.awaitResultSubstitutions?.has(awaitPoint.expr as Expr)
  ) {
    throw new Error(unsupportedAwaitMessage(condExpr, awaitPoint));
  }

  // Store branch info for later generation
  const branchesWithAwait: Array<{
    index: number;
    value: Expr;
    hasAwait: boolean;
    remainingExprs?: Expr[]; // Expressions after the await in this branch
    deferredDropExpressions?: Expr[]; // Drop expressions for the branch's begin block
    awaitTargetVariableId?: string; // This branch's own `x := io.await(…)` binding
  }> = [];

  // First pass: check for compile-time constant conditions to optimize dead branches.
  // If the evaluator determined a branch condition is compile-time false, skip it.
  // If a branch condition is compile-time true, only generate that branch.
  let firstNonFalseBranchIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const pairExpr = args[i]!;
    if (
      pairExpr.tag === ExprTag.FnCall &&
      exprIsFunctionCallOf(pairExpr, "=>")
    ) {
      const condition = pairExpr.args[0];
      if (condition) {
        const isFalse =
          isBooleanValue(condition.$?.value) &&
          condition.$.value.value === false;
        if (!isFalse) {
          firstNonFalseBranchIndex = i;
          break;
        }
      }
    }
  }

  // Check if the first non-false branch is a compile-time true
  let canOptimizeToDirect = false;
  if (firstNonFalseBranchIndex >= 0) {
    const firstArg = args[firstNonFalseBranchIndex]!;
    if (
      firstArg.tag === ExprTag.FnCall &&
      exprIsFunctionCallOf(firstArg, "=>")
    ) {
      const firstCondition = firstArg.args[0];
      if (
        firstCondition &&
        isBooleanValue(firstCondition.$?.value) &&
        firstCondition.$.value.value === true
      ) {
        canOptimizeToDirect = true;
      }
    }
  }

  // If the condition is compile-time known, only generate the taken branch
  if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
    const pairExpr = args[firstNonFalseBranchIndex]!;
    const value = exprIsFunctionCall(pairExpr) ? pairExpr.args[1] : undefined;
    if (value) {
      const branchContainsAwait = branchHasAwait(value);
      if (branchContainsAwait) {
        const remainingExprs = generateCondBranchWithAwait(
          value,
          awaitPoint,
          indent,
          context
        );
        // Check if the await was inside a while loop
        const whileInfo = context.asyncWhileLoopInfo?.get(awaitPoint.index);
        if (whileInfo && remainingExprs.length > 0) {
          const innerEntry = context.asyncCondBranchInfo?.get(awaitPoint.index);
          const hasNestedCondConflict =
            innerEntry?.branches.some(
              (b) =>
                b.hasAwait && b.remainingExprs && b.remainingExprs.length > 0
            ) ?? false;
          whileInfo.condBranchPostWhileExprs = {
            branchIndex: firstNonFalseBranchIndex,
            condBranchFieldIndex: awaitPoint.index,
            exprs: remainingExprs,
            deferredDropExpressions: value.$?.deferredDropExpressions,
            skipCondBranchCheck: hasNestedCondConflict,
          };
          branchesWithAwait.push({
            index: firstNonFalseBranchIndex,
            value,
            hasAwait: true,
            remainingExprs: [],
            deferredDropExpressions: value.$?.deferredDropExpressions,
          });
        } else {
          branchesWithAwait.push({
            index: firstNonFalseBranchIndex,
            value,
            hasAwait: true,
            remainingExprs,
            deferredDropExpressions: value.$?.deferredDropExpressions,
          });
        }
      } else {
        if (
          shouldEmitAsyncBranchCompletion(
            condExpr,
            value,
            context,
            targetVariableId,
            targetAssignmentCode
          )
        ) {
          emitNonAwaitBranchAsyncCompletion(value, indent, context);
        } else if (
          exprIsFunctionCall(value) &&
          exprIsFunctionCallOf(value, BuiltinKeywords.begin)
        ) {
          const beginArgs = value.args;
          for (let j = 0; j < beginArgs.length; j++) {
            const arg = beginArgs[j]!;
            const argCode = generateExpr(arg, indent, context);
            if (argCode === "break" && awaitPoint.isInsideWhile) {
              emitter.emitLine(
                `${indent}sm->while_loop_${awaitPoint.index}_active = false;`
              );
              emitter.emitLine(
                `${indent}goto while_loop_${awaitPoint.index}_end;`
              );
            } else {
              const isControlFlow =
                argCode === "break" ||
                argCode === "continue" ||
                argCode?.includes("return");
              if (
                argCode &&
                (isControlFlow ||
                  (arg.$ && !isTempVariableName(arg.$.env.modulePath, argCode)))
              ) {
                emitter.emitLine(`${indent}${argCode};`);
              }
            }
          }
          if (value.$?.deferredDropExpressions) {
            for (const dropExpr of value.$.deferredDropExpressions) {
              const dropCode = generateExpr(dropExpr, indent, context);
              if (dropCode) {
                emitter.emitLine(`${indent}${dropCode};`);
              }
            }
          }
        } else {
          const code = generateExpr(value, indent, context);
          if (code === "break" && awaitPoint.isInsideWhile) {
            emitter.emitLine(
              `${indent}sm->while_loop_${awaitPoint.index}_active = false;`
            );
            emitter.emitLine(
              `${indent}goto while_loop_${awaitPoint.index}_end;`
            );
          } else {
            const isControlFlow =
              code === "break" ||
              code === "continue" ||
              code?.includes("return");
            if (
              code &&
              (isControlFlow ||
                (value.$ && !isTempVariableName(value.$.env.modulePath, code)))
            ) {
              emitter.emitLine(`${indent}${code};`);
            }
          }
        }
        branchesWithAwait.push({
          index: firstNonFalseBranchIndex,
          value,
          hasAwait: false,
        });
      }
    }

    if (!context.asyncCondBranchInfo) {
      context.asyncCondBranchInfo = new Map();
    }
    // Don't overwrite if a nested cond already stored branch info with actual
    // remaining code. The inner cond's entry is the one that matters for the
    // resume state's switch — it's closest to the actual await point.
    const existingInner = context.asyncCondBranchInfo.get(awaitPoint.index);
    const innerHasRemainingCode =
      existingInner?.branches.some(
        (b) => b.hasAwait && b.remainingExprs && b.remainingExprs.length > 0
      ) ?? false;
    if (!innerHasRemainingCode) {
      context.asyncCondBranchInfo.set(awaitPoint.index, {
        branches: branchesWithAwait,
        targetVariableId,
        targetAssignmentCode,
      });
    }
    return;
  }

  // Generate if-else chain
  let hasEmittedBranch = false;
  let elseBlockDepth = 0;
  let currentIndent = indent;
  for (let i = 0; i < args.length; i++) {
    const pairExpr = args[i]!;

    // Each branch is a => expression: condition => value
    if (
      pairExpr.tag !== ExprTag.FnCall ||
      !exprIsFunctionCallOf(pairExpr, "=>")
    ) {
      emitter.emitLine(`${currentIndent}// Error: Expected => pair in cond`);
      continue;
    }

    const condition = pairExpr.args[0];
    const value = pairExpr.args[1];

    if (!condition || !value) {
      emitter.emitLine(`${currentIndent}// Error: Invalid pair in cond`);
      continue;
    }

    // Skip compile-time false conditions
    if (
      isBooleanValue(condition.$?.value) &&
      condition.$.value.value === false
    ) {
      continue;
    }

    // For subsequent branches, wrap in else { ... } to prevent condition
    // pre-computation (begin blocks) from breaking the if-else chain.
    if (hasEmittedBranch) {
      emitter.emitLine(`${currentIndent}else {`);
      elseBlockDepth++;
      currentIndent += "  ";
    }

    const condCode =
      i === args.length - 1 &&
      condition.tag === ExprTag.Atom &&
      condition.token?.value === "true"
        ? null // Last condition is 'true' - no need to check
        : generateExpr(condition, currentIndent, context);

    if (condCode) {
      emitter.emitLine(`${currentIndent}if (${condCode}) {`);
    } else {
      emitter.emitLine(`${currentIndent}{`);
    }
    hasEmittedBranch = true;

    const valueIndent = `${currentIndent}  `;

    // Check if this branch contains an await
    const branchContainsAwait = branchHasAwait(value);

    if (branchContainsAwait) {
      // Store which branch was taken
      emitter.emitLine(
        `${valueIndent}sm->cond_branch_${awaitPoint.index} = ${condBranchBase + i};`
      );
      // This branch contains an await - generate code to spawn and store Future
      const remainingExprs = generateCondBranchWithAwait(
        value,
        awaitPoint,
        valueIndent,
        context
      );
      // Check if the await was inside a while loop in this branch.
      // If so, post-while-loop expressions should only run after the loop exits,
      // not on every resume from the in-loop await.
      const whileInfo = context.asyncWhileLoopInfo?.get(awaitPoint.index);
      if (whileInfo && remainingExprs.length > 0) {
        // Check if a nested cond already stored branch info at the same key.
        // If so, the nested cond's cond_branch_N writes will overwrite this
        // cond's writes, making the sm->cond_branch_N guard unreliable.
        const innerEntry = context.asyncCondBranchInfo?.get(awaitPoint.index);
        const hasNestedCondConflict =
          innerEntry?.branches.some(
            (b) => b.hasAwait && b.remainingExprs && b.remainingExprs.length > 0
          ) ?? false;
        whileInfo.condBranchPostWhileExprs = {
          branchIndex: condBranchBase + i,
          condBranchFieldIndex: awaitPoint.index,
          exprs: remainingExprs,
          deferredDropExpressions: value.$?.deferredDropExpressions,
          skipCondBranchCheck: hasNestedCondConflict,
        };
        branchesWithAwait.push({
          index: condBranchBase + i,
          value,
          hasAwait: true,
          remainingExprs: [], // Post-while-loop exprs are in while loop info
          deferredDropExpressions: value.$?.deferredDropExpressions,
          awaitTargetVariableId: findBranchAwaitTargetVariableId(value),
        });
      } else {
        // Store branch info with remaining expressions and deferred drops from the branch's begin block
        branchesWithAwait.push({
          index: condBranchBase + i,
          value,
          hasAwait: true,
          remainingExprs,
          deferredDropExpressions: value.$?.deferredDropExpressions,
          awaitTargetVariableId: findBranchAwaitTargetVariableId(value),
        });
      }
    } else {
      // This branch doesn't contain await - just generate normal code

      if (
        shouldEmitAsyncBranchCompletion(
          condExpr,
          value,
          context,
          targetVariableId,
          targetAssignmentCode
        )
      ) {
        emitNonAwaitBranchAsyncCompletion(value, valueIndent, context);
      } else {
        // Normal non-await branch: generate code inline (original logic)
        // Handle begin blocks specially to avoid unnecessary block wrappers
        if (
          exprIsFunctionCall(value) &&
          exprIsFunctionCallOf(value, BuiltinKeywords.begin)
        ) {
          // For begin blocks, generate statements inline
          const beginArgs = value.args;
          for (let j = 0; j < beginArgs.length; j++) {
            const arg = beginArgs[j]!;
            const argCode = generateExpr(arg, valueIndent, context);
            // Check if this is a break statement in an async while loop
            if (argCode === "break" && awaitPoint.isInsideWhile) {
              // In async while loops, break needs to set the active flag and jump to end
              emitter.emitLine(
                `${valueIndent}sm->while_loop_${awaitPoint.index}_active = false;`
              );
              emitter.emitLine(
                `${valueIndent}goto while_loop_${awaitPoint.index}_end;`
              );
            } else {
              // Emit control flow statements always
              const isControlFlow =
                argCode === "break" ||
                argCode === "continue" ||
                argCode?.includes("return");
              if (
                argCode &&
                (isControlFlow ||
                  (arg.$ && !isTempVariableName(arg.$.env.modulePath, argCode)))
              ) {
                emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }
          }

          // Generate deferred drop expressions for the begin block
          if (value.$?.deferredDropExpressions) {
            for (const dropExpr of value.$.deferredDropExpressions) {
              const dropCode = generateExpr(dropExpr, valueIndent, context);
              if (dropCode) {
                emitter.emitLine(`${valueIndent}${dropCode};`);
              }
            }
          }
        } else {
          // Not a begin block - generate normal code
          const code = generateExpr(value, valueIndent, context);
          // Check if this is a break statement in an async while loop
          if (code === "break" && awaitPoint.isInsideWhile) {
            // In async while loops, break needs to set the active flag and jump to end
            emitter.emitLine(
              `${valueIndent}sm->while_loop_${awaitPoint.index}_active = false;`
            );
            emitter.emitLine(
              `${valueIndent}goto while_loop_${awaitPoint.index}_end;`
            );
          } else {
            // Emit control flow statements (break, continue, return) always
            const isControlFlow =
              code === "break" ||
              code === "continue" ||
              code?.includes("return");
            if (
              code &&
              (isControlFlow ||
                (value.$ && !isTempVariableName(value.$.env.modulePath, code)))
            ) {
              emitter.emitLine(`${valueIndent}${code};`);
            }
          }
        }
      }
      // Store branch info without remaining expressions
      branchesWithAwait.push({
        index: condBranchBase + i,
        value,
        hasAwait: false,
      });
    }

    emitter.emitLine(`${currentIndent}}`);
  }

  // Close all else blocks
  for (let d = 0; d < elseBlockDepth; d++) {
    currentIndent = currentIndent.slice(0, -2);
    emitter.emitLine(`${currentIndent}}`);
  }

  // Store branch information in context for resume state generation
  if (!context.asyncCondBranchInfo) {
    context.asyncCondBranchInfo = new Map();
  }
  // Don't overwrite if a nested cond already stored branch info with actual
  // remaining code. The inner cond's entry is the one that matters for the
  // resume state's switch — it's closest to the actual await point.
  const existingInnerEntry = context.asyncCondBranchInfo.get(awaitPoint.index);
  const innerEntryHasRemainingCode =
    existingInnerEntry?.branches.some(
      (b) => b.hasAwait && b.remainingExprs && b.remainingExprs.length > 0
    ) ?? false;
  if (!innerEntryHasRemainingCode) {
    context.asyncCondBranchInfo.set(awaitPoint.index, {
      branches: branchesWithAwait,
      targetVariableId,
      targetAssignmentCode,
    });
  }
}

/**
 * Checks if a non-await cond/match branch should complete the async Future directly.
 * Returns true when the enclosing cond/match IS the async body's implicit return value,
 * there's no target variable, and the branch doesn't already have an explicit return.
 */
function shouldEmitAsyncBranchCompletion(
  condOrMatchExpr: Expr,
  branchValue: Expr,
  context: FunctionGenerationContext,
  targetVariableId?: string,
  targetAssignmentCode?: string
): boolean {
  return (
    !targetVariableId &&
    !targetAssignmentCode &&
    context.asyncBodyReturnExpr !== undefined &&
    condOrMatchExpr === context.asyncBodyReturnExpr &&
    !!context.inAsyncStateMachine &&
    !exprContainsReturnStatement(branchValue)
  );
}

/**
 * Emits async Future completion for a non-await cond/match branch that IS the
 * async function body's implicit return value. Generates:
 *   value computation → sm->result = value → drop locals → complete Future → return
 */
function emitNonAwaitBranchAsyncCompletion(
  value: Expr,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const isUnit = isUnitType(value.$?.type);

  if (
    exprIsFunctionCall(value) &&
    exprIsFunctionCallOf(value, BuiltinKeywords.begin)
  ) {
    // Begin block: generate all statements, last one is the result value
    const beginArgs = value.args;
    for (let j = 0; j < beginArgs.length - 1; j++) {
      const arg = beginArgs[j]!;
      const argCode = generateExpr(arg, indent, context);
      if (
        argCode &&
        arg.$ &&
        !isTempVariableName(arg.$.env.modulePath, argCode)
      ) {
        emitter.emitLine(`${indent}${argCode};`);
      }
    }
    // Last expression is the result value
    const lastArg = beginArgs[beginArgs.length - 1];
    if (lastArg && !isUnit) {
      const lastCode = generateExpr(lastArg, indent, context);
      if (lastCode) {
        emitter.emitLine(`${indent}sm->result = ${lastCode};`);
      }
    }
    // Deferred drops for the begin block
    if (value.$?.deferredDropExpressions) {
      for (const dropExpr of value.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  } else {
    // Non-begin: the expression directly IS the result value
    if (!isUnit) {
      const code = generateExpr(value, indent, context);
      if (code) {
        emitter.emitLine(`${indent}sm->result = ${code};`);
      }
    }
  }

  // Drop pending deferred drops (body-level local variables)
  emitter.emitLine(`${indent}// Drop local variables before early completion`);
  if (context.pendingDeferredDrops) {
    for (const dropExpr of context.pendingDeferredDrops) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode && dropCode.includes("sm->")) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }

  // Complete the Future
  emitAsyncFutureCompletion({
    emitter,
    indent,
    resultCode: undefined, // Already stored above
    debugLabel: context.currentFunctionName,
  });
  emitter.emitLine(`${indent}return;`);
}

/**
 * Checks if a branch value contains any await expression
 */
function branchHasAwait(expr: Expr): boolean {
  if (expr.tag === ExprTag.FnCall && isIoAwaitCall(expr)) {
    return true;
  }

  if (expr.tag === ExprTag.FnCall) {
    for (const arg of expr.args) {
      if (branchHasAwait(arg)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if an expression contains a return statement.
 * Used to avoid double-completion when a non-await cond branch already has
 * an explicit return that handles async Future completion.
 */
function exprContainsReturnStatement(expr: Expr): boolean {
  if (exprIsAtomOf(expr, "return")) {
    return true;
  }
  if (exprIsFunctionCallOf(expr, "return")) {
    return true;
  }
  if (expr.tag === ExprTag.FnCall) {
    for (const arg of expr.args) {
      if (exprContainsReturnStatement(arg)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Generates async-aware code for a match expression containing await in branches.
 * Similar to generateCondWithAwait but handles match pattern matching.
 * Strategy:
 * 1. Evaluate the matched value and bind pattern variables
 * 2. Determine which match case to execute
 * 3. Store which case was chosen in state machine
 * 4. Execute code up to await and spawn the Future
 * 5. In next state, extract result and execute remaining code from chosen case
 */
function generateMatchWithAwait(
  matchExpr: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext,
  targetVariableId?: string,
  targetAssignmentCode?: string
): void {
  const emitter = context.emitter;

  if (
    matchExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(matchExpr, BuiltinKeywords.match)
  ) {
    emitter.emitLine(`${indent}// Error: Expected match expression`);
    return;
  }

  // match is: match(value, .Pattern1(x) => body1, .Pattern2 => body2, ...)
  const matchedValueExpr = matchExpr.args[0];
  const cases = matchExpr.args.slice(1);
  // Dispatch codes unique within this function — see allocCondBranchCodes.
  const condBranchBase = allocCondBranchCodes(context, cases.length);

  if (!matchedValueExpr || cases.length === 0) {
    emitter.emitLine(
      `${indent}// Error: match must have a value and at least one case`
    );
    return;
  }

  // Generate the matched value
  const matchedValueCode = generateExpr(matchedValueExpr, indent, context);
  const matchValueType = matchedValueExpr.$?.type;

  if (!matchValueType) {
    emitter.emitLine(`${indent}// Error: match value has no type`);
    return;
  }

  // Check if this is a primitive match (integer, bool) via the isPrimitiveMatch flag
  if (matchExpr.$?.isPrimitiveMatch) {
    generatePrimitiveMatchWithAwait(
      matchExpr,
      cases,
      matchedValueCode,
      awaitPoint,
      indent,
      context,
      targetVariableId,
      targetAssignmentCode
    );
    return;
  }

  if (!isEnumType(matchValueType)) {
    emitter.emitLine(
      `${indent}// Error: match requires an enum type or primitive type`
    );
    return;
  }

  const enumType = matchValueType as EnumType;
  const enumCName = context.types[enumType.id]?.cName;

  if (!enumCName) {
    emitter.emitLine(`${indent}// Error: enum type has no C name`);
    return;
  }

  // Check if this is an Option-like enum optimized as nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);

  if (nullablePointerType) {
    // Nullable pointer optimization: match on NULL vs non-NULL
    // Find null case and pointer case
    let nullCaseIndex = -1;
    let pointerCaseIndex = -1;
    let pointerVarName: string | undefined;

    for (let i = 0; i < cases.length; i++) {
      const caseExpr = cases[i]!;
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        const pattern = caseExpr.args[0];
        if (
          pattern &&
          exprIsFunctionCall(pattern) &&
          exprIsFunctionCallOf(pattern, ".")
        ) {
          // Simple pattern like .None
          nullCaseIndex = i;
        } else if (pattern && exprIsFunctionCall(pattern)) {
          // Destructuring pattern like .Some(x)
          const patternFunc = pattern.func;
          if (
            patternFunc &&
            exprIsFunctionCall(patternFunc) &&
            exprIsFunctionCallOf(patternFunc, ".")
          ) {
            pointerCaseIndex = i;
            // Extract bound variable name
            if (pattern.args.length > 0 && exprIsAtom(pattern.args[0]!)) {
              pointerVarName = pattern.args[0]!.token.value;
            }
          }
        }
      }
    }

    // Generate NULL check
    emitter.emitLine(`${indent}if (${matchedValueCode} != NULL) {`);

    if (pointerCaseIndex >= 0) {
      const caseExpr = cases[pointerCaseIndex]!;
      if (!exprIsFunctionCall(caseExpr)) {
        emitter.emitLine(`${indent}  // Error: Expected => in case`);
      } else {
        const caseBody = caseExpr.args[1]!;

        // Bind the destructured variable
        if (pointerVarName) {
          // Check if this variable is captured in the state machine
          const functionContext = context as FunctionGenerationContext;
          let isStateMachineVar = false;
          let varId: string | undefined;

          // Look through captured variables to find if this variable crosses await boundary
          if (functionContext.stateMachineVariables) {
            for (const [id, varInfo] of functionContext.stateMachineVariables) {
              if (varInfo.name === pointerVarName) {
                isStateMachineVar = true;
                varId = id;
                break;
              }
            }
          }

          if (isStateMachineVar && varId) {
            // Store directly in state machine variable
            const fieldName = getStateMachineFieldName(
              varId,
              "local",
              functionContext.stateMachineFieldAliases
            );
            emitter.emitLine(
              `${indent}  sm->${fieldName} = ${matchedValueCode};`
            );
          } else {
            // Local variable not crossing await - declare locally
            emitter.emitLine(
              `${indent}  ${getTypeString(nullablePointerType, context)} ${pointerVarName} = ${matchedValueCode};`
            );
          }
        }

        emitter.emitLine(
          `${indent}  sm->cond_branch_${awaitPoint.index} = ${condBranchBase + pointerCaseIndex};`
        );

        if (branchHasAwait(caseBody)) {
          // Process the case body looking for await
          const remainingExprs = generateCondBranchWithAwait(
            caseBody,
            awaitPoint,
            indent + "  ",
            context
          );

          // Store remaining expressions for resume state
          if (remainingExprs.length > 0) {
            // Store in context for state machine generation
            const functionContext = context as FunctionGenerationContext;
            if (!functionContext.asyncCondBranchInfo) {
              functionContext.asyncCondBranchInfo = new Map();
            }

            const branchData = functionContext.asyncCondBranchInfo.get(
              awaitPoint.index
            ) || {
              branches: [],
            };

            branchData.branches.push({
              index: condBranchBase + pointerCaseIndex,
              value: caseBody,
              hasAwait: true,
              remainingExprs,
              deferredDropExpressions: caseBody.$?.deferredDropExpressions,
              awaitTargetVariableId: findBranchAwaitTargetVariableId(caseBody),
            });

            functionContext.asyncCondBranchInfo.set(
              awaitPoint.index,
              branchData
            );
          }
        } else {
          // No await in pointer case - generate normally
          if (
            shouldEmitAsyncBranchCompletion(
              matchExpr,
              caseBody,
              context,
              targetVariableId,
              targetAssignmentCode
            )
          ) {
            emitNonAwaitBranchAsyncCompletion(caseBody, indent + "  ", context);
          } else {
            const code = generateExpr(caseBody, indent + "  ", context);
            if (targetVariableId) {
              // Assign the branch result to the target variable
              const fieldName = sanitizeForCIdentifier(
                `var_${targetVariableId}`
              );
              if (code) {
                emitter.emitLine(`${indent}  sm->${fieldName} = ${code};`);
              }
            } else if (targetAssignmentCode) {
              if (code) {
                emitter.emitLine(
                  `${indent}  ${targetAssignmentCode} = ${code};`
                );
              }
            } else if (
              code &&
              caseBody.$ &&
              !isTempVariableName(caseBody.$.env.modulePath, code)
            ) {
              emitter.emitLine(`${indent}  ${code};`);
            }
          }
        }
      }
    }

    emitter.emitLine(`${indent}} else {`);

    if (nullCaseIndex >= 0) {
      const caseExpr = cases[nullCaseIndex]!;
      if (!exprIsFunctionCall(caseExpr)) {
        emitter.emitLine(`${indent}  // Error: Expected => in case`);
      } else {
        const caseBody = caseExpr.args[1]!;

        emitter.emitLine(
          `${indent}  sm->cond_branch_${awaitPoint.index} = ${condBranchBase + nullCaseIndex};`
        );

        // Check if null case also has await
        if (branchHasAwait(caseBody)) {
          const remainingExprs = generateCondBranchWithAwait(
            caseBody,
            awaitPoint,
            indent + "  ",
            context
          );

          if (remainingExprs.length > 0) {
            const functionContext = context as FunctionGenerationContext;
            if (!functionContext.asyncCondBranchInfo) {
              functionContext.asyncCondBranchInfo = new Map();
            }

            const branchData = functionContext.asyncCondBranchInfo.get(
              awaitPoint.index
            ) || {
              branches: [],
            };

            branchData.branches.push({
              index: condBranchBase + nullCaseIndex,
              value: caseBody,
              hasAwait: true,
              remainingExprs,
              deferredDropExpressions: caseBody.$?.deferredDropExpressions,
              awaitTargetVariableId: findBranchAwaitTargetVariableId(caseBody),
            });

            functionContext.asyncCondBranchInfo.set(
              awaitPoint.index,
              branchData
            );
          }
        } else {
          // No await in null case - generate normally
          if (
            shouldEmitAsyncBranchCompletion(
              matchExpr,
              caseBody,
              context,
              targetVariableId,
              targetAssignmentCode
            )
          ) {
            emitNonAwaitBranchAsyncCompletion(caseBody, indent + "  ", context);
          } else {
            const code = generateExpr(caseBody, indent + "  ", context);
            if (targetVariableId) {
              // Assign the branch result to the target variable
              const fieldName = sanitizeForCIdentifier(
                `var_${targetVariableId}`
              );
              if (code) {
                emitter.emitLine(`${indent}  sm->${fieldName} = ${code};`);
              }
            } else if (targetAssignmentCode) {
              if (code) {
                emitter.emitLine(
                  `${indent}  ${targetAssignmentCode} = ${code};`
                );
              }
            } else if (
              code &&
              caseBody.$ &&
              !isTempVariableName(caseBody.$.env.modulePath, code)
            ) {
              emitter.emitLine(`${indent}  ${code};`);
            }
          }
        }
      }
    }

    emitter.emitLine(`${indent}}`);
  } else {
    // Regular enum with switch/case.
    //
    // A payload-free enum is lowered to a PLAIN C enum ("optimized as simple
    // enum" in codegen/types/generation.ts) with no `tag` member, so `.tag` on
    // it does not compile. `codegen/exprs/match.ts` has always branched on
    // `canOptimizeAsSimpleEnum`; this generator did not, so any `match` on such
    // an enum inside an async body emitted `switch (x.tag)` — "member reference
    // base type ... is not a structure or union".
    const scrutineeCode = canOptimizeAsSimpleEnum(enumType)
      ? matchedValueCode
      : `${matchedValueCode}.tag`;
    emitter.emitLine(`${indent}switch (${scrutineeCode}) {`);

    let hasWildcardDefault = false;
    for (let i = 0; i < cases.length; i++) {
      const caseExpr = cases[i]!;
      if (
        !exprIsFunctionCall(caseExpr) ||
        !exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        continue;
      }

      const pattern = caseExpr.args[0]!;
      const caseBody = caseExpr.args[1]!;

      // Check for wildcard pattern "_" — generate default case
      const isWildcard = exprIsAtom(pattern) && pattern.token.value === "_";

      // Extract variant name from pattern
      let variantName: string | undefined;
      if (!isWildcard) {
        if (
          exprIsFunctionCall(pattern) &&
          exprIsFunctionCallOf(pattern, ".", 1)
        ) {
          // Simple pattern like .Some
          variantName = pattern.args[0]!.token.value;
        } else if (exprIsFunctionCall(pattern)) {
          // Destructuring pattern like .Some(x)
          const patternFunc = pattern.func;
          if (
            patternFunc &&
            exprIsFunctionCall(patternFunc) &&
            exprIsFunctionCallOf(patternFunc, ".", 1)
          ) {
            variantName = patternFunc.args[0]!.token.value;
          }
        }
      }

      if (!isWildcard && !variantName) {
        emitter.emitLine(`${indent}  // Error: Could not extract variant name`);
        continue;
      }

      if (isWildcard) {
        hasWildcardDefault = true;
        emitter.emitLine(`${indent}  default: {`);
      } else {
        const variantTag = `${enumCName.toUpperCase()}_${variantName!.toUpperCase()}`;
        emitter.emitLine(`${indent}  case ${variantTag}: {`);
      }
      emitter.emitLine(
        `${indent}    sm->cond_branch_${awaitPoint.index} = ${condBranchBase + i};`
      );

      // Handle destructuring patterns like .Some(task)
      if (exprIsFunctionCall(pattern) && pattern.args.length >= 1) {
        // Check if pattern is .VariantName(bindings...)
        const patternFunc = pattern.func;
        if (
          patternFunc &&
          exprIsFunctionCall(patternFunc) &&
          exprIsFunctionCallOf(patternFunc, ".")
        ) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.fields) {
            for (
              let fieldIndex = 0;
              fieldIndex < Math.min(pattern.args.length, variant.fields.length);
              fieldIndex++
            ) {
              const destructuredVar = pattern.args[fieldIndex]!;
              const variantField = variant.fields[fieldIndex];

              if (exprIsAtom(destructuredVar) && variantField) {
                const rawVarName = destructuredVar.token.value;
                const varName = sanitizeForCIdentifier(rawVarName);

                // Check if this variable is captured in the state machine
                const functionContext = context as FunctionGenerationContext;
                let isStateMachineVar = false;
                let varId: string | undefined;

                if (functionContext.stateMachineVariables) {
                  for (const [
                    id,
                    varInfo,
                  ] of functionContext.stateMachineVariables) {
                    if (varInfo.name === rawVarName) {
                      isStateMachineVar = true;
                      varId = id;
                      break;
                    }
                  }
                }

                const fieldLabel = sanitizeForCIdentifier(
                  variantField.label,
                  variantField.type.isExtern === "c"
                );
                const accessExpr = `${matchedValueCode}.data.${variantName}.${fieldLabel}`;

                if (isStateMachineVar && varId) {
                  // Store in state machine variable
                  const fieldName = getStateMachineFieldName(
                    varId,
                    "local",
                    functionContext.stateMachineFieldAliases
                  );
                  emitter.emitLine(
                    `${indent}    sm->${fieldName} = ${accessExpr};`
                  );
                } else {
                  // Local variable - declare it
                  const fieldType = getTypeString(variantField.type, context);
                  emitter.emitLine(
                    `${indent}    ${fieldType} ${varName} = ${accessExpr};`
                  );
                }
              }
            }
          }
        }
      }

      // Check if this case has await
      if (branchHasAwait(caseBody)) {
        const remainingExprs = generateCondBranchWithAwait(
          caseBody,
          awaitPoint,
          indent + "    ",
          context
        );

        if (remainingExprs.length > 0) {
          const functionContext = context as FunctionGenerationContext;
          if (!functionContext.asyncCondBranchInfo) {
            functionContext.asyncCondBranchInfo = new Map();
          }

          const branchData = functionContext.asyncCondBranchInfo.get(
            awaitPoint.index
          ) || {
            branches: [],
          };

          branchData.branches.push({
            index: condBranchBase + i,
            value: caseBody,
            hasAwait: true,
            remainingExprs,
            deferredDropExpressions: caseBody.$?.deferredDropExpressions,
            awaitTargetVariableId: findBranchAwaitTargetVariableId(caseBody),
          });

          functionContext.asyncCondBranchInfo.set(awaitPoint.index, branchData);
        }
      } else {
        // No await - generate normally
        if (
          shouldEmitAsyncBranchCompletion(
            matchExpr,
            caseBody,
            context,
            targetVariableId,
            targetAssignmentCode
          )
        ) {
          emitNonAwaitBranchAsyncCompletion(caseBody, indent + "    ", context);
        } else {
          const code = generateExpr(caseBody, indent + "    ", context);
          if (targetVariableId) {
            // Assign the branch result to the target variable
            const fieldName = sanitizeForCIdentifier(`var_${targetVariableId}`);
            if (code) {
              emitter.emitLine(`${indent}    sm->${fieldName} = ${code};`);
            }
          } else if (targetAssignmentCode) {
            if (code) {
              emitter.emitLine(
                `${indent}    ${targetAssignmentCode} = ${code};`
              );
            }
          } else if (
            code &&
            caseBody.$ &&
            !isTempVariableName(caseBody.$.env.modulePath, code)
          ) {
            emitter.emitLine(`${indent}    ${code};`);
          }
        }
      }

      emitter.emitLine(`${indent}    break;`);
      emitter.emitLine(`${indent}  }`);
    }

    if (!hasWildcardDefault) {
      emitter.emitLine(`${indent}  default: break;`);
    }
    emitter.emitLine(`${indent}}`);
  }
}

/**
 * Gets a C literal from a compile-time value (for primitive match patterns).
 */
/**
 * Helper function to check if an expression is an or-pattern (using `|`)
 */
function isOrPatternExpr(expr: Expr): boolean {
  if (!exprIsFunctionCall(expr)) return false;
  return exprIsFunctionCallOf(expr, "|", 2);
}

/**
 * Helper function to flatten an or-pattern into a list of individual patterns
 */
function flattenOrPatternExpr(expr: Expr): Expr[] {
  if (!isOrPatternExpr(expr)) {
    return [expr];
  }
  if (expr.tag !== ExprTag.FnCall) return [expr];
  const left = expr.args[0]!;
  const right = expr.args[1]!;
  return [...flattenOrPatternExpr(left), ...flattenOrPatternExpr(right)];
}

/**
 * Generates async-aware code for a primitive match (integer, bool) containing await in branches.
 * Similar to generateCondWithAwait but uses switch/case for primitive pattern matching.
 */
function generatePrimitiveMatchWithAwait(
  matchExpr: Expr,
  cases: Expr[],
  matchedValueCode: string,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext,
  targetVariableId?: string,
  targetAssignmentCode?: string
): void {
  const emitter = context.emitter;
  // Dispatch codes unique within this function — see allocCondBranchCodes.
  const condBranchBase = allocCondBranchCodes(context, cases.length);

  // Store branch info for later generation
  const branchesWithAwait: Array<{
    index: number;
    value: Expr;
    hasAwait: boolean;
    remainingExprs?: Expr[];
    deferredDropExpressions?: Expr[];
    awaitTargetVariableId?: string; // This branch's own `x := io.await(…)` binding
  }> = [];

  emitter.emitLine(`${indent}switch (${matchedValueCode}) {`);

  for (let i = 0; i < cases.length; i++) {
    const caseExpr = cases[i]!;
    if (
      !exprIsFunctionCall(caseExpr) ||
      !exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      continue;
    }

    const caseValue = caseExpr.args[0]!;
    const caseBody = caseExpr.args[1]!;

    // Check for wildcard pattern "_"
    if (exprIsAtomOf(caseValue, "_")) {
      emitter.emitLine(`${indent}  default:`);
    } else {
      // Get pattern values from the or-pattern or single pattern
      const patternValues = caseValue.$?.primitivePatternValues;
      if (patternValues && patternValues.length > 0) {
        for (const value of patternValues) {
          if (value !== undefined) {
            const cLiteral = generateComptimeValue(value, context);
            emitter.emitLine(`${indent}  case ${cLiteral}:`);
          }
        }
      } else {
        // Fallback: try to get values from flattened pattern expressions
        const flattenedPatterns = flattenOrPatternExpr(caseValue);
        for (const patternExpr of flattenedPatterns) {
          const patternValue = patternExpr.$?.value;
          if (patternValue !== undefined) {
            const cLiteral = generateComptimeValue(patternValue, context);
            emitter.emitLine(`${indent}  case ${cLiteral}:`);
          }
        }
      }
    }

    emitter.emitLine(
      `${indent}    sm->cond_branch_${awaitPoint.index} = ${condBranchBase + i};`
    );

    if (branchHasAwait(caseBody)) {
      const remainingExprs = generateCondBranchWithAwait(
        caseBody,
        awaitPoint,
        indent + "    ",
        context
      );

      branchesWithAwait.push({
        index: condBranchBase + i,
        value: caseBody,
        hasAwait: true,
        remainingExprs,
        deferredDropExpressions: caseBody.$?.deferredDropExpressions,
        awaitTargetVariableId: findBranchAwaitTargetVariableId(caseBody),
      });
    } else {
      if (
        shouldEmitAsyncBranchCompletion(
          matchExpr,
          caseBody,
          context,
          targetVariableId,
          targetAssignmentCode
        )
      ) {
        emitNonAwaitBranchAsyncCompletion(caseBody, indent + "    ", context);
      } else {
        const code = generateExpr(caseBody, indent + "    ", context);
        if (targetVariableId) {
          const fieldName = sanitizeForCIdentifier(`var_${targetVariableId}`);
          if (code) {
            emitter.emitLine(`${indent}    sm->${fieldName} = ${code};`);
          }
        } else if (targetAssignmentCode) {
          if (code) {
            emitter.emitLine(`${indent}    ${targetAssignmentCode} = ${code};`);
          }
        } else if (
          code &&
          caseBody.$ &&
          !isTempVariableName(caseBody.$.env.modulePath, code)
        ) {
          emitter.emitLine(`${indent}    ${code};`);
        }
      }
      branchesWithAwait.push({
        index: condBranchBase + i,
        value: caseBody,
        hasAwait: false,
      });
    }

    emitter.emitLine(`${indent}    break;`);
  }

  emitter.emitLine(`${indent}}`);

  // Store branch information in context for resume state generation
  if (!context.asyncCondBranchInfo) {
    context.asyncCondBranchInfo = new Map();
  }
  context.asyncCondBranchInfo.set(awaitPoint.index, {
    branches: branchesWithAwait,
    targetVariableId,
    targetAssignmentCode,
  });
}

/**
 * Generates code for a cond branch that contains an await.
 * The branch value should be a begin block with await inside.
 * Returns the expressions that come AFTER the await, to be executed in the resume state.
 */
function generateCondBranchWithAwait(
  branchValue: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext
): Expr[] {
  const emitter = context.emitter;
  const remainingExprs: Expr[] = [];

  // The branch value should be a begin block: { value := await future; printf(...); }
  if (
    branchValue.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(branchValue, "begin")
  ) {
    emitter.emitLine(
      `${indent}// Error: Expected begin block in cond branch with await`
    );
    return remainingExprs;
  }

  const expressions = branchValue.args;
  let foundAwait = false;

  // Process expressions in the begin block
  // Look for ANY await expression (not just the specific awaitPoint.expr)
  for (const expr of expressions) {
    if (foundAwait) {
      // This expression comes AFTER the await - save it for resume state
      remainingExprs.push(expr);
      continue;
    }

    // Check if this expression contains ANY await
    if (branchHasAwait(expr)) {
      foundAwait = true;

      // This expression contains an await
      // Handle assignment: varName := await(futureExpr)
      if (expr.tag === ExprTag.FnCall && exprIsFunctionCallOf(expr, ":=")) {
        // const varNameExpr = expr.args[0];
        const valueExpr = expr.args[1];

        if (
          valueExpr &&
          valueExpr.tag === ExprTag.FnCall &&
          isIoAwaitCall(valueExpr)
        ) {
          const futureExpr = valueExpr.args[0];
          if (futureExpr) {
            // Generate: sm->await_future_X = <futureExpr>;
            const futureCode = generateExpr(futureExpr, indent, context);
            emitter.emitLine(
              `${indent}// Store Future for await ${awaitPoint.index} (cond branch)`
            );
            emitter.emitLine(
              `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
            );
          }
        }
      } else if (expr.tag === ExprTag.FnCall && isIoAwaitCall(expr)) {
        // Standalone await
        const futureExpr = expr.args[0];
        if (futureExpr) {
          // Only store the Future if it's not already captured in a state machine variable
          if (awaitPoint.futureVariableId === undefined) {
            const futureCode = generateExpr(futureExpr, indent, context);
            emitter.emitLine(
              `${indent}// Store Future for await ${awaitPoint.index} (cond branch)`
            );
            emitter.emitLine(
              `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
            );
          } else {
            // The future is already stored in a state machine variable
            emitter.emitLine(
              `${indent}// Await will use Future from sm->var_${awaitPoint.futureVariableId}`
            );
          }
        }
      } else if (
        expr.tag === ExprTag.FnCall &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
      ) {
        // Nested cond expression with await in one of its branches
        // If this cond is the last expression in the branch and we're in
        // async tail position, propagate the flag so the nested cond's
        // non-await branches also emit Future completion code.
        const isLastExprInBranch = expr === expressions[expressions.length - 1];
        const previousAsyncBodyReturnExpr = context.asyncBodyReturnExpr;
        if (isLastExprInBranch && context.asyncBodyReturnExpr !== undefined) {
          context.asyncBodyReturnExpr = expr;
        }
        generateCondWithAwait(expr, awaitPoint, indent, context);
        context.asyncBodyReturnExpr = previousAsyncBodyReturnExpr;
      } else if (
        expr.tag === ExprTag.FnCall &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.match)
      ) {
        // Match expression with await in one of its branches
        // Propagate async tail position to nested match (same logic as cond above)
        const isLastExprInBranch = expr === expressions[expressions.length - 1];
        const previousAsyncBodyReturnExpr = context.asyncBodyReturnExpr;
        if (isLastExprInBranch && context.asyncBodyReturnExpr !== undefined) {
          context.asyncBodyReturnExpr = expr;
        }
        generateMatchWithAwait(expr, awaitPoint, indent, context);
        context.asyncBodyReturnExpr = previousAsyncBodyReturnExpr;
      } else if (
        expr.tag === ExprTag.FnCall &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.while)
      ) {
        // While loop with await in the body
        generateWhileWithAwait(expr, awaitPoint, indent, context);
      } else if (
        expr.$?.macroExpansion &&
        exprIsFunctionCall(expr.$.macroExpansion) &&
        exprIsFunctionCallOf(expr.$.macroExpansion, BuiltinKeywords.cond)
      ) {
        // An `if` inside a cond/match branch. `if` is a `cond` wearing a macro
        // head, and only the expansion carries the branch structure — the same
        // recursion `generateAwaitExpression` does at the top level of an async
        // body, which is why `if` works there and used to be rejected here.
        generateCondWithAwait(
          expr.$.macroExpansion,
          awaitPoint,
          indent,
          context
        );
      } else {
        // An await in a shape none of the above can split. At the TOP level of an
        // async body this same situation throws `unsupportedAwaitMessage` — see
        // `generateAwaitExpression`, whose comment is "a compile error is always
        // better than a segfaulting binary". Inside a cond/match branch it used to
        // fall out of the chain silently: no `sm->await_future_N` store, so the
        // await machinery emitted right after read a NULL future.
        //
        // `out = io.await(f, io)` (assignment, as opposed to `out := …`) is the
        // shape that exposed this. It is a loud error at the top level and was a
        // silent no-op — or a SIGSEGV once the state machine ran on — in a branch.
        // See issues/fixed/async-unsupported-await-shape-in-branch-silently-dropped.md.
        throw new Error(unsupportedAwaitMessage(expr, awaitPoint));
      }
    } else {
      // Expression doesn't contain await - generate normally
      const code = generateExpr(expr, indent, context);
      if (code && expr.$ && !isTempVariableName(expr.$.env.modulePath, code)) {
        emitter.emitLine(`${indent}${code};`);
      }
    }
  }

  return remainingExprs;
}

/**
 * Generates async-aware code for a while loop containing await in the body.
 * Strategy:
 * 1. Set loop active flag to true
 * 2. Evaluate condition - if false, set active=false and skip body
 * 3. Execute body up to await point
 * 4. Store Future and set up continuation
 * 5. In next state, execute remaining body expressions, then jump back to re-evaluate condition
 */
function generateWhileWithAwait(
  whileExpr: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Type guard - whileExpr should be a FnCall to while
  if (
    whileExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(whileExpr, "while")
  ) {
    emitter.emitLine(`${indent}// Error: Expected while expression`);
    return;
  }

  // while is represented as: while(condition, body) or while(condition, step, body)
  const args = whileExpr.args;
  if (args.length < 2 || args.length > 3) {
    emitter.emitLine(
      `${indent}// Error: while must have 2 or 3 arguments (condition, [step,] body)`
    );
    return;
  }

  const conditionExpr = args[0]!;
  const stepExpr = args.length === 3 ? args[1] : undefined;
  const bodyExpr = args.length === 3 ? args[2]! : args[1]!;

  // Check if the body contains a nested while-with-await.
  // If so, this is an outer while and needs a separate while loop index
  // so labels don't collide with the inner while.
  const hasNestedWhileWithAwait = bodyContainsWhileWithAwait(bodyExpr);

  let whileLoopIndex: number;
  if (hasNestedWhileWithAwait) {
    // Allocate a fresh while loop index for this outer while
    whileLoopIndex = context.asyncNextWhileLoopIndex ?? awaitPoint.index + 1;
    context.asyncNextWhileLoopIndex = whileLoopIndex + 1;
  } else {
    // Innermost while uses the await point index
    whileLoopIndex = awaitPoint.index;
  }

  // Initialize loop as active
  emitter.emitLine(`${indent}sm->while_loop_${whileLoopIndex}_active = true;`);

  // Generate label for loop start (so we can jump back after await)
  emitter.emitLine(`${indent}while_loop_${whileLoopIndex}_start:`);

  // The loop's suspension point is the CONDITION itself. Store its future and
  // suspend — the test, the body and the step all run in the next state, where
  // the result is live. Jumping back here re-stores the future for the next
  // iteration, which is what makes the condition re-evaluate per iteration.
  const conditionIsAwait = exprIsBareAwait(conditionExpr, awaitPoint);
  if (conditionIsAwait) {
    emitHoistedAwaitFutureStore(awaitPoint, indent, context);
    emitter.emitLine(`${indent}while_loop_${whileLoopIndex}_end:`);

    if (!context.asyncWhileLoopInfo) {
      context.asyncWhileLoopInfo = new Map();
    }
    context.asyncWhileLoopInfo.set(awaitPoint.index, {
      conditionExpr,
      stepExpr,
      bodyExpr,
      bodyExprsAfterAwait: [],
      conditionAwait: true,
    });
    return;
  }

  // Evaluate condition
  const condCode = generateExpr(conditionExpr, indent, context);
  emitter.emitLine(`${indent}if (!(${condCode})) {`);
  emitter.emitLine(
    `${indent}  sm->while_loop_${whileLoopIndex}_active = false;`
  );
  emitter.emitLine(`${indent}  goto while_loop_${whileLoopIndex}_end;`);
  emitter.emitLine(`${indent}}`);

  // The suspension point is in the STEP. The step runs after the body each
  // iteration, so it splits the loop exactly where a trailing body await would:
  // emit the body in full, then the step up to its await. What follows the
  // await becomes `bodyExprsAfterAwait`, and the resume state skips the step.
  const stepIsAwaiting = stepExpr !== undefined && exprContainsAwait(stepExpr);

  const bodyExprsAfterAwait = stepIsAwaiting
    ? (generateWholeWhileBody(bodyExpr, indent, context, whileLoopIndex),
      generateWhileBodyWithAwait(
        stepExpr!,
        awaitPoint,
        indent,
        context,
        whileLoopIndex
      ))
    : generateWhileBodyWithAwait(
        bodyExpr,
        awaitPoint,
        indent,
        context,
        whileLoopIndex
      );

  // Generate label for loop end
  emitter.emitLine(`${indent}while_loop_${whileLoopIndex}_end:`);

  // Store loop information in context for resume state generation
  if (!context.asyncWhileLoopInfo) {
    context.asyncWhileLoopInfo = new Map();
  }

  if (hasNestedWhileWithAwait) {
    // This is an outer while. The inner while has already stored its info
    // at awaitPoint.index via the recursive generateWhileWithAwait call.
    // Attach outer while info to the inner while's entry for the resume state.
    const innerWhileInfo = context.asyncWhileLoopInfo.get(awaitPoint.index);
    if (innerWhileInfo) {
      innerWhileInfo.outerWhileLoop = {
        whileLoopIndex,
        conditionExpr,
        stepExpr,
        bodyExpr,
        bodyExprsAfterAwait,
      };
    }
  } else {
    // Innermost while - store directly
    context.asyncWhileLoopInfo.set(awaitPoint.index, {
      conditionExpr,
      stepExpr,
      bodyExpr,
      bodyExprsAfterAwait,
      stepAwait: stepIsAwaiting,
    });
  }
}

/**
 * Generates code for a while loop body that contains an await.
 * Returns the expressions that come AFTER the await, to be executed in the resume state.
 */
function generateWhileBodyWithAwait(
  bodyExpr: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext,
  whileLoopIndex: number
): Expr[] {
  const emitter = context.emitter;
  const remainingExprs: Expr[] = [];

  // If body is a begin block, extract expressions
  let bodyExprs: Expr[] = [];
  if (
    bodyExpr.tag === ExprTag.FnCall &&
    exprIsFunctionCallOf(bodyExpr, "begin")
  ) {
    bodyExprs = bodyExpr.args;
  } else {
    bodyExprs = [bodyExpr];
  }

  // Find the first await expression
  let awaitFoundIndex = -1;
  for (let i = 0; i < bodyExprs.length; i++) {
    const expr = bodyExprs[i]!;
    if (exprContainsAwait(expr)) {
      awaitFoundIndex = i;
      break;
    }
  }

  if (awaitFoundIndex === -1) {
    // No await in body - this shouldn't happen
    emitter.emitLine(
      `${indent}// Error: Expected await in while loop body but none found`
    );
    return remainingExprs;
  }

  // Pre-await body expressions are generated in state 0 where we use labels
  // (not a real C while loop). Configure break/continue handling explicitly.
  // Use the current while loop's index for labels.
  const previousSmWhileBreakInfo = context.smWhileBreakInfo;
  const previousSmWhileContinueInfo = context.smWhileContinueInfo;
  const previousSmWhileBodyDrops = context.smWhileBodyDrops;
  context.smWhileBreakInfo = {
    label: `while_loop_${whileLoopIndex}_end`,
    activeIndex: whileLoopIndex,
  };
  context.smWhileContinueInfo = {
    label: `while_loop_${whileLoopIndex}_start`,
    emitDropsBeforeGoto: true,
  };
  context.smWhileBodyDrops = [...(bodyExpr.$?.deferredDropExpressions ?? [])];

  // Generate expressions before the await
  for (let i = 0; i < awaitFoundIndex; i++) {
    const expr = bodyExprs[i]!;
    const code = generateExpr(expr, indent, context);
    if (code && expr.$ && !isTempVariableName(expr.$.env.modulePath, code)) {
      emitter.emitLine(`${indent}${code};`);
    }
  }

  // Restore while control-flow context before generating await handling.
  context.smWhileBreakInfo = previousSmWhileBreakInfo;
  context.smWhileContinueInfo = previousSmWhileContinueInfo;
  context.smWhileBodyDrops = previousSmWhileBodyDrops;

  // Generate code to store the Future at the await point
  const awaitExpr = bodyExprs[awaitFoundIndex]!;

  // Check if the await-containing expression is a nested while loop
  if (
    exprIsFunctionCall(awaitExpr) &&
    exprIsFunctionCallOf(awaitExpr, BuiltinKeywords.while) &&
    exprContainsAwait(awaitExpr)
  ) {
    // Nested while-with-await: recursively generate the inner while
    generateWhileWithAwait(awaitExpr, awaitPoint, indent, context);
    // Collect remaining expressions after the inner while
    for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
    return remainingExprs;
  }

  if (exprIsFunctionCall(awaitExpr) && exprIsFunctionCallOf(awaitExpr, ":=")) {
    // This is an assignment with await: varName := await(futureExpr)
    const valueExpr = awaitExpr.args[1];
    if (
      valueExpr &&
      valueExpr.tag === ExprTag.FnCall &&
      isIoAwaitCall(valueExpr)
    ) {
      const futureExpr = valueExpr.args[0];
      if (futureExpr) {
        const futureCode = generateExpr(futureExpr, indent, context);
        emitter.emitLine(
          `${indent}// Store Future for await ${awaitPoint.index} (while loop body)`
        );
        emitter.emitLine(
          `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
        );
      }
    }
  } else if (awaitExpr.tag === ExprTag.FnCall && isIoAwaitCall(awaitExpr)) {
    // Standalone await
    const futureExpr = awaitExpr.args[0];
    if (futureExpr) {
      if (awaitPoint.futureVariableId === undefined) {
        const futureCode = generateExpr(futureExpr, indent, context);
        emitter.emitLine(
          `${indent}// Store Future for await ${awaitPoint.index} (while loop body)`
        );
        emitter.emitLine(
          `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
        );
      }
    }
  } else if (
    exprIsFunctionCall(awaitExpr) &&
    exprIsFunctionCallOf(awaitExpr, BuiltinKeywords.cond)
  ) {
    // Cond expression with await in one of its branches
    generateCondWithAwait(awaitExpr, awaitPoint, indent, context, undefined);
    // The cond branch remainingExprs are already stored in context.asyncCondBranchInfo
    // but we still need to collect expressions AFTER the cond in the while loop body
    // (e.g., loop counter increments like `i = (i + usize(1))`)
    for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
    return remainingExprs;
  } else if (
    exprIsFunctionCall(awaitExpr) &&
    exprIsFunctionCallOf(awaitExpr, BuiltinKeywords.match)
  ) {
    // Match expression with await in one of its branches
    generateMatchWithAwait(awaitExpr, awaitPoint, indent, context);
    // The match branch remainingExprs are already stored in context.asyncCondBranchInfo
    // but we still need to collect expressions AFTER the match in the while loop body
    for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
    return remainingExprs;
  } else if (
    awaitExpr.$?.macroExpansion &&
    exprIsFunctionCall(awaitExpr.$.macroExpansion) &&
    exprIsFunctionCallOf(awaitExpr.$.macroExpansion, BuiltinKeywords.cond)
  ) {
    // An `if` — which is a `cond` wearing a macro head. The AST node stays an
    // `if`; the branch structure only exists in its expansion, so neither check
    // above matched and the loop body emitted NOTHING AT ALL: no branch code, no
    // `sm->cond_branch_N` assignment. The loop ran, did nothing, and the program
    // exited 0 — a silent no-op, not a crash. Dispatch on the expansion exactly
    // as the `cond` case above does, and keep collecting the ORIGINAL body's
    // trailing expressions (the loop counter increment lives there).
    // See issues/fixed/async-if-with-await-in-while-body-emits-nothing.md.
    generateCondWithAwait(
      awaitExpr.$.macroExpansion,
      awaitPoint,
      indent,
      context,
      undefined
    );
    for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
      remainingExprs.push(bodyExprs[i]!);
    }
    return remainingExprs;
  }

  // Collect remaining expressions after the await
  for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
    remainingExprs.push(bodyExprs[i]!);
  }

  return remainingExprs;
}

/**
 * Checks if a while loop body contains a nested while loop that itself contains await.
 * This is used to detect outer whiles that need separate while loop indices.
 */
function bodyContainsWhileWithAwait(bodyExpr: Expr): boolean {
  const bodyExprs =
    bodyExpr.tag === ExprTag.FnCall && exprIsFunctionCallOf(bodyExpr, "begin")
      ? bodyExpr.args
      : [bodyExpr];

  for (const expr of bodyExprs) {
    if (
      expr.tag === ExprTag.FnCall &&
      exprIsFunctionCallOf(expr, BuiltinKeywords.while) &&
      exprContainsAwait(expr)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when this await point IS the condition of the `while` that encloses it.
 *
 * Used both by codegen (to pick the condition-await loop layout) and by the
 * state-struct emitter, which must allocate `await_result_N` for it — that
 * field is otherwise reserved for cond awaits, and the layout reads it to test
 * the loop condition.
 */
export function awaitIsWhileCondition(awaitPoint: AwaitPoint): boolean {
  const whileExpr = awaitPoint.enclosingWhileExpr as Expr | undefined;
  if (
    !whileExpr ||
    whileExpr.tag !== ExprTag.FnCall ||
    !exprIsFunctionCallOf(whileExpr, "while")
  ) {
    return false;
  }
  return exprIsBareAwait(whileExpr.args[0], awaitPoint);
}

/**
 * Emits a `while` body that contains no await, in the label/goto form state 0
 * uses. Only needed when the loop's await is in the STEP: the body still has to
 * run before it, but there is nothing to split.
 */
function generateWholeWhileBody(
  bodyExpr: Expr,
  indent: string,
  context: FunctionGenerationContext,
  whileLoopIndex: number
): void {
  const emitter = context.emitter;
  const previousBreakInfo = context.smWhileBreakInfo;
  const previousContinueInfo = context.smWhileContinueInfo;
  context.smWhileBreakInfo = {
    label: `while_loop_${whileLoopIndex}_end`,
    activeIndex: whileLoopIndex,
  };
  context.smWhileContinueInfo = {
    label: `while_loop_${whileLoopIndex}_start`,
    emitDropsBeforeGoto: true,
  };

  const exprs =
    bodyExpr.tag === ExprTag.FnCall && exprIsFunctionCallOf(bodyExpr, "begin")
      ? bodyExpr.args
      : [bodyExpr];
  for (const sub of exprs) {
    const code = generateExpr(sub, indent, context);
    if (!code || !sub.$ || isTempVariableName(sub.$.env.modulePath, code)) {
      continue;
    }
    emitter.emitLine(`${indent}${code};`);
  }

  context.smWhileBreakInfo = previousBreakInfo;
  context.smWhileContinueInfo = previousContinueInfo;
}
