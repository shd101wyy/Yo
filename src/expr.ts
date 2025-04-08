/* eslint-disable no-constant-condition */
import { Environment } from "./env";
import { Token, TokenType } from "./token";
import { Type } from "./type-checker";
import { Value } from "./value";

export enum ExprTag {
  Atom = "Atom",
  FuncCall = "FuncCall",
}

export type AtomExpr = {
  // Parser stage
  tag: ExprTag.Atom;
  token: Token;

  // Evaluator stage
  type?: Type;
  env?: Environment;
  value?: Value;
};

export type FuncCallExpr = {
  // Parser stage
  tag: ExprTag.FuncCall;
  func: Expr;
  args: Expr[];
  isInfix?: boolean;
  token: Token;

  // Evaluator stage
  /**
   * The type of the return value of the function call.
   */
  type?: Type;
  env?: Environment;
  value?: Value;
};

export type Expr = AtomExpr | FuncCallExpr;

export function exprIsFunctionCall(expr: Expr): expr is FuncCallExpr {
  return expr.tag === ExprTag.FuncCall;
}
export function exprIsAtom(expr: Expr): expr is AtomExpr {
  return expr.tag === ExprTag.Atom;
}

export function exprIsAtomAndOperator(expr: Expr): boolean {
  return expr.tag === ExprTag.Atom && expr.token.type === TokenType.Operator;
}

export function exprIsFunctionCallOf(
  expr: Expr,
  funcName: string,
  argumentCount?: number
): boolean {
  return (
    expr.tag === ExprTag.FuncCall &&
    expr.func.tag === ExprTag.Atom &&
    expr.func.token.value === funcName &&
    (argumentCount === undefined || expr.args.length === argumentCount)
  );
}

export enum BuiltinCollections {
  Array = "array",
  Tuple = "tuple",
  Record = "record",
  Begin = "begin",
}

export function exprIsInfixOperatorFunctionCall(expr: Expr): boolean {
  return !!(
    expr.tag === "FuncCall" &&
    expr.isInfix &&
    expr.func.tag === "Atom" &&
    expr.func.token.type === TokenType.Operator &&
    expr.args.length === 2
  );
}

export function exprToString(expr: Expr): string {
  let printed = "";
  switch (expr.tag) {
    case "Atom": {
      printed = expr.token.value;
      break;
    }
    case "FuncCall": {
      if (
        expr.func.tag === "Atom" &&
        (expr.func.token.type === TokenType.Operator ||
          expr.func.token.type === TokenType.Dot)
      ) {
        if (expr.args.length === 1) {
          if (expr.func.token.value === ".") {
            printed = `${expr.func.token.value}${exprToString(expr.args[0])}`;
          } else {
            printed = `${expr.func.token.value}(${exprToString(expr.args[0])})`;
          }
          break;
        } else if (expr.args.length === 2 && expr.isInfix) {
          let lhs = exprToString(expr.args[0]);
          let rhs = exprToString(expr.args[1]);
          lhs =
            exprIsInfixOperatorFunctionCall(expr.args[0]) ||
            exprIsAtomAndOperator(expr.args[0])
              ? `(${lhs})`
              : lhs;
          rhs =
            exprIsInfixOperatorFunctionCall(expr.args[1]) ||
            exprIsAtomAndOperator(expr.args[1])
              ? `(${rhs})`
              : rhs;
          if (expr.func.token.value === ".") {
            printed = `${lhs}.${rhs}`;
          } else {
            printed = `${lhs} ${expr.func.token.value} ${rhs}`;
          }
          break;
        }
      }
      if (
        expr.func.tag === "Atom" &&
        expr.func.token.type === TokenType.Identifier &&
        expr.func.token.value === BuiltinCollections.Tuple
      ) {
        if (expr.args.length === 1) {
          printed = `(${exprToString(expr.args[0])},)`;
        } else {
          printed = `(${expr.args
            .map((arg) => {
              return exprToString(arg);
            })
            .join(", ")
            .trim()})`;
        }
        break;
      }

      const func = exprToString(expr.func);
      const args = expr.args
        .map((arg) => {
          return exprToString(arg);
        })
        .join(", ")
        .trim();
      printed = `${func}(${args})`;
      break;
    }
  }

  return printed;
}
