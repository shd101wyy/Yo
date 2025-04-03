import { addVariableToEnv, createNewEnv, Environment } from "./env";
import { formatErrorMessage } from "./error";
import {
  AtomExpr,
  BuiltinCollections,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "./expr";
import Parser from "./parser";
import { Token, TokenType } from "./token";
import {
  createTupleType,
  TFree,
  TI32,
  TLinear,
  TType,
  TUnit,
  typeOfType,
  TypeTag,
} from "./type-checker";
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
    // const userDefinedType: Type | undefined = undefined;
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

  private evaluateExtern({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "extern")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected extern, got ${expr.tag}`
      );
    }
    const record = expr.args[0];
    if (
      !exprIsFunctionCall(record) ||
      !exprIsFunctionCallOf(record, "record")
    ) {
      throw this.formatErrorMessage(
        record.token,
        `Expected record, got:\n${exprToString(record)}`
      );
    }
    const declarations = record.args;
    for (const declaration of declarations) {
      if (
        !exprIsFunctionCall(declaration) ||
        !exprIsFunctionCallOf(declaration, ":", 2)
      ) {
        throw this.formatErrorMessage(
          declaration.token,
          `Expected type annotation, got:\n${exprToString(declaration)}`
        );
      }
      const nameExpr = declaration.args[0];
      const typeExpr = declaration.args[1];
      if (!exprIsAtom(nameExpr)) {
        throw this.formatErrorMessage(
          declaration.token,
          `Expected identifier, got:\n${exprToString(nameExpr)}`
        );
      }
      const name = declaration.args[0].token.value;
      const nextExpr = this.evaluateExpression({
        expr: typeExpr,
        env,
      });
      env = nextExpr.env || env;
      const typeValue = nextExpr.value;
      if (!typeValue) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type, got:\n${exprToString(typeExpr)}`
        );
      }
      // Add the variable to the env
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name,
          token: nameExpr.token,
          type: typeValue.type,
          isMutable: false,
          isNotInitialized: true,
          value: typeValue,
        },
      });
      env = nextEnv;
      expr.env = env;
    }

    expr.type = TUnit;
    return expr;
  }

  private evaluateIdentifier({
    expr, //    env,
  }: {
    expr: AtomExpr;
    env: Environment;
  }): AtomExpr {
    const identifier = expr.token.value;
    if (identifier === TypeTag.Free) {
      expr.value = {
        tag: TypeTag.Free,
        value: TFree,
        type: typeOfType(TFree),
      };
      expr.type = expr.value.type;
      return expr;
    } else if (identifier === TypeTag.Linear) {
      expr.value = {
        tag: TypeTag.Linear,
        value: TLinear,
        type: typeOfType(TLinear),
      };
      expr.type = expr.value.type;
      return expr;
    } else if (identifier === TypeTag.Type) {
      expr.value = {
        tag: TypeTag.Type,
        value: TType,
        type: typeOfType(TType),
      };
      expr.type = expr.value.type;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `'evaluateIdentifier' Not implemented for identifier: ${identifier}`
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
        case TokenType.Identifier: {
          return this.evaluateIdentifier({
            expr,
            env,
          });
        }
        case TokenType.Integer: {
          return this.evaluateIntegerLiteral(expr);
        }
        default: {
          throw this.formatErrorMessage(
            expr.token,
            `(1) Evaluating the expression below is not implemented:
${exprToString(expr)}`
          );
        }
      }
    } else {
      if (exprIsFunctionCallOf(expr, ":=")) {
        // Variable assignment
        return this.evaluateInitializationAssignment({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "extern")) {
        // extern
        return this.evaluateExtern({ expr, env });
      } else if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
        // tuple
        return this.evaluateTuple({ expr, env });
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `(2) Evaluating the expression below is not implemented:
${exprToString(expr)}`
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
      env = nextExpr.env || env;
    }
  }
}
