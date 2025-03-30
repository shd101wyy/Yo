import { addVariableToEnv, createNewEnv, Environment } from "./env";
import { formatErrorMessage } from "./error";
import Parser, {
  AtomExpr,
  BuiltinCollections,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  FuncCallExpr,
} from "./parser";
import { Token, TokenType } from "./token";
import { createTupleType, TI32, TUnit, Type, TypeTag } from "./type-checker";
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

  private evaluateIntegerLiteral(expr: AtomExpr): AtomExpr {
    if (expr.token.type === TokenType.Integer) {
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

  private evaluateTuple({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
      const args = expr.args.map((arg) =>
        this.evaluateExpression({ expr: arg, env })
      );
      expr.args = args;
      expr.type = createTupleType(
        args.map((arg) => {
          if (!arg.type) {
            throw this.formatErrorMessage(
              arg.token,
              `Expected type for tuple element, got ${arg.tag}`
            );
          }
          return arg.type;
        })
      );
      // TODO: Create value
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected tuple, got ${expr.tag}`
      );
    }
  }

  private isValidVariableName(expr: Expr): boolean {
    return (
      exprIsAtom(expr) &&
      (expr.token.type === TokenType.Identifier ||
        expr.token.type === TokenType.Operator)
    );
  }

  private evaluateInitializationAssignment({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    // const isReAssignment = exprIsFunctionCallOf(expr, "=");
    let lhs = expr.args[0];
    const rhs = expr.args[1];

    // Evaluate the rhs expression
    const nextExpr = this.evaluateExpression({ expr: rhs, env });
    if (nextExpr.env) {
      env = nextExpr.env;
    }

    const rhsType = rhs.type;
    if (!rhsType) {
      throw this.formatErrorMessage(
        rhs.token,
        `Expected type for rhs, got ${rhs.tag}`
      );
    }

    // Check if the lhs is type annotation
    // x : i32
    let isMutable = false;
    let userDefinedType: Type | undefined = undefined;
    if (exprIsFunctionCallOf(lhs, ":")) {
      throw this.formatErrorMessage(
        lhs.token,
        `Type annotation is not implemented`
      );
    }
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, "mut")) {
      isMutable = true;
      // Check if the lhs is a variable
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
    }

    if (lhs.tag === ExprTag.Atom) {
      if (!this.isValidVariableName(lhs)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Invalid assignment to ${lhs.token.value}, expected identifier or operator`
        );
      }
      // Set the variable type
      lhs.type = rhsType;
      // Set the variable value
      lhs.value = rhs.value;
      // TODO: Add variable to env
      // TODO: Attach the updated env to expr
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: lhs.token.value,
          token: lhs.token,
          type: rhsType,
          isMutable,
          isNotInitialized: false,
          value: lhs.value,
        },
      });
      env = nextEnv;
      expr.env = env;
      expr.type = TUnit;
      return expr;
    } else {
      throw this.formatErrorMessage(
        lhs.token,
        `Expected identifier or operator, got ${lhs.tag}`
      );
    }
  }

  private evaluateExpression({
    expr,
    env,
  }: {
    expr: Expr;
    env: Environment;
  }): Expr {
    if (exprIsAtom(expr)) {
      switch (expr.token.type) {
        case TokenType.Integer: {
          const nextExpr = this.evaluateIntegerLiteral(expr);
          if (nextExpr.env) {
            env = nextExpr.env;
          }
          return nextExpr;
        }
        default: {
          throw this.formatErrorMessage(
            expr.token,
            `(1) Evaluating expression ${this.parser.exprToString(
              expr
            )} is not implemented`
          );
        }
      }
    } else {
      if (exprIsFunctionCallOf(expr, ":=")) {
        // Variable assignment
        return this.evaluateInitializationAssignment({ expr, env });
      } else if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
        return this.evaluateTuple({ expr, env });
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `(2) Evaluating expression ${expr.tag} is not implemented`
        );
      }
    }
  }

  private evaluateProgram(): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
    for (let i = 0; i < this.program.length; i++) {
      const expr = this.program[i];
      const nextExpr = this.evaluateExpression({ expr, env });
      if (nextExpr.env) {
        env = nextExpr.env;
      }
    }
  }
}
