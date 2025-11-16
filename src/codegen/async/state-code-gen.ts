/**
 * state-code-gen.ts
 *
 * Generates code for each state segment in an async state machine.
 * Splits the function body at await points and generates C code for each segment.
 */

import { getVariablesFromEnv } from "../../env";
import {
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  ExprTag,
  exprIsFunctionCallOf,
} from "../../expr";
import { TokenType } from "../../token";
import { generateExpr } from "../expressions";
import { FunctionGenerationContext } from "../functions/context";
import { AwaitPoint } from "./await-analysis";

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
}

/**
 * Splits a function body into segments at await points.
 * Each segment contains the expressions to execute before reaching the next await.
 */
export function splitIntoStateSegments(
  body: Expr,
  awaitPoints: AwaitPoint[]
): StateSegment[] {
  const segments: StateSegment[] = [];

  // For now, we'll implement a simple version that handles the common case:
  // A begin block with sequential expressions containing await calls

  if (body.tag !== ExprTag.FuncCall || !exprIsFunctionCallOf(body, "begin")) {
    // Not a begin block - check if we need to transform it
    if (awaitPoints.length === 0) {
      // No awaits - single segment
      return [
        {
          stateNumber: 0,
          expressions: [body],
          awaitPoint: null,
        },
      ];
    }

    // Body is a single expression with await(s) - treat as single segment
    // The await handling will be done in generateAwaitExpression
    return [
      {
        stateNumber: 0,
        expressions: [body],
        awaitPoint: awaitPoints[0] ?? null,
      },
    ];
  }

  // Begin block - split at await points and return statements
  const expressions = body.args;
  const segmentExpressions: Expr[][] = [];
  let currentSegment: Expr[] = [];

  for (const expr of expressions) {
    // Check if this expression contains an await
    const awaitIndex = findAwaitInExpr(expr, awaitPoints);

    // Check if this expression is a return statement
    const isReturn = exprIsFunctionCallOf(expr, "return");

    if (awaitIndex !== -1) {
      // This expression contains an await - end this segment
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];
    } else if (isReturn) {
      // This is a return statement - end this segment after including the return
      currentSegment.push(expr);
      segmentExpressions.push(currentSegment);
      currentSegment = [];
      // Don't process any more expressions after a return
      break;
    } else {
      // No await or return in this expression
      currentSegment.push(expr);
    }
  }

  // Add final segment if there are remaining expressions
  if (currentSegment.length > 0) {
    segmentExpressions.push(currentSegment);
  }

  // Create state segments
  for (let i = 0; i < segmentExpressions.length; i++) {
    const exprs = segmentExpressions[i]!;
    const awaitPoint = i < awaitPoints.length ? awaitPoints[i]! : null;

    segments.push({
      stateNumber: i,
      expressions: exprs,
      awaitPoint,
    });
  }

  return segments;
}

/**
 * Finds the index of an await point that matches an expression.
 * Returns -1 if no await is found in the expression.
 */
function findAwaitInExpr(expr: Expr, awaitPoints: AwaitPoint[]): number {
  for (let i = 0; i < awaitPoints.length; i++) {
    if (containsAwaitExpr(expr, awaitPoints[i]!.expr)) {
      return i;
    }
  }
  return -1;
}

/**
 * Checks if an expression contains a specific await expression.
 */
function containsAwaitExpr(expr: Expr, awaitExpr: Expr): boolean {
  if (expr === awaitExpr) {
    return true;
  }

  switch (expr.tag) {
    case ExprTag.FuncCall:
      if (containsAwaitExpr(expr.func, awaitExpr)) {
        return true;
      }
      for (const arg of expr.args) {
        if (containsAwaitExpr(arg, awaitExpr)) {
          return true;
        }
      }
      break;
  }

  return false;
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
  const emitter = context.emitter;

  for (let i = 0; i < segment.expressions.length; i++) {
    const expr = segment.expressions[i]!;
    const isLastExpr = i === segment.expressions.length - 1;

    // Check if this expression contains the await for this segment
    const isAwaitExpr =
      segment.awaitPoint && containsAwaitExpr(expr, segment.awaitPoint.expr);

    if (isAwaitExpr && segment.awaitPoint) {
      // This expression contains an await - handle specially
      generateAwaitExpression(
        expr,
        segment.awaitPoint,
        segment.stateNumber,
        indent,
        context
      );
    } else if (isLastExpr && captureLastExprResult) {
      // Last expression in final segment - capture its value in sm->result->result
      const code = generateExpr(expr, indent, context);
      if (code) {
        emitter.emitLine(`${indent}// Store final expression result`);
        emitter.emitLine(`${indent}sm->result->result = ${code};`);
      }
    } else {
      // Regular expression - generate normally
      const code = generateExpr(expr, indent, context);
      if (code) {
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
function generateAwaitExpression(
  expr: Expr,
  awaitPoint: AwaitPoint,
  _stateNumber: number,
  indent: string,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Check if this is a standalone await expression: await(futureExpr)
  if (
    expr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.await)
  ) {
    // This is a standalone await: await(futureExpr)
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
  if (expr.tag === ExprTag.FuncCall && exprIsFunctionCallOf(expr, ":=")) {
    // This is an assignment
    const varNameExpr = expr.args[0];
    const valueExpr = expr.args[1];

    if (!varNameExpr || !valueExpr) {
      emitter.emitLine(`${indent}// Error: Invalid assignment expression`);
      return;
    }

    // Check if the value is an await expression
    if (
      valueExpr.tag === ExprTag.FuncCall &&
      exprIsFunctionCallOf(valueExpr, BuiltinFunctions.await)
    ) {
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

      // Store the Future - it's already spawned eagerly
      // The actual result extraction and variable assignment happens in the next state
      // (in generateAsyncBlockResumeFunction, after the result is extracted to await_result_X)
      emitter.emitLine(
        `${indent}// Store Future for await (variable: ${varName}) - future already in state machine and already spawned`
      );

      return;
    }

    // Check if the value is a cond with await in branches
    if (
      valueExpr.tag === ExprTag.FuncCall &&
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
  }

  // Handle cond expression with await in branches
  if (
    expr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(expr, BuiltinKeywords.cond)
  ) {
    emitter.emitLine(
      `${indent}// ERROR: cond expressions with await in branches are not yet fully supported`
    );
    emitter.emitLine(
      `${indent}// Workaround: Extract the cond logic before the await:`
    );
    emitter.emitLine(
      `${indent}//   future := cond(condition => task_a(), true => task_b());`
    );
    emitter.emitLine(`${indent}//   result := await future;`);
    generateCondWithAwait(expr, awaitPoint, indent, context, undefined);
    return;
  }

  // Handle match expression with await in branches
  if (expr.tag === ExprTag.FuncCall && exprIsFunctionCallOf(expr, "match")) {
    emitter.emitLine(
      `${indent}// TODO: Generate async-aware code for match expression with await`
    );
    emitter.emitLine(
      `${indent}// match expressions with await not yet supported`
    );
    return;
  }

  // Handle while loop with await in body
  if (expr.tag === ExprTag.FuncCall && exprIsFunctionCallOf(expr, "while")) {
    generateWhileWithAwait(expr, awaitPoint, indent, context);
    return;
  }

  // Handle other patterns - error, not supported
  emitter.emitLine(
    `${indent}// ERROR: Unsupported pattern for await expression`
  );
  emitter.emitLine(
    `${indent}// Expression type: ${expr.tag}, function: ${expr.tag === ExprTag.FuncCall ? (expr.func.tag === ExprTag.Atom ? expr.func.token?.value : expr.func.tag) : "N/A"}`
  );
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
  targetVariableId?: string // Variable that receives the cond result
): void {
  const emitter = context.emitter;

  // Type guard - condExpr should be a FuncCall
  if (
    condExpr.tag !== ExprTag.FuncCall ||
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

  // Store branch info for later generation
  const branchesWithAwait: Array<{
    index: number;
    value: Expr;
    hasAwait: boolean;
    remainingExprs?: Expr[]; // Expressions after the await in this branch
  }> = [];

  // Generate if-else chain
  for (let i = 0; i < args.length; i++) {
    const pairExpr = args[i]!;

    // Each branch is a => expression: condition => value
    if (
      pairExpr.tag !== ExprTag.FuncCall ||
      !exprIsFunctionCallOf(pairExpr, "=>")
    ) {
      emitter.emitLine(`${indent}// Error: Expected => pair in cond`);
      continue;
    }

    const condition = pairExpr.args[0];
    const value = pairExpr.args[1];

    if (!condition || !value) {
      emitter.emitLine(`${indent}// Error: Invalid pair in cond`);
      continue;
    }

    const condCode =
      i === args.length - 1 &&
      condition.tag === ExprTag.Atom &&
      condition.token?.value === "true"
        ? null // Last condition is 'true' - no need to check
        : generateExpr(condition, indent, context);

    if (condCode) {
      emitter.emitLine(
        `${indent}${i === 0 ? "if" : "else if"} (${condCode}) {`
      );
    } else {
      emitter.emitLine(`${indent}${i === 0 ? "{" : "else {"}`);
    }

    // Check if this branch contains an await
    const branchContainsAwait = branchHasAwait(value);

    if (branchContainsAwait) {
      // Store which branch was taken
      emitter.emitLine(
        `${indent}  sm->cond_branch_${awaitPoint.index} = ${i};`
      );
      // This branch contains an await - generate code to spawn and store Future
      const remainingExprs = generateCondBranchWithAwait(
        value,
        awaitPoint,
        `${indent}  `,
        context
      );
      // Store branch info with remaining expressions
      branchesWithAwait.push({
        index: i,
        value,
        hasAwait: true,
        remainingExprs,
      });
    } else {
      // This branch doesn't contain await - just generate normal code
      const code = generateExpr(value, `${indent}  `, context);
      if (code) {
        emitter.emitLine(`${indent}  ${code};`);
      }
      // Store branch info without remaining expressions
      branchesWithAwait.push({
        index: i,
        value,
        hasAwait: false,
      });
    }

    emitter.emitLine(`${indent}}`);
  }

  // Store branch information in context for resume state generation
  if (!context.condBranchInfo) {
    context.condBranchInfo = new Map();
  }
  context.condBranchInfo.set(awaitPoint.index, {
    branches: branchesWithAwait,
    targetVariableId,
  });
}

/**
 * Checks if a branch value contains any await expression
 */
function branchHasAwait(expr: Expr): boolean {
  if (
    expr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.await)
  ) {
    return true;
  }

  if (expr.tag === ExprTag.FuncCall) {
    for (const arg of expr.args) {
      if (branchHasAwait(arg)) {
        return true;
      }
    }
  }

  return false;
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
    branchValue.tag !== ExprTag.FuncCall ||
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
      if (expr.tag === ExprTag.FuncCall && exprIsFunctionCallOf(expr, ":=")) {
        const valueExpr = expr.args[1];

        if (
          valueExpr &&
          valueExpr.tag === ExprTag.FuncCall &&
          exprIsFunctionCallOf(valueExpr, BuiltinFunctions.await)
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
      } else if (
        expr.tag === ExprTag.FuncCall &&
        exprIsFunctionCallOf(expr, BuiltinFunctions.await)
      ) {
        // Standalone await
        const futureExpr = expr.args[0];
        if (futureExpr) {
          const futureCode = generateExpr(futureExpr, indent, context);
          emitter.emitLine(
            `${indent}// Store Future for await ${awaitPoint.index} (cond branch)`
          );
          emitter.emitLine(
            `${indent}sm->await_future_${awaitPoint.index} = ${futureCode};`
          );
        }
      }
    } else {
      // Expression doesn't contain await - generate normally
      const code = generateExpr(expr, indent, context);
      if (code) {
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

  // Type guard - whileExpr should be a FuncCall to while
  if (
    whileExpr.tag !== ExprTag.FuncCall ||
    !exprIsFunctionCallOf(whileExpr, "while")
  ) {
    emitter.emitLine(`${indent}// Error: Expected while expression`);
    return;
  }

  // while is represented as: while(condition, body)
  const args = whileExpr.args;
  if (args.length !== 2) {
    emitter.emitLine(
      `${indent}// Error: while must have exactly 2 arguments (condition, body)`
    );
    return;
  }

  const conditionExpr = args[0]!;
  const bodyExpr = args[1]!;

  // Initialize loop as active
  emitter.emitLine(
    `${indent}sm->while_loop_${awaitPoint.index}_active = true;`
  );

  // Generate label for loop start (so we can jump back after await)
  emitter.emitLine(`${indent}while_loop_${awaitPoint.index}_start:`);

  // Evaluate condition
  const condCode = generateExpr(conditionExpr, indent, context);
  emitter.emitLine(`${indent}if (!(${condCode})) {`);
  emitter.emitLine(
    `${indent}  sm->while_loop_${awaitPoint.index}_active = false;`
  );
  emitter.emitLine(`${indent}  goto while_loop_${awaitPoint.index}_end;`);
  emitter.emitLine(`${indent}}`);

  // Generate body up to await
  const bodyExprsAfterAwait = generateWhileBodyWithAwait(
    bodyExpr,
    awaitPoint,
    indent,
    context
  );

  // Generate label for loop end
  emitter.emitLine(`${indent}while_loop_${awaitPoint.index}_end:`);

  // Store loop information in context for resume state generation
  if (!context.whileLoopInfo) {
    context.whileLoopInfo = new Map();
  }
  context.whileLoopInfo.set(awaitPoint.index, {
    conditionExpr,
    bodyExpr,
    bodyExprsAfterAwait,
  });
}

/**
 * Generates code for a while loop body that contains an await.
 * Returns the expressions that come AFTER the await, to be executed in the resume state.
 */
function generateWhileBodyWithAwait(
  bodyExpr: Expr,
  awaitPoint: AwaitPoint,
  indent: string,
  context: FunctionGenerationContext
): Expr[] {
  const emitter = context.emitter;
  const remainingExprs: Expr[] = [];

  // If body is a begin block, extract expressions
  let bodyExprs: Expr[] = [];
  if (
    bodyExpr.tag === ExprTag.FuncCall &&
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

  // Generate expressions before the await
  for (let i = 0; i < awaitFoundIndex; i++) {
    const expr = bodyExprs[i]!;
    const code = generateExpr(expr, indent, context);
    if (code) {
      emitter.emitLine(`${indent}${code};`);
    }
  }

  // Generate code to store the Future at the await point
  const awaitExpr = bodyExprs[awaitFoundIndex]!;
  if (
    awaitExpr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(awaitExpr, ":=")
  ) {
    // This is an assignment with await: varName := await(futureExpr)
    const valueExpr = awaitExpr.args[1];
    if (
      valueExpr &&
      valueExpr.tag === ExprTag.FuncCall &&
      exprIsFunctionCallOf(valueExpr, BuiltinFunctions.await)
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
  } else if (
    awaitExpr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(awaitExpr, BuiltinFunctions.await)
  ) {
    // Standalone await
    const futureExpr = awaitExpr.args[0];
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

  // Collect remaining expressions after the await
  for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
    remainingExprs.push(bodyExprs[i]!);
  }

  return remainingExprs;
}

/**
 * Checks if an expression contains any await
 */
function exprContainsAwait(expr: Expr): boolean {
  if (
    expr.tag === ExprTag.FuncCall &&
    exprIsFunctionCallOf(expr, BuiltinFunctions.await)
  ) {
    return true;
  }

  if (expr.tag === ExprTag.FuncCall) {
    if (exprContainsAwait(expr.func)) {
      return true;
    }
    for (const arg of expr.args) {
      if (exprContainsAwait(arg)) {
        return true;
      }
    }
  }

  return false;
}
