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
  areTypesCompatible,
  createFunctionType,
  createTupleType,
  FunctionParameter,
  TBoolean,
  TF32,
  TF64,
  TFree,
  TI16,
  TI32,
  TI64,
  TI8,
  TIsize,
  TLinear,
  TType,
  TU16,
  TU32,
  TU64,
  TU8,
  TUnit,
  TUsize,
  Type,
  typeOfType,
  TypeTag,
  typeToString,
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

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
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
        type: { ...TI32, isCompileTimeKnown: true },
        value: integerValue,
      };
      expr.value = value;
      expr.type = value.type;
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
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      const typeExpr = lhs.args[1];
      lhs = lhs.args[0];

      // Parse the type expression
      const evaluatedType = this.evaluateExpression({
        expr: typeExpr,
        env,
      });
      if (evaluatedType.env) {
        env = evaluatedType.env;
      }
      const typeValue = evaluatedType.value;
      if (!typeValue || typeValue.tag !== TypeTag.Type) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for lhs, got ${exprToString(typeExpr)}`
        );
      }
      lhs.type = typeValue.value;
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
      if (!lhs.type) {
        // user didn't specify the type
        lhs.type = rhsType;
      } else {
        // Check if the type is compatible
        if (!areTypesCompatible(lhs.type, rhsType)) {
          throw this.formatErrorMessage(
            lhs.token,
            `Incompatible types:
- Defined: ${typeToString(lhs.type)}
- Given  : ${typeToString(rhsType)}`
          );
        }
      }
      // Set the variable value
      lhs.value = rhs.value;
      // Add variable to env
      // Attach the updated env to expr
      const { env: nextEnv } = addVariableToEnv({
        env,
        variable: {
          name: lhs.token.value,
          token: lhs.token,
          type: lhs.type,
          isMutable,
          isNotInitialized: false,
          value: lhs.value,
        },
      });
      env = nextEnv;
      expr.env = env;
      lhs.env = env;
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
      if (!typeValue || typeValue.tag !== TypeTag.Type) {
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
          type: typeValue.value,
          isMutable: false,
          isNotInitialized: true,
        },
      });

      nameExpr.type = typeValue.value;
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
    // Free
    if (identifier === TypeTag.Free) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TFree),
        value: TFree,
      };
      expr.type = typeOfType(TFree);
      return expr;
    }
    // Linear
    else if (identifier === TypeTag.Linear) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TLinear),
        value: TLinear,
      };
      expr.type = typeOfType(TLinear);
      return expr;
    }
    // Type
    else if (identifier === TypeTag.Type) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TType),
        value: TType,
      };
      expr.type = typeOfType(TType);
      return expr;
    }
    // boolean
    else if (identifier === TypeTag.Boolean) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TBoolean),
        value: TBoolean,
      };
      expr.type = typeOfType(TBoolean);
      return expr;
    }
    // usize
    else if (identifier === TypeTag.Usize) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TUsize),
        value: TUsize,
      };
      expr.type = typeOfType(TUsize);
      return expr;
    }
    // isize
    else if (identifier === TypeTag.Isize) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TIsize),
        value: TIsize,
      };
      expr.type = typeOfType(TIsize);
      return expr;
    }
    // u8
    else if (identifier === TypeTag.U8) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TU8),
        value: TU8,
      };
      expr.type = typeOfType(TU8);
      return expr;
    }
    // i8
    else if (identifier === TypeTag.I8) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TI8),
        value: TI8,
      };
      expr.type = typeOfType(TI8);
      return expr;
    }
    // u16
    else if (identifier === TypeTag.U16) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TU16),
        value: TU16,
      };
      expr.type = typeOfType(TU16);
      return expr;
    }
    // i16
    else if (identifier === TypeTag.I16) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TI16),
        value: TI16,
      };
      expr.type = typeOfType(TI16);
      return expr;
    }
    // u32
    else if (identifier === TypeTag.U32) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TU32),
        value: TU32,
      };
      expr.type = typeOfType(TU32);
      return expr;
    }
    // i32
    else if (identifier === TypeTag.I32) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TI32),
        value: TI32,
      };
      expr.type = typeOfType(TI32);
      return expr;
    }
    // u64
    else if (identifier === TypeTag.U64) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TU64),
        value: TU64,
      };
      expr.type = typeOfType(TU64);
      return expr;
    }
    // i64
    else if (identifier === TypeTag.I64) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TI64),
        value: TI64,
      };
      expr.type = typeOfType(TI64);
      return expr;
    }
    // f32
    else if (identifier === TypeTag.F32) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TF32),
        value: TF32,
      };
      expr.type = typeOfType(TF32);
      return expr;
    }
    // f64
    else if (identifier === TypeTag.F64) {
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(TF64),
        value: TF64,
      };
      expr.type = typeOfType(TF64);
      return expr;
    }
    // error
    else {
      throw this.formatErrorMessage(
        expr.token,
        `'evaluateIdentifier' Not implemented for identifier: ${identifier}`
      );
    }
  }

  private evaluateFunctionType({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "->", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected -> for function type, got:\n${exprToString(expr)}`
      );
    }

    const argListExpr = expr.args[0];
    const returnTypeExpr = expr.args[1];

    // Evaluate the return type expression
    const evaluatedReturnType = this.evaluateExpression({
      expr: returnTypeExpr,
      env,
    });

    // Check that the return type is indeed a type
    if (
      !evaluatedReturnType.value ||
      evaluatedReturnType.value.tag !== TypeTag.Type
    ) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a type for function return type, got:\n${exprToString(
          returnTypeExpr
        )}`
      );
    }

    const returnType = evaluatedReturnType.value.value;

    // Handle different forms of parameter lists
    const functionParameters: FunctionParameter[] = [];

    if (
      exprIsFunctionCall(argListExpr) &&
      exprIsFunctionCallOf(argListExpr, BuiltinCollections.Tuple)
    ) {
      // Handle tuple-style parameter list: (param1: Type1, param2: Type2)
      const argList = argListExpr.args;

      for (let i = 0; i < argList.length; i++) {
        const arg = argList[i];
        let paramName: string | undefined = undefined;
        let paramType: Type | undefined = undefined;
        let isMutable = false;
        let paramNameExpr: Expr | undefined = undefined;

        if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, ":", 2)) {
          // Parameter with name and type: paramName: Type
          paramNameExpr = arg.args[0];
          const paramTypeExpr = arg.args[1];

          // Check if the parameter is mutable (mut(paramName): Type)
          if (
            exprIsFunctionCall(paramNameExpr) &&
            exprIsFunctionCallOf(paramNameExpr, "mut", 1)
          ) {
            isMutable = true;
            paramNameExpr = paramNameExpr.args[0];
          }

          // Extract parameter name
          if (!exprIsAtom(paramNameExpr)) {
            throw this.formatErrorMessage(
              paramNameExpr.token,
              `Expected identifier for parameter name, got:\n${exprToString(
                paramNameExpr
              )}`
            );
          }
          paramName = paramNameExpr.token.value;

          // Evaluate the parameter type
          const evaluatedParamType = this.evaluateExpression({
            expr: paramTypeExpr,
            env,
          });

          if (
            !evaluatedParamType.value ||
            evaluatedParamType.value.tag !== TypeTag.Type
          ) {
            throw this.formatErrorMessage(
              paramTypeExpr.token,
              `Expected a type for parameter type, got:\n${exprToString(
                paramTypeExpr
              )}`
            );
          }

          paramType = evaluatedParamType.value.value;
        } else {
          // Just a type without a name, evaluate it directly
          const evaluatedType = this.evaluateExpression({
            expr: arg,
            env,
          });

          if (
            !evaluatedType.value ||
            evaluatedType.value.tag !== TypeTag.Type
          ) {
            throw this.formatErrorMessage(
              arg.token,
              `Expected a type for parameter, got:\n${exprToString(arg)}`
            );
          }

          paramType = evaluatedType.value.value;
        }

        if (!paramType) {
          throw this.formatErrorMessage(
            arg.token,
            `Could not determine parameter type for parameter ${i + 1}`
          );
        }

        const functionParameter: FunctionParameter = {
          name: paramName,
          type: paramType,
          isMutable,
        };

        functionParameters.push(functionParameter);

        // Add functionParameter to the environment
        if (paramName) {
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: paramName,
              token: arg.token,
              type: paramType,
              isMutable,
              isNotInitialized: true,
            },
          });
          env = nextEnv;
        }

        // Update the tokens
        if (paramNameExpr) {
          paramNameExpr.type = paramType;
        }
      }
    } else {
      throw this.formatErrorMessage(
        argListExpr.token,
        `Expected (...) for function parameters, got:\n${exprToString(
          argListExpr
        )}`
      );
    }

    // Create the function type
    const functionType = createFunctionType(functionParameters, returnType);

    // Set the type and value of the expression
    expr.type = typeOfType(functionType);
    expr.value = {
      tag: TypeTag.Type,
      type: typeOfType(functionType),
      value: functionType,
    };

    return expr;
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
      if (exprIsFunctionCallOf(expr, ":=", 2)) {
        // Variable assignment
        return this.evaluateInitializationAssignment({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "->", 2)) {
        // Function type
        return this.evaluateFunctionType({ expr, env });
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
