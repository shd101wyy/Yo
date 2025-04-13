import {
  addVariableToEnv,
  createNewEnv,
  Environment,
  getVariablesFromEnv,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
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
  areParametersAndArgumentsCompatible,
  areTypesCompatible,
  createEnumType,
  createFunctionType,
  createStructType,
  createTupleType,
  EnumType,
  EnumVariant,
  isEnumType,
  isFunctionType,
  isStructType,
  SomeType,
  StructType,
  TBoolean,
  TF32,
  TF64,
  TI16,
  TI32,
  TI64,
  TI8,
  TIsize,
  TU16,
  TU32,
  TU64,
  TU8,
  TUnit,
  TupleElement,
  TupleType,
  TUsize,
  Type,
  typeOfType,
  TypeTag,
  typeToString,
} from "./type-checker";
import { createTypeValue, isTypeValue, Value, ValueTag } from "./value";

interface EvaluatorContext {
  isEvaluatingType?: boolean;
}

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
  private tokens: Token[];

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
    this.tokens = this.parser.getTokens();

    // Evaluate the program
    this.evaluateProgram();
  }

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
  }

  // Add a public method to get the tokens
  public getTokens(): Token[] {
    return this.tokens;
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
        tag: ValueTag.I32,
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

  private evaluateBooleanLiteral(expr: AtomExpr): AtomExpr {
    if (expr.token.type === TokenType.Boolean) {
      const booleanValue = expr.token.value === "true";
      const value: Value = {
        tag: ValueTag.Boolean,
        type: { ...TBoolean, isCompileTimeKnown: true },
        value: booleanValue,
      };
      expr.value = value;
      expr.type = value.type;
      return expr;
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Expected boolean literal, got ${expr.tag}`
      );
    }
  }

  /**
   * Evaluate the element in tuple rvalue, such as
   * value:
   * 14  in (14, ...)
   * (x: 16) in (x: 16)
   *
   * type:
   * i32 in (i32, ...)
   * (x: i32) in (x: i32, ...)
   * (mut(x): i32) in (mut(x): i32, ...)
   */
  private evaluateTupleElement({
    expr,
    env,
    context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
  }): { type: TupleElement; value: Value | undefined; env: Environment } {
    let label: string | undefined = undefined;
    let isMutable: boolean = false;
    let lhsExpr: Expr | undefined = undefined;
    let rhsExpr: Expr = expr;
    let elementType: Type | undefined = undefined;

    // Parse the lhs expr
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ":")) {
      rhsExpr = expr.args[1];
      lhsExpr = expr.args[0];

      if (exprIsFunctionCall(lhsExpr) && exprIsFunctionCallOf(lhsExpr, "mut")) {
        if (!context.isEvaluatingType) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected "mut" to be used in type context, got ${exprToString(
              lhsExpr
            )}`
          );
        }

        isMutable = true;
        if (lhsExpr.args.length !== 1) {
          throw this.formatErrorMessage(
            lhsExpr.token,
            `Expected one argument for mut, got ${lhsExpr.args.length}`
          );
        }
        lhsExpr = lhsExpr.args[0];
      }
      if (!exprIsAtom(lhsExpr) && !this.isValidVariableName(lhsExpr)) {
        throw this.formatErrorMessage(
          lhsExpr.token,
          `Expected identifier for tuple element label, got ${exprToString(
            lhsExpr
          )}`
        );
      }
      label = lhsExpr.token.value;
    }

    // Parse the rhs expr
    const evaluatedRhs = this.evaluateExpression({
      expr: rhsExpr,
      env,
      context,
    });
    if (evaluatedRhs.env) {
      env = evaluatedRhs.env;
    }
    if (context.isEvaluatingType) {
      // Expected the evaluatedRhs to be a type
      const typeValue = evaluatedRhs.value;
      if (!typeValue || !isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `(1) Expected type for tuple element, got ${exprToString(rhsExpr)}`
        );
      }
      elementType = typeValue.value;
      if (lhsExpr) {
        lhsExpr.type = elementType;
      }
    } else {
      // Expected the evaluatedRhs to be a value
      elementType = evaluatedRhs.type;
      if (!elementType) {
        throw this.formatErrorMessage(
          rhsExpr.token,
          `(2) Expected type for tuple element, got ${exprToString(rhsExpr)}`
        );
      }

      if (lhsExpr) {
        lhsExpr.type = lhsExpr.type || evaluatedRhs.type;
      }
    }

    let value: Value | undefined = undefined;
    if (!context.isEvaluatingType) {
      // Evaluating value.
      value = evaluatedRhs.value;
    } else {
      // Evaluating type.
      value = evaluatedRhs.value;
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.value = evaluatedRhs.value;
    }
    expr.env = env;

    return {
      type: {
        label,
        type: elementType,
        isMutable,
        defaultValue: undefined,
      },
      value: value,
      env,
    };
  }

  private evaluateTuple({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected tuple, got ${expr.tag}`
      );
    }

    if (expr.args.length === 0) {
      // Unit
      if (context.isEvaluatingType) {
        expr.value = {
          tag: ValueTag.Type,
          type: typeOfType(TUnit),
          value: TUnit,
        };
        expr.type = typeOfType(TUnit);
        return expr;
      } else {
        expr.value = {
          tag: ValueTag.Unit,
          type: TUnit,
        };
        expr.type = TUnit;
        return expr;
      }
    }

    if (context.isEvaluatingType) {
      env = pushEnvFrame(env);
    }
    const {
      type: tupleType,
      value: tupleValue,
      env: nextEnv,
    } = this.evaluateTupleElements({ args: expr.args, env, context });
    env = nextEnv;
    if (context.isEvaluatingType) {
      env = popEnvFrame(env);
    }

    expr.value = tupleValue;
    expr.type = context.isEvaluatingType ? typeOfType(tupleType) : tupleType;
    expr.env = env;
    return expr;
  }

  /**
   * Please note this function will add args to env if
   * context.isEvaluatingType is true.
   * You need to push the env frame before calling this function.
   * You need to pop the env frame after calling this function.
   * @returns
   */
  private evaluateTupleElements({
    args,
    env,
    context,
  }: {
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): { type: TupleType; value: Value | undefined; env: Environment } {
    const tupleElements: TupleElement[] = [];
    const tupleValues: (Value | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const {
        type,
        value,
        env: nextEnv,
      } = this.evaluateTupleElement({
        expr: arg,
        env,
        context,
      });

      // Check if there is duplicate labels
      if (type.label) {
        const duplicateLabel = tupleElements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            exprIsFunctionCall(arg)
              ? arg.args[0]?.token ?? arg.token
              : arg.token,
            `Duplicate label "${type.label}" in tuple`
          );
        }
      }

      tupleElements.push(type);
      tupleValues.push(value);
      env = nextEnv;

      // Add the variable to the env
      if (context.isEvaluatingType && type.label) {
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: type.label,
            token: arg.token,
            type: type.type,
            isMutable: type.isMutable,
            isNotInitialized: false, // Set as initialized
          },
        });
        env = nextEnv;
      }
    }

    const tupleType: TupleType = createTupleType(tupleElements);
    let value: Value | undefined = undefined;
    if (context.isEvaluatingType) {
      value = {
        tag: ValueTag.Type,
        type: typeOfType(tupleType),
        value: tupleType,
      };
    } else {
      value = tupleValues.some((v) => v === undefined)
        ? undefined
        : {
            tag: ValueTag.Tuple,
            type: tupleType,
            elements: tupleValues as Value[],
          };
    }
    return {
      type: tupleType,
      value,
      env,
    };
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
    const nextExpr = this.evaluateExpression({
      expr: rhs,
      env,
      context: {
        isEvaluatingType: false,
      },
    });
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
        context: {
          isEvaluatingType: true,
        },
      });
      if (evaluatedType.env) {
        env = evaluatedType.env;
      }
      const typeValue = evaluatedType.value;
      if (!typeValue || typeValue.tag !== ValueTag.Type) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for lhs, got value: ${exprToString(typeExpr)}`
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
    const { env: nextEnv } = this.evaluateTupleElements({
      args: expr.args,
      env,
      context: {
        isEvaluatingType: true,
      },
    });
    env = nextEnv;
    expr.type = TUnit;
    expr.env = env;
    return expr;
  }

  private evaluateIdentifier({
    expr,
    env,
  }: {
    expr: AtomExpr;
    env: Environment;
  }): AtomExpr {
    const identifier = expr.token.value;
    // Free
    if (identifier === TypeTag.Free) {
      const someType: SomeType = {
        tag: TypeTag.SomeType,
        parentType: TypeTag.Free,
        size: undefined,
      };
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(someType),
        value: someType,
      };
      expr.type = typeOfType(someType);
      return expr;
    }
    // Linear
    else if (identifier === TypeTag.Linear) {
      const someType: SomeType = {
        tag: TypeTag.SomeType,
        parentType: TypeTag.Linear,
        size: undefined,
      };
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(someType),
        value: someType,
      };
      expr.type = typeOfType(someType);
      return expr;
    }
    // Type
    else if (identifier === TypeTag.Type) {
      const someType: SomeType = {
        tag: TypeTag.SomeType,
        parentType: TypeTag.Type,
        size: undefined,
      };
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(someType),
        value: someType,
      };
      expr.type = typeOfType(someType);
      return expr;
    }
    // boolean
    else if (identifier === TypeTag.Boolean) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TBoolean),
        value: TBoolean,
      };
      expr.type = typeOfType(TBoolean);
      return expr;
    }
    // usize
    else if (identifier === TypeTag.Usize) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TUsize),
        value: TUsize,
      };
      expr.type = typeOfType(TUsize);
      return expr;
    }
    // isize
    else if (identifier === TypeTag.Isize) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TIsize),
        value: TIsize,
      };
      expr.type = typeOfType(TIsize);
      return expr;
    }
    // u8
    else if (identifier === TypeTag.U8) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU8),
        value: TU8,
      };
      expr.type = typeOfType(TU8);
      return expr;
    }
    // i8
    else if (identifier === TypeTag.I8) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI8),
        value: TI8,
      };
      expr.type = typeOfType(TI8);
      return expr;
    }
    // u16
    else if (identifier === TypeTag.U16) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU16),
        value: TU16,
      };
      expr.type = typeOfType(TU16);
      return expr;
    }
    // i16
    else if (identifier === TypeTag.I16) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI16),
        value: TI16,
      };
      expr.type = typeOfType(TI16);
      return expr;
    }
    // u32
    else if (identifier === TypeTag.U32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU32),
        value: TU32,
      };
      expr.type = typeOfType(TU32);
      return expr;
    }
    // i32
    else if (identifier === TypeTag.I32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI32),
        value: TI32,
      };
      expr.type = typeOfType(TI32);
      return expr;
    }
    // u64
    else if (identifier === TypeTag.U64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TU64),
        value: TU64,
      };
      expr.type = typeOfType(TU64);
      return expr;
    }
    // i64
    else if (identifier === TypeTag.I64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TI64),
        value: TI64,
      };
      expr.type = typeOfType(TI64);
      return expr;
    }
    // f32
    else if (identifier === TypeTag.F32) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TF32),
        value: TF32,
      };
      expr.type = typeOfType(TF32);
      return expr;
    }
    // f64
    else if (identifier === TypeTag.F64) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TF64),
        value: TF64,
      };
      expr.type = typeOfType(TF64);
      return expr;
    }
    // variable
    else {
      const variables = getVariablesFromEnv(env, identifier);
      if (!variables.length) {
        throw this.formatErrorMessage(
          expr.token,
          `Variable ${identifier} not found`
        );
      } else {
        const variable = variables[variables.length - 1];
        if (variable.isNotInitialized) {
          throw this.formatErrorMessage(
            expr.token,
            `Variable ${identifier} not initialized`
          );
        }
        expr.value = variable.value;
        expr.type = variable.type;
        expr.env = env;
        return expr;
      }
    }
  }

  private evaluateFunctionType({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "->", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected -> for function type, got:\n${exprToString(expr)}`
      );
    }

    const argListExpr = expr.args[0];
    const returnTypeExpr = expr.args[1];

    // Handle different forms of parameter lists
    let argList: Expr[] = [];
    if (
      exprIsFunctionCall(argListExpr) &&
      exprIsFunctionCallOf(argListExpr, BuiltinCollections.Tuple)
    ) {
      // Handle tuple-style parameter list: (param1: Type1, param2: Type2)
      argList = argListExpr.args;
    } else if (
      exprIsAtom(argListExpr) ||
      (exprIsFunctionCall(argListExpr) &&
        exprIsFunctionCallOf(argListExpr, ":"))
    ) {
      argList = [argListExpr];
    } else {
      throw this.formatErrorMessage(
        argListExpr.token,
        `Expected tuple for function parameters, got:\n${exprToString(
          argListExpr
        )}`
      );
    }

    // Evaluate the parameter list
    env = pushEnvFrame(env);
    const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
      args: argList,
      env,
      context: {
        isEvaluatingType: true,
      },
    });
    const functionParameters = tupleType.elements;
    env = nextEnv;

    // Evaluate the return type expression
    const evaluatedReturnType = this.evaluateExpression({
      expr: returnTypeExpr,
      env,
      context: { isEvaluatingType: true },
    });

    // Check that the return type is indeed a type
    if (!evaluatedReturnType.value || !isTypeValue(evaluatedReturnType.value)) {
      throw this.formatErrorMessage(
        returnTypeExpr.token,
        `Expected a type for function return type, got:\n${exprToString(
          returnTypeExpr
        )}`
      );
    }
    const returnType = evaluatedReturnType.value.value;

    // Create the function type
    const functionType = createFunctionType(functionParameters, returnType);

    // Pop the environment frame
    env = popEnvFrame(env);

    // Set the type and value of the expression
    expr.type = typeOfType(functionType);
    expr.value = {
      tag: ValueTag.Type,
      type: typeOfType(functionType),
      value: functionType,
    };

    return expr;
  }

  private evaluateTypeExpression({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "type", 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected type with 1 argument, got:\n${exprToString(expr)}`
      );
    }

    const typeExpr = expr.args[0];
    const evaluatedType = this.evaluateExpression({
      expr: typeExpr,
      env,
      context: { isEvaluatingType: true },
    });
    if (evaluatedType.env) {
      env = evaluatedType.env;
    }
    const typeValue = evaluatedType.value;
    if (!typeValue || !isTypeValue(typeValue)) {
      throw this.formatErrorMessage(
        typeExpr.token,
        `Expected a type for type expression, got:\n${exprToString(typeExpr)}`
      );
    }
    expr.type = typeValue.type;
    expr.value = typeValue;

    // Add information to the `type` token
    expr.func.type = expr.type;
    expr.func.value = expr.value;

    return expr;
  }

  private evaluateStruct({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "struct")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected struct, got:\n${exprToString(expr)}`
      );
    }

    env = pushEnvFrame(env);
    const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
      args: expr.args,
      env,
      context: {
        isEvaluatingType: true,
      },
    });
    env = nextEnv;
    env = popEnvFrame(env);

    const structType: StructType = createStructType(tupleType.elements);
    expr.type = typeOfType(structType);
    expr.value = {
      tag: ValueTag.Type,
      type: typeOfType(structType),
      value: structType,
    };
    expr.env = env;

    // Append more information to "struct" token.
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

    return expr;
  }

  private evaluateEnum({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "enum")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected enum, got:\n${exprToString(expr)}`
      );
    }

    // Evaluate the variants
    const variants: EnumVariant[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const enumArg = expr.args[i];

      if (exprIsAtom(enumArg)) {
        const variantName = enumArg.token.value;
        if (!this.isValidVariableName(enumArg)) {
          throw this.formatErrorMessage(
            enumArg.token,
            `Expected identifier for enum variant, got:\n${exprToString(
              enumArg
            )}`
          );
        }
        variants.push({
          name: variantName,
        });
      } else {
        if (exprIsFunctionCallOf(enumArg, ":")) {
          throw this.formatErrorMessage(
            enumArg.token,
            `Enum variant with : is not implemented yet`
          );
        }
        if (!this.isValidVariableName(enumArg.func)) {
          throw this.formatErrorMessage(
            enumArg.func.token,
            `Expected identifier for enum variant, got:\n${exprToString(
              enumArg.func
            )}`
          );
        }
        const variantName = enumArg.func.token.value;

        env = pushEnvFrame(env);
        const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
          args: enumArg.args,
          env,
          context: {
            isEvaluatingType: true,
          },
        });
        env = nextEnv;
        env = popEnvFrame(env);

        variants.push({
          name: variantName,
          params: tupleType.elements,
        });
      }
    }

    const enumType: EnumType = createEnumType(variants);
    expr.type = typeOfType(enumType);
    expr.value = createTypeValue(enumType);
    expr.env = env;

    // Append more information to "enum" token.
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

    return expr;
  }

  private evaluatePropertyAccess({
    expr,
    env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, ".")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." for property access, got:\n${exprToString(expr)}`
      );
    }

    if (exprIsFunctionCallOf(expr, ".", 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Inferred variant is not implemented yet, got:\n${exprToString(expr)}`
      );
    }

    if (!exprIsFunctionCallOf(expr, ".", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    const objectExpr = expr.args[0];
    const propertyExpr = expr.args[1];

    // Evaluate object
    const evaluatedObject = this.evaluateExpression({
      expr: objectExpr,
      env,
      context,
    });
    if (evaluatedObject.env) {
      env = evaluatedObject.env;
    }

    // We only support enum for now
    if (evaluatedObject.value && isTypeValue(evaluatedObject.value)) {
      const typeValue = evaluatedObject.value;
      if (isEnumType(typeValue.value)) {
        // Expect propertyExpr to be a symbol atom
        if (!exprIsAtom(propertyExpr)) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Expected identifier for enum variant, got:\n${exprToString(
              propertyExpr
            )}`
          );
        }
        const variantName = propertyExpr.token.value;
        // Check if variantName is a valid enum variant
        const enumType = typeValue.value;
        const variant = enumType.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            propertyExpr.token,
            `Enum variant "${variantName}" not found in enum`
          );
        }
        const newEnumType: EnumType = {
          ...enumType,
          selectedVariantName: variantName,
        };
        expr.type = typeOfType(newEnumType);
        expr.value = createTypeValue(newEnumType);
        expr.env = env;

        return expr;
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Property access not implemented, got:\n${exprToString(expr)}`
    );
  }

  /*
  private evaluateVariant({
    expr,
    // env,
    context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    if (!context.isEvaluatingType) {
      throw this.formatErrorMessage(expr.token, "Not implemented");
    }
    if (!exprIsFunctionCallOf(expr, ".", 1)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected variant with 1 argument, got:\n${exprToString(expr)}`
      );
    }
    const variantExpr = expr.args[0];
    if (exprIsAtom(variantExpr)) {
      if (!this.isValidVariableName(variantExpr)) {
        throw this.formatErrorMessage(
          variantExpr.token,
          `Expected identifier for variant, got:\n${exprToString(variantExpr)}`
        );
      }
      const variantName = variantExpr.token.value;
      const variantType: VariantType = {
        tag: TypeTag.Variant,
        name: variantName,
      };
      expr.type = typeOfType(variantType);
      expr.value = {
        tag: TypeTag.Type,
        type: typeOfType(variantType),
        value: variantType,
      };
      return expr;
    }
    throw this.formatErrorMessage(
      expr.token,
      `Expected identifier for variant, got:\n${exprToString(expr)}`
    );
  }
  */

  /*
  private applyArgumentsToVariant({
    variantExpr,
    args,
    env,
    context,
  }: {
    variantExpr: FuncCallExpr;
    args: Expr[];
    env: Environment;
    context: EvaluatorContext;
  }): Environment {
    const tupleElements: TupleElement[] = [];
    const tupleValues: (Value | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const {
        type,
        value,
        env: nextEnv,
      } = this.evaluateTupleElement({
        expr: arg,
        env: env,
        context,
      });
      env = nextEnv;

      // Check if there is duplicate labels
      if (type.label) {
        const duplicateLabel = tupleElements.find(
          (element) => element.label === type.label
        );
        if (duplicateLabel) {
          throw this.formatErrorMessage(
            arg.token,
            `Duplicate label "${type.label}" in variant`
          );
        }
      }

      tupleElements.push(type);
      tupleValues.push(value);
    }
    const tupleType: TupleType = createTupleType(tupleElements);
    const variantType: VariantType = {
      tag: TypeTag.Variant,
      name: variantExpr.args[0].token.value,
      params: tupleType,
    };
    if (context.isEvaluatingType) {
      variantExpr.value = {
        tag: TypeTag.Type,
        type: typeOfType(variantType),
        value: variantType,
      };
      variantExpr.type = typeOfType(variantType);
      variantExpr.env = env;
    } else {
      variantExpr.type = variantType;
      variantExpr.value = tupleValues.some((v) => v === undefined)
        ? undefined
        : {
            tag: TypeTag.Variant,
            type: variantType,
            elements: tupleValues as Value[],
          };
      variantExpr.env = env;
    }
    return env;
  }
  */

  private evaluateFunctionCall({
    expr,
    env, // context,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    context: EvaluatorContext;
  }): FuncCallExpr {
    const func = expr.func;
    const args = expr.args;

    let functions: { type: Type; value?: Value }[] = [];

    if (exprIsFunctionCall(func)) {
      const functionToCall = this.evaluateExpression({
        expr: func,
        env,
        context: {
          isEvaluatingType: false,
        },
      });
      if (!functionToCall.type) {
        throw this.formatErrorMessage(
          func.token,
          `Expected type for function call, got ${func.tag}`
        );
      }
      functions = [
        {
          type: functionToCall.type,
          value: functionToCall.value,
        },
      ];
    } else {
      const functionName = func.token.value;
      /**
       * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
       */
      const functionVariables = getVariablesFromEnv(env, functionName);
      functions = functionVariables.map((variable) => ({
        type: variable.type,
        value: variable.value,
      }));
    }

    const {
      type: tupleType,
      // value: tupleValue,
      env: nextEnv,
    } = this.evaluateTupleElements({
      args,
      env,
      context: {
        isEvaluatingType: false,
      },
    });
    env = nextEnv;
    const evaluatedArgs = tupleType.elements;

    // Find the functions whose parameters match the arguments
    const functionsWithMatchingTypes = functions.filter((variable) => {
      if (isFunctionType(variable.type)) {
        return areParametersAndArgumentsCompatible(
          variable.type.params,
          evaluatedArgs
        );
      } else {
        const value = variable.value;
        if (value && isTypeValue(value) && isStructType(value.value)) {
          return areParametersAndArgumentsCompatible(
            value.value.members,
            evaluatedArgs
          );
        } else if (value && isTypeValue(value) && isEnumType(value.value)) {
          const enumType = value.value;
          const selectedVariant = enumType.variants.find(
            (variant) => variant.name === enumType.selectedVariantName
          );
          if (!selectedVariant) {
            throw this.formatErrorMessage(
              expr.token,
              `Enum variant not selected for enum type`
            );
          }
          return areParametersAndArgumentsCompatible(
            selectedVariant.params || [],
            evaluatedArgs
          );
        } else {
          // TODO: Support Union and Enum
          return false;
        }
      }
    });

    if (functionsWithMatchingTypes.length === 0) {
      throw this.formatErrorMessage(
        func.token,
        `No matching call found with arguments:
${exprToString(expr)}`
      );
    }
    if (functionsWithMatchingTypes.length > 1) {
      throw this.formatErrorMessage(
        func.token,
        `Ambiguous call with arguments:
${exprToString(expr)}

Found ${functionsWithMatchingTypes.length} matching calls:
${functionsWithMatchingTypes
  .map((func) => `${typeToString(func.type)}`)
  .join("\n")}
`
      );
    }

    const functionToCall = functionsWithMatchingTypes[0];

    if (functionToCall.type && isFunctionType(functionToCall.type)) {
      const functionType = functionToCall.type;
      const functionReturnType = functionType.returnType;
      expr.type = functionReturnType;
      func.type = functionToCall.type;
      return expr;
    } else {
      const value = functionToCall.value;
      if (value && isTypeValue(value) && isStructType(value.value)) {
        const structType = value.value;
        expr.type = structType;
        return expr;
      } else if (value && isTypeValue(value) && isEnumType(value.value)) {
        const enumType = value.value;
        expr.type = enumType;
        return expr;
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Function call is not implemented yet:
${exprToString(expr)}`
    );
  }

  private evaluateDefnExpression({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "defn", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "defn" with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    const functionDefinitionExpr = expr.args[0];
    const functionBodyExpr = expr.args[1];

    if (
      !exprIsFunctionCall(functionDefinitionExpr) ||
      !exprIsFunctionCallOf(functionDefinitionExpr, ":", 2)
    ) {
      throw this.formatErrorMessage(
        functionDefinitionExpr.token,
        `Expected ":" for defining the function parameters and return type, got:\n${exprToString(
          functionDefinitionExpr
        )}`
      );
    }
    const functionNameAndParametersExpr = functionDefinitionExpr.args[0];
    const functionReturnTypeExpr = functionDefinitionExpr.args[1];
    if (!exprIsFunctionCall(functionNameAndParametersExpr)) {
      throw this.formatErrorMessage(
        functionNameAndParametersExpr.token,
        `Expected function name and parameters like "add(x: i32, y: i32)", got:\n${exprToString(
          functionNameAndParametersExpr
        )}`
      );
    }
    const functionNameExpr = functionNameAndParametersExpr.func;
    const functionParameterExprList = functionNameAndParametersExpr.args;

    if (
      !exprIsAtom(functionNameExpr) ||
      !this.isValidVariableName(functionNameExpr)
    ) {
      throw this.formatErrorMessage(
        functionNameExpr.token,
        `Expected identifier for function name, got:\n${exprToString(
          functionNameExpr
        )}`
      );
    }

    // Parse the function parameters
    env = pushEnvFrame(env);
    const { type: tupleType, env: nextEnv } = this.evaluateTupleElements({
      args: functionParameterExprList,
      env,
      context: { isEvaluatingType: true },
    });
    env = nextEnv;
    const functionParameters = tupleType.elements;

    // Parse the function return type
    const evaluatedReturnTypeExpr = this.evaluateExpression({
      expr: functionReturnTypeExpr,
      env,
      context: { isEvaluatingType: true },
    });
    const returnTypeValue = evaluatedReturnTypeExpr.value;
    if (!returnTypeValue || !isTypeValue(returnTypeValue)) {
      throw this.formatErrorMessage(
        functionReturnTypeExpr.token,
        `Expected type for function return type, got:\n${exprToString(
          functionReturnTypeExpr
        )}`
      );
    }
    const returnType = returnTypeValue.value;

    /// Add functionType to the functionNameExpr
    const functionType = createFunctionType(functionParameters, returnType);
    functionNameExpr.type = functionType;
    /// Add function with name to env;
    const { env: nextNextEnv } = addVariableToEnv({
      env,
      variable: {
        name: functionNameExpr.token.value,
        token: functionNameExpr.token,
        type: functionType,
        isMutable: false,
        isNotInitialized: false,
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;

    // Parse the function body
    const evaluatedFunctionBody = this.evaluateExpression({
      expr: functionBodyExpr,
      env,
      context: { isEvaluatingType: false },
    });
    if (evaluatedFunctionBody.env) {
      env = evaluatedFunctionBody.env;
    }

    // Check if the function body type matches the function return type
    if (evaluatedFunctionBody.type) {
      if (!areTypesCompatible(returnType, evaluatedFunctionBody.type)) {
        throw this.formatErrorMessage(
          functionReturnTypeExpr.token,
          `Incompatible function return type:
- Expected: ${typeToString(returnType)}
- Given  : ${typeToString(evaluatedFunctionBody.type)}`
        );
      }
    }

    // Pop the env frame
    env = popEnvFrame(env);

    // Set the function type and value
    expr.type = functionType;
    expr.env = env;
    return expr;
  }

  private evaluateBeginExpression({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "begin")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "begin", got:\n${exprToString(expr)}`
      );
    }
    const exprs = expr.args;

    // Empty begin
    // return unit
    if (exprs.length === 0) {
      expr.type = TUnit;
      expr.value = {
        tag: ValueTag.Unit,
        type: TUnit,
      };
      return expr;
    }

    // Push a new environment frame
    env = pushEnvFrame(env);

    // Evaluate expressions
    for (let i = 0; i < exprs.length; i++) {
      const evaluatedExpr = this.evaluateExpression({
        expr: exprs[i],
        env,
        context: {
          isEvaluatingType: false,
        },
      });
      if (evaluatedExpr.env) {
        env = evaluatedExpr.env;
      }
    }
    const lastExpr = exprs[exprs.length - 1];
    expr.type = lastExpr.type;
    expr.value = lastExpr.value;

    // Pop the environment frame
    env = popEnvFrame(env);
    expr.env = env;
    return expr;
  }

  private evaluateExpression({
    expr,
    env,
    context,
  }: {
    expr: Expr;
    env: Environment;
    context: EvaluatorContext;
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
        case TokenType.Boolean: {
          return this.evaluateBooleanLiteral(expr);
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
        return this.evaluateFunctionType({
          expr,
          env,
          context: { isEvaluatingType: true },
        });
      } else if (exprIsFunctionCallOf(expr, "extern")) {
        // extern
        return this.evaluateExtern({ expr, env });
      } else if (exprIsFunctionCallOf(expr, BuiltinCollections.Tuple)) {
        // tuple
        return this.evaluateTuple({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "type")) {
        // type Expr
        return this.evaluateTypeExpression({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "struct")) {
        // struct
        return this.evaluateStruct({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "enum")) {
        // enum
        return this.evaluateEnum({ expr, env });
      } else if (exprIsFunctionCallOf(expr, ".")) {
        // property access
        return this.evaluatePropertyAccess({ expr, env, context });
      } else if (exprIsFunctionCallOf(expr, "defn")) {
        // defn
        return this.evaluateDefnExpression({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "begin")) {
        // begin
        return this.evaluateBeginExpression({ expr, env });
      } else {
        /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      } */
        // Function call
        return this.evaluateFunctionCall({ expr, env, context });
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
      const nextExpr = this.evaluateExpression({
        expr,
        env,
        context: {
          isEvaluatingType: false,
        },
      });
      env = nextExpr.env || env;
    }
  }
}
