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
  exprToString,
  FuncCallExpr,
} from "./expr";
import Parser from "./parser";
import { Token, TokenType } from "./token";
import {
  areTypesCompatible,
  createEnumType,
  createFunctionType,
  createStructType,
  createTupleType,
  EnumType,
  EnumVariant,
  FunctionType,
  isBooleanType,
  isEnumType,
  isFunctionType,
  isFunctionTypeAndIsTypeFunction,
  isPlaceholderType,
  isStructType,
  isTupleType,
  isTypeHierarchyType,
  StructType,
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
  TPlaceholder,
  TType,
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
import {
  createTypeValue,
  FunctionValue,
  isFunctionValue,
  isTupleValue,
  isTypeValue,
  TupleValue,
  TypeValue,
  Value,
  ValueTag,
  VUnknown,
} from "./value";

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
  }): { type: TupleElement; value: Value; env: Environment } {
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
        elementType = TPlaceholder;
      } else if (lhsExpr) {
        lhsExpr.type = lhsExpr.type || evaluatedRhs.type;
      }
    }

    let value: Value = VUnknown;
    if (!context.isEvaluatingType) {
      // Evaluating value.
      value = evaluatedRhs.value ?? VUnknown;
    } else {
      // Evaluating type.
      value = VUnknown; // NOTE: This is necessary
    }

    if (lhsExpr) {
      lhsExpr.env = env;
      lhsExpr.value = value;
    }
    expr.env = env;
    return {
      type: {
        label,
        type: elementType,
        expr,
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
  }): {
    type: TupleType;
    value: TupleValue | TypeValue | undefined;
    env: Environment;
  } {
    const tupleElements: TupleElement[] = [];
    const tupleValues: Value[] = [];
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
      value = {
        tag: ValueTag.Tuple,
        type: tupleType,
        elements: tupleValues,
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

  /**
   * Synthesize the expression and type, such as:
   * - (p: Point) := _(3, 4);   // here _ becomes Point
   * - (p: Color) := .Red;      // here (.) becomes (Color.)
   * - (p: Shape) := .Circle(3) // here (.) becomes (Shape.)
   */
  private synthesizeExprAndType({
    expr,
    type,
    env,
  }: {
    expr: Expr;
    type: Type;
    env: Environment;
  }): { expr: Expr; type: Type; env: Environment } {
    console.log(`Synthesize expr and type:
expr: ${exprToString(expr)}
type: ${typeToString(type)}`);

    // Handle the _ case
    if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, "_")) {
      // Check if type is a struct type
      if (isStructType(type)) {
        const funcCallExpr = this.evaluateFunctionCall({
          expr,
          env,
          givenFunc: {
            type: typeOfType(type),
            value: createTypeValue(type),
          },
        });

        if (!funcCallExpr.type || !funcCallExpr.env) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to evaluate expr and type for struct:\n${exprToString(
              expr
            )}`
          );
        }

        return {
          expr: funcCallExpr,
          type: funcCallExpr.type,
          env: funcCallExpr.env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use _ with type ${typeToString(
            type
          )}. Only supported with struct types.`
        );
      }
    }
    // Handle the . case for enum variant
    else if (exprIsFunctionCall(expr) && exprIsFunctionCallOf(expr, ".", 1)) {
      // Check if type is an enum type
      if (isEnumType(type)) {
        const variantNameExpr = expr.args[0];
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            expr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }
        const variantName = variantNameExpr.token.value;
        const variant = type.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            expr.token,
            `Enum variant "${variantName}" not found in ${typeToString(type)}`
          );
        }

        const newEnumType = { ...type, selectedVariantName: variantName };
        expr.type = newEnumType;
        // TODO: comptime value

        return {
          expr: expr,
          type: newEnumType,
          env: env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use . with type ${typeToString(
            type
          )}. Only supported with enum types.`
        );
      }
    }
    // Handle the . case for enum variant call
    else if (
      exprIsFunctionCall(expr) &&
      exprIsFunctionCall(expr.func) &&
      exprIsFunctionCallOf(expr.func, ".", 1)
    ) {
      if (isEnumType(type)) {
        const variantExpr = expr.func;
        const variantNameExpr = variantExpr.args[0];
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            variantExpr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }

        const variantName = variantNameExpr.token.value;
        const variant = type.variants.find(
          (variant) => variant.name === variantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            expr.token,
            `Enum variant "${variantName}" not found in ${typeToString(type)}`
          );
        }

        const newEnumType = { ...type, selectedVariantName: variantName };
        const funcCallExpr = this.evaluateFunctionCall({
          expr,
          env,
          givenFunc: {
            type: typeOfType(newEnumType),
            value: createTypeValue(newEnumType),
          },
        });
        if (!funcCallExpr.type || !funcCallExpr.env) {
          throw this.formatErrorMessage(
            expr.token,
            `Failed to evaluate expr and type for enum variant:\n${exprToString(
              expr
            )}`
          );
        }

        return {
          expr: funcCallExpr,
          type: funcCallExpr.type,
          env: funcCallExpr.env,
        };
      } else {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot use . with type ${typeToString(
            type
          )}. Only supported with enum types.`
        );
      }
    } else {
      throw this.formatErrorMessage(
        expr.token,
        `Failed to synthesize the type and expr: ${exprToString(expr)}`
      );
    }
  }

  /**
   * rhs should be already evaluated
   */
  private evaluateDestructuringAssignment({
    lhs,
    rhs,
    env,
  }: {
    lhs: Expr;
    rhs: Expr;
    env: Environment;
  }): Environment {
    const rhsType = rhs.type;
    if (!rhsType) {
      throw this.formatErrorMessage(
        rhs.token,
        `(1) Expected type for right-hand side, got ${exprToString(rhs)}`
      );
    }

    // Handle struct destructuring
    if (isStructType(rhsType) && exprIsFunctionCall(lhs)) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsMembers: rhsType.members,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
      });
    }
    // Handle tuple destructuring
    else if (
      isTupleType(rhsType) &&
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinCollections.Tuple)
    ) {
      return this.handleMemberDestructuring({
        lhsFunc: lhs.func,
        lhsElements: lhs.args,
        rhsMembers: rhsType.elements,
        rhsValue: rhs.value,
        rhsType,
        lhs,
        env,
      });
    }

    throw this.formatErrorMessage(
      lhs.token,
      `Destructuring assignment not supported for this pattern: ${exprToString(
        lhs
      )}`
    );
  }

  // Modified to handle member destructuring directly
  private handleMemberDestructuring({
    lhsFunc,
    lhsElements,
    rhsMembers,
    rhsValue,
    rhsType,
    lhs,
    env,
  }: {
    lhsFunc: Expr;
    lhsElements: Expr[];
    rhsMembers: TupleElement[];
    rhsValue: Value | undefined;
    rhsType: Type;
    lhs: Expr;
    env: Environment;
  }): Environment {
    const isStruct = isStructType(rhsType);
    const structTypeName = isStruct ? lhsFunc.token.value : undefined;

    // Verify the struct type name matches if specified
    if (
      isStructType(rhsType) &&
      rhsType.typeName &&
      structTypeName !== "_" &&
      structTypeName !== rhsType.typeName
    ) {
      throw this.formatErrorMessage(
        lhsFunc.token,
        `Expected struct of type ${rhsType.typeName}, got ${structTypeName}`
      );
    }

    // Check if we have enough elements
    if (lhsElements.length > rhsMembers.length) {
      throw this.formatErrorMessage(
        lhs.token,
        `Too many elements in destructuring pattern. Expected at most ${rhsMembers.length}, got ${lhsElements.length}`
      );
    }

    // Process each lhs element
    for (let i = 0; i < lhsElements.length; i++) {
      const lhsElement = lhsElements[i];
      let elementIndex: number = i;
      // Initialize rhsMember here, before any conditional branches
      let rhsMember = rhsMembers[elementIndex];
      let variableName: string | undefined;
      let variableToken: Token | undefined;
      let labelExpr: Expr | undefined = undefined;
      let renameExpr: Expr | undefined = undefined;

      // Handle nested tuple destructuring pattern like (a, b, (x, y))
      if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, BuiltinCollections.Tuple)
      ) {
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Ensure the member we're destructuring is a tuple or struct
        if (!isTupleType(nestedRhsType) && !isStructType(nestedRhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected tuple or struct for nested destructuring, got ${typeToString(
              nestedRhsType
            )}`
          );
        }

        // Get the nested members
        const nestedMembers = isTupleType(nestedRhsType)
          ? nestedRhsType.elements
          : (nestedRhsType as StructType).members;

        // Recursively process nested destructuring
        env = this.handleMemberDestructuring({
          lhsFunc: lhsElement.func,
          lhsElements: lhsElement.args,
          rhsMembers: nestedMembers,
          rhsValue: nestedValue as TupleValue | undefined,
          rhsType: nestedRhsType,
          lhs: lhsElement,
          env,
        });

        // Set type and value on the lhs element
        lhsElement.type = nestedRhsType;
        lhsElement.value = nestedValue;
        lhsElement.env = env;

        // Skip to next element since we've already processed this one
        continue;
      }

      // Handle nested struct destructuring pattern like (a, SomeStruct(x, y)) or (a, _(x, y))
      else if (
        exprIsFunctionCall(lhsElement) &&
        ((exprIsAtom(lhsElement.func) &&
          this.isValidVariableName(lhsElement)) ||
          exprIsFunctionCallOf(lhsElement.func, "_"))
      ) {
        const structNameExpr = lhsElement.func;
        const structNameValue = exprIsAtom(structNameExpr)
          ? structNameExpr.token.value
          : "_";

        // Get the right-hand side value at this position
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Ensure the member we're destructuring is a struct
        if (!isStructType(nestedRhsType)) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Expected struct for struct destructuring, got ${typeToString(
              nestedRhsType
            )}`
          );
        }

        // For named struct, verify the struct type name matches
        if (
          structNameValue !== "_" &&
          nestedRhsType.typeName &&
          structNameValue !== nestedRhsType.typeName
        ) {
          throw this.formatErrorMessage(
            lhsElement.func.token,
            `Expected struct of type ${nestedRhsType.typeName}, got ${structNameValue}`
          );
        }

        // Recursively process nested destructuring
        env = this.handleMemberDestructuring({
          lhsFunc: lhsElement.func,
          lhsElements: lhsElement.args,
          rhsMembers: nestedRhsType.members,
          rhsValue: nestedValue as TupleValue | undefined,
          rhsType: nestedRhsType,
          lhs: lhsElement,
          env,
        });

        // Set type and value on the lhs element
        lhsElement.type = nestedRhsType;
        lhsElement.value = nestedValue;
        lhsElement.env = env;

        // Skip to next element since we've already processed this one
        continue;
      }
      // Handle labeled nested destructuring pattern like (c: (x, y))
      else if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ":", 2)
      ) {
        const leftSide = lhsElement.args[0]; // The label (c)
        const rightSide = lhsElement.args[1]; // Could be (x, y) or could be a variable

        // The left side should be an identifier
        if (!exprIsAtom(leftSide) || !this.isValidVariableName(leftSide)) {
          throw this.formatErrorMessage(
            leftSide.token,
            `Expected identifier for label in destructuring pattern, got ${exprToString(
              leftSide
            )}`
          );
        }

        labelExpr = leftSide;
        const label = labelExpr.token.value;

        // Find the member with matching label
        const matchingMemberIndex = rhsMembers.findIndex(
          (member) => member.label === label
        );

        if (matchingMemberIndex === -1) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Label "${label}" not found in the ${
              isStruct ? "struct" : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsMember = rhsMembers[elementIndex];
        const nestedRhsType = rhsMember.type;

        // Get the nested value
        let nestedValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          nestedValue = rhsValue.elements[elementIndex];
        }

        // Check if the right side is a tuple for nested destructuring (c: (x, y))
        if (
          exprIsFunctionCall(rightSide) &&
          exprIsFunctionCallOf(rightSide, BuiltinCollections.Tuple)
        ) {
          // Ensure the member we're destructuring is a tuple or struct
          if (!isTupleType(nestedRhsType) && !isStructType(nestedRhsType)) {
            throw this.formatErrorMessage(
              lhsElement.token,
              `Expected tuple or struct for nested destructuring, got ${typeToString(
                nestedRhsType
              )}`
            );
          }

          // Get the nested members
          const nestedMembers = isTupleType(nestedRhsType)
            ? nestedRhsType.elements
            : (nestedRhsType as StructType).members;

          // Recursively process nested destructuring
          env = this.handleMemberDestructuring({
            lhsFunc: rightSide.func,
            lhsElements: rightSide.args,
            rhsMembers: nestedMembers,
            rhsValue: nestedValue as TupleValue | undefined,
            rhsType: nestedRhsType,
            lhs: rightSide,
            env,
          });

          // Set type and value on expressions
          rightSide.type = nestedRhsType;
          rightSide.value = nestedValue;
          rightSide.env = env;

          labelExpr.type = nestedRhsType;
          lhsElement.type = nestedRhsType;
          lhsElement.value = nestedValue;
          lhsElement.env = env;

          // Skip to next element since we've already processed this one
          continue;
        }
        // Variable rename case like (a: m)
        else if (exprIsAtom(rightSide) && this.isValidVariableName(rightSide)) {
          renameExpr = rightSide;
          variableName = rightSide.token.value;
          variableToken = rightSide.token;
        }
        // Other patterns that don't match previous conditions
        else {
          throw this.formatErrorMessage(
            rightSide.token,
            `Expected tuple or variable name for destructuring pattern, got ${exprToString(
              rightSide
            )}`
          );
        }
      }

      // Handle label-based destructuring like Named(.x, .y) := p or (.a, .b) := x
      else if (
        exprIsFunctionCall(lhsElement) &&
        exprIsFunctionCallOf(lhsElement, ".", 1)
      ) {
        labelExpr = lhsElement.args[0];
        if (!exprIsAtom(labelExpr) || !this.isValidVariableName(labelExpr)) {
          throw this.formatErrorMessage(
            labelExpr.token,
            `Expected identifier for label in destructuring pattern, got ${exprToString(
              labelExpr
            )}`
          );
        }

        const label = labelExpr.token.value;
        // Find the member with matching label
        const matchingMemberIndex = rhsMembers.findIndex(
          (member) => member.label === label
        );

        if (matchingMemberIndex === -1) {
          throw this.formatErrorMessage(
            lhsElement.token,
            `Label "${label}" not found in the ${
              isStruct ? "struct" : "tuple"
            } being destructured`
          );
        }

        elementIndex = matchingMemberIndex;
        rhsMember = rhsMembers[elementIndex];
        variableName = label;
        variableToken = labelExpr.token;
      }

      // Handle positional destructuring
      else if (exprIsAtom(lhsElement) && this.isValidVariableName(lhsElement)) {
        variableName = lhsElement.token.value;
        variableToken = lhsElement.token;
      } else {
        throw this.formatErrorMessage(
          lhsElement.token,
          `Unsupported destructuring pattern for ${
            isStruct ? "struct" : "tuple"
          }: ${exprToString(lhsElement)}`
        );
      }

      // After determining variableName and variableToken, add to environment
      if (variableName && variableToken) {
        // Get the value if available
        let elementValue: Value | undefined = undefined;
        if (isTupleValue(rhsValue)) {
          elementValue = rhsValue.elements[elementIndex];
        }

        // Add the variable to the environment
        const { env: nextEnv } = addVariableToEnv({
          env,
          variable: {
            name: variableName,
            token: variableToken,
            type: rhsMember.type,
            isMutable: false,
            isNotInitialized: false,
            value: elementValue,
          },
        });

        env = nextEnv;

        // Set the type and value on the lhs element for completeness
        lhsElement.type = rhsMember.type;
        lhsElement.value = elementValue;
        lhsElement.env = env;

        if (labelExpr) {
          labelExpr.type = rhsMember.type;
          if (!renameExpr) {
            labelExpr.value = elementValue;
          }
          labelExpr.env = env;
        }

        if (renameExpr) {
          renameExpr.type = rhsMember.type;
          renameExpr.value = elementValue;
          renameExpr.env = env;
        }
      }
    }

    return env;
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
    let rhs = expr.args[1];

    // Evaluate the rhs expression
    rhs = this.evaluateExpression({
      expr: rhs,
      env,
      context: {
        isEvaluatingType: false,
      },
    });
    if (rhs.env) {
      env = rhs.env;
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
      if (!typeValue || !isTypeValue(typeValue)) {
        throw this.formatErrorMessage(
          typeExpr.token,
          `Expected type for lhs, got value: ${exprToString(typeExpr)}`
        );
      }
      lhs.type = typeValue.value;
    }
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, "mut")) {
      isMutable = true;

      // If rhs is type value, then it cannot be mutable
      if (isTypeValue(rhs.value)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Unexpected mut for type value: ${exprToString(rhs)}`
        );
      }

      // Check if the lhs is a variable
      if (lhs.args.length !== 1) {
        throw this.formatErrorMessage(
          lhs.token,
          `Expected one argument for mut, got ${lhs.args.length}`
        );
      }
      lhs = lhs.args[0];
    }

    if (exprIsAtom(lhs)) {
      if (!this.isValidVariableName(lhs)) {
        throw this.formatErrorMessage(
          lhs.token,
          `Invalid assignment to ${lhs.token.value}, expected identifier or operator`
        );
      }

      // Set the variable type
      let rhsType = rhs.type;
      if (!lhs.type) {
        if (!rhsType) {
          throw this.formatErrorMessage(
            rhs.token,
            `(2) Expected type for right-hand side, got ${exprToString(rhs)}`
          );
        }
        // user didn't specify the type
        lhs.type = rhsType;
      } else {
        // If !rhsType, then check if rhs is a function call of _
        if (!rhsType) {
          // Infer the type
          const {
            expr: nextRhs,
            type: nextRhsType,
            env: nextEnv,
          } = this.synthesizeExprAndType({
            expr: rhs,
            type: lhs.type,
            env: env,
          });
          rhs = nextRhs;
          rhsType = nextRhsType;
          env = nextEnv;
        }

        // Check if the type is compatible
        if (!areTypesCompatible(lhs.type, rhsType, env)) {
          throw this.formatErrorMessage(
            lhs.token,
            `Incompatible types:
- Defined: ${typeToString(lhs.type)}
- Given  : ${typeToString(rhsType)}`
          );
        }
      }

      // Add .typeName info if necessary
      if (
        isTypeValue(rhs.value) &&
        (isStructType(rhs.value.value) || isEnumType(rhs.value.value)) &&
        !rhs.value.value.typeName
      ) {
        rhs.value.value.typeName = lhs.token.value;
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
      // Evaluate the destructuring assignment
      if (!rhs.type) {
        throw this.formatErrorMessage(
          rhs.token,
          `(3) Expected type for right-hand side, got ${exprToString(rhs)}`
        );
      }

      env = this.evaluateDestructuringAssignment({
        lhs,
        rhs,
        env,
      });
      expr.type = TUnit;
      expr.env = env;
      return expr;
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

  private evaluateCond({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "cond")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected cond, got ${expr.tag}`
      );
    }

    const statements = expr.args;
    if (statements.length === 0) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least one statement in cond, got ${statements.length}`
      );
    }

    // Evaluate each statement
    // condition -> value.
    // expect each value to be the same type.
    let valueType: Type | undefined = undefined;
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (
        !exprIsFunctionCall(statement) ||
        !exprIsFunctionCallOf(statement, "->", 2)
      ) {
        throw this.formatErrorMessage(
          statement.token,
          `Expected -> for cond statement, got ${statement.tag}`
        );
      }
      const condExpr = statement.args[0];
      const valueExpr = statement.args[1];

      // Expect condExpr to be a boolean
      const evaluatedCond = this.evaluateExpression({
        expr: condExpr,
        env,
        context: {
          isEvaluatingType: false,
        },
      });

      // TODO: Check comptime value if exists
      if (evaluatedCond.env) {
        env = evaluatedCond.env;
      }
      if (!evaluatedCond.type || !isBooleanType(evaluatedCond.type)) {
        throw this.formatErrorMessage(
          condExpr.token,
          `Expected boolean for cond statement, got ${exprToString(condExpr)}`
        );
      }

      // Evaluate the valueExpr
      const evaluatedValue = this.evaluateExpression({
        expr: valueExpr,
        env,
        context: {
          isEvaluatingType: false,
        },
      });

      // QUESTION: Should we update the env here?
      // if (evaluatedValue.env) {
      //   env = evaluatedValue.env;
      //}
      if (!evaluatedValue.type) {
        throw this.formatErrorMessage(
          valueExpr.token,
          `Expected type for cond statement, got ${exprToString(valueExpr)}`
        );
      }
      if (!valueType) {
        valueType = evaluatedValue.type;
      } else {
        // Check if the type is compatible
        if (!areTypesCompatible(valueType, evaluatedValue.type, env)) {
          throw this.formatErrorMessage(
            valueExpr.token,
            `Incompatible types:
- Previous: ${typeToString(valueType)}
- Current : ${typeToString(evaluatedValue.type)}`
          );
        }
      }
    }

    expr.type = valueType;
    // TODO: set .value
    expr.value = VUnknown;
    return expr;
  }

  private evaluateMatch({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "match")) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected match, got ${expr.tag}`
      );
    }

    const args = expr.args;
    if (args.length < 2) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected at least 2 arguments for match, got ${args.length}`
      );
    }

    // Evaluate the value to be matched
    const valueExpr = args[0];
    const evaluatedValue = this.evaluateExpression({
      expr: valueExpr,
      env,
      context: {
        isEvaluatingType: false,
      },
    });

    if (evaluatedValue.env) {
      env = evaluatedValue.env;
    }

    // Check if the value is an enum type
    if (!evaluatedValue.type || !isEnumType(evaluatedValue.type)) {
      throw this.formatErrorMessage(
        valueExpr.token,
        `Expected enum type for match expression, got ${
          evaluatedValue.type
            ? typeToString(evaluatedValue.type)
            : "unknown type"
        }`
      );
    }

    const enumType = evaluatedValue.type;
    const patterns = args.slice(1);
    let resultType: Type | undefined = undefined;

    // Process each pattern
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];

      // Check if the pattern is a valid match arm
      if (
        !exprIsFunctionCall(pattern) ||
        !exprIsFunctionCallOf(pattern, "->", 2)
      ) {
        throw this.formatErrorMessage(
          pattern.token,
          `Expected -> for match pattern, got ${exprToString(pattern)}`
        );
      }

      const patternExpr = pattern.args[0];
      const resultExpr = pattern.args[1];

      // Check if the pattern is a valid enum variant
      if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCallOf(patternExpr, ".", 1)
      ) {
        // For patterns like .Red
        const variantNameExpr = patternExpr.args[0];
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }

        const variantName = variantNameExpr.token.value;
        // Check if variant exists in enum
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (!variant) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" not found in ${typeToString(
              enumType
            )}`
          );
        }

        // Evaluate the result expression
        const tempEnv = pushEnvFrame(env);
        const evaluatedResult = this.evaluateExpression({
          expr: resultExpr,
          env: tempEnv,
          context: {
            isEvaluatingType: false,
          },
        });
        // We don't update the original env here since each pattern has its own scope

        if (!evaluatedResult.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.type;
        } else if (!areTypesCompatible(resultType, evaluatedResult.type, env)) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current : ${typeToString(evaluatedResult.type)}`
          );
        }
      }
      // For patterns with destructuring like Shape.Circle(r)
      else if (
        exprIsFunctionCall(patternExpr) &&
        exprIsFunctionCall(patternExpr.func) &&
        exprIsFunctionCallOf(patternExpr.func, ".", 1)
      ) {
        const variantExpr = patternExpr.func;
        const variantNameExpr = variantExpr.args[0];
        if (!exprIsAtom(variantNameExpr)) {
          throw this.formatErrorMessage(
            variantExpr.token,
            `Expected identifier for enum variant, got ${exprToString(
              variantNameExpr
            )}`
          );
        }

        const variantName = variantNameExpr.token.value;
        // Check if variant exists in enum
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (!variant) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" not found in ${typeToString(
              enumType
            )}`
          );
        }

        if (!variant.params) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Enum variant "${variantName}" does not have parameters but got pattern with parameters`
          );
        }

        // Push a new environment frame for this pattern
        const patternEnv = pushEnvFrame(env);

        // Check if the pattern arguments match the variant parameters
        const patternParams = patternExpr.args;
        if (patternParams.length > variant.params.length) {
          throw this.formatErrorMessage(
            patternExpr.token,
            `Too many parameters in pattern. Expected ${variant.params.length}, got ${patternParams.length}`
          );
        }

        // Add each parameter to environment as local variable
        for (let j = 0; j < patternParams.length; j++) {
          const param = patternParams[j];
          const variantParam = variant.params[j];

          if (!exprIsAtom(param) || !this.isValidVariableName(param)) {
            throw this.formatErrorMessage(
              param.token,
              `Expected identifier for parameter, got ${exprToString(param)}`
            );
          }

          // Assign the proper type from the variant parameter to this variable
          param.type = variantParam.type;

          const { env: updatedEnv } = addVariableToEnv({
            env: patternEnv,
            variable: {
              name: param.token.value,
              token: param.token,
              type: variantParam.type,
              isMutable: false,
              isNotInitialized: false,
            },
          });

          // Update our local environment
          Object.assign(patternEnv, updatedEnv);
        }

        // Evaluate the result expression in the pattern's environment
        const evaluatedResult = this.evaluateExpression({
          expr: resultExpr,
          env: patternEnv,
          context: {
            isEvaluatingType: false,
          },
        });

        if (!evaluatedResult.type) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Expected type for match result expression, got ${exprToString(
              resultExpr
            )}`
          );
        }

        // Set or verify the result type consistency
        if (!resultType) {
          resultType = evaluatedResult.type;
        } else if (!areTypesCompatible(resultType, evaluatedResult.type, env)) {
          throw this.formatErrorMessage(
            resultExpr.token,
            `Incompatible types in match arms:
- Previous: ${typeToString(resultType)}
- Current: ${typeToString(evaluatedResult.type)}`
          );
        }
      } else {
        throw this.formatErrorMessage(
          patternExpr.token,
          `Invalid pattern in match expression: ${exprToString(patternExpr)}
Please use .variantName or .variantName(args) for destructuring enum variants.`
        );
      }
    }

    if (!resultType) {
      throw this.formatErrorMessage(
        expr.token,
        `Could not determine result type for match expression`
      );
    }

    // Set the type and value of the match expression
    expr.type = resultType;
    // For compile-time evaluation, we'd determine which arm matches and set the value
    // For now, just set it to unknown
    expr.value = VUnknown;
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
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TFree),
        value: TFree,
      };
      expr.type = typeOfType(TFree);
      return expr;
    }
    // Linear
    else if (identifier === TypeTag.Linear) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TLinear),
        value: TLinear,
      };
      expr.type = typeOfType(TLinear);
      return expr;
    }
    // Type
    else if (identifier === TypeTag.Type) {
      expr.value = {
        tag: ValueTag.Type,
        type: typeOfType(TType),
        value: TType,
      };
      expr.type = typeOfType(TType);
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
          `Variable "${identifier}" not found`
        );
      } else {
        const variable = variables[variables.length - 1];
        if (variable.isNotInitialized) {
          throw this.formatErrorMessage(
            expr.token,
            `Variable "${identifier}" not initialized`
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
    env, // context,
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
    const functionType = createFunctionType({
      params: functionParameters,
      return_: {
        expr: returnTypeExpr,
        type: returnType,
      },
    });

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
    expr.env = env;

    // Add information to the `type` token
    expr.func.type = expr.type;
    expr.func.value = expr.value;
    expr.func.env = env;

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
      // Expect the argument to be an identifier
      const arg = expr.args[0];
      if (!exprIsAtom(arg) && !this.isValidVariableName(arg)) {
        throw this.formatErrorMessage(
          arg.token,
          `Expected identifier for enum variant access, got:\n${exprToString(
            arg
          )}`
        );
      }

      // Inferred enum variant
      // Skip the evaluation
      // Set expr.type and expr.value later
      expr.type = undefined;
      expr.value = undefined;
      return expr;
    }

    if (!exprIsFunctionCallOf(expr, ".", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "." with 2 arguments, got:\n${exprToString(expr)}`
      );
    }

    let objectExpr = expr.args[0];
    const propertyExpr = expr.args[1];

    // Evaluate object
    objectExpr = this.evaluateExpression({
      expr: objectExpr,
      env,
      context,
    });
    if (objectExpr.env) {
      env = objectExpr.env;
    }

    if (isTypeValue(objectExpr.value)) {
      const typeValue = objectExpr.value;
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

        /**
         * This is for case like
         * Color := enum Red, Green, Blue;
         * r := Color.Red;
         */
        if (!variant.params) {
          expr.type = newEnumType;
          // FIXME: Support expr.value for comptime evaluation.
          // expr.value = createEnumValue()
        } else {
          /**
           * This is for case like
           * Shape := enum Circle(i32), Square(i32, i32);
           * c := Shape.Circle(3);
           */
          expr.value = createTypeValue(newEnumType);
          expr.type = expr.value.type;
        }
        expr.env = env;
        return expr;
      } else if (
        isTupleType(typeValue.value) ||
        isStructType(typeValue.value)
      ) {
        let elements: TupleElement[] = [];
        if (isTupleType(typeValue.value)) {
          elements = typeValue.value.elements;
        } else if (isStructType(typeValue.value)) {
          elements = typeValue.value.members;
        }
        // Check if it's accessing the tuple element by
        // - number index: point.0
        // - label name:   point.x
        if (exprIsAtom(propertyExpr)) {
          if (propertyExpr.token.type === TokenType.Integer) {
            const index = parseInt(propertyExpr.token.value, 10);
            if (isNaN(index)) {
              throw this.formatErrorMessage(
                propertyExpr.token,
                `Expected integer for tuple index, got:\n${exprToString(
                  propertyExpr
                )}`
              );
            }
            if (index < 0 || index >= elements.length) {
              throw this.formatErrorMessage(
                propertyExpr.token,
                `Index out of bounds: ${index} for accessing element in:\n${typeToString(
                  typeValue.value
                )}`
              );
            }
            const tupleElement = elements[index];
            expr.value = createTypeValue(tupleElement.type);
            expr.type = expr.value.type;
            return expr;
          } else if (this.isValidVariableName(propertyExpr)) {
            const label = propertyExpr.token.value;
            const tupleElement = elements.find(
              (element) => element.label === label
            );
            if (!tupleElement) {
              throw this.formatErrorMessage(
                propertyExpr.token,
                `Element with label "${label}" not found in:\n${typeToString(
                  typeValue.value
                )}`
              );
            }
            expr.value = createTypeValue(tupleElement.type);
            expr.type = expr.value.type;
            return expr;
          }
        }
      }
    }

    if (isTupleType(objectExpr.type) || isStructType(objectExpr.type)) {
      let elements: TupleElement[] = [];
      if (isTupleType(objectExpr.type)) {
        elements = objectExpr.type.elements;
      } else if (isStructType(objectExpr.type)) {
        elements = objectExpr.type.members;
      }
      // Check if it's accessing the tuple element by
      // - number index: point.0
      // - label name:   point.x
      if (exprIsAtom(propertyExpr)) {
        if (propertyExpr.token.type === TokenType.Integer) {
          const index = parseInt(propertyExpr.token.value, 10);
          if (isNaN(index)) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Expected integer for tuple index, got:\n${exprToString(
                propertyExpr
              )}`
            );
          }
          if (index < 0 || index >= elements.length) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Index out of bounds: ${index} for accessing element in:\n${typeToString(
                objectExpr.type
              )}`
            );
          }
          const tupleElement = elements[index];
          expr.type = tupleElement.type;
          // TODO: Support comptime value
          // expr.value = ...
          return expr;
        } else if (this.isValidVariableName(propertyExpr)) {
          const label = propertyExpr.token.value;
          const tupleElement = elements.find(
            (element) => element.label === label
          );
          if (!tupleElement) {
            throw this.formatErrorMessage(
              propertyExpr.token,
              `Element with label "${label}" not found in:\n${typeToString(
                objectExpr.type
              )}`
            );
          }
          expr.type = tupleElement.type;
          // TODO: Support comptime value
          // expr.value = ...
          return expr;
        }
      }
    }

    // TODO: Evaluate the interface method call

    // Since we fail to evaluate the property access
    // it could be a uniform function call.
    expr.type = undefined;
    expr.value = undefined;
    return expr;
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

  private areParametersAndArgumentsCompatible({
    paramElements,
    argElements,
    argValues,
    argExprs,
    env,
    updateArgType,
  }: {
    paramElements: TupleElement[];
    argElements: TupleElement[];
    argValues: TupleValue | undefined;
    argExprs: Expr[];
    env: Environment;
    updateArgType?: boolean;
  }): Environment | false {
    if (argElements.length > paramElements.length) {
      return false;
    }

    env = pushEnvFrame(env);
    const checkedTupleElements: Set<TupleElement> = new Set();
    for (let i = 0; i < paramElements.length; i++) {
      let paramElement: TupleElement | undefined = paramElements[i];
      const argElement = argElements[i];
      const argValue = argValues?.elements[i];
      const argExpr = argExprs[i];

      /*
      // TODO: Implement this support for the defaultValue:
      // Check the defaultValue
      if (!argType) {
        if (checkedTupleElements.has(paramType)) {
          return false; // Already checked this element
        }
        // Needs to check the defaultValue if no arg
        if (paramType.defaultValue) {
          continue;
        } else {
          return false;
        }
      }
      */
      if (!argElement) {
        return false;
      }

      if (argElement.label) {
        // Find the matching label in the expectedType
        paramElement = paramElements.find(
          (element) => element.label === argElement.label
        );
        if (!paramElement) {
          return false;
        }
      }

      if (checkedTupleElements.has(paramElement)) {
        return false; // Already checked this element
        // We cannot have duplicate labels
      }

      let argType = argElement.type;
      if (isPlaceholderType(argType)) {
        // Synthesize the type
        const { type: nextArgType, env: nextEnv } = this.synthesizeExprAndType({
          expr: argExpr,
          type: paramElement.type,
          env,
        });
        env = nextEnv;
        argType = nextArgType;
        if (updateArgType) {
          argElement.type = nextArgType;
        }
      }

      // Pass a type to parameter
      // eg: T: Type
      if (
        isTypeHierarchyType(paramElement.type) &&
        paramElement.type.level === 0
      ) {
        // Check if the type is a subtype of the given type
        // TODO: Check interfaces
        if (!isTypeHierarchyType(argType) || argType.level !== 0) {
          return false;
        }
        if (paramElement.label) {
          // Add the arg to the environment
          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: paramElement.label,
              type: argType,
              isMutable: paramElement.isMutable,
              token: argExpr.token,
              isNotInitialized: false,
              value: argValue,
            },
          });
          env = nextEnv;
        }
      }

      // Compare the types
      else if (!areTypesCompatible(paramElement.type, argType, env)) {
        return false;
      }
      checkedTupleElements.add(paramElement);
    }
    return env;
  }

  private evaluateFunctionCall({
    expr,
    env, // context,
    givenFunc,
  }: {
    expr: FuncCallExpr;
    env: Environment;
    givenFunc?: { type: Type; value: TypeValue };
    // context: EvaluatorContext;
  }): FuncCallExpr {
    const func = expr.func;
    let args = expr.args;

    let functions: { type: Type; value?: Value }[] = [];
    if (givenFunc) {
      functions = [givenFunc];
    } else if (exprIsFunctionCall(func)) {
      // Check .Circle(3) like function for inferred enum variant call
      if (exprIsFunctionCall(func) && exprIsFunctionCallOf(func, ".", 1)) {
        // Skip the evaluation
        // Set expr.type and expr.value later
        expr.type = undefined;
        expr.value = undefined;
        return expr;
      }

      let functionToCall = this.evaluateExpression({
        expr: func,
        env,
        context: {
          isEvaluatingType: false,
        },
      });

      // Check if . property access for uniform function call
      if (
        !functionToCall.type &&
        exprIsFunctionCall(functionToCall) &&
        exprIsFunctionCallOf(functionToCall, ".", 2)
      ) {
        const callerArg = functionToCall.args[0];
        functionToCall = this.evaluateExpression({
          expr: functionToCall.args[1],
          env,
          context: {
            isEvaluatingType: false,
          },
        });
        args = [callerArg, ...args];
      }

      if (!functionToCall.type) {
        throw this.formatErrorMessage(
          func.token,
          `Expected type for function call, got ${exprToString(functionToCall)}`
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

      // Check _ function
      if (functionName === "_") {
        // Skip the evaluation
        // Set expr.type and expr.value later
        expr.type = undefined;
        expr.value = undefined;
        return expr;
      } else {
        /**
         * functionVariables might be of FunctionType, StructType, UnionType, and EnumVariant
         */
        const functionVariables = getVariablesFromEnv(env, functionName);
        functions = functionVariables.map((variable) => ({
          type: variable.type,
          value: variable.value,
        }));
      }
    }

    const {
      type: tupleType,
      value: tupleValue,
      env: nextEnv,
    } = this.evaluateTupleElements({
      args,
      env,
      context: {
        isEvaluatingType: false,
      },
    });
    env = nextEnv;
    const evaluatedArgElements = tupleType.elements;
    const evaluatedArgValues = tupleValue as TupleValue | undefined;

    // Find the functions whose parameters match the arguments
    const functionsWithMatchingTypes = functions.filter((func) => {
      if (isFunctionType(func.type)) {
        return this.areParametersAndArgumentsCompatible({
          paramElements: func.type.params,
          argElements: evaluatedArgElements,
          argValues: evaluatedArgValues,
          argExprs: args,
          env,
        });
      } else {
        const value = func.value;
        // struct value
        if (isTypeValue(value) && isStructType(value.value)) {
          return this.areParametersAndArgumentsCompatible({
            paramElements: value.value.members,
            argElements: evaluatedArgElements,
            argValues: evaluatedArgValues,
            argExprs: args,
            env,
          });
        }
        // enum value
        else if (isTypeValue(value) && isEnumType(value.value)) {
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
          return this.areParametersAndArgumentsCompatible({
            paramElements: selectedVariant.params || [],
            argElements: evaluatedArgElements,
            argValues: evaluatedArgValues,
            argExprs: args,
            env,
          });
        }
        return false;
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

    if (isFunctionType(functionToCall.type)) {
      const functionType = functionToCall.type;

      // It is type function
      if (isFunctionTypeAndIsTypeFunction(functionType)) {
        const functionValue = functionToCall.value;
        if (!isFunctionValue(functionValue)) {
          throw this.formatErrorMessage(
            expr.token,
            `Function value is not defined`
          );
        }

        const { value: returnValue, env: nextEnv } =
          this.evaluateTypeFunctionCall({
            functionCallExpr: expr,
            functionType,
            functionValue,
            argElements: evaluatedArgElements,
            argValues: evaluatedArgValues,
            argExprs: args,
            env,
          });
        env = nextEnv;
        expr.value = returnValue;
        expr.type = typeOfType(returnValue.type);

        // Attach necessary info to the func
        func.type = functionToCall.type;
        func.value = functionToCall.value;
      } else {
        // It's
        // - Runtime function
        // - Comptime function
        const { returnType, env: nextEnv } =
          this.evaluateFunctionCallReturnType({
            functionCallExpr: expr,
            functionType,
            argElements: evaluatedArgElements,
            argValues: evaluatedArgValues,
            argExprs: args,
            env,
          });
        env = nextEnv;
        expr.type = returnType;
        // TODO: expr.value should be available for comptime function.

        // Attach necessary info to the func
        func.type = functionToCall.type;
        func.value = functionToCall.value;
      }
      return expr;
    } else {
      const value = functionToCall.value;
      // struct value
      if (isTypeValue(value) && isStructType(value.value)) {
        // console.log("struct value");
        const structType = value.value;
        expr.type = structType;
        expr.env = env;

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
      // enum value
      else if (isTypeValue(value) && isEnumType(value.value)) {
        // console.log("enum value");
        const enumType = value.value;
        expr.type = enumType;
        expr.env = env;

        // Attach necessary info to the func
        func.type = value.type;
        func.value = value;
        return expr;
      }
    }

    throw this.formatErrorMessage(
      expr.token,
      `Function call is not implemented yet:
${exprToString(expr)}`
    );
  }

  private evaluateTypeFunctionCall({
    functionCallExpr,
    functionType,
    functionValue,
    argElements,
    argValues,
    argExprs,
    env,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    functionValue: FunctionValue;
    argElements: TupleElement[];
    argValues: TupleValue | undefined;
    argExprs: Expr[];
    env: Environment;
  }): { value: TypeValue; env: Environment } {
    // This will push a new frame to the env and
    // add the parameters to the env
    const nextEnv = this.areParametersAndArgumentsCompatible({
      paramElements: functionType.params,
      argElements: argElements,
      argValues: argValues,
      argExprs: argExprs,
      env,
      updateArgType: true,
    });
    if (!nextEnv) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Incompatible types for function call:
Expected: ${typeToString(functionType)}`
      );
    }
    env = nextEnv;

    // Evaluate functionValue.body with the new env
    const functionBodyExpr = functionValue.body;
    const evaluatedFunctionBody = this.evaluateExpression({
      expr: functionBodyExpr,
      env,
      context: { isEvaluatingType: false },
    });
    if (!evaluatedFunctionBody.env) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly`
      );
    }

    // Get the return type value
    const returnValue = evaluatedFunctionBody.value;
    if (!returnValue || !isTypeValue(returnValue)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly. Expected to return a type.`
      );
    }

    // Restore the environment frames
    env = popEnvFrame(evaluatedFunctionBody.env);

    return {
      value: returnValue,
      env,
    };
  }

  private evaluateFunctionCallReturnType({
    functionCallExpr,
    functionType,
    argElements,
    argValues,
    argExprs,
    env,
  }: {
    functionCallExpr: Expr;
    functionType: FunctionType;
    argElements: TupleElement[];
    argValues: TupleValue | undefined;
    argExprs: Expr[];
    env: Environment;
  }): { returnType: Type; env: Environment } {
    // This will push a new frame to the env and
    // add the parameters to the env
    const nextEnv = this.areParametersAndArgumentsCompatible({
      paramElements: functionType.params,
      argElements: argElements,
      argValues,
      argExprs,
      env,
      updateArgType: true,
    });
    if (!nextEnv) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Incompatible types for function call:
Expected: ${typeToString(functionType)}`
      );
    }
    env = nextEnv;

    // Evaluate the function return expr again
    const evaluatedFunctionReturnExpr = this.evaluateExpression({
      expr: functionType.return.expr,
      env,
      context: { isEvaluatingType: true },
    });
    /*
    if (!evaluatedFunctionReturnExpr.env) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly`
      );
    } else {
      env = evaluatedFunctionReturnExpr.env; 
    }
    */

    // Get the return type
    const functionReturnTypeValue = evaluatedFunctionReturnExpr.value;
    if (!isTypeValue(functionReturnTypeValue)) {
      throw this.formatErrorMessage(
        functionCallExpr.token,
        `Function body is not evaluated correctly. Expected to return a type.`
      );
    }
    const functionReturnType = functionReturnTypeValue.value;

    // Restore the environment frames
    env = popEnvFrame(env);

    return {
      returnType: functionReturnType,
      env,
    };
  }

  private evaluateDefExpression({
    expr,
    env,
  }: {
    expr: FuncCallExpr;
    env: Environment;
  }): FuncCallExpr {
    if (!exprIsFunctionCallOf(expr, "def", 2)) {
      throw this.formatErrorMessage(
        expr.token,
        `Expected "def" with 2 arguments, got:\n${exprToString(expr)}`
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
    const functionType = createFunctionType({
      params: functionParameters,
      return_: {
        expr: functionReturnTypeExpr,
        type: returnType,
      },
    });
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
        value: {
          tag: ValueTag.Function,
          type: functionType,
          body: functionBodyExpr,
          frameLevel: env.frames.length - 1,
        },
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
      if (!areTypesCompatible(returnType, evaluatedFunctionBody.type, env)) {
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
      } else if (exprIsFunctionCallOf(expr, "cond")) {
        // cond
        return this.evaluateCond({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "match")) {
        // match
        return this.evaluateMatch({ expr, env });
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
      } else if (exprIsFunctionCallOf(expr, "def")) {
        // def
        return this.evaluateDefExpression({ expr, env });
      } else if (exprIsFunctionCallOf(expr, "begin")) {
        // begin
        return this.evaluateBeginExpression({ expr, env });
      } else {
        /* else if (exprIsFunctionCallOf(expr, ".", 1)) {
        // variant
        return this.evaluateVariant({ expr, env, context });
      } */
        // Function call
        return this.evaluateFunctionCall({ expr, env });
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
