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

export function cloneExpr(expr: Expr): Expr {
  switch (expr.tag) {
    case ExprTag.Atom:
      return { ...expr };
    case ExprTag.FuncCall:
      return {
        ...expr,
        func: cloneExpr(expr.func),
        args: expr.args.map(cloneExpr),
      };
  }
}

export type Expr = AtomExpr | FuncCallExpr;

export function exprIsFunctionCall(
  expr: Expr | undefined
): expr is FuncCallExpr {
  return expr?.tag === ExprTag.FuncCall;
}
export function exprIsAtom(expr: Expr | undefined): expr is AtomExpr {
  return expr?.tag === ExprTag.Atom;
}

export function exprIsAtomOf(expr: Expr, values: string | string[]): boolean {
  return (
    expr.tag === ExprTag.Atom &&
    (typeof values === "string"
      ? expr.token.value === values
      : values.includes(expr.token.value))
  );
}

export function exprIsAtomAndOperator(expr: Expr): boolean {
  return expr.tag === ExprTag.Atom && expr.token.type === TokenType.Operator;
}

export function exprIsFunctionCallOf(
  expr: Expr,
  funcNames: string | string[],
  argumentCount?: number
): boolean {
  return (
    expr.tag === ExprTag.FuncCall &&
    expr.func.tag === ExprTag.Atom &&
    (typeof funcNames === "string"
      ? expr.func.token.value === funcNames
      : funcNames.includes(expr.func.token.value)) &&
    (argumentCount === undefined || expr.args.length === argumentCount)
  );
}

export const BuiltinCollections = {
  Tuple: "tuple",
  Array: "array",
};

export const BuiltinKeywords = {
  compt: ["compt", "@"],
  mut: ["mut", "!"],
  implicit: ["implicit", "?"],

  forall: ["forall", "∀"],
  // Exists: ["exists", "∃"],
  // Where: ["where", "∋"],
  // In: ["in", "∈"],

  quote: ["quote", ":"],
  unquote: ["unquote", "$"],

  typeof: ["typeof"],
  def: ["def"],
  recur: ["recur"],
  fn: ["fn"],
  extern: ["extern"],
  cond: ["cond"],
  type: ["type"],
  match: ["match"],
  struct: ["struct"],
  enum: ["enum"],
  union: ["union"],
  module: ["module"],
  begin: ["begin"],
  import: ["import"],
  export: ["export"],

  undefined: ["undefined"],
  null: ["null"],
  true: ["true"],
  false: ["false"],
};

export const BuiltinFunctions = {
  AreTypesCompatible: ["are_types_compatible"],
};

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
          expr.func.token.type === TokenType.Dot ||
          expr.func.token.type === TokenType.BacktickIdentifier)
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
            printed = `(${lhs}.${rhs})`;
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
