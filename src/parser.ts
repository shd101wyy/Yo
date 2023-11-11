/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AssignmentExpr,
  AstType,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  PrimitiveValueExpr,
  getFunctionArgumentsInOrder,
  getFunctionsOfCallerFromEnv,
  getMatchedOverloadingFunction,
  getTokenPrecedence,
  synthesizeExprType,
  synthesizeRecordType,
} from "./ast";
import {
  Environment,
  addEnvFreeVariable,
  addEnvValueType,
  copyEnvironment,
  getEnvCurrentFrameLevel,
  getEnvValueTypesByVariableName,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import { Token, TokenType } from "./token";
import {
  ParserReturn,
  TSlice,
  TTypeParameter,
  Type,
  TypeValues,
  checkType,
  convertPrimitiveToType,
  synthesizeFunctionTypeFromTokens,
  synthesizeTypeFromTokens,
  synthesizeTypeParametersFromTokens,
  typeToString,
} from "./type-checker";

export default class Parser {
  private inputString: string;

  constructor(inputString: string) {
    this.inputString = inputString;
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
      inputString: this.inputString,
    });
  }

  private parseNumberExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Integer) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: {
            type: "i32",
            value: token.value,
            tag: "primitive",
          },
        },
        index: index + 1,
        env,
      };
    } else if (token.type === TokenType.Float) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "f32", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected number");
    }
  }

  private parseCharactorExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Char) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "char", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected charactor");
    }
  }

  private parseStringExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.String) {
      const end: PrimitiveValueExpr = {
        type: AstType.Value,
        tag: "primitive",
        typeValue: { type: "char", value: "\0", tag: "primitive" },
      };
      return {
        expr: {
          type: AstType.Value,
          tag: "slice",
          typeValue: {
            type: "slice",
            elementType: TypeValues.char,
            size: token.value.length + 1,
          },
          values: token.value
            .split("")
            .map((char) => {
              const charValue: PrimitiveValueExpr = {
                type: AstType.Value,
                tag: "primitive",
                typeValue: { type: "char", value: char, tag: "primitive" },
              };
              return charValue;
            })
            .concat(end),
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseSymbolExpr(tokens, index, env): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Symbol) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "symbol", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected symbol");
    }
  }

  private parseBooleanExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Boolean) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "boolean", value: token.value, tag: "primitive" },
        },
        index: index + 1,
        env,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected boolean");
    }
  }

  private parseSliceOrTupleExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (token.type !== TokenType.LBracket) {
      throw this.formatErrorMessage(token, "Expected '[' for slice");
    }
    index = index + 1;
    const values: Expr[] = [];
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']' for slice");
      }
      if (token.type === TokenType.RBracket) {
        index = index + 1;
        break;
      } else {
        const {
          expr,
          index: nextIndex,
          env: nextEnv,
        } = this.parseExpression(tokens, index, env);
        if (!expr) {
          return { expr, index: nextIndex, env: nextEnv };
        }
        values.push(expr);
        index = nextIndex;
        env = nextEnv;
        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
    }

    const elementTypes = values.map((value) => synthesizeExprType(value, env));
    // Check if all the element types are the same
    const firstElementType = convertPrimitiveToType(elementTypes[0]);
    const isSlice = elementTypes.every((type) =>
      checkType(firstElementType, convertPrimitiveToType(type))
    );

    let typeValue: Type;
    if (isSlice) {
      typeValue = {
        type: "slice",
        elementType: firstElementType,
        size: values.length,
      };
    } else {
      /*
      typeValue = {
        type: "tuple",
        elements: elementTypes,
      };
      */
      throw this.formatErrorMessage(
        tokens[index],
        "Expected slice, but got tuple"
      );
    }

    return {
      expr: {
        type: AstType.Value,
        typeValue,
        values: values,
        tag: "slice",
      },
      index,
      env,
    };
  }

  // TODO: Implement curly bracket expression
  // it could be either the RecordExpr or BlockExpr
  private parseCurlyBracketExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    return this.parseRecordExpr(tokens, index, env);
  }

  private parseRecordExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket || !tokens[index + 1]) {
      throw this.formatErrorMessage(tokens[index], "Expected '{' for record");
    }
    index = index + 1;
    if (tokens[index].type === TokenType.RCurlyBracket) {
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: { type: "Record", typeParameters: [], properties: [] },
          properties: [],
        },
        index: index + 1,
        env,
      };
    } else if (
      tokens[index].type === TokenType.Identifier &&
      tokens[index + 1].type === TokenType.Colon
    ) {
      const properties: { name: string; value: Expr }[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const token = tokens[index];
        if (!token) {
          throw this.formatErrorMessage(token, "Expected '}' for record");
        }
        if (token.type === TokenType.RCurlyBracket) {
          index = index + 1;
          break;
        }
        if (token.type !== TokenType.Identifier) {
          throw this.formatErrorMessage(
            token,
            "Expected identifier for record property name"
          );
        }
        const propertyName = token.value;
        if (tokens[index + 1].type !== TokenType.Colon) {
          throw this.formatErrorMessage(
            tokens[index + 1],
            "Expected ':' for record property"
          );
        }
        index = index + 2;
        const {
          expr,
          index: nextIndex,
          env: nextEnv,
        } = this.parseExpression(tokens, index, env);
        if (!expr) {
          return { expr, index: nextIndex, env: nextEnv };
        }
        properties.push({ name: propertyName, value: expr });
        index = nextIndex;
        env = nextEnv;

        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: synthesizeRecordType(properties, env),
          properties,
        },
        index,
        env,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
    }
  }

  private parsePropertyAccessExpr(
    expr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (Array.isArray(expr)) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected property access expression"
      );
    }
    if (tokens[index].type !== TokenType.Dot) {
      throw this.formatErrorMessage(tokens[index], "Expected '.'");
    }

    // parse properties
    index = index + 1;
    const token = tokens[index];
    if (!token) {
      throw this.formatErrorMessage(token, "Expected property name");
    }

    // Check if it's a valid property in the record
    const callerType = expr.typeValue;
    if (callerType.type === "Record") {
      const property = callerType.properties.find(
        (property) => property.name === token.value
      );
      if (property) {
        return {
          expr: {
            type: AstType.PropertyAccess,
            expr: expr,
            propertyName: property.name,
            typeValue: property.type,
          },
          env,
          index: index + 1,
        };
      }
    }

    // Check if it's a valid function that takes
    // the `expr` as the first argument
    if (tokens[index + 1]?.type === TokenType.LParen) {
      const functionName = token.value;
      // Find the functions that takes `expr` as the first argument
      const matchedFunctions = getFunctionsOfCallerFromEnv(
        callerType,
        functionName,
        env
      );

      // Try all functions to see if there is a match
      const parserReturns: ParserReturn[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallExpr(
              {
                type: AstType.Variable,
                name: functionName,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
              },
              tokens,
              index + 1,
              env,
              expr
            )
          );
        } catch (error) {
          // Ignore the error
        }
      }
      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          token,
          `Cannot find function ${functionName} that takes ${typeToString(
            callerType
          )} as the first argument`
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          token,
          `Ambiguous function ${functionName} that takes ${typeToString(
            callerType
          )} as the first argument
Found possible functions:
- ${matchedFunctions
            .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
            .join("\n- ")}`
        );
      } else {
        return parserReturns[0];
      }
    } else {
      throw this.formatErrorMessage(
        token,
        `Expected property name, but got ${token.value}`
      );
    }
  }

  private parseIndexAccessExpr(
    expr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LBracket) {
      throw this.formatErrorMessage(tokens[index], "Expected '['");
    }
    const indexes: Expr[] = [];
    let valueType = synthesizeExprType(expr, env);
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
      const {
        expr,
        index: nextIndex,
        env: nextEnv,
      } = this.parseExpression(tokens, index, env);
      if (!expr) {
        throw this.formatErrorMessage(token, "Expected expression");
      }
      indexes.push(expr);
      index = nextIndex;
      env = nextEnv;

      const indexType = synthesizeExprType(expr, env);
      if (!checkType(TypeValues.i32, indexType)) {
        throw this.formatErrorMessage(
          token,
          `Expected i32 for index, but got ${typeToString(indexType)}`
        );
      }

      if (valueType.type !== "slice") {
        throw this.formatErrorMessage(
          token,
          `Expected slice for index access, but got ${typeToString(valueType)}`
        );
      }
      valueType = valueType.elementType;
      /*
      if (valueType.type === "slice") {
        valueType = valueType.elementType;
      } else {
        // tuple
        if ("tag" in indexType && indexType.tag === "primitive") {
          const indexValue = parseInt(indexType.value, 10);
          if (indexValue >= valueType.elements.length) {
            throw this.formatErrorMessage(
              token,
              `Index out of range: ${indexValue}`
            );
          }
          valueType = valueType.elements[indexValue];
        } else {
          // union of all types
          throw this.formatErrorMessage(
            token,
            `Not implemented: tuple index access with non-constant index`
          );
        }
      }
      */

      if (tokens[index].type === TokenType.RBracket) {
        index = index + 1;
        if (tokens[index].type === TokenType.LBracket) {
          index = index + 1;
        } else {
          break;
        }
      } else {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
    }

    return {
      expr: {
        type: AstType.IndexAccess,
        expr,
        indexes,
        typeValue: valueType,
      },
      index,
      env,
    };
  }

  private parseAnonymouseFunction(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected left paren for anonymous function"
      );
    }

    const currentFrameLevel = getEnvCurrentFrameLevel(env);
    // parse prototype
    const oldEnv = env;
    env = copyEnvironment(env, currentFrameLevel, []);
    env = pushEnvFrame(env);
    try {
      const {
        prototype,
        index: nextIndex,
        env: nextEnv,
      } = this.parsePrototype({
        tokens,
        index,
        env,
        requireFunctionName: false,
        withFunctionBody: true,
      });
      if (!prototype) {
        throw new Error("Failed to parse prototype");
      }

      // check if current token is `=>`
      if (tokens[nextIndex].type !== TokenType.LambdaArrow) {
        throw new Error("Expected `=>` for anonymous function");
      }

      // parse body
      const {
        exprs: body,
        returnType,
        index: nextNextIndex,
        env: nextNextEnv,
      } = this.parseBlockExpressions(tokens, nextIndex + 1, nextEnv);
      env = nextNextEnv;

      // Check function body return type matches
      // prototype.returnType
      if (prototype.typeValue.returnType.type === "unknown") {
        prototype.typeValue.returnType = returnType;
      }

      if (
        !checkType(returnType, prototype.typeValue.returnType) &&
        !checkType(prototype.typeValue.returnType, returnType)
      ) {
        throw this.formatErrorMessage(
          tokens[index],
          `Mismatched return type:
Prototype: ${typeToString(prototype.typeValue.returnType)}
Returned:  ${typeToString(returnType)}`
        );
      }

      prototype.typeValue.freeVariables = env.freeVariables;

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        typeValue: prototype.typeValue,
        body,
        frameLevel: currentFrameLevel,
        freeVariables: env.freeVariables, // FIXME: Implement freeVariables
      };
      env = popEnvFrame(env);
      return {
        expr: functionExpr,
        index: nextNextIndex,
        env: copyEnvironment(
          env,
          oldEnv.functionDeclarationFrameLevel,
          oldEnv.freeVariables
        ),
      };
    } catch (error) {
      env = popEnvFrame(env);
      throw error;
    }
  }

  /**
   * parenexpr ::= "(" expr ")"
   * @param tokens
   * @param index
   * @returns
   */
  private parseParenExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (
      tokens[index + 1]?.type === TokenType.RParen &&
      tokens[index + 2]?.type !== TokenType.LambdaArrow
    ) {
      // unit type
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          typeValue: { type: "()", value: "()", tag: "primitive" },
        },
        index: index + 2,
        env,
      };
    }

    // Try parse as anonymouse function
    try {
      const {
        expr,
        index: nextIndex,
        env: newEnv,
      } = this.parseAnonymouseFunction(tokens, index, env);
      if (expr) {
        return { expr, index: nextIndex, env: newEnv };
      } else {
        throw new Error("Failed to parse as anonymouse function");
      }
    } catch (error) {
      // Ignore the error
      // This means we failed to parse it as anonymouse function
    }

    const {
      expr,
      index: nextIndex,
      env: nextEnv,
    } = this.parseExpression(tokens, index + 1, env);
    if (!expr) {
      return { expr, index: nextIndex, env: nextEnv };
    }

    if (tokens[nextIndex].type !== TokenType.RParen) {
      throw this.formatErrorMessage(tokens[nextIndex], "Expected right paren");
    }
    return { expr, index: nextIndex + 1, env: nextEnv };
  }

  private parseCallExpr(
    callee: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    caller?: Expr
  ): ParserReturn {
    if (Array.isArray(callee) || callee.typeValue.type !== "Function") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected function for call expression"
      );
    }
    if (tokens[index]?.type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    const functionArguments: Expr[] = [];
    if (caller) {
      functionArguments.push(caller);
    }

    let nextIndex = index + 2;
    if (tokens[index + 1]?.type !== TokenType.RParen) {
      index = index + 1;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Check if it's keyword argument
        if (
          tokens[index].type === TokenType.Identifier &&
          tokens[index + 1].type === TokenType.Assign
        ) {
          const variableName = tokens[index].value;
          const {
            expr: defaultParameterValueExpr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseExpression(tokens, index + 2, env);
          env = nextEnv;

          if (!defaultParameterValueExpr) {
            throw this.formatErrorMessage(
              tokens[index],
              "Expected expression for default parameter value"
            );
          }

          const parameterAssignmentExpr: AssignmentExpr = {
            type: AstType.ConstantAssigment,
            variableName: variableName,
            right: defaultParameterValueExpr,
            typeValue: TypeValues.unit,
            variableType: synthesizeExprType(defaultParameterValueExpr, env),
            frameLevel: getEnvCurrentFrameLevel(env),
          };
          functionArguments.push(parameterAssignmentExpr);
          index = nextIndex;
        } else {
          const {
            expr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseExpression(tokens, index, env);
          env = nextEnv;

          if (!expr) {
            throw this.formatErrorMessage(
              tokens[index],
              "Expected expression for function argument"
            );
          }
          functionArguments.push(expr);
          index = nextIndex;
        }

        if (tokens[index].type === TokenType.RParen) {
          break;
        }

        if (tokens[index].type !== TokenType.Comma) {
          throw this.formatErrorMessage(
            tokens[index],
            `Expected comma, but got ${tokens[index].value}`
          );
        }
        index = index + 1;
      }

      nextIndex = index + 1;
    }

    const functionArgumentsInOrder = getFunctionArgumentsInOrder(
      functionArguments,
      callee.typeValue
    );

    if (!functionArgumentsInOrder) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched function arguments.
Expected: (${callee.typeValue.parameterTypes
          .map(
            (parameter) =>
              (parameter.name ? `${parameter.name}: ` : "") +
              typeToString(parameter.type)
          )
          .join(", ")})
Got:      (${functionArguments
          .map((arg) => {
            if (Array.isArray(arg)) {
              return "";
            } else {
              return typeToString(arg.typeValue);
            }
          })
          .join(", ")})`
      );
    }

    return {
      expr: {
        type: AstType.CallFunction,
        callee,
        functionArguments: functionArgumentsInOrder,
        typeValue: callee.typeValue.returnType,
      },
      index: nextIndex,
      env,
    };
  }

  /**
   * identifierexpr
   *   ::= identifier
   * @param tokens
   * @param index
   */
  private parseIdentifierExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const identifier = tokens[index].value;

    // Check if variable is defined
    const valueTypes = getEnvValueTypesByVariableName(env, identifier);
    if (valueTypes.length === 0) {
      throw this.formatErrorMessage(
        tokens[index],
        `Unbounded variable \`${identifier}\``
      );
    }
    const valueType = valueTypes[valueTypes.length - 1];
    const typeValue = valueType.type;
    const isFreeVariable =
      valueType.frameLevel <= env.functionDeclarationFrameLevel;

    // Add free variables to env
    if (isFreeVariable) {
      env = addEnvFreeVariable(env, valueType);
    }

    return {
      expr: {
        type: AstType.Variable,
        name: identifier,
        typeValue,
        frameLevel: valueType.frameLevel,
        // isFreeVariable,
      },
      index: index + 1,
      env,
    };
  }

  /**
   * primary
   *   ::= identifierexpr
   *   ::= numberexpr
   *   ::= parenexpr
   *   ::= ifexpr
   * @param tokens
   * @param index
   */
  private parsePrimary(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    let returnValue: ParserReturn | null = null;
    switch (token.type) {
      case TokenType.Identifier: {
        returnValue = this.parseIdentifierExpr(tokens, index, env);
        break;
      }
      case TokenType.Integer:
      case TokenType.Float: {
        returnValue = this.parseNumberExpr(tokens, index, env);
        break;
      }
      case TokenType.Char: {
        returnValue = this.parseCharactorExpr(tokens, index, env);
        break;
      }
      case TokenType.String: {
        returnValue = this.parseStringExpr(tokens, index, env);
        break;
      }
      case TokenType.Symbol: {
        returnValue = this.parseSymbolExpr(tokens, index, env);
        break;
      }
      case TokenType.Boolean: {
        returnValue = this.parseBooleanExpr(tokens, index, env);
        break;
      }
      case TokenType.LBracket: {
        returnValue = this.parseSliceOrTupleExpr(tokens, index, env);
        break;
      }
      case TokenType.LParen: {
        returnValue = this.parseParenExpr(tokens, index, env);
        break;
      }
      case TokenType.LCurlyBracket: {
        returnValue = this.parseCurlyBracketExpr(tokens, index, env);
        break;
      }
      case TokenType.If: {
        returnValue = this.parseIfExpr(tokens, index, env);
        break;
      }
      case TokenType.Const: {
        return this.parseConstAssignment(tokens, index, env);
      }
      case TokenType.Semicolon: {
        return {
          expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
          index: index + 1,
          env,
        };
      }
      default: {
        throw this.formatErrorMessage(
          token,
          `Unknown token: ${JSON.stringify(token)}`
        );
      }
    }
    return this.parsePrimaryEnd(
      returnValue.expr,
      tokens,
      returnValue.index,
      returnValue.env
    );
  }

  private parsePrimaryEnd(
    primaryExpr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    const token = tokens[index];
    if (!token || Array.isArray(primaryExpr)) {
      return {
        expr: primaryExpr,
        index,
        env,
      };
    } else if (token.type === TokenType.Dot) {
      // parsePropertyAccessExpr
      const returnValue = this.parsePropertyAccessExpr(
        primaryExpr,
        tokens,
        index,
        env
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.env
      );
    } else if (token.type === TokenType.LBracket) {
      // parseIndexAccessExpr
      const returnValue = this.parseIndexAccessExpr(
        primaryExpr,
        tokens,
        index,
        env
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.env
      );
    } else if (
      primaryExpr.typeValue.type === "Function" &&
      token.type === TokenType.LParen
    ) {
      // parseCallExpr
      const returnValue = this.parseCallExpr(primaryExpr, tokens, index, env);
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.env
      );
    } else {
      return {
        expr: primaryExpr,
        index,
        env,
      };
    }
  }

  private parseBinOpRHS(
    tokens: Token[],
    exprPrecedence: number,
    LHS: Expr,
    index: number,
    env: Environment
  ): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];
      const tokenPrecedence = getTokenPrecedence(token);

      // If this is a binop that binds at least as tightly as the current binop,
      // consume it, otherwise we are done.
      if (tokenPrecedence < exprPrecedence) {
        return { expr: LHS, index, env };
      }

      // Okay, we know this is a binop
      const binaryOperator = token;
      index = index + 1; // eat binop

      // eslint-disable-next-line prefer-const
      let {
        expr: RHS,
        // eslint-disable-next-line prefer-const
        index: nextIndex,
        // eslint-disable-next-line prefer-const
        env: nextEnv,
      } = this.parsePrimary(tokens, index, env);
      env = nextEnv;
      if (!RHS) {
        return { expr: RHS, index: nextIndex, env };
      }

      // If BinOp binds less tightly with RHS than the operator after RHS, let
      // the pending operator take RHS as its LHS.
      const nextToken = tokens[nextIndex];
      const nextTokenPrecedence = getTokenPrecedence(nextToken);
      if (tokenPrecedence < nextTokenPrecedence) {
        const { expr, index: nextNextIndex } = this.parseBinOpRHS(
          tokens,
          tokenPrecedence + 1,
          RHS,
          nextIndex,
          env
        );
        if (!expr) {
          return { expr, index: nextNextIndex, env };
        }
        RHS = expr;
        index = nextNextIndex;
      } else {
        index = nextIndex;
      }

      // Merge LHS/RHS
      const needsSwap = [
        TokenType.GreaterThan,
        TokenType.GreaterThanOrEqual,
      ].includes(binaryOperator.value as TokenType);
      let operator = binaryOperator.value as TokenType;
      if (needsSwap) {
        if (operator === TokenType.GreaterThan) {
          operator = TokenType.LessThan;
        } else if (operator === TokenType.GreaterThanOrEqual) {
          operator = TokenType.LessThanOrEqual;
        }
      }
      LHS = {
        type: AstType.BinaryOperator,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        operator: operator as any,
        left: needsSwap ? RHS : LHS,
        right: needsSwap ? LHS : RHS,
        typeValue: synthesizeExprType(LHS, env), // FIXME:
      };
    }
  }

  private parsePrototype({
    tokens,
    index,
    env,
    requireFunctionName,
    withFunctionBody,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    requireFunctionName: boolean;
    withFunctionBody: boolean;
  }): {
    prototype: FunctionPrototype | null;
    index: number;
    env: Environment;
  } {
    let functionName: string | undefined = undefined;
    if (requireFunctionName) {
      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function name in prototype"
        );
      } else {
        functionName = tokens[index].value;
        index = index + 1;
      }
    }

    const {
      index: nextIndex,
      typeValue: functionType,
      env: nextEnv,
    } = synthesizeFunctionTypeFromTokens({
      tokens,
      index,
      inputString: this.inputString,
      env,
      parseExpression: this.parseExpression.bind(this),
      withFunctionBody,
      functionName,
    });

    return {
      prototype: {
        type: AstType.FunctionPrototype,
        functionName,
        typeValue: functionType,
      },
      index: nextIndex,
      env: nextEnv,
    };
  }

  private parseBlockExpressions(
    tokens: Token[],
    index: number,
    env: Environment
  ): { exprs: Expr[]; index: number; env: Environment; returnType: Type } {
    let exprs: Expr[] = [];
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for block expressions"
      );
    }
    index = index + 1;
    env = pushEnvFrame(env);
    let nextEnv = env;

    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected '}' for function body");
      }
      if (token.type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      const {
        expr,
        index: nextIndex,
        env: nextNextEnv,
      } = this.parseExpression(tokens, index, nextEnv);
      nextEnv = nextNextEnv;
      if (expr) {
        exprs.push(expr);
      }
      index = nextIndex;
    }

    exprs = exprs.filter(
      (expr) => !Array.isArray(expr) && expr.type !== AstType.Ignore
    );
    const lastExpr: Expr | null = exprs[exprs.length - 1] ?? null;
    if (!lastExpr || tokens[index - 2].type === TokenType.Semicolon) {
      exprs.push({
        type: AstType.Value,
        tag: "primitive",
        typeValue: { type: "()", value: "()", tag: "primitive" },
      });
    }

    // NOTE: Needs to put this before `env.popFrame` to get `returnType`.
    const returnType = synthesizeExprType(exprs[exprs.length - 1], nextEnv);
    env = popEnvFrame(nextEnv);
    const returnValue = {
      index,
      exprs,
      env,
      returnType,
    };
    return returnValue;
  }

  private parseFunction(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Function) {
      throw this.formatErrorMessage(tokens[index], "Expected function");
    }

    const currentFrameLevel = getEnvCurrentFrameLevel(env);
    index = index + 1;
    const oldEnv = env;
    env = copyEnvironment(env, currentFrameLevel, []);
    env = pushEnvFrame(env);
    const {
      prototype,
      index: nextIndex,
      env: nextEnv,
    } = this.parsePrototype({
      tokens,
      index,
      env,
      requireFunctionName: true,
      withFunctionBody: true,
    });
    env = nextEnv;
    if (!prototype) {
      env = popEnvFrame(env);
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextIndex,
        env,
      };
    } else {
      index = nextIndex;

      // Check allow function overloading
      const matchedOverloadingFunctions = getMatchedOverloadingFunction(
        prototype,
        env
      );
      if (matchedOverloadingFunctions.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Function overloading is not allowed.
Found possible functions:
- ${matchedOverloadingFunctions
            .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
            .join("\n- ")}
`
        );
      }

      env = addEnvValueType(
        env,
        {
          id: prototype.typeValue.id,
          variableName: prototype.functionName!,
          type: prototype.typeValue,
        },
        -1
      );
    }

    // Check function body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for function body"
      );
    } else {
      const {
        exprs,
        index: nextIndex,
        returnType: functionReturnType,
        env: nextEnv,
      } = this.parseBlockExpressions(tokens, index, env);
      env = nextEnv;

      // Check function body return type matches
      // prototype.returnType
      if (prototype.typeValue.returnType.type === "unknown") {
        prototype.typeValue.returnType = functionReturnType;
      }

      if (!checkType(functionReturnType, prototype.typeValue.returnType)) {
        throw this.formatErrorMessage(
          tokens[index],
          `Mismatched return type: 
Prototype: ${typeToString(prototype.typeValue.returnType)}
Returned:  ${typeToString(functionReturnType)}`
        );
      }

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        typeValue: prototype.typeValue,
        body: exprs,
        frameLevel: currentFrameLevel,
        freeVariables: env.freeVariables, // FIXME: Implement freeVariables
      };
      env = popEnvFrame(env);
      return {
        expr: functionExpr,
        index: nextIndex,
        env: copyEnvironment(
          env,
          oldEnv.functionDeclarationFrameLevel,
          oldEnv.freeVariables
        ),
      };
    }
  }

  private parseExtern(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Extern) {
      throw this.formatErrorMessage(tokens[index], "Expected extern");
    }

    index = index + 1;
    env = pushEnvFrame(env);
    const { prototype, index: nextIndex } = this.parsePrototype({
      tokens,
      index,
      env,
      requireFunctionName: true,
      withFunctionBody: true, // NOTE: We need to set it to `true` even though `extern` function has no function body
    });
    env = popEnvFrame(env);
    if (!prototype) {
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextIndex,
        env,
      };
    } else {
      index = nextIndex;
      env = addEnvValueType(env, {
        id: prototype.typeValue.id,
        variableName: prototype.functionName!,
        type: prototype.typeValue,
      });
    }

    return {
      expr: {
        type: AstType.Extern,
        prototype,
        typeValue: prototype.typeValue,
      },
      index,
      env,
    };
  }

  private parseIfExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    index = index + 1;

    // parse condition
    const {
      expr: condition,
      index: nextIndex,
      env: nextEnv,
    } = this.parseExpression(tokens, index, env);
    if (!condition) {
      throw this.formatErrorMessage(tokens[index], "Expected condition for if");
    }
    const conditionType = synthesizeExprType(condition, env);
    if (!checkType(TypeValues.boolean, conditionType)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Expected boolean for condition, but got ${typeToString(conditionType)}`
      );
    }
    index = nextIndex;
    env = nextEnv;

    let thenExpr: Expr[] = [];
    let thenReturnType: Type;
    // parse then
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      const returnValue = this.parseExpression(tokens, index, env);
      index = returnValue.index;
      thenExpr = [returnValue.expr];
      if (Array.isArray(returnValue.expr)) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected block expression for then"
        );
      }
      thenReturnType = returnValue.expr.typeValue;
    } else {
      const returnValue = this.parseBlockExpressions(tokens, index, env);
      index = returnValue.index;
      thenExpr = returnValue.exprs;
      thenReturnType = returnValue.returnType;
    }

    // parse else
    const elseExpr: Expr[] = [];
    let elseReturnType: Type = TypeValues.unit;
    if (tokens[index].type === TokenType.Else) {
      index = index + 1;

      if (tokens[index].type === TokenType.If) {
        const { expr, index: nextNextNextIndex } = this.parseIfExpr(
          tokens,
          index,
          env
        );
        if (!expr || Array.isArray(expr) || expr.type !== AstType.If) {
          throw "WTF";
        }
        elseExpr.push(expr);
        elseReturnType = expr.typeValue;
        index = nextNextNextIndex;
      } else {
        if (tokens[index].type !== TokenType.LCurlyBracket) {
          const { expr, index: nextNextNextIndex } = this.parseExpression(
            tokens,
            index,
            env
          );
          if (Array.isArray(expr)) {
            throw this.formatErrorMessage(
              tokens[index],
              "Expected block expression for else"
            );
          }
          elseExpr.push(expr);
          elseReturnType = expr.typeValue;
          index = nextNextNextIndex;
        } else {
          const {
            exprs,
            index: nextNextNextIndex,
            returnType,
          } = this.parseBlockExpressions(tokens, index, env);
          if (exprs) {
            elseExpr.push(...exprs);
          }
          elseReturnType = returnType;
          index = nextNextNextIndex;
        }
      }
    }

    if (
      !checkType(
        convertPrimitiveToType(thenReturnType),
        convertPrimitiveToType(elseReturnType)
      )
    ) {
      throw new Error(
        `Mismatched types between \`then\` and \`else\`.
then: ${typeToString(thenReturnType)}
else: ${typeToString(elseReturnType)}  
`
      );
    }

    return {
      expr: {
        type: AstType.If,
        condition,
        then: thenExpr,
        else: elseExpr,
        typeValue: thenReturnType,
      },
      index: index,
      env,
    };
  }

  private parseConstAssignment(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Const) {
      throw this.formatErrorMessage(tokens[index], "Expected const");
    }
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for const assignment"
      );
    }
    const variableName = tokens[index].value;
    index = index + 1;

    const userDefinedVariableTypeTokenIndex = index;
    let userDefinedVariableType: Type | null = null;
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      const {
        typeValue,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString: this.inputString,
        env,
        parseExpression: this.parseExpression.bind(this),
      });
      userDefinedVariableType = typeValue;
      index = nextIndex;
      env = nextEnv;

      console.log("userDefinedVariableType: ", userDefinedVariableType);
    }

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for const assignment"
      );
    }
    index = index + 1;

    const valueIndex = index;
    const {
      expr: value,
      index: nextNextIndex,
      env: nextEnv,
    } = this.parseExpression(tokens, index, env);
    if (!value) {
      return {
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit },
        index: nextNextIndex,
        env,
      };
    }
    index = nextNextIndex;
    env = nextEnv;

    let variableType: Type;
    try {
      variableType = synthesizeExprType(value, env);
    } catch (error) {
      throw this.formatErrorMessage(tokens[valueIndex], error);
    }

    // Check if type matches
    if (userDefinedVariableType !== null) {
      const typeMatches = checkType(userDefinedVariableType, variableType);
      if (!typeMatches) {
        throw this.formatErrorMessage(
          tokens[userDefinedVariableTypeTokenIndex],
          `Mismatched types:
Expected: ${typeToString(userDefinedVariableType)}
Got:      ${typeToString(variableType)}`
        );
      }

      // QUESTION: I am not sure if this is correct or not
      // narrow Union type if necessary
      /*
      if (userDefinedVariableType.type === "Union") {
        userDefinedVariableType = variableType;
      }
      */

      if (userDefinedVariableType.type === "slice") {
        let userType = userDefinedVariableType;
        let valueType = variableType as TSlice;
        // Assign size to the slice if it's undefined
        while (true) {
          if (userType.size === undefined) {
            userType.size = valueType.size;
          } else if (valueType.size && valueType.size < userType.size) {
            valueType.size = userType.size;
          }

          if (userType.elementType.type === "slice") {
            userType = userType.elementType;
            valueType = valueType.elementType as TSlice;
          } else {
            break;
          }
        }
      }
    }

    // Add variable to env
    console.log("addEnvValueType: ", variableName, variableType);
    env = addEnvValueType(env, {
      variableName,
      type: variableType,
    });

    return {
      expr: {
        type: AstType.ConstantAssigment,
        variableName,
        variableType: userDefinedVariableType ?? variableType,
        right: value,
        typeValue: TypeValues.unit,
        frameLevel: getEnvCurrentFrameLevel(env),
      },
      index,
      env,
    };
  }

  private parseTypeAlias(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Type) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "type" for type alias'
      );
    }

    index = index + 1;
    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for type alias"
      );
    }
    const typeName = tokens[index].value;
    index = index + 1;

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    if (tokens[index].type === TokenType.LessThan) {
      const {
        index: nextIndex,
        typeParameters: tp,
        env: nextEnv,
      } = synthesizeTypeParametersFromTokens({
        tokens,
        index,
        env,
        inputString: this.inputString,
        parseExpression: this.parseExpression.bind(this),
      });
      index = nextIndex;
      typeParameters = tp;
      env = nextEnv;
    }

    // Type value
    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for type alias"
      );
    }
    index = index + 1;

    const {
      index: nextIndex,
      typeValue,
      env: nextEnv,
    } = synthesizeTypeFromTokens({
      tokens,
      index,
      inputString: this.inputString,
      env,
      parseExpression: this.parseExpression.bind(this),
    });
    env = nextEnv;
    env = addEnvValueType(
      env,
      {
        type: typeValue,
        variableName: typeName,
      },
      -1
    );

    if ("typeParameters" in typeValue) {
      typeValue.typeParameters = typeParameters;
    }

    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.TypeAlias,
        typeName,
        typeValue: typeValue,
      },
      index: nextIndex,
      env,
    };
  }

  /**
   * expression
   *  ::= primary binoprhs
   * @param tokens
   * @param index
   */
  private parseExpression(
    tokens: Token[],
    index = 0,
    env: Environment
  ): ParserReturn {
    const {
      expr,
      index: nextIndex,
      env: nextEnv,
    } = this.parsePrimary(tokens, index, env);
    if (!expr) {
      return { expr, index: nextIndex, env: nextEnv };
    } else {
      return this.parseBinOpRHS(tokens, 0, expr, nextIndex, nextEnv);
    }
  }

  public parse(
    tokens: Token[],
    env: Environment = {
      functionDeclarationFrameLevel: -1,
      frames: [[]],
      freeVariables: [],
    }
  ): Expr {
    let index = 0;
    const exprs: Expr[] = [];
    while (true) {
      const token = tokens[index];
      if (!token) {
        break;
      }
      // Top level expression
      switch (token.type) {
        case TokenType.Semicolon: {
          // ignore top-level semicolons.
          index = index + 1;
          break;
        }
        case TokenType.Const: {
          const {
            expr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseConstAssignment(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = nextEnv;
          break;
        }
        case TokenType.Function: {
          const {
            expr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseFunction(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = nextEnv;
          break;
        }
        case TokenType.Extern: {
          const {
            expr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseExtern(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = nextEnv;
          break;
        }
        case TokenType.Type: {
          const {
            expr,
            index: nextIndex,
            env: nextEnv,
          } = this.parseTypeAlias(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = nextEnv;
          break;
        }
        default: {
          /*
          const { expr, index: nextIndex } = this.parseExpression(
            tokens,
            index
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          break;
          */
          throw this.formatErrorMessage(
            tokens[index],
            "Invalid top-level expression"
          );
        }
      }
    }
    return exprs.filter(
      (expr) => !Array.isArray(expr) && expr.type !== AstType.Ignore
    );
  }
}
