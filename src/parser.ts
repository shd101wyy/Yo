/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import {
  AstType,
  BlockExpr,
  Expr,
  FunctionExpr,
  FunctionPrototype,
  LetAssignmentExpr,
  PrimitiveValueExpr,
  exprToString,
  getTokenPrecedence,
  synthesizeRecordType,
} from "./ast";
import {
  Environment,
  ValueType,
  addEnvFreeVariable,
  addEnvValueType,
  copyEnvironment,
  getEnvCurrentFrameLevel,
  getEnvCurrentRegionId,
  getEnvValueTypesByVariableName,
  getNewRegionId,
  popEnvFrame,
  pushEnvFrame,
} from "./env";
import { formatErrorMessage } from "./error";
import { isUpperCamelCase } from "./naming-checker";
import { Token, TokenType } from "./token";
import {
  ParserReturn,
  RegionKind,
  TClass,
  TClassFunction,
  TEnum,
  TEnumVariant,
  TFunction,
  TParameterType,
  TRegionParameter,
  TSlice,
  TTypeConstructor,
  TTypeParameter,
  Type,
  TypeKind,
  TypeValues,
  applyTypeArgumentsToType,
  checkType,
  convertPrimitiveToType,
  getEnumTypeKind,
  getFunctionArgumentsInOrder,
  getFunctionsOfCallerFromEnv,
  parseTypeKind,
  synthesizeFunctionParameterTypesFromTokens,
  synthesizeFunctionTypeFromTokens,
  synthesizeTypeAndRegionParametersFromTokens,
  synthesizeTypeArgumentsFromTokens,
  synthesizeTypeFromTokens,
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
      if (
        tokens[index + 1]?.type === TokenType.As &&
        tokens[index + 2]?.type === TokenType.Const
      ) {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "i32",
              kind: "Free",
              value: token.value,
              tag: "primitive",
            },
            env,
          },
          index: index + 3,
        };
      } else {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "i32",
              kind: "Free",
            },
            env,
          },
          index: index + 1,
        };
      }
    } else if (token.type === TokenType.Float) {
      if (
        tokens[index + 1]?.type === TokenType.As &&
        tokens[index + 2]?.type === TokenType.Const
      ) {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "f32",
              kind: "Free",
              value: token.value,
              tag: "primitive",
            },
            env,
          },
          index: index + 3,
        };
      } else {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "f32",
              kind: "Free",
            },
            env,
          },
          index: index + 1,
        };
      }
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
      if (
        tokens[index + 1]?.type === TokenType.As &&
        tokens[index + 2]?.type === TokenType.Const
      ) {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "char",
              kind: "Free",
              value: token.value,
              tag: "primitive",
            },
            env,
          },
          index: index + 3,
        };
      } else {
        return {
          expr: {
            type: AstType.Value,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "char",
              kind: "Free",
            },
            env,
          },
          index: index + 1,
        };
      }
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
        value: "\0",
        typeValue: {
          type: "char",
          kind: "Free",
        },
        env,
      };
      return {
        expr: {
          type: AstType.Value,
          tag: "slice",
          typeValue: {
            type: "slice",
            kind: "Free",
            elementType: TypeValues.char,
            size: token.value.length + 1,
          },
          env,
          values: token.value
            .split("")
            .map((char) => {
              const charValue: PrimitiveValueExpr = {
                type: AstType.Value,
                tag: "primitive",
                value: char,
                typeValue: {
                  type: "char",
                  kind: "Free",
                },
                env,
              };
              return charValue;
            })
            .concat(end),
        },
        index: index + 1,
      };
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseSymbolExpr(tokens, index, env): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.Symbol) {
      if (
        tokens[index + 1]?.type === TokenType.As &&
        tokens[index + 2]?.type === TokenType.Const
      ) {
        return {
          expr: {
            type: AstType.Value,
            env,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "symbol",
              kind: "Free",
              value: token.value,
              tag: "primitive",
            },
          },
          index: index + 3,
        };
      } else {
        return {
          expr: {
            type: AstType.Value,
            env,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "symbol",
              kind: "Free",
            },
          },
          index: index + 1,
        };
      }
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
      if (
        tokens[index + 1]?.type === TokenType.As &&
        tokens[index + 2]?.type === TokenType.Const
      ) {
        return {
          expr: {
            type: AstType.Value,
            env,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "boolean",
              kind: "Free",
              value: token.value,
              tag: "primitive",
            },
          },
          index: index + 3,
        };
      } else {
        return {
          expr: {
            type: AstType.Value,
            env,
            tag: "primitive",
            value: token.value,
            typeValue: {
              type: "boolean",
              kind: "Free",
            },
          },
          index: index + 1,
        };
      }
    } else {
      throw this.formatErrorMessage(token, "Expected boolean");
    }
  }

  private parseSliceOrTupleExpr(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement
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
        const { expr, index: nextIndex } = this.parseExpression(
          tokens,
          index,
          env,
          isWithStatement
        );
        if (!expr) {
          return { expr, index: nextIndex };
        }
        values.push(expr);
        index = nextIndex;
        env = expr.env;
        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
    }

    const elementTypes = values.map((value) => value.typeValue);
    // Check if all the element types are the same
    const firstElementType = convertPrimitiveToType(elementTypes[0]);
    const isSlice = elementTypes.every((type) =>
      checkType(firstElementType, convertPrimitiveToType(type), env)
    );

    let typeValue: Type;
    if (isSlice) {
      typeValue = {
        type: "slice",
        kind: firstElementType.kind as TypeKind,
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
        env,
        typeValue,
        values: values,
        tag: "slice",
      },
      index,
    };
  }

  // TODO: Implement curly bracket expression
  // it could be either the RecordExpr or BlockExpr
  private parseCurlyBracketExpr(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    try {
      return this.parseRecordExpr(tokens, index, env, isWithStatement);
    } catch {
      return this.parseBlockExpressions(tokens, index, env, isWithStatement);
    }
  }

  private parseRecordExpr(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
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
          typeValue: { type: "Record", kind: "Free", properties: [] },
          env,
          properties: [],
        },
        index: index + 1,
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
        const { expr, index: nextIndex } = this.parseExpression(
          tokens,
          index,
          env,
          isWithStatement
        );
        if (!expr) {
          return { expr, index: nextIndex };
        }
        properties.push({ name: propertyName, value: expr });
        index = nextIndex;
        env = expr.env;

        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: synthesizeRecordType(properties),
          env,
          properties,
        },
        index,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
    }
  }

  private parsePropertyAccessExpr(
    expr: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
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
            env,
          },
          index: index + 1,
        };
      }
    } else if (callerType.type === "Class") {
      const func = callerType.functions.find(
        (property) => property.name === token.value
      );
      if (func) {
        // Return the function
        return {
          expr: {
            type: AstType.PropertyAccess,
            expr: expr,
            propertyName: func.name,
            typeValue: func.func,
            env,
          },
          index: index + 1,
        };
      } else {
        throw this.formatErrorMessage(
          token,
          `Cannot find function '${token.value}' in class:\n${typeToString(
            callerType
          )}`
        );
      }
    } else if (callerType.type === "Enum") {
      const variant = callerType.variants.find(
        (variant) => variant.name === token.value
      );
      if (variant) {
        const typeValue: TEnum = {
          ...callerType,
          selectedVariantName: variant.name,
        };

        if (variant.parameterTypes.length === 0) {
          return {
            expr: {
              type: AstType.CallEnum,
              env,
              typeValue: {
                ...typeValue,
              },
              variantArguments: [],
            },
            index: index + 1,
          };
        } else {
          return {
            expr: {
              type: AstType.PropertyAccess,
              expr: expr,
              propertyName: variant.name,
              typeValue: typeValue,
              env,
            },
            index: index + 1,
          };
        }
      } else {
        throw this.formatErrorMessage(
          token,
          `Cannot find variant '${token.value}' in enum:\n${typeToString(
            callerType
          )}`
        );
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
      const parsedFunctions: ValueType[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallFunctionExpr(
              {
                type: AstType.Variable,
                name: functionName,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
                env,
              },
              tokens,
              index + 1,
              env,
              isWithStatement,
              expr
            )
          );
          parsedFunctions.push(functionType);
        } catch (error) {
          // Ignore the error
        }
      }
      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          token,
          `Cannot find function '${functionName}' that takes the following type as the first argument:

${typeToString(callerType)}
`
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          token,
          `Ambiguous function "${functionName}" that takes ${typeToString(
            callerType
          )} as the first argument
Found possible functions:
- ${parsedFunctions
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
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LBracket) {
      throw this.formatErrorMessage(tokens[index], "Expected '['");
    }
    const indexes: Expr[] = [];
    let valueType = expr.typeValue;
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
      const { expr, index: nextIndex } = this.parseExpression(
        tokens,
        index,
        env,
        isWithStatement
      );
      if (!expr) {
        throw this.formatErrorMessage(token, "Expected expression");
      }
      indexes.push(expr);
      index = nextIndex;
      env = expr.env;

      const indexType = expr.typeValue;
      if (!checkType(TypeValues.i32, indexType, env)) {
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
        env,
      },
      index,
    };
  }

  private parseAnonymouseFunction(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '(' for anonymous function"
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
      const { expr, index: nextNextIndex } = this.parseBlockExpressions(
        tokens,
        nextIndex + 1,
        nextEnv,
        isWithStatement
      );
      const { exprs: body, typeValue: returnType, env: nextNextEnv } = expr;
      env = nextNextEnv;

      // Check function body return type matches
      // prototype.returnType
      if (prototype.typeValue.returnType.type === "unknown") {
        prototype.typeValue.returnType = returnType;
      }

      if (
        !checkType(returnType, prototype.typeValue.returnType, env) &&
        !checkType(prototype.typeValue.returnType, returnType, env)
      ) {
        throw this.formatErrorMessage(
          tokens[index],
          `(1) Mismatched return type:
Prototype: ${typeToString(prototype.typeValue.returnType)}
Returned:  ${typeToString(returnType)}`
        );
      }

      prototype.typeValue.freeVariables = env.freeVariables;

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        body,
        frameLevel: currentFrameLevel,
        freeVariables: env.freeVariables, // FIXME: Implement freeVariables
        typeValue: prototype.typeValue,
        env: copyEnvironment(
          popEnvFrame(env),
          oldEnv.functionDeclarationFrameLevel,
          oldEnv.freeVariables
        ),
      };
      env = popEnvFrame(env);
      return {
        expr: functionExpr,
        index: nextNextIndex,
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
    env: Environment,
    isWithStatement: boolean
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
          value: "()",
          typeValue: {
            type: "()",
            kind: "Free",
          },
          env,
        },
        index: index + 2,
      };
    }

    // Try parse as anonymouse function
    try {
      const { expr, index: nextIndex } = this.parseAnonymouseFunction(
        tokens,
        index,
        env,
        isWithStatement
      );
      if (expr) {
        return { expr, index: nextIndex };
      } else {
        throw new Error("Failed to parse as anonymouse function");
      }
    } catch (error) {
      // Ignore the error
      // This means we failed to parse it as anonymouse function
    }

    const { expr, index: nextIndex } = this.parseExpression(
      tokens,
      index + 1,
      env,
      isWithStatement
    );
    if (!expr) {
      return { expr, index: nextIndex };
    }

    if (tokens[nextIndex].type !== TokenType.RParen) {
      throw this.formatErrorMessage(tokens[nextIndex], "Expected right paren");
    }
    return { expr, index: nextIndex + 1 };
  }

  private parseFunctionCallArguments(
    callee: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean,
    caller?: Expr
  ): {
    index: number;
    typeArguments: Type[];
    functionArguments: Expr[];
    calleeTypeValue: TFunction;
    env: Environment;
  } {
    let calleeTypeValue = callee.typeValue;
    if (calleeTypeValue.type !== "Function") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected function for call expression"
      );
    }
    // type arguments
    let typeArguments: Type[] = [];
    if (tokens[index]?.type === TokenType.LessThan) {
      const {
        typeArguments: nextTypeArguments,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeArgumentsFromTokens({
        tokens,
        index: index,
        inputString: this.inputString,
        env,
        parseExpression: this.parseExpression.bind(this),
      });
      typeArguments = nextTypeArguments;
      index = nextIndex;
      env = nextEnv;
    }

    const functionArguments: Expr[] = [];
    if (caller) {
      functionArguments.push(caller);
    }

    let parsedNormalArguments = false;
    while (true) {
      // Try parsing as anonymous function
      try {
        const { expr, index: nextIndex } = this.parseAnonymouseFunction(
          tokens,
          index,
          env,
          false
        );
        if (expr) {
          functionArguments.push(expr);
          index = nextIndex;
          continue;
        } else {
          throw new Error("Failed to parse as anonymouse function");
        }
      } catch (error) {
        // Ignore the error
        // This means we failed to parse it as anonymouse function
        // Try parse as block expression
        try {
          if (tokens[index].type !== TokenType.LCurlyBracket) {
            throw new Error("Expected left curly bracket");
          }

          // Insert "(", ")", "=>" tokens to make it a valid function
          const newTokens: Token[] = [
            ...tokens.slice(0, index),
            {
              type: TokenType.LParen,
              value: "(",
              position: tokens[index].position,
            },
            {
              type: TokenType.RParen,
              value: ")",
              position: tokens[index].position,
            },
            {
              type: TokenType.LambdaArrow,
              value: "=>",
              position: tokens[index].position,
            },
            ...tokens.slice(index),
          ];
          const diffSize = newTokens.length - tokens.length;
          const { expr, index: nextIndex } = this.parseAnonymouseFunction(
            newTokens,
            index,
            env,
            false
          );
          if (expr) {
            // FIXME: Convert block expression to anonymous function with 0 parameters
            functionArguments.push(expr);
            index = nextIndex - diffSize; // Remove "(", ")", "=>"
            continue;
          } else {
            throw new Error("Failed to parse as block expression");
          }
        } catch (error) {
          if (parsedNormalArguments) {
            break;
          }
          // Ignore the error
          // This means we failed to parse it as block expression
          // NOTE: This is not right for trailing lambda
          if (tokens[index]?.type !== TokenType.LParen) {
            // throw this.formatErrorMessage(tokens[index], "Expected left paren");
            break;
          }
          index = index + 1;

          if (tokens[index]?.type === TokenType.RParen) {
            index = index + 1;
            parsedNormalArguments = true;
            continue;
          }

          // eslint-disable-next-line no-constant-condition
          while (true) {
            // Check if it's keyword argument
            if (
              tokens[index].type === TokenType.Identifier &&
              tokens[index + 1].type === TokenType.Assign
            ) {
              const variableName = tokens[index].value;
              const { expr: defaultParameterValueExpr, index: nextIndex } =
                this.parseExpression(tokens, index + 2, env, false);
              env = defaultParameterValueExpr.env;

              if (!defaultParameterValueExpr) {
                throw this.formatErrorMessage(
                  tokens[index],
                  "Expected expression for default parameter value"
                );
              }

              const parameterAssignmentExpr: LetAssignmentExpr = {
                type: AstType.LetAssignment,
                variableName: variableName,
                isMutable: false, // NOTE: This is not used.
                right: defaultParameterValueExpr,
                typeValue: TypeValues.unit,
                variableType: defaultParameterValueExpr.typeValue,
                frameLevel: getEnvCurrentFrameLevel(env),
                env,
              };
              functionArguments.push(parameterAssignmentExpr);
              index = nextIndex;
            } else {
              const { expr, index: nextIndex } = this.parseExpression(
                tokens,
                index,
                env,
                false
              );
              env = expr.env;

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
              index = index + 1;
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
          parsedNormalArguments = true;
        }
      }
    }

    // Check if it's 'with' statement
    if (isWithStatement) {
      // Parse the rest of the tokens as anonymouse function
      // add "(", ")", "=>", "{" to the tokens
      // FIXME: Type arguments;
      const newTokens: Token[] = [
        ...tokens.slice(0, index),
        {
          type: TokenType.LParen,
          value: "(",
          position: tokens[index].position,
        },
        {
          type: TokenType.RParen,
          value: ")",
          position: tokens[index].position,
        },
        {
          type: TokenType.LambdaArrow,
          value: "=>",
          position: tokens[index].position,
        },
        {
          type: TokenType.LCurlyBracket,
          value: "{",
          position: tokens[index].position,
        },
        ...tokens.slice(index),
      ];
      const diffSize = newTokens.length - tokens.length;
      const { expr: lambdaExpr, index: nextNextIndex } =
        this.parseAnonymouseFunction(newTokens, index, env, false);
      index = nextNextIndex - diffSize - 1;
      env = lambdaExpr.env;
      functionArguments.push(lambdaExpr);
    }

    const {
      functionArguments: functionArgumentsInOrder,
      functionTypeArguments: functionTypeArgumentsInOrder,
    } = getFunctionArgumentsInOrder(
      functionArguments,
      calleeTypeValue.parameterTypes,
      typeArguments,
      calleeTypeValue.typeParameters,
      env
    );

    if (!functionArgumentsInOrder) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched function arguments.
Expected: (${calleeTypeValue.parameterTypes
          .map(
            (parameter) =>
              (parameter.name ? `${parameter.name}: ` : "") +
              typeToString(parameter.type)
          )
          .join(", ")})
Got:      (${functionArguments
          .map((arg) => {
            return typeToString(arg.typeValue);
          })
          .join(", ")})`
      );
    }
    if (!functionTypeArgumentsInOrder) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched type arguments.
Expected: <${calleeTypeValue.typeParameters
          .map((typeParameter) => `${typeToString(typeParameter)}`)
          .join(", ")}>
Got:      <${typeArguments.map((type) => typeToString(type)).join(", ")}>`
      );
    }

    // Check if typeArguments matches
    // and apply typeArguments to callee.typeValue
    const typeParameters = calleeTypeValue.typeParameters;
    if (typeParameters.length !== functionTypeArgumentsInOrder.length) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched type arguments.
Expected: <${typeParameters
          .map((typeParameter) => `${typeToString(typeParameter)}`)
          .join(", ")}>
Got:      <${functionTypeArgumentsInOrder
          .map((type) => typeToString(type))
          .join(", ")}>`
      );
    } else {
      const typeValue_ = applyTypeArgumentsToType(
        calleeTypeValue,
        functionTypeArgumentsInOrder
      );
      if (typeValue_.type !== "Function") {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function for call expression"
        );
      } else {
        callee.typeValue = typeValue_;
        calleeTypeValue = typeValue_;
      }
    }

    return {
      index,
      typeArguments: functionTypeArgumentsInOrder,
      functionArguments: functionArgumentsInOrder,
      calleeTypeValue,
      env,
    };
  }

  private parseCallFunctionExpr(
    callee: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean,
    caller?: Expr
  ): ParserReturn {
    const {
      index: nextIndex,
      env: nextEnv,
      typeArguments,
      functionArguments,
      calleeTypeValue,
    } = this.parseFunctionCallArguments(
      callee,
      tokens,
      index,
      env,
      isWithStatement,
      caller
    );
    index = nextIndex;
    env = nextEnv;

    return {
      expr: {
        type: AstType.CallFunction,
        callee,
        typeArguments,
        functionArguments,
        typeValue: calleeTypeValue.returnType,
        env,
      },
      index,
    };
  }

  private parseCallEnumExpr(
    callee: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    const calleeTypeValue = callee.typeValue;
    if (calleeTypeValue.type !== "Enum") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected enum for call expression"
      );
    }
    const selectedVariantName = calleeTypeValue.selectedVariantName;
    if (selectedVariantName === undefined) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected enum variant for call expression"
      );
    }

    const selectedVariant = calleeTypeValue.variants.find(
      (variant) => variant.name === selectedVariantName
    );
    if (!selectedVariant) {
      throw this.formatErrorMessage(
        tokens[index],
        `Cannot find enum variant ${selectedVariantName}`
      );
    }

    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }

    const appliedTypeArguments: Type[] = calleeTypeValue.typeParameters.map(
      (typeParameter) => typeParameter.appliedType ?? TypeValues.unknown
    );

    const variantArguments: Expr[] = [];
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ')'");
      }
      if (token.type === TokenType.RParen) {
        index = index + 1;
        break;
      } else {
        const { expr, index: nextIndex } = this.parseExpression(
          tokens,
          index,
          env,
          isWithStatement
        );
        if (!expr) {
          throw this.formatErrorMessage(token, "Expected expression");
        }
        variantArguments.push(expr);
        index = nextIndex;
        env = expr.env;

        if (tokens[index].type === TokenType.Comma) {
          index = index + 1;
        }
      }
    }

    const {
      functionArguments: variantArgumentsInOrder,
      functionTypeArguments: variantTypeArgumentsInOrder,
    } = getFunctionArgumentsInOrder(
      variantArguments,
      selectedVariant.parameterTypes,
      appliedTypeArguments,
      calleeTypeValue.typeParameters,
      env
    );

    if (!variantArgumentsInOrder) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched function arguments.
Expected: (${selectedVariant.parameterTypes
          .map(
            (parameter) =>
              (parameter.name ? `${parameter.name}: ` : "") +
              typeToString(parameter.type)
          )
          .join(", ")})
Got:      (${variantArguments
          .map((arg) => {
            return typeToString(arg.typeValue);
          })
          .join(", ")})`
      );
    }

    if (!variantTypeArgumentsInOrder) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched type arguments.
Expected: <${calleeTypeValue.typeParameters
          .map((typeParameter) => `${typeToString(typeParameter)}`)
          .join(", ")}>
Got:      <${appliedTypeArguments
          .map((type) => typeToString(type))
          .join(", ")}>`
      );
    }

    const enumType: TEnum = applyTypeArgumentsToType(
      { ...calleeTypeValue },
      variantTypeArgumentsInOrder
    ) as TEnum;

    return {
      expr: {
        type: AstType.CallEnum,
        variantArguments: variantArgumentsInOrder as Expr[],
        typeValue: enumType,
        env,
      },
      index,
    };
  }

  private parseIsOperatorExpr(
    enumExpr: Expr,
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (enumExpr.typeValue.type !== "Enum") {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected enum for "is" comparison'
      );
    }
    if (tokens[index].type !== TokenType.Is) {
      throw this.formatErrorMessage(tokens[index], "Expected 'is' keyword");
    }
    index = index + 1;

    const { expr: targetEnumExpr, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      false
    );
    if (!targetEnumExpr) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected expression for enum"
      );
    }
    index = nextIndex;
    if (targetEnumExpr.typeValue.type !== "Enum") {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected enum for "is" comparison'
      );
    }
    const targetEnumType = targetEnumExpr.typeValue;
    const targetSelectedVariantName = targetEnumType.selectedVariantName;
    if (!targetSelectedVariantName) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected enum variant for enum"
      );
    }

    if (enumExpr.typeValue.enumName !== targetEnumType.enumName) {
      throw this.formatErrorMessage(
        tokens[index],
        `Expected enum ${typeToString(
          enumExpr.typeValue
        )}, but got ${typeToString(targetEnumType)}`
      );
    }

    if (
      targetEnumType.typeParameters.every(
        (typeParameter) => !typeParameter.appliedType
      )
    ) {
      targetEnumType.typeParameters = enumExpr.typeValue.typeParameters;
    }

    return {
      expr: {
        type: AstType.IsOperator,
        left: enumExpr,
        right: targetEnumType,
        typeValue: TypeValues.boolean,
        env,
      },
      index,
    };
  }

  /**
   * identifierexpr
   *   ::= identifier
   *   ::= identifier "(" expression* ")" # Call
   * @param tokens
   * @param index
   */
  private parseIdentifierExpr(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    const identifier = tokens[index].value;

    // Check if variable is defined
    const valueTypes = [
      ...getEnvValueTypesByVariableName(env, identifier, "value"),
      ...getEnvValueTypesByVariableName(env, identifier, "class"),
      ...getEnvValueTypesByVariableName(env, identifier, "type"),
    ];
    if (valueTypes.length === 0) {
      throw this.formatErrorMessage(
        tokens[index],
        `Unbounded variable \`${identifier}\``
      );
    }
    const matchedFunctions = valueTypes.filter(
      (valueType) => valueType.type.type === "Function"
    );
    const matchedTypeclasses = valueTypes.filter(
      (valueType) =>
        valueType.type.type === "Class" && valueType.kind === "class"
    );
    const matchedEnums = valueTypes.filter(
      (valueType) =>
        valueType.type.type === "Enum" &&
        (valueType.kind === "type" || valueType.kind === "value")
    );

    // Check if it's a typeclass
    if (matchedTypeclasses.length > 0) {
      // FIXME: Support this
      if (matchedTypeclasses.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous typeclasses "${identifier}"
Found possible typeclasses:
- ${matchedTypeclasses
            .map((typeclassType) => typeToString(typeclassType.type))
            .join("\n- ")}
          `
        );
      } else {
        const typeclass = matchedTypeclasses[0];
        const typeclassType = typeclass.type;
        if (typeclassType.type !== "Class") {
          throw this.formatErrorMessage(
            tokens[index],
            `Expected class, but got ${typeToString(typeclassType)}`
          );
        }
        let typeArguments: Type[] = [];
        if (tokens[index + 1]?.type === TokenType.LessThan) {
          const {
            typeArguments: nextTypeArguments,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeArgumentsFromTokens({
            tokens,
            index: index + 1,
            inputString: this.inputString,
            env,
            parseExpression: this.parseExpression.bind(this),
          });
          typeArguments = nextTypeArguments;
          index = nextIndex;
          env = nextEnv;
        } else {
          index = index + 1;
        }

        const newTypeclassType = applyTypeArgumentsToType(
          typeclassType,
          typeArguments
        );
        if (newTypeclassType.type !== "Class") {
          throw this.formatErrorMessage(
            tokens[index],
            `Expected class type, but got ${typeToString(newTypeclassType)}`
          );
        } else {
          return {
            expr: {
              type: AstType.Class,
              className: identifier,
              typeValue: newTypeclassType,
              typeArguments: typeArguments,
              env,
              isDefinition: false,
            },
            index,
          };
        }
      }
    }

    // Check if it's an enum
    if (matchedEnums.length > 0) {
      if (matchedEnums.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous enum "${identifier}"
Found possible enums:
- ${matchedEnums.map((enumType) => typeToString(enumType.type)).join("\n- ")}
          `
        );
      } else {
        const enumValue = matchedEnums[0];
        const enumType = enumValue.type as TEnum;
        let typeArguments: Type[] = [];
        if (tokens[index + 1]?.type === TokenType.LessThan) {
          const {
            typeArguments: nextTypeArguments,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeArgumentsFromTokens({
            tokens,
            index: index + 1,
            inputString: this.inputString,
            env,
            parseExpression: this.parseExpression.bind(this),
          });
          typeArguments = nextTypeArguments;
          index = nextIndex;
          env = nextEnv;
        } else {
          index = index + 1;
        }

        const newEnumType: TEnum = {
          ...enumType,
          typeParameters: enumType.typeParameters.map(
            (typeParameter, index) => {
              if (index >= typeArguments.length) {
                return typeParameter;
              } else {
                return {
                  ...typeParameter,
                  appliedType: typeArguments[index],
                };
              }
            }
          ),
        };

        return {
          expr: {
            type: AstType.Variable,
            name: identifier,
            env,
            typeValue: newEnumType,
            frameLevel: enumValue.frameLevel,
          },
          index,
        };
      }
    }

    // Check if it's a function
    // - test(1) Normal function call
    // - test { 12 } Trailing lambda
    // - test { 12 } { 13 } Trailing lambdas
    // - test (x)=> { x + 1 } Trailing lambda
    if (
      tokens[index + 1]?.type === TokenType.LParen ||
      tokens[index + 1]?.type === TokenType.LCurlyBracket ||
      tokens[index + 1]?.type === TokenType.LessThan ||
      isWithStatement
    ) {
      // Try all matchedFunctions to see if there is a match
      const parserReturns: ParserReturn[] = [];
      const parsedFunctions: ValueType[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallFunctionExpr(
              {
                type: AstType.Variable,
                name: identifier,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
                env,
              },
              tokens,
              index + 1,
              env,
              isWithStatement
            )
          );
          parsedFunctions.push(functionType);
        } catch (error) {
          // Ignore the error
        }
      }

      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot find function '${identifier}'
Below are the possible functions:

${matchedFunctions
  .map((func) => `  ${func.variableName}: ${typeToString(func.type)}`)
  .join("\n")}
          `
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous function "${identifier}"
Found possible functions:
- ${parsedFunctions
            .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
            .join("\n- ")}`
        );
      } else {
        // FIXME: Might need to check `isFreeVariable` here as well
        return parserReturns[0];
      }
    }

    const valueTypes_ = getEnvValueTypesByVariableName(
      env,
      identifier,
      "value"
    );
    if (valueTypes_.length === 0) {
      throw this.formatErrorMessage(
        tokens[index],
        `Unbounded variable \`${identifier}\``
      );
    }

    const valueType = valueTypes_[valueTypes_.length - 1];
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
        env,
        // isFreeVariable,
      },
      index: index + 1,
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
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    const token = tokens[index];
    let returnValue: ParserReturn | null = null;
    switch (token.type) {
      case TokenType.Identifier: {
        returnValue = this.parseIdentifierExpr(
          tokens,
          index,
          env,
          isWithStatement
        );
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
        returnValue = this.parseSliceOrTupleExpr(
          tokens,
          index,
          env,
          isWithStatement
        );
        break;
      }
      case TokenType.LParen: {
        returnValue = this.parseParenExpr(tokens, index, env, isWithStatement);
        break;
      }
      case TokenType.LCurlyBracket: {
        returnValue = this.parseCurlyBracketExpr(
          tokens,
          index,
          env,
          isWithStatement
        );
        break;
      }
      case TokenType.If: {
        returnValue = this.parseIfExpr(tokens, index, env, isWithStatement);
        break;
      }
      case TokenType.Let: {
        return this.parseLetAssignment(tokens, index, env, isWithStatement);
      }
      case TokenType.Semicolon: {
        return {
          expr: { type: AstType.Ignore, typeValue: TypeValues.unit, env },
          index: index + 1,
        };
      }
      case TokenType.With: {
        return this.parseWithExpr(tokens, index, env);
      }
      case TokenType.MutableReference:
      case TokenType.BitwiseAnd: {
        return this.parseReferenceExpr(tokens, index, env);
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
      returnValue.expr.env,
      isWithStatement
    );
  }

  private parsePrimaryEnd(
    primaryExpr: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    const token = tokens[index];
    if (!token) {
      return {
        expr: primaryExpr,
        index,
      };
    } else if (token.type === TokenType.Dot) {
      // parsePropertyAccessExpr
      const returnValue = this.parsePropertyAccessExpr(
        primaryExpr,
        tokens,
        index,
        env,
        isWithStatement
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        isWithStatement
      );
    } else if (token.type === TokenType.LBracket) {
      // parseIndexAccessExpr
      const returnValue = this.parseIndexAccessExpr(
        primaryExpr,
        tokens,
        index,
        env,
        isWithStatement
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        isWithStatement
      );
    } else if (
      primaryExpr.typeValue.type === "Function" &&
      (token.type === TokenType.LParen || token.type === TokenType.LessThan)
    ) {
      // parseCallFunctionExpr
      const returnValue = this.parseCallFunctionExpr(
        primaryExpr,
        tokens,
        index,
        env,
        isWithStatement
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        isWithStatement
      );
    } else if (
      primaryExpr.typeValue.type === "Enum" &&
      token.type === TokenType.LParen
    ) {
      // parseCallEnumExpr
      const returnValue = this.parseCallEnumExpr(
        primaryExpr,
        tokens,
        index,
        env,
        isWithStatement
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        isWithStatement
      );
    } else if (
      primaryExpr.typeValue.type === "Enum" &&
      token.type === TokenType.Is
    ) {
      // parseIsOperatorExpr
      const returnValue = this.parseIsOperatorExpr(
        primaryExpr,
        tokens,
        index,
        env
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        isWithStatement
      );
    } else {
      return {
        expr: primaryExpr,
        index,
      };
    }
  }

  private parseBinOpRHS(
    tokens: Token[],
    exprPrecedence: number,
    LHS: Expr,
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];
      const tokenPrecedence = getTokenPrecedence(token);

      // If this is a binop that binds at least as tightly as the current binop,
      // consume it, otherwise we are done.
      if (tokenPrecedence < exprPrecedence) {
        return { expr: LHS, index };
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
      } = this.parsePrimary(tokens, index, env, isWithStatement);
      env = RHS.env;
      if (!RHS) {
        return { expr: RHS, index: nextIndex };
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
          env,
          isWithStatement
        );
        if (!expr) {
          return { expr, index: nextNextIndex };
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
      const lhsType = convertPrimitiveToType((needsSwap ? RHS : LHS).typeValue);
      LHS = {
        type: AstType.BinaryOperator,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        operator: operator as any,
        left: needsSwap ? RHS : LHS,
        right: needsSwap ? LHS : RHS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeValue: lhsType, // FIXME:
        // const x = 1
        // x + 2  // give type 1
        env,
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
    env: Environment,
    isWithStatement: boolean,
    requireLCurlyBracket = true
  ): { index: number; expr: BlockExpr } {
    let exprs: Expr[] = [];
    if (
      requireLCurlyBracket &&
      tokens[index].type !== TokenType.LCurlyBracket
    ) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for block expressions"
      );
    }
    if (requireLCurlyBracket) {
      index = index + 1;
    }
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
      const { expr, index: nextIndex } = this.parseExpression(
        tokens,
        index,
        nextEnv,
        isWithStatement
      );
      nextEnv = expr.env;
      if (expr) {
        exprs.push(expr);
      }
      index = nextIndex;
    }

    exprs = exprs.filter((expr) => expr.type !== AstType.Ignore);
    const lastExpr: Expr | null = exprs[exprs.length - 1] ?? null;
    if (!lastExpr || tokens[index - 2].type === TokenType.Semicolon) {
      exprs.push({
        type: AstType.Value,
        tag: "primitive",
        value: "()",
        typeValue: { type: "()", kind: "Free" },
        env: nextEnv,
      });
    }

    // NOTE: Needs to put this before `env.popFrame` to get `returnType`.
    const returnType = exprs[exprs.length - 1].typeValue;
    env = popEnvFrame(nextEnv);

    return {
      index: requireLCurlyBracket ? index : index - 1,
      expr: {
        type: AstType.Block,
        exprs,
        env,
        typeValue: returnType,
      },
    };
  }

  private parseFunction(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean,
    requireFunctionKeyword = true
  ): ParserReturn {
    if (requireFunctionKeyword) {
      if (tokens[index].type !== TokenType.Function) {
        throw this.formatErrorMessage(
          tokens[index],
          `Expected function, but got ${tokens[index].type}`
        );
      } else {
        index = index + 1;
      }
    }

    const currentFrameLevel = getEnvCurrentFrameLevel(env);
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
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit, env },
        index: nextIndex,
      };
    } else {
      index = nextIndex;

      /*
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
      */

      env = addEnvValueType(
        env,
        {
          variableName: prototype.functionName!,
          type: prototype.typeValue,
          kind: "value",
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
      const { index: nextIndex, expr } = this.parseBlockExpressions(
        tokens,
        index,
        env,
        isWithStatement
      );
      const functionReturnType = expr.typeValue;
      const exprs = expr.exprs;
      env = expr.env;

      // Check function body return type matches
      // prototype.returnType
      if (prototype.typeValue.returnType.type === "unknown") {
        prototype.typeValue.returnType = functionReturnType;
      }

      if (!checkType(prototype.typeValue.returnType, functionReturnType, env)) {
        throw this.formatErrorMessage(
          tokens[index],
          `(2) Mismatched return type: 
Prototype: ${typeToString(prototype.typeValue.returnType)}
Returned:  ${typeToString(functionReturnType)}`
        );
      }

      const functionExpr: FunctionExpr = {
        type: AstType.Function,
        prototype,
        typeValue: prototype.typeValue,
        env: copyEnvironment(
          popEnvFrame(env),
          oldEnv.functionDeclarationFrameLevel,
          oldEnv.freeVariables
        ),
        body: exprs,
        frameLevel: currentFrameLevel,
        freeVariables: env.freeVariables,
      };
      env = popEnvFrame(env);
      return {
        expr: functionExpr,
        index: nextIndex,
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
        expr: { type: AstType.Ignore, typeValue: TypeValues.unit, env },
        index: nextIndex,
      };
    } else {
      index = nextIndex;
      env = addEnvValueType(env, {
        variableName: prototype.functionName!,
        type: prototype.typeValue,
        kind: "value",
      });
    }

    return {
      expr: {
        type: AstType.Extern,
        prototype,
        typeValue: prototype.typeValue,
        env,
      },
      index,
    };
  }

  private parseIfExpr(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    index = index + 1;

    // parse condition
    const { expr: condition, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      isWithStatement
    );
    if (!condition) {
      throw this.formatErrorMessage(tokens[index], "Expected condition for if");
    }
    const conditionType = condition.typeValue;
    if (!checkType(TypeValues.boolean, conditionType, env)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Expected boolean for condition, but got ${typeToString(conditionType)}`
      );
    }
    index = nextIndex;
    env = condition.env;

    let thenExpr: Expr[] = [];
    let thenReturnType: Type;
    // parse then
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      const returnValue = this.parseExpression(
        tokens,
        index,
        env,
        isWithStatement
      );
      index = returnValue.index;
      thenExpr = [returnValue.expr];
      thenReturnType = returnValue.expr.typeValue;
    } else {
      const { index: nextIndex, expr } = this.parseBlockExpressions(
        tokens,
        index,
        env,
        isWithStatement
      );
      index = nextIndex;
      thenExpr = expr.exprs;
      thenReturnType = expr.typeValue;
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
          env,
          isWithStatement
        );
        if (!expr || expr.type !== AstType.If) {
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
            env,
            isWithStatement
          );
          elseExpr.push(expr);
          elseReturnType = expr.typeValue;
          index = nextNextNextIndex;
        } else {
          const { expr, index: nextNextNextIndex } = this.parseBlockExpressions(
            tokens,
            index,
            env,
            isWithStatement
          );
          if (expr.exprs.length) {
            elseExpr.push(...expr.exprs);
          }
          elseReturnType = expr.typeValue;
          index = nextNextNextIndex;
        }
      }
    }

    if (
      !checkType(
        convertPrimitiveToType(thenReturnType),
        convertPrimitiveToType(elseReturnType),
        env
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
        env,
      },
      index: index,
    };
  }

  private parseLetAssignment(
    tokens: Token[],
    index: number,
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Let) {
      throw this.formatErrorMessage(tokens[index], 'Expected "let"');
    }
    index = index + 1;

    let isMutable: boolean = false;
    if (tokens[index].type === TokenType.Mut) {
      isMutable = true;
      index = index + 1;
    }

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
    }

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for const assignment"
      );
    }
    index = index + 1;

    const { expr: value, index: nextNextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      isWithStatement
    );
    if (!value) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected expression for const assignment"
      );
    }
    index = nextNextIndex;
    env = value.env;

    const variableType: Type = value.typeValue;
    // Check if type matches
    if (userDefinedVariableType !== null) {
      // Type inference for enum type
      if (
        userDefinedVariableType.type === "Enum" &&
        variableType.type === "Enum" &&
        userDefinedVariableType.enumName === variableType.enumName &&
        (userDefinedVariableType.selectedVariantName === undefined ||
          userDefinedVariableType.selectedVariantName ===
            variableType.selectedVariantName)
      ) {
        for (
          let i = 0;
          i < userDefinedVariableType.typeParameters.length;
          i++
        ) {
          const userDefinedTypeArgument =
            userDefinedVariableType.typeParameters[i].appliedType;
          const typeArgument = variableType.typeParameters[i].appliedType;
          if (!userDefinedTypeArgument && typeArgument) {
            userDefinedVariableType.typeParameters[i].appliedType =
              typeArgument;
          } else if (userDefinedTypeArgument && !typeArgument) {
            variableType.typeParameters[i].appliedType =
              userDefinedTypeArgument;
          }
        }
        userDefinedVariableType.selectedVariantName =
          variableType.selectedVariantName;
      }

      const typeMatches = checkType(userDefinedVariableType, variableType, env);
      if (!typeMatches) {
        throw this.formatErrorMessage(
          tokens[userDefinedVariableTypeTokenIndex],
          `Mismatched types:
Expected: ${typeToString(userDefinedVariableType, {
            extractTypeConstructor: "all",
          })}
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

      userDefinedVariableType = variableType;
    }

    // Add variable to env
    env = addEnvValueType(env, {
      variableName,
      type: variableType,
      kind: "value",
    });

    return {
      expr: {
        type: AstType.LetAssignment,
        variableName,
        isMutable,
        variableType: userDefinedVariableType ?? variableType,
        right: value,
        typeValue: TypeValues.unit,
        frameLevel: getEnvCurrentFrameLevel(env),
        env,
      },
      index,
    };
  }

  private parseWithExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.With) {
      throw this.formatErrorMessage(tokens[index], 'Expected "with"');
    }
    index = index + 1;

    // Parse expr after `with`
    const { expr: withExpr, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      true
    );
    if (!withExpr) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected expression for "with"'
      );
    }
    index = nextIndex;
    env = withExpr.env;

    // Check the type of `withExpr`
    if (withExpr.type === AstType.CallFunction) {
      return {
        expr: withExpr,
        index,
      };
    }

    const typeValue = withExpr.typeValue;

    switch (typeValue.type) {
      /*case "Record": {
        
        // Convert to ConstAssignment
        const constAssignmentExprs: Expr[] = [];
        // Add record fields to env
        for (const field of typeValue.properties) {
          env = addEnvValueType(env, {
            variableName: field.name,
            type: field.type,
            kind: "value",
          });
          constAssignmentExprs.push({
            type: AstType.LetAssignment,
            variableName: field.name,
            variableType: field.type,
            right: {
              type: AstType.PropertyAccess,
              expr: withExpr,
              propertyName: field.name,
              typeValue: field.type,
              env,
            },
            typeValue: TypeValues.unit,
            frameLevel: getEnvCurrentFrameLevel(env),
            env,
          });
        }

        // Parse the rest of the tokens
        const { expr: blockExpr, index: nextIndex } =
          this.parseBlockExpressions(tokens, index, env, false, false);

        return {
          expr: {
            type: AstType.Block,
            exprs: [...constAssignmentExprs, ...blockExpr.exprs],
            env: blockExpr.env,
            typeValue: blockExpr.typeValue,
          },
          index: nextIndex,
        };
      }
      */
      case "Class": {
        // Take the typeclass functions out to env
        for (const func of typeValue.functions) {
          env = addEnvValueType(env, {
            variableName: func.name,
            type: func.func,
            kind: "value",
          });
        }

        // Parse the rest of the tokens
        const { expr: blockExpr, index: nextIndex } =
          this.parseBlockExpressions(tokens, index, env, false, false);

        return {
          expr: {
            type: AstType.Block,
            exprs: blockExpr.exprs,
            env: blockExpr.env,
            typeValue: blockExpr.typeValue,
          },
          index: nextIndex,
        };
      }
      default: {
        throw this.formatErrorMessage(
          tokens[index],
          `The "with" statement doesn't support the following type:\n\n${typeToString(
            typeValue
          )}\n`
        );
      }
    }
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

    // typeName has to be UpperCamelCase
    if (!isUpperCamelCase(typeName)) {
      throw this.formatErrorMessage(
        tokens[index - 1],
        "Type name has to be UpperCamelCase"
      );
    }

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);
    env = addEnvValueType(env, {
      variableName: typeName,
      type: {
        type: "unknown",
        kind: "Free",
        typeName,
      },
      kind: "type",
    });

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].type === TokenType.LessThan) {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
        inputString: this.inputString,
      });
      index = nextIndex;
      typeParameters = tp;
      regionParameters = rp;
      env = nextEnv;
    }

    // Parse userDefinedKind
    let userDefinedKind: TypeKind | undefined = undefined;
    const userDefinedKindTokenIndex = index + 1;
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      userDefinedKind = parseTypeKind(tokens[index]);
      if (!userDefinedKind) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected 'Type', 'Linear' or 'Free'"
        );
      }
      index = index + 1;
    }

    // Type value
    let kind: TypeKind | RegionKind | undefined = undefined;
    let typeValue: Type = {
      type: "Extern",
      kind: "Free",
    };
    if (tokens[index].type === TokenType.Assign) {
      index = index + 1;

      const {
        index: nextIndex,
        typeValue: nextTypeValue,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        inputString: this.inputString,
        env,
        parseExpression: this.parseExpression.bind(this),
      });

      // Check if userDefinedKind is valid:
      kind = nextTypeValue.kind;
      if (
        userDefinedKind &&
        userDefinedKind === "Free" &&
        (kind === "Linear" || kind === "Type")
      ) {
        throw this.formatErrorMessage(
          tokens[userDefinedKindTokenIndex],
          `Cannot mix 'Free' type and '${kind}' type`
        );
      } else if (
        userDefinedKind &&
        userDefinedKind === "Linear" &&
        kind === "Type"
      ) {
        throw this.formatErrorMessage(
          tokens[userDefinedKindTokenIndex],
          `Cannot mix 'Linear' type and '${kind}' type`
        );
      } else {
        kind = userDefinedKind ? userDefinedKind : kind;
      }

      index = nextIndex;
      env = nextEnv;
      typeValue = nextTypeValue;
    } else {
      if (!userDefinedKind) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected kind for type alias"
        );
      }
      kind = userDefinedKind;
      typeValue = {
        type: "Extern",
        kind,
      };
    }

    const typeConstructor: TTypeConstructor = {
      type: "TypeConstructor",
      kind,
      name: typeName,
      typeParameters,
      regionParameters,
      typeValue,
    };

    env = addEnvValueType(
      env,
      {
        variableName: typeName,
        type: typeConstructor,
        kind: "type",
      },
      -1
    );

    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.TypeAlias,
        typeName,
        typeValue: typeConstructor,
        env,
      },
      index,
    };
  }

  /**
   *
   * class ::= "class" identifier typeParameters? "{" functionPrototype* "}"
   *           ::= "class" identifier typeParameters? "with" typeclassType "{" functionPrototype* "}"
   * FIXME: Support `with` for class
   * FIXME: If the class has no type parameters, then all functions in the class should have default implementations.
   * @param tokens
   * @param index
   * @param env
   * @returns
   */
  private parseClass(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Class) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "class" for typeclass declaration'
      );
    }

    index = index + 1;
    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected identifier for "class"'
      );
    }
    const typeclassName = tokens[index].value;
    index = index + 1;

    // typeclassName has to be UpperCamelCase
    if (!isUpperCamelCase(typeclassName)) {
      throw this.formatErrorMessage(
        tokens[index],
        "Class name has to be UpperCamelCase"
      );
    }

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);
    env = addEnvValueType(env, {
      variableName: typeclassName,
      type: {
        type: "unknown",
        kind: "Free",
        typeName: typeclassName,
      },
      kind: "type",
    });

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].type === TokenType.LessThan) {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
        inputString: this.inputString,
      });
      index = nextIndex;
      typeParameters = tp;
      regionParameters = rp;
      env = nextEnv;
    }

    // NOTE: `extends` doesn't work for typeclass.
    // Should use `with` instead.
    const functions: TClassFunction[] = [];
    /*
    // extends other class
    const interfaceTypes: TClass[] = [];
    if (tokens[index].type === TokenType.Extends) {
      index = index + 1;

      while (true) {
        const {
          env: nextEnv,
          index: nextIndex,
          typeValue: typeclassType,
        } = synthesizeTypeFromTokens({
          tokens,
          index,
          inputString: this.inputString,
          env,
          parseExpression: this.parseExpression.bind(this),
        });
        if (typeclassType.type !== "Class") {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected class type, but got " + typeToString(typeclassType)
          );
        }
        interfaceTypes.push(typeclassType);
        index = nextIndex;
        env = nextEnv;

        if (tokens[index]?.type === TokenType.Comma) {
          index = index + 1;
          continue;
        } else {
          break;
        }
      }
    }
    /// Add functions from extended typeclasses
    for (const typeclassType of interfaceTypes) {
      for (const func of typeclassType.functions) {
        functions.push(func);
      }
    }
    */

    // Parse class body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for \"class\" body"
      );
    }
    index = index + 1;
    while (true) {
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      if (tokens[index].type === TokenType.Semicolon) {
        index = index + 1;
        continue;
      }

      // NOTE: We don't allow function declaration like `id: (...)=> ...` format in class
      if (
        tokens[index].type === TokenType.Identifier &&
        tokens[index + 1]?.type === TokenType.Colon
      ) {
        throw this.formatErrorMessage(
          tokens[index],
          `Please define functions in "class" like below:

class Show<T> {
  show(x: T): string
}
`
        );
      }

      // Parse function prototype
      const startIndex = index;
      const {
        prototype,
        index: nextIndex,
        env: nextEnv,
      } = this.parsePrototype({
        tokens,
        index,
        env,
        requireFunctionName: true,
        withFunctionBody: true, // NOTE: We need to set it to `true` even though `extern` function has no function body
      });
      index = nextIndex;
      env = nextEnv;
      if (!prototype) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function prototype"
        );
      }
      const functionType = prototype.typeValue;
      if (functionType.typeParameters.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Type parameters are not allowed in class functions as it uses the type parameters defined in the class itself:

${typeToString(functionType)}
`
        );
      }

      // Check if the function has a body
      let functionExpr: FunctionExpr | undefined = undefined;
      if (tokens[index].type === TokenType.LCurlyBracket) {
        const { expr: functionExpr_, index: nextNextIndex } =
          this.parseFunction(tokens, startIndex, env, false, false);
        if (!functionExpr_ || functionExpr_.type !== AstType.Function) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected function body"
          );
        }
        index = nextNextIndex;
        env = functionExpr_.env;
        functionExpr = functionExpr_;
      }

      // functionType.typeParameters = typeParameters; // NOTE: This is wrong
      functions.push({
        name: functionType.functionName!,
        func: functionType,
        functionExpr,
      });
    }

    const typeclassType: TClass = {
      type: "Class",
      kind: "Free",
      typeParameters,
      regionParameters,
      functions,
    };

    // Add to environment
    env = addEnvValueType(
      env,
      {
        variableName: typeclassName,
        type: typeclassType,
        kind: "class",
      },
      -1
    );

    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.Class,
        className: typeclassName,
        typeValue: typeclassType,
        typeArguments: undefined, // Defining class doesn't have type arguments
        env,
        isDefinition: true,
      },
      index,
    };
  }

  private parseTypeclassInstance(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Instance) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "instance" for class instance'
      );
    }

    index = index + 1;
    if (tokens[index].type !== TokenType.Identifier) {
      // FIXME: Allow module access
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for class instance"
      );
    }
    const typeclassName = tokens[index].value;
    index = index + 1;

    // Find the class from env
    const typeclasses = getEnvValueTypesByVariableName(
      env,
      typeclassName,
      "class"
    );
    if (typeclasses.length === 0) {
      throw this.formatErrorMessage(
        tokens[index],
        `Cannot find class "${typeclassName}"`
      );
    } else if (typeclasses.length > 1) {
      throw this.formatErrorMessage(
        tokens[index],
        `Found multiple typeclasses with the same name "${typeclassName}":
- ${typeclasses.map((typeclass) => typeToString(typeclass.type)).join("\n- ")}`
      );
    }
    const typeclassType = typeclasses[0].type as TClass;

    // Parse type arguments
    const typeArguments: Type[] = [];
    if (tokens[index].type === TokenType.LessThan) {
      const {
        index: nextIndex,
        typeArguments: ta,
        env: nextEnv,
      } = synthesizeTypeArgumentsFromTokens({
        tokens,
        index,
        env,
        inputString: this.inputString,
        parseExpression: this.parseExpression.bind(this),
      });
      index = nextIndex;
      typeArguments.push(...ta);
      env = nextEnv;
    }

    // Apply type arguments to typeclass
    const typeclassType_ = applyTypeArgumentsToType(
      typeclassType,
      typeArguments
    ) as TClass;

    // Parse typeclass body
    const functions: TClassFunction[] = [];
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for class instance body"
      );
    }
    index = index + 1;
    while (true) {
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      if (tokens[index].type === TokenType.Semicolon) {
        index = index + 1;
        continue;
      }

      // NOTE: We don't allow function declaration like `id: (...)=> ...` format in typeclass
      if (
        tokens[index].type === TokenType.Identifier &&
        tokens[index + 1]?.type === TokenType.Colon
      ) {
        throw this.formatErrorMessage(
          tokens[index],
          `Please define functions in "class" like below:

class Show<T> {
  show(x: T): string
}
`
        );
      }

      // Parse function prototype
      const startIndex = index;
      const {
        prototype,
        index: nextIndex,
        env: nextEnv,
      } = this.parsePrototype({
        tokens,
        index,
        env,
        requireFunctionName: true,
        withFunctionBody: true, // NOTE: We need to set it to `true` even though `extern` function has no function body
      });
      index = nextIndex;
      env = nextEnv;
      if (!prototype) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function prototype"
        );
      }
      const functionType = prototype.typeValue;
      if (functionType.typeParameters.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Type parameters are not allowed in class functions as it uses the type parameters defined in the class itself:

${typeToString(functionType)}
`
        );
      }

      // Check if the function has a body
      let functionExpr: FunctionExpr | undefined = undefined;
      if (tokens[index].type === TokenType.LCurlyBracket) {
        const { expr: functionExpr_, index: nextNextIndex } =
          this.parseFunction(tokens, startIndex, env, false, false);
        if (!functionExpr_ || functionExpr_.type !== AstType.Function) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected function body"
          );
        }
        index = nextNextIndex;
        env = functionExpr_.env;
        functionExpr = functionExpr_;
      }

      // functionType.typeParameters = typeParameters; // NOTE: This is wrong
      functions.push({
        name: functionType.functionName!,
        func: functionType,
        functionExpr,
      });
    }

    // Check if all functions in class are implemented correctly
    for (const typeclassFunction of typeclassType_.functions) {
      const matchedFunctions = functions.filter(
        (func) => func.name === typeclassFunction.name
      );
      if (matchedFunctions.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Function "${typeclassFunction.name}" is not implemented:
Expected: ${typeToString(typeclassFunction.func)}`
        );
      } else if (matchedFunctions.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Found multiple implementations for function "${
            typeclassFunction.name
          }":
- ${matchedFunctions.map((func) => typeToString(func.func)).join("\n- ")}`
        );
      } else {
        const matchedFunction = matchedFunctions[0];
        if (!checkType(typeclassFunction.func, matchedFunction.func, env)) {
          throw this.formatErrorMessage(
            tokens[index],
            `Mismatched function type:
Expected: ${typeToString(typeclassFunction.func)}
Got:      ${typeToString(matchedFunction.func)}`
          );
        }
      }
    }
    typeclassType_.functions = functions;

    // Add to environment
    env = addEnvValueType(env, {
      variableName: typeclassName,
      type: typeclassType_,
      kind: "value", // NOTE: We need to set it to "value" instead of "class" because we need to use it as a value
    });

    return {
      expr: {
        type: AstType.Class,
        className: typeclassName,
        typeValue: typeclassType_,
        typeArguments,
        env,
        isDefinition: true,
      },
      index,
    };
  }

  private parseEnum(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (tokens[index].type !== TokenType.Enum) {
      throw this.formatErrorMessage(tokens[index], 'Expected "enum"');
    }
    const enumTokenIndex = index;
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for enum"
      );
    }
    const enumName = tokens[index].value;
    index = index + 1;

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);
    env = addEnvValueType(env, {
      variableName: enumName,
      type: {
        type: "unknown",
        kind: "Free",
        typeName: enumName,
      },
      kind: "type",
    });

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].type === TokenType.LessThan) {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
        inputString: this.inputString,
      });
      index = nextIndex;
      typeParameters = tp;
      regionParameters = rp;
      env = nextEnv;
    }

    // Parse userDefinedKind
    let userDefinedKind: TypeKind | undefined = undefined;
    const userDefinedKindTokenIndex = index + 1;
    if (tokens[index].type === TokenType.Colon) {
      index = index + 1;
      userDefinedKind = parseTypeKind(tokens[index]);
      if (!userDefinedKind) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected 'Type', 'Linear' or 'Free'"
        );
      }
      index = index + 1;
    }

    // Parse enum body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for enum body"
      );
    }
    index = index + 1;
    const enumVariants: TEnumVariant[] = [];
    while (true) {
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }
      if (tokens[index].type === TokenType.Comma) {
        index = index + 1;
        continue;
      }

      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for enum value"
        );
      }
      const enumVariantName = tokens[index].value;
      index = index + 1;

      // enumVariantName has to be UpperCamelCase
      if (!isUpperCamelCase(enumVariantName)) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          "Enum variant name has to be UpperCamelCase"
        );
      }

      // Parameter types
      let parameterTypes: TParameterType[] = [];
      if (tokens[index].type === TokenType.LParen) {
        const {
          index: nextIndex,
          parameterTypes: pt,
          env: nextEnv,
        } = synthesizeFunctionParameterTypesFromTokens({
          tokens,
          index,
          env,
          inputString: this.inputString,
          parseExpression: this.parseExpression.bind(this),
          withFunctionBody: false,
        });
        index = nextIndex;
        parameterTypes = pt;
        env = nextEnv;
      }

      enumVariants.push({
        name: enumVariantName,
        parameterTypes,
      });
    }

    if (enumVariants.length === 0) {
      throw this.formatErrorMessage(
        tokens[enumTokenIndex + 1],
        "Enum must have at least one variant"
      );
    }

    // Check if userDefinedKind is valid:
    let kind = getEnumTypeKind(enumVariants);
    if (
      userDefinedKind &&
      userDefinedKind === "Free" &&
      (kind === "Linear" || kind === "Type")
    ) {
      throw this.formatErrorMessage(
        tokens[userDefinedKindTokenIndex],
        `Cannot mix 'Free' type and '${kind}' type`
      );
    } else if (
      userDefinedKind &&
      userDefinedKind === "Linear" &&
      kind === "Type"
    ) {
      throw this.formatErrorMessage(
        tokens[userDefinedKindTokenIndex],
        `Cannot mix 'Linear' type and '${kind}' type`
      );
    } else {
      kind = userDefinedKind ? userDefinedKind : kind;
    }

    const enumType: TEnum = {
      type: "Enum",
      kind,
      enumName,
      typeParameters,
      regionParameters,
      variants: enumVariants,
      selectedVariantName:
        enumVariants.length === 1 ? enumVariants[0].name : undefined,
    };

    // Add to environment
    env = addEnvValueType(
      env,
      {
        variableName: enumName,
        type: enumType,
        kind: "type",
      },
      -1
    );
    env = popEnvFrame(env);

    return {
      expr: {
        type: AstType.Enum,
        enumName,
        typeValue: enumType,
        env,
      },
      index,
    };
  }

  private parseReferenceExpr(
    tokens: Token[],
    index: number,
    env: Environment
  ): ParserReturn {
    if (
      tokens[index].type !== TokenType.BitwiseAnd &&
      tokens[index].type !== TokenType.MutableReference
    ) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '&' or '&!' for reference expression"
      );
    }
    const isMutableReference =
      tokens[index].type === TokenType.MutableReference;
    index = index + 1;

    const { expr, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      false
    );
    index = nextIndex;

    switch (expr.type) {
      case AstType.Variable: {
        const variableName = expr.name;
        const variableValues = getEnvValueTypesByVariableName(
          env,
          variableName,
          "value"
        );
        if (!variableValues.length) {
          throw this.formatErrorMessage(
            tokens[index],
            `Cannot find variable "${variableName}"`
          );
        }
        const variableValue = variableValues[variableValues.length - 1];
        return {
          expr: {
            type: AstType.Reference,
            expr,
            isMutableReference: isMutableReference,
            typeValue: {
              ...(isMutableReference
                ? TypeValues.MutableReference
                : TypeValues.Reference),
              typeParameters: [
                {
                  type: "TypeParameter",
                  kind: "Type",
                  name: "T",
                  appliedType: variableValue.type,
                },
              ],
              regionParameters: [
                {
                  type: "RegionParameter",
                  kind: "Region",
                  name: "R",
                  appliedRegion: {
                    type: "Region",
                    kind: "Region",
                    regionId: getEnvCurrentRegionId(env),
                  },
                },
              ],
            },
            env,
          },
          index,
        };
      }
      default: {
        throw this.formatErrorMessage(
          tokens[index],
          `Unable to create reference for:
${exprToString(expr)}`
        );
      }
    }
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
    env: Environment,
    isWithStatement: boolean
  ): ParserReturn {
    const { expr, index: nextIndex } = this.parsePrimary(
      tokens,
      index,
      env,
      isWithStatement
    );
    if (!expr) {
      return { expr, index: nextIndex };
    } else {
      return this.parseBinOpRHS(
        tokens,
        0,
        expr,
        nextIndex,
        env,
        isWithStatement
      );
    }
  }

  public parse(
    tokens: Token[],
    env: Environment = {
      functionDeclarationFrameLevel: -1,
      frames: [
        {
          regionId: getNewRegionId(),
          values: [],
        },
      ],
      freeVariables: [],
    }
  ): Expr[] {
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
        case TokenType.Let: {
          const { expr, index: nextIndex } = this.parseLetAssignment(
            tokens,
            index,
            env,
            false
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Function: {
          const { expr, index: nextIndex } = this.parseFunction(
            tokens,
            index,
            env,
            false
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Extern: {
          const { expr, index: nextIndex } = this.parseExtern(
            tokens,
            index,
            env
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Type: {
          const { expr, index: nextIndex } = this.parseTypeAlias(
            tokens,
            index,
            env
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Class: {
          const { expr, index: nextIndex } = this.parseClass(
            tokens,
            index,
            env
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Instance: {
          const { expr, index: nextIndex } = this.parseTypeclassInstance(
            tokens,
            index,
            env
          );
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Enum: {
          const { expr, index: nextIndex } = this.parseEnum(tokens, index, env);
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
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
    return exprs.filter((expr) => expr.type !== AstType.Ignore);
  }
}
