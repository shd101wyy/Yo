import { createNewEnv, Environment } from "./env";
import { formatErrorMessage } from "./error";
import Parser, { Expr, exprIsFunctionCallOf, ExprTag } from "./parser";
import { Token, TokenType } from "./token";
import { TI32, TypeTag } from "./type-checker";
import { Value } from "./value";

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private parser: Parser;
  private program: Expr[];

  constructor({
    modulePath,
    inputString,
  }: {
    modulePath: string;
    inputString: string;
  }) {
    this.modulePath = modulePath;
    this.inputString = inputString;

    // Parse the module
    this.parser = new Parser({ modulePath, inputString });
    this.program = this.parser.getProgram();

    // Evaluate the program
    this.evaluateProgram();
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
  }

  private evaluateIntegerLiteral(expr: Expr): Expr {
    if (expr.tag === ExprTag.Atom && expr.token.type === TokenType.Integer) {
      const integerValue = parseInt(expr.token.value, 10);
      const value: Value = {
        tag: TypeTag.I32,
        type: TI32,
        value: integerValue,
      };
      expr.value = value;
      expr.type = TI32;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected integer literal, got ${expr.tag}`
      );
    }
  }

  private evaluateAssignment({
    expr,
    env,
  }: {
    expr: Expr;
    env: Environment;
  }): Expr {
    if (expr.tag === ExprTag.FuncCall) {
      // const isReAssignment = exprIsFunctionCallOf(expr, "=");
      const lhs = expr.args[0];
      const rhs = expr.args[1];

      // Evaluate the rhs expression
      const nextExpr = this.evaluateExpression({ expr: rhs, env });
      env = nextExpr.env;

      if (lhs.tag === ExprTag.Atom) {
        if (
          lhs.token.type !== TokenType.Identifier &&
          lhs.token.type !== TokenType.Operator
        ) {
          throw this.formatErrorMessage(
            lhs.token,
            `Invalid assignment to ${lhs.token.value}, expected identifier or operator`
          );
        }
        // Set the variable type
        lhs.type = rhs.type;
        // Set the variable value
        lhs.value = rhs.value;
        // TODO: Add variable to env
        // TODO: Attach the updated env to expr
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      "Evaluating assignment is not implemented"
    );
  }

  private evaluateExpression({ expr, env }: { expr: Expr; env: Environment }): {
    env: Environment;
  } {
    if (expr.tag === ExprTag.Atom) {
      switch (expr.token.type) {
        case TokenType.Integer: {
          const nextExpr = this.evaluateIntegerLiteral(expr);
          if (nextExpr.env) {
            env = nextExpr.env;
          }
          break;
        }
        default: {
          throw this.formatErrorMessage(
            expr.token,
            `Evaluating expression ${this.parser.exprToString(
              expr
            )} is not implemented`
          );
        }
      }
    } else {
      if (exprIsFunctionCallOf(expr, ":=")) {
        // Variable assignment
        const nextExpr = this.evaluateAssignment({ expr, env });
        if (nextExpr.env) {
          env = nextExpr.env;
        }
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Evaluating expression ${expr.tag} is not implemented`
        );
      }
    }

    return { env };
  }

  private evaluateProgram(): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
    for (let i = 0; i < this.program.length; i++) {
      const expr = this.program[i];
      const { env: nextEnv } = this.evaluateExpression({ expr, env });
      env = nextEnv;
    }
  }
}
