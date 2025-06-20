import { Environment } from "../env";
import {
  BuiltinFunctions,
  Expr,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../expr";
import { Token } from "../token";
import { VUnit } from "../value";

// Interface for evaluator context - simplified for now
interface EvaluatorContext {
  borrowings: any[];
  expectedType?: any;
  isEvaluatingFunctionBody?: any;
  SelfType?: any;
  ModuleType?: any;
}

/**
 * Evaluates built-in functions like typeof, consume, etc.
 */
export function evaluateTypeOf(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  createTypeValue: (type: any) => any
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.typeof, 1)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "typeof" with 1 argument, got:\n${exprToString(expr)}`
    );
  }
  const typeExpr = expr.args[0]!;

  // Evaluate the expression
  const evaluatedExpr = evaluateExpression({
    expr: typeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (evaluatedExpr.$?.env) {
    env = evaluatedExpr.$.env;
  }

  // Check if the expression has a type
  if (!evaluatedExpr.$?.type) {
    throw formatErrorMessage(
      typeExpr.token,
      `Expected type for expression, got:\n${exprToString(typeExpr)}`
    );
  }
  const type = evaluatedExpr.$.type;
  const value = createTypeValue(type);
  expr.$ = {
    env,
    type: value.type,
    value: value,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}

export function evaluateConsume(
  expr: FuncCallExpr,
  env: Environment,
  context: EvaluatorContext,
  formatErrorMessage: (token: Token, message: string) => Error,
  evaluateExpression: (params: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }) => Expr,
  checkBorrowings: (borrowings: any[], expr: any) => void,
  setExprAsConsumed: (expr: any, env: Environment) => Environment
): FuncCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinFunctions.consume, 1)) {
    throw formatErrorMessage(
      expr.token,
      `Expected "consume", got:\n${exprToString(expr)}`
    );
  }
  const consumeArgExpr = expr.args[0]!;

  // Evaluate the consume argument
  const evaluatedConsumeArgExpr = evaluateExpression({
    expr: consumeArgExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedConsumeArgExpr.$) {
    throw formatErrorMessage(
      consumeArgExpr.token,
      `Failed to evaluate consume argument:\n${exprToString(consumeArgExpr)}`
    );
  }

  // Check if the consume argument is already borrowed
  checkBorrowings(context.borrowings, evaluatedConsumeArgExpr);

  // Set the consume argument as consumed
  env = evaluatedConsumeArgExpr.$.env;
  env = setExprAsConsumed(evaluatedConsumeArgExpr, env);

  expr.$ = {
    env,
    type: VUnit.type,
    value: VUnit,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
