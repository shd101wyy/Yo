/* eslint-disable no-constant-condition */
/**
 * Construct an AST parser from a grammar.
 */

import * as fs from "fs";
import * as path from "path";
import {
  AstType,
  BlockExpr,
  CallFunctionExpr,
  Destructuring,
  Expr,
  ExternVariable,
  FunctionExpr,
  IfCase,
  LetAssignmentExpr,
  MatchCase,
  exprToString,
} from "./ast";
import {
  Environment,
  ReferedVariable,
  ValueType,
  addEnvFreeVariable,
  addEnvOperatorPrecedence,
  addEnvValueType,
  copyEnvironment,
  createNewEnv,
  createTopLevelEnv,
  decrementVariableReferenceCount,
  emptyToken,
  generateNewTempVariableName,
  generateValueTypeId,
  getEnvCurrentFrameLevel,
  getEnvInfixOperatorPrecedence,
  getEnvValueTypesByVariableName,
  increaseEnvVariableReferenceCount,
  mergeAndCheckEnv,
  popEnvFrame,
  pushEnvFrame,
  setEnvVariableAsConsumed,
  updateExistingValueType,
} from "./env";
import { formatErrorMessage, formatErrorMessages } from "./error";
import { tokenize } from "./lexer";
import * as logger from "./logger";
import { isUpperCamelCase } from "./naming-checker";
import { OperatorPrecedence, stringIsOperator } from "./operator";
import { Token, TokenType } from "./token";
import {
  ParseExpression,
  ParserReturn,
  Region,
  RegionKind,
  TClass,
  TClassFunction,
  TEffect,
  TEffectOperation,
  TEnum,
  TEnumVariant,
  TFunction,
  TModule,
  TParameterType,
  TRecord,
  TRegionParameter,
  TTypeConstructor,
  TTypeParameter,
  Type,
  TypeKind,
  TypeValues,
  applyTypeAndRegionArgumentsToClass,
  applyTypeAndRegionArgumentsToEffect,
  applyTypeAndRegionArgumentsToType,
  checkEffect,
  checkFunctionEffects,
  checkType,
  convertPrimitiveToType,
  effectsToString,
  emptyFunctionThatHasMoreEffects,
  getEnumTypeKind,
  getFunctionArgumentsInOrder,
  getFunctionsOfCallerFromEnv,
  parseTypeKind,
  synthesizeFunctionParameterTypesFromTokens,
  synthesizeFunctionTypeFromTokens,
  synthesizeRecordType,
  synthesizeTypeAndRegionArgumentsFromTokens,
  synthesizeTypeAndRegionParametersFromTokens,
  synthesizeTypeFromTokens,
  synthesizeTypes,
  typeIsFunctionTypeThatReturnsPromise,
  typeIsPromise,
  typeToString,
} from "./type-checker";

interface ParserData {
  callSites: TFunction[];
  // resumeType?: Type;
  // abortType?: Type;
  // abortTokenIndex?: number;
}

export default class Parser {
  private modulePath: string;
  private stdPath: string;
  private inputString: string;
  private tokens: Token[];
  private ast: Expr[];
  private env: Environment;
  private loadModule: (modulePath: string) => TModule;

  constructor({
    modulePath,
    stdPath,
    loadModule,
    printTokens,
    printAst,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: (modulePath: string) => TModule;
    printTokens?: boolean;
    printAst?: boolean;
  }) {
    logger.debug(`= parser: ${modulePath}`);
    this.modulePath = modulePath;
    this.stdPath = stdPath;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }

    this.loadModule = loadModule;
    this.inputString = fs.readFileSync(
      modulePath.replace(/^file:\/\//, ""), // NOTE: We only support local file for now
      "utf-8"
    );
    this.tokens = tokenize(this.inputString);
    if (printTokens) {
      console.log(`= lexer: `, this.tokens);
    }

    const { ast, env } = this.parse(this.tokens);
    this.ast = ast;
    this.env = env;

    if (printAst) {
      console.log("\n= parser: ");
      this.ast.map((expr) => console.log(exprToString(expr)));
      console.log("\n= parser end\n");
    }
  }

  private formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
  }

  private parseNumberExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
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
              permission: "own",
              value: token.value,
              tag: "primitive",
            },
            env,
            token: tokens[index],
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
              permission: "own",
            },
            env,
            token: tokens[index],
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
              type: "f64",
              kind: "Free",
              permission: "own",
              value: token.value,
              tag: "primitive",
            },
            env,
            token: tokens[index],
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
              type: "f64",
              kind: "Free",
              permission: "own",
            },
            env,
            token: tokens[index],
          },
          index: index + 1,
        };
      }
    } else {
      throw this.formatErrorMessage(token, "Expected number");
    }
  }

  private parseCharactorExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
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
              permission: "own",
              value: token.value,
              tag: "primitive",
            },
            env,
            token: tokens[index],
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
              permission: "own",
            },
            env,
            token: tokens[index],
          },
          index: index + 1,
        };
      }
    } else {
      throw this.formatErrorMessage(token, "Expected charactor");
    }
  }

  private parseStringExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
    const token = tokens[index];
    if (token.type === TokenType.String) {
      return {
        expr: {
          type: AstType.Value,
          tag: "primitive",
          value: token.value,
          typeValue: {
            type: "string",
            kind: "Free",
            permission: "own",
            tag: "primitive",
            value: token.value,
          },
          env,
          token: tokens[index],
        },
        index: index + 1,
      };

      /*
      const end: PrimitiveValueExpr = {
        type: AstType.Value,
        tag: "primitive",
        value: "\0",
        typeValue: {
          type: "char",
          kind: "Free",
        },
        token: tokens[index],
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
          token: tokens[index],
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
                token: tokens[index],
              };
              return charValue;
            })
            .concat(end),
        },
        index: index + 1,
      };
      */
    } else {
      throw this.formatErrorMessage(token, "Expected string");
    }
  }

  private parseBooleanExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
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
              permission: "own",
              value: token.value,
              tag: "primitive",
            },
            token: tokens[index],
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
              permission: "own",
            },
            token: tokens[index],
          },
          index: index + 1,
        };
      }
    } else {
      throw this.formatErrorMessage(token, "Expected boolean");
    }
  }

  private parseSliceOrTupleExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const token = tokens[index];
    if (token.type !== TokenType.LBracket) {
      throw this.formatErrorMessage(token, "Expected '[' for slice");
    }
    const sliceTokenIndex = index;
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
        const { expr, index: nextIndex } = this.parseExpression({
          tokens,
          index,
          env,
          caller,
          parserData,
        });
        if (!expr) {
          return { expr, index: nextIndex };
        }
        values.push(expr);
        index = nextIndex;
        env = expr.env;

        // Consume the value if necessary
        const { env: nextEnv } = this.setVariableAsConsumed(env, expr);
        env = nextEnv;

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
        permission: "own",
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
        token: tokens[sliceTokenIndex],
      },
      index,
    };
  }

  // TODO: Implement curly bracket expression
  // it could be either the RecordExpr or BlockExpr
  private parseCurlyBracketExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    try {
      return this.parseRecordExpr({ tokens, index, env, caller, parserData });
    } catch (error) {
      logger.debug(error);
      return this.parseBlockExpressions({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
    }
  }

  private parseRecordExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket || !tokens[index + 1]) {
      throw this.formatErrorMessage(tokens[index], "Expected '{' for record");
    }
    const recordTokenIndex = index;
    index = index + 1;
    if (tokens[index].type === TokenType.RCurlyBracket) {
      return {
        expr: {
          type: AstType.Value,
          tag: "record",
          typeValue: {
            type: "Record",
            kind: "Free",
            permission: "own",
            properties: [],
          },
          env,
          properties: [],
          token: tokens[recordTokenIndex],
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
        const { expr, index: nextIndex } = this.parseExpression({
          tokens,
          index,
          env,
          caller,
          parserData,
        });
        if (!expr) {
          return { expr, index: nextIndex };
        }
        properties.push({ name: propertyName, value: expr });
        index = nextIndex;
        env = expr.env;

        // Consume the value if necessary
        const { env: nextEnv } = this.setVariableAsConsumed(env, expr);
        env = nextEnv;

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
          token: tokens[recordTokenIndex],
        },
        index,
      };
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected invalid record");
    }
  }

  private parsePropertyAccessExpr({
    expr,
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    expr: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Dot) {
      throw this.formatErrorMessage(tokens[index], "Expected '.'");
    }
    const dotTokenIndex = index;

    // parse properties
    index = index + 1;
    const token = tokens[index];
    if (!token) {
      throw this.formatErrorMessage(token, "Expected property name");
    }

    // Check if it's a valid property in the record
    let callerType = expr.typeValue;
    let referenceType: TTypeConstructor | undefined = undefined;

    if (
      // Reference or MutableReference
      callerType.type === "TypeConstructor" &&
      (callerType.name === "&" || callerType.name === "&!") &&
      callerType.typeParameters[0].appliedType
    ) {
      referenceType = callerType;
      callerType = callerType.typeParameters[0].appliedType;
    }
    // It's record type
    if (
      callerType.type === "TypeConstructor" &&
      callerType.typeValue.type === "Record"
    ) {
      callerType = callerType.typeValue;
    }

    if (callerType.type === "Record") {
      const property = callerType.properties.find(
        (property) => property.name === token.value
      );
      if (!property) {
        throw this.formatErrorMessage(
          token,
          `Cannot find property '${token.value}' in record:\n${typeToString(
            callerType
          )}`
        );
      }

      const returnType: Type = referenceType
        ? {
            ...referenceType,
            typeParameters: referenceType.typeParameters.map(
              (typeParameter) => ({
                ...typeParameter,
                appliedType: property.type,
              })
            ),
          }
        : property.type;

      return {
        expr: {
          type: AstType.PropertyAccess,
          expr: expr,
          propertyName: property.name,
          typeValue: returnType,
          isMutable: "isMutable" in expr ? expr.isMutable : false,
          env,
          token: tokens[dotTokenIndex],
        },
        index: index + 1,
      };
    }
    // FIXME: Now calling function from typeclass like
    //  `Id.id()` is not supported
    /* else if (callerType === "Class") {
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
            isMutable: false,
            env,
            token: tokens[dotTokenIndex],
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
    }*/
    else if (callerType.type === "Enum") {
      const propertyName = token.value;
      const selectedVariantName = callerType.selectedVariantName;
      if (selectedVariantName) {
        const variant = callerType.variants.find(
          (variant) => variant.name === selectedVariantName
        );
        if (!variant) {
          throw this.formatErrorMessage(
            token,
            `Cannot find variant '${selectedVariantName}' in enum:\n${typeToString(
              callerType
            )}`
          );
        }

        // Check if propertyName in variant.parameterTypes
        const parameterType = variant.parameterTypes.find(
          (parameterType) => parameterType.name === propertyName
        );
        if (!parameterType) {
          throw this.formatErrorMessage(
            token,
            `Cannot find property '${propertyName}' in enum variant '${selectedVariantName}'`
          );
        } else {
          const isMutable = "isMutable" in expr ? expr.isMutable : false;
          return {
            expr: {
              type: AstType.PropertyAccess,
              expr: expr,
              propertyName: propertyName,
              typeValue: parameterType.type,
              isMutable,
              env,
              token: tokens[dotTokenIndex],
            },
            index: index + 1,
          };
        }
      } else {
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
                token: tokens[dotTokenIndex],
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
                isMutable: false,
                env,
                token: tokens[dotTokenIndex],
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
    }

    // Check if it's a valid function that takes
    // the `expr` as the first argument
    callerType = expr.typeValue;
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
      const matchedFunctionErrors: Error[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallFunctionExpr({
              callee: {
                type: AstType.Variable,
                variableName: functionName,
                variableId: functionType.id,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
                isMutable: false,
                env,
                token: tokens[index - 1],
              },
              tokens,
              index: index + 1,
              env,
              caller,
              firstArgument: expr,
              parserData,
            })
          );
          parsedFunctions.push(functionType);
        } catch (error) {
          // Ignore the error
          matchedFunctionErrors.push(error);
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
        `Expected property name, but got "${token.value}"`
      );
    }
  }

  private parseAssignmentExpr({
    lhs,
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    lhs: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(tokens[index], "Expected '='");
    }
    const lhsTokenIndex = index - 1;
    index = index + 1;
    const { expr: rhs, index: nextIndex } = this.parseExpression({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    if (!rhs) {
      throw this.formatErrorMessage(tokens[index], "Expected expression");
    }
    index = nextIndex;
    env = rhs.env;

    // Check if the type of rhs matches the type of lhs
    if (!checkType(lhs.typeValue, rhs.typeValue, env)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Mismatched types:
LHS: ${typeToString(lhs.typeValue)}
${exprToString(lhs)}

RHS: ${typeToString(rhs.typeValue)}
${exprToString(rhs)}
`
      );
    }

    let isMutable = false; // TODO: Check if it's mutable.
    if (lhs.type === AstType.Variable) {
      isMutable = lhs.isMutable;
    } else if (
      lhs.type === AstType.IndexAccess ||
      lhs.type === AstType.PropertyAccess
    ) {
      isMutable = lhs.isMutable;
    }
    if (!isMutable) {
      throw this.formatErrorMessage(
        tokens[lhsTokenIndex],
        `Expected mutable left-hand side for assignment:
${exprToString(lhs)}
`
      );
    }

    const resetConsumedVariable = false;
    /*
    if (lhs.type !== AstType.Dereference) {
      // NOTE: We don't need to check a dereference to an mutable reference
      // Check if lhs can be created as mutable reference
      const { resetConsumedVariable: reset, env: nextEnv } =
        this.trySettingVariableAsReference({
          env,
          expr: lhs,
          isMutableReference: true,
          isForAssignment: true,
        });
      resetConsumedVariable = !!reset;
      env = nextEnv;
    }
    */

    // Consume RHS value if necessary
    const { env: nextNextEnv /*referedVariable: nextReferedVariable*/ } =
      this.setVariableAsConsumed(env, rhs);
    env = nextNextEnv;

    // Generate temp variable for holding the old value of lhs
    const valueType = resetConsumedVariable ? TypeValues.unit : rhs.typeValue;
    const { env: nextNextNextEnv, value: tempVariable } =
      this.generateTempVariableForHoldingValue({
        env,
        token: tokens[lhsTokenIndex],
        valueType,
      });
    env = nextNextNextEnv;

    return {
      expr: {
        type: AstType.Assignment,
        left: lhs,
        right: rhs,
        env,
        typeValue: valueType,
        token: tokens[lhsTokenIndex],
        tempVariableName: tempVariable.variableName,
      },
      index,
    };
  }

  private parseIndexAccessExpr({
    expr,
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    expr: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LBracket) {
      throw this.formatErrorMessage(tokens[index], "Expected '['");
    }
    const bracketTokenIndex = index;
    const indexes: Expr[] = [];
    let valueType = expr.typeValue;
    index = index + 1;
    while (true) {
      const token = tokens[index];
      if (!token) {
        throw this.formatErrorMessage(token, "Expected ']'");
      }
      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
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
        isMutable: "isMutable" in expr ? expr.isMutable : false,
        env,
        token: tokens[bracketTokenIndex],
      },
      index,
    };
  }

  private makeParseExpression({
    caller,
    parserData,
  }: {
    caller: TFunction;
    parserData: ParserData;
  }): ParseExpression {
    return ({ tokens, index, env }) => {
      return this.parseExpression({ tokens, index, env, caller, parserData });
    };
  }

  private parseAnonymousFunction({
    tokens,
    index,
    env,
    caller,
    parserData,
    effectOperationAbortType,
    functionName,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    effectOperationAbortType?: Type;
    functionName?: string;
  }): ParserReturn {
    const startIndex = index;
    const currentFrameLevel = getEnvCurrentFrameLevel(env);
    // parse function
    const oldEnv = env;
    env = copyEnvironment(env, currentFrameLevel, []);
    env = pushEnvFrame(env);

    let {
      typeValue: functionType,
      // eslint-disable-next-line prefer-const
      env: nextEnv,
      // eslint-disable-next-line prefer-const
      index: nextIndex,
    } = synthesizeFunctionTypeFromTokens({
      tokens,
      index,
      env,
      parseExpression: this.makeParseExpression({ caller, parserData }),
      withFunctionBody: true,
      functionName,
    });
    env = nextEnv;
    index = nextIndex;

    // NOTE: If it's top-level function, we need to set the env to the top-level frame
    if (!functionType.isClosure) {
      // Parse the type again with new env that only
      // contains the top-level frame
      let newEnv = createTopLevelEnv(oldEnv);
      newEnv = pushEnvFrame(newEnv);
      const { typeValue: newFunctionType, env: nextNextEnv } =
        synthesizeFunctionTypeFromTokens({
          tokens,
          index: startIndex,
          env: newEnv,
          parseExpression: this.makeParseExpression({ caller, parserData }),
          withFunctionBody: true,
          functionName,
        });
      env = nextNextEnv;
      functionType = newFunctionType;
    }

    const promiseReturnType =
      typeIsFunctionTypeThatReturnsPromise(functionType);
    const newParserData: ParserData = {
      callSites: [...parserData.callSites, functionType],
      // abortType: isFunctionReturningPromise ? undefined : parserData.abortType,
      // abortTokenIndex: isFunctionReturningPromise
      //   ? undefined
      //   : parserData.abortTokenIndex,
    };

    // Extract effect operations
    if (functionType.effects.length > 0) {
      functionType.effects.forEach((effect) => {
        effect.operations.forEach(({ name, func }) => {
          const { env: nextEnv } = addEnvValueType({
            env,
            valueType: {
              variableName: name,
              type: func,
              kind: "value",
              isMutable: false,
              token: emptyToken,
            },
          });
          env = nextEnv;
        });
      });
    }

    // Add "resume" and "abort" functions if the function returns promise
    if (promiseReturnType) {
      const resumeType = promiseReturnType.typeParameters[0].appliedType;
      if (!resumeType) {
        throw this.formatErrorMessage(
          tokens[startIndex],
          `Expected resume type`
        );
      }
      const resumeFunc = this.constructResumeFunctionType(resumeType, env);
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: "resume",
          type: resumeFunc,
          kind: "value",
          isMutable: false,
          token: tokens[startIndex],
        },
      });
      env = nextEnv;

      if (effectOperationAbortType) {
        const abortFunc = this.constructAbortFunctionType(
          effectOperationAbortType,
          env
        );
        const { env: nextEnv } = addEnvValueType({
          env,
          valueType: {
            variableName: "abort",
            type: abortFunc,
            kind: "value",
            isMutable: false,
            token: tokens[startIndex],
          },
        });
        env = nextEnv;
      }
    }

    // Parse body
    const { expr: body, index: nextNextIndex } = this.parseBlockExpressions({
      tokens,
      index,
      env: env, // FIXME: For top-level function, it should only be able to access the top level frame.
      caller: functionType,
      parserData: newParserData,
    });
    env = body.env;
    index = nextNextIndex;

    // Check function body return type matches
    // the function type return type
    // NOTE: `control` effect operation can only return () type.
    const expectedReturnType = promiseReturnType
      ? TypeValues.unit
      : functionType.returnType;
    if (!checkType(expectedReturnType, body.typeValue, env)) {
      throw formatErrorMessages({
        inputString: this.inputString,
        modulePath: this.modulePath,
        tokenAndErrorList: [
          {
            token: body.token,
            errorMessage: `Mismatched return type:
              Prototype: ${typeToString(expectedReturnType)}
              Returned : ${typeToString(body.typeValue)}${
                promiseReturnType
                  ? `\nPlease note function that returns a Promise requires () as its real return type.  `
                  : ""
              }
              `,
          },
          {
            token: body.exprs[body.exprs.length - 1].token,
            errorMessage: `Returned value:`,
          },
        ],
      });
    }
    functionType.freeVariables = env.freeVariables;

    // Check if the last expression of body is `recur`
    const lastExpr = body.exprs[body.exprs.length - 1];
    if (lastExpr && lastExpr.type === AstType.Recur) {
      lastExpr.isLastExpr = true;
    } else if (
      lastExpr &&
      (lastExpr.type === AstType.If || lastExpr.type === AstType.Match)
    ) {
      const cases = lastExpr.cases;
      // Check if any of the cases has `recur` in the last expression.
      for (const case_ of cases) {
        const caseBody = case_.body;
        const caseLastExpr = caseBody.exprs[caseBody.exprs.length - 1];
        if (caseLastExpr && caseLastExpr.type === AstType.Recur) {
          caseLastExpr.isLastExpr = true;
        }
      }
    }

    return {
      index,
      expr: {
        type: AstType.Function,
        body,
        env: copyEnvironment(
          functionType.isClosure ? popEnvFrame(env) : oldEnv,
          oldEnv.functionDeclarationFrameLevel,
          oldEnv.freeVariables
        ),
        frameLevel: currentFrameLevel,
        token: tokens[startIndex],
        typeValue: functionType,
      },
    };
  }

  private constructResumeFunctionType(
    resumeType: Type,
    env: Environment
  ): TFunction {
    const func: TFunction = {
      type: "Function",
      kind: "Free",
      permission: "own",
      functionId: generateValueTypeId(env, "resume"),
      effects: [],
      // hasMoreEffects: false,
      typeParameters: [],
      regionParameters: [],
      returnType: TypeValues.unit,
      parameterTypes: [
        {
          name: "value",
          parameterId: generateValueTypeId(env, "value"),
          type: resumeType,
          isMutable: false,
          defaultValue: null,
        },
      ],
      isClosure: false,
      frameLevel: 0,
    };
    return func;
  }

  private constructAbortFunctionType(
    abortType: Type,
    env: Environment
  ): TFunction {
    const func: TFunction = {
      type: "Function",
      kind: "Free",
      permission: "own",
      functionId: generateValueTypeId(env, "abort"),
      effects: [],
      // hasMoreEffects: false,
      typeParameters: [],
      regionParameters: [],
      returnType: TypeValues.unit,
      parameterTypes: [
        {
          name: "value",
          parameterId: generateValueTypeId(env, "value"),
          type: abortType,
          isMutable: false,
          defaultValue: null,
        },
      ],
      isClosure: false,
      frameLevel: 0,
    };
    return func;
  }

  /**
   * parenexpr ::= "(" expr ")"
   * @param tokens
   * @param index
   * @returns
   */
  private parseParenExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(tokens[index], "Expected left paren");
    }
    if (
      tokens[index + 1]?.type === TokenType.RParen &&
      tokens[index + 2]?.type !== TokenType.FatArrow &&
      tokens[index + 2]?.type !== TokenType.FunctionArrow
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
            permission: "own",
          },
          env,
          token: tokens[index],
        },
        index: index + 2,
      };
    }

    const rParenIndex = this.findTokenIndexForRBracket(tokens, index);
    if (
      // Anonymous function
      rParenIndex > 0 &&
      (tokens[rParenIndex + 1].type === TokenType.FatArrow ||
        tokens[rParenIndex + 1].type === TokenType.FunctionArrow)
    ) {
      const { expr, index: nextIndex } = this.parseAnonymousFunction({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      if (expr) {
        return { expr, index: nextIndex };
      } else {
        throw new Error("Failed to parse as anonymouse function");
      }
    } else {
      const returnValue = this.parseExpression({
        tokens,
        index: index + 1,
        env,
        caller,
        parserData,
      });
      let expr = returnValue.expr;
      const nextIndex = returnValue.index;
      if (!expr) {
        return { expr, index: nextIndex };
      }
      index = nextIndex;

      if (tokens[index].type === TokenType.Assign) {
        const { expr: rhs, index: nextNextIndex } = this.parseAssignmentExpr({
          lhs: expr,
          tokens,
          index,
          env: expr.env,
          caller,
          parserData,
        });
        expr = rhs;
        index = nextNextIndex;
      }

      if (tokens[index].type !== TokenType.RParen) {
        throw this.formatErrorMessage(tokens[index], "Expected right paren");
      }
      return { expr, index: index + 1 };
    }
  }

  private parseFunctionCallArguments({
    /**
     * Function being called
     */
    calleeType,
    tokens,
    index,
    env,
    caller,
    parserData,
    /**
     * The first argument being passed to the function
     */
    firstArgument,
  }: {
    calleeType: TFunction;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    firstArgument?: Expr;
  }): {
    index: number;
    typeArguments: Type[];
    functionArguments: Expr[];
    calleeTypeValue: TFunction;
    env: Environment;
  } {
    let calleeTypeValue = calleeType;

    // type arguments
    let typeArguments: Type[] = [];
    if (tokens[index]?.value === "<") {
      const {
        typeArguments: nextTypeArguments,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeAndRegionArgumentsFromTokens({
        tokens,
        index: index,
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
      });
      typeArguments = nextTypeArguments;
      index = nextIndex;
      env = nextEnv;
    }

    const functionArguments: Expr[] = [];
    if (firstArgument) {
      functionArguments.push(firstArgument);
    }

    let parsedNormalArguments = false;
    while (true) {
      // Try parsing as anonymous function
      try {
        const { expr, index: nextIndex } = this.parseAnonymousFunction({
          tokens,
          index,
          env,
          caller,
          parserData,
        });
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
              type: TokenType.FatArrow,
              value: "=>",
              position: tokens[index].position,
            },
            ...tokens.slice(index),
          ];
          const diffSize = newTokens.length - tokens.length;
          const { expr, index: nextIndex } = this.parseAnonymousFunction({
            tokens: newTokens,
            index,
            env,
            caller,
            parserData,
          });
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
                this.parseExpression({
                  tokens,
                  index: index + 2,
                  env,
                  caller,
                  parserData,
                });
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
                variableId: "", // FIXME: Is this correct?
                isMutable: false, // NOTE: This is not used.
                right: defaultParameterValueExpr,
                typeValue: TypeValues.unit,
                variableType: defaultParameterValueExpr.typeValue,
                frameLevel: getEnvCurrentFrameLevel(env),
                env,
                token: tokens[index],
              };
              functionArguments.push(parameterAssignmentExpr);
              index = nextIndex;
            } else {
              const { expr, index: nextIndex } = this.parseExpression({
                tokens,
                index,
                env,
                caller,
                parserData,
              });
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

    // logger.debug(JSON.stringify(calleeTypeValue));
    const {
      functionArguments: functionArgumentsInOrder,
      functionTypeArguments: functionTypeArgumentsInOrder,
      functionRegionArguments: functionRegionArgumentsInOrder,
    } = getFunctionArgumentsInOrder(
      calleeTypeValue,
      calleeTypeValue.parameterTypes,
      functionArguments,
      typeArguments,
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
              typeToString(parameter.type, { hideTypeParameterKind: true })
          )
          .join(", ")})
Got:      (${functionArguments
          .map((arg) => {
            return typeToString(arg.typeValue, { hideTypeParameterKind: true });
          })
          .join(", ")})`
      );
    }
    if (!functionTypeArgumentsInOrder || !functionRegionArgumentsInOrder) {
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
      const typeValue_ = applyTypeAndRegionArgumentsToType({
        env,
        type: calleeTypeValue,
        typeArguments: functionTypeArgumentsInOrder,
        regionArguments: functionRegionArgumentsInOrder,
        regionParameterToRegionArgumentMap: {},
        typeParameterToTypeArgumentMap: {},
      });
      if (typeValue_.type !== "Function") {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected function for call expression"
        );
      } else {
        calleeTypeValue = typeValue_;
      }
    }

    // Set variable as consumed if necessary
    for (let i = 0; i < functionArgumentsInOrder.length; i++) {
      const functionParameter = calleeTypeValue.parameterTypes[i];
      if (functionParameter.type.permission === "own") {
        const { env: nextEnv } = this.setVariableAsConsumed(
          env,
          functionArgumentsInOrder[i]
        );
        env = nextEnv;
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

  private generateTempVariableForHoldingValue({
    env,
    valueType,
    token,
    referedVariable,
    deltaFrame,
  }: {
    env: Environment;
    valueType: Type;
    token: Token;
    referedVariable?: ReferedVariable;
    deltaFrame?: number;
  }): {
    env: Environment;
    value: ValueType;
  } {
    const tempVariableName = generateNewTempVariableName(env);
    const { env: nextEnv, value } = addEnvValueType({
      env,
      valueType: {
        variableName: tempVariableName,
        type: valueType,
        kind: "value",
        isMutable: false,
        token,
        referedVariable,
      },
      deltaFrame: deltaFrame ?? 0,
    });

    return {
      value,
      env: nextEnv,
    };
  }

  private parseCallFunctionExpr({
    callee,
    tokens,
    index,
    env,
    caller,
    parserData,
    firstArgument,
  }: {
    callee: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    firstArgument?: Expr;
  }): ParserReturn {
    const startIndex = index;
    const calleeType = callee.typeValue;
    if (calleeType.type !== "Function") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected function for call expression"
      );
    }

    const {
      index: nextIndex,
      env: nextEnv,
      functionArguments,
      calleeTypeValue,
    } = this.parseFunctionCallArguments({
      calleeType: calleeType,
      tokens,
      index,
      env,
      caller,
      parserData,
      firstArgument,
    });
    index = nextIndex;
    env = nextEnv;

    // Check function effects
    if (!checkFunctionEffects(calleeTypeValue, caller, env)) {
      // NOTE: This order matters ^^^
      throw this.formatErrorMessage(
        tokens[startIndex],
        `Mismatched effects:
Caller  : ${effectsToString(caller.effects)}
Callee  : ${effectsToString(calleeTypeValue.effects)}
`
      );
    }

    // save the return value to a temporary variable
    const returnType = calleeTypeValue.returnType;
    const { env: nextNextEnv, value: tempVariable } =
      this.generateTempVariableForHoldingValue({
        env,
        token: tokens[startIndex],
        valueType: returnType,
      });
    env = nextNextEnv;

    callee.typeValue = calleeTypeValue;
    return {
      expr: {
        type: AstType.CallFunction,
        callee,
        functionArguments,
        typeValue: returnType,
        env,
        token: tokens[startIndex],
        tempVariableName: tempVariable.variableName,
      },
      index,
    };
  }

  private parseCallEnumExpr({
    callee,
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    callee: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const startIndex = index;
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
        const { expr, index: nextIndex } = this.parseExpression({
          tokens,
          index,
          env,
          caller,
          parserData,
        });
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
      functionRegionArguments: variantRegionArgumentsInOrder,
    } = getFunctionArgumentsInOrder(
      calleeTypeValue,
      selectedVariant.parameterTypes,
      variantArguments,
      appliedTypeArguments,
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
              typeToString(parameter.type, { hideTypeParameterKind: true })
          )
          .join(", ")})
Got:      (${variantArguments
          .map((arg) => {
            return typeToString(arg.typeValue, { hideTypeParameterKind: true });
          })
          .join(", ")})`
      );
    }

    if (!variantTypeArgumentsInOrder || !variantRegionArgumentsInOrder) {
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

    const enumType: TEnum = applyTypeAndRegionArgumentsToType({
      env,
      type: { ...calleeTypeValue },
      typeArguments: variantTypeArgumentsInOrder,
      regionArguments: variantRegionArgumentsInOrder,
      typeParameterToTypeArgumentMap: {},
      regionParameterToRegionArgumentMap: {},
    }) as TEnum;

    return {
      expr: {
        type: AstType.CallEnum,
        variantArguments: variantArgumentsInOrder as Expr[],
        typeValue: enumType,
        env,
        token: tokens[startIndex],
      },
      index,
    };
  }

  /*
  // NOTE: Let's use `match` for now
  private parseIsOperatorExpr(
    enumExpr: Expr,
    tokens: Token[],
    index: number,
    env: Environment,
    caller: TFunction
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
    const isTokenIndex = index;
    index = index + 1;

    const { expr: targetEnumExpr, index: nextIndex } = this.parseExpression(
      tokens,
      index,
      env,
      caller
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
        token: tokens[isTokenIndex],
      },
      index,
    };
  }
  */

  /**
   * identifierexpr
   *   ::= identifier
   *   ::= identifier "(" expression* ")" # Call
   * @param tokens
   * @param index
   */
  private parseIdentifierExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    let identifierTokenIndex = index;
    let identifier = tokens[index].value;

    if (
      tokens[index].type === TokenType.LParen &&
      tokens[index + 1]?.type === TokenType.Operator &&
      tokens[index + 2]?.type === TokenType.RParen
    ) {
      identifierTokenIndex = index + 1;
      identifier = tokens[index + 1].value;
      index = index + 2;
    }

    // Check if variable is defined
    const valueTypes = [
      ...getEnvValueTypesByVariableName(env, identifier, "value"),
      ...getEnvValueTypesByVariableName(env, identifier, "class"),
      ...getEnvValueTypesByVariableName(env, identifier, "type"),
    ];
    if (valueTypes.length === 0) {
      throw this.formatErrorMessage(
        tokens[identifierTokenIndex],
        `Unbounded variable \`${identifier}\``
      );
    }
    const matchedFunctions = valueTypes.filter(
      (valueType) => valueType.type.type === "Function"
    );
    const matchedFunctionErrors: Error[] = [];
    const matchedTypeclasses = valueTypes.filter(
      (valueType) => valueType.class && valueType.kind === "class"
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
          tokens[identifierTokenIndex],
          `Ambiguous typeclasses "${identifier}"
Found possible typeclasses:
- ${matchedTypeclasses
            .map((typeclassType) => typeToString(typeclassType.type))
            .join("\n- ")}
          `
        );
      } else {
        const typeclass = matchedTypeclasses[0];
        const class_ = typeclass.class;
        if (!class_) {
          throw this.formatErrorMessage(
            tokens[identifierTokenIndex],
            `Expected class, but got ${typeToString(typeclass.type)}`
          );
        }
        let typeArguments: Type[] = [];
        let regionArguments: Region[] = [];
        if (tokens[index + 1]?.value === "<") {
          const {
            typeArguments: nextTypeArguments,
            regionArguments: nextRegionArguments,
            index: nextIndex,
            env: nextEnv,
          } = synthesizeTypeAndRegionArgumentsFromTokens({
            tokens,
            index: index + 1,
            env,
            parseExpression: this.makeParseExpression({ caller, parserData }),
          });
          typeArguments = nextTypeArguments;
          regionArguments = nextRegionArguments;
          index = nextIndex;
          env = nextEnv;
        } else {
          index = index + 1;
        }
        const newTypeclassType = applyTypeAndRegionArgumentsToClass({
          class_: class_,
          env,
          typeArguments,
          regionArguments,
          typeParameterToTypeArgumentMap: {},
          regionParameterToRegionArgumentMap: {},
        });

        return {
          expr: {
            type: AstType.Class,
            typeValue: TypeValues.unit,
            class: newTypeclassType,
            env,
            token: tokens[identifierTokenIndex],
          },
          index,
        };
      }
    }

    // Check if it's an enum
    if (matchedEnums.length > 0) {
      /*
      if (matchedEnums.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous enum "${identifier}"
Found possible enums:
- ${matchedEnums.map((enumType) => typeToString(enumType.type)).join("\n- ")}
          `
        );
      } else {
      */
      const enumValue = matchedEnums[matchedEnums.length - 1];
      const enumType = enumValue.type as TEnum;
      let typeArguments: Type[] = [];
      const enumTokenIndex = index;
      if (tokens[index + 1]?.value === "<") {
        const {
          typeArguments: nextTypeArguments,
          index: nextIndex,
          env: nextEnv,
        } = synthesizeTypeAndRegionArgumentsFromTokens({
          tokens,
          index: index + 1,
          env,
          parseExpression: this.makeParseExpression({ caller, parserData }),
        });
        typeArguments = nextTypeArguments;
        index = nextIndex;
        env = nextEnv;
      } else {
        index = index + 1;
      }

      const newEnumType: TEnum = {
        ...enumType,
        typeParameters: enumType.typeParameters.map((typeParameter, index) => {
          if (index >= typeArguments.length) {
            return typeParameter;
          } else {
            return {
              ...typeParameter,
              appliedType: typeArguments[index],
            };
          }
        }),
      };

      return {
        expr: {
          type: AstType.Variable,
          variableName: identifier,
          variableId: enumValue.id,
          env,
          typeValue: newEnumType,
          frameLevel: enumValue.frameLevel,
          isMutable: false,
          token: tokens[enumTokenIndex],
        },
        index,
      };
      // }
    }

    // Check if it's a function
    // - test(1) Normal function call
    // - test { 12 } Trailing lambda
    // - test { 12 } { 13 } Trailing lambdas
    // - test (x)=> { x + 1 } Trailing lambda
    if (
      tokens[index + 1]?.type === TokenType.LParen ||
      tokens[index + 1]?.type === TokenType.LCurlyBracket ||
      tokens[index + 1]?.value === "<"
    ) {
      // Try all matchedFunctions to see if there is a match
      const parserReturns: ParserReturn[] = [];
      const parsedFunctions: ValueType[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallFunctionExpr({
              callee: {
                type: AstType.Variable,
                variableName: identifier,
                variableId: functionType.id,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
                env,
                isMutable: false,
                token: tokens[identifierTokenIndex],
              },
              tokens,
              index: index + 1,
              env,
              caller,
              parserData,
            })
          );
          parsedFunctions.push(functionType);
        } catch (error) {
          // console.error(error);
          // Ignore the error
          matchedFunctionErrors.push(error);
        }
      }

      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot find function '${identifier}'
Below are the possible functions:

${matchedFunctions
  .map(
    (func, i) => `- ${func.variableName}: ${typeToString(func.type)}
  
${matchedFunctionErrors[i]}`
  )
  .join("\n")}
          `
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous function "${identifier}"
Found possible functions:
- ${parsedFunctions
            .map(
              (func, i) => `${func.variableName}: ${typeToString(func.type)}
 
${matchedFunctionErrors[i] ?? ""}`
            )
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

    /*
    NOTE: We shouldn't check here because 
    we might perform type coercion.  
    
    if (valueType.consumedAtToken) {
      throw formatErrorMessages({
        modulePath: this.modulePath,
        inputString: this.inputString,
        tokenAndErrorList: [
          {
            token: tokens[identifierTokenIndex],
            errorMessage: `Variable \`${identifier}\` is already consumed.`,
          },
          {
            token: valueType.consumedAtToken,
            errorMessage: `Previously consumed here:`,
          },
        ],
      });
    }
    */

    // Add free variables to env
    if (isFreeVariable) {
      env = addEnvFreeVariable(env, valueType);
    }

    return {
      expr: {
        type: AstType.Variable,
        variableName: identifier,
        variableId: valueType.id,
        typeValue,
        frameLevel: valueType.frameLevel,
        isMutable: !!valueType.isMutable,
        env,
        token: tokens[identifierTokenIndex],
        // isFreeVariable,
      },
      index: index + 1,
    };
  }

  private parseSymbolValue({
    tokens,
    index,
    env,
  }: {
    tokens;
    index;
    env;
  }): ParserReturn {
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
              permission: "own",
              value: token.value,
              tag: "primitive",
            },
            token: tokens[index],
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
              permission: "own",
            },
            token: tokens[index],
          },
          index: index + 1,
        };
      }
    } else {
      throw this.formatErrorMessage(token, "Expected symbol");
    }
  }

  private parseSymbolExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const symbolTokenIndex = index;
    if (tokens[index].type !== TokenType.Symbol) {
      throw this.formatErrorMessage(tokens[index], "Expected symbol");
    }
    const symbol = `@${tokens[index].value}`;

    // Check if variable is defined
    const valueTypes = getEnvValueTypesByVariableName(env, symbol, "value");
    if (valueTypes.length === 0) {
      return this.parseSymbolValue({ tokens, index, env });
    }

    const matchedFunctions = valueTypes.filter(
      (valueType) => valueType.type.type === "Function"
    );
    const matchedFunctionErrors: Error[] = [];
    // Check if it's a function
    // - test(1) Normal function call
    // - test { 12 } Trailing lambda
    // - test { 12 } { 13 } Trailing lambdas
    // - test (x)=> { x + 1 } Trailing lambda
    if (
      tokens[index + 1]?.type === TokenType.LParen ||
      tokens[index + 1]?.type === TokenType.LCurlyBracket ||
      tokens[index + 1]?.value === "<"
    ) {
      // Try all matchedFunctions to see if there is a match
      const parserReturns: ParserReturn[] = [];
      const parsedFunctions: ValueType[] = [];
      for (const functionType of matchedFunctions) {
        try {
          parserReturns.push(
            this.parseCallFunctionExpr({
              callee: {
                type: AstType.Variable,
                variableName: symbol,
                variableId: functionType.id,
                frameLevel: functionType.frameLevel,
                typeValue: functionType.type,
                env,
                isMutable: false,
                token: tokens[symbolTokenIndex],
              },
              tokens,
              index: index + 1,
              env,
              caller,
              parserData,
            })
          );
          parsedFunctions.push(functionType);
        } catch (error) {
          // console.error(error);
          // Ignore the error
          matchedFunctionErrors.push(error);
        }
      }

      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot find function "${symbol}"
Below are the possible functions:

${matchedFunctions
  .map(
    (func, i) => `- ${func.variableName}: ${typeToString(func.type)}
  
${matchedFunctionErrors[i]}`
  )
  .join("\n")}
          `
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Ambiguous function "${symbol}"
Found possible functions:
- ${parsedFunctions
            .map(
              (func, i) => `${func.variableName}: ${typeToString(func.type)}
 
${matchedFunctionErrors[i] ?? ""}`
            )
            .join("\n- ")}`
        );
      } else {
        // FIXME: Might need to check `isFreeVariable` here as well
        return parserReturns[0];
      }
    } else {
      return this.parseSymbolValue({ tokens, index, env });
    }
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
  private parsePrimary({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const token = tokens[index];
    let returnValue: ParserReturn | null = null;

    if (token.value === "<") {
      returnValue = this.parseAnonymousFunction({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
    } /* else if (
      token.value === "&" || // immutable reference
      token.value === "&!" // mutable reference
    ) {
      returnValue = this.parseReferenceExpr({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
    } else if (token.value.startsWith("*")) {
      // Split tokens if necessary
      if (token.value.length > 1) {
        tokens.splice(
          index,
          1,
          {
            type: TokenType.Operator,
            value: "*",
            position: token.position,
          },
          {
            type: TokenType.Operator,
            value: token.value.slice(1),
            position: token.position,
          }
        );
      }

      returnValue = this.parseDereferenceExpr({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
    } */ else if (
      token.type === TokenType.Identifier ||
      (tokens[index].type === TokenType.LParen &&
        tokens[index + 1]?.type === TokenType.Operator &&
        tokens[index + 2]?.type === TokenType.RParen)
    ) {
      returnValue = this.parseIdentifierExpr({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
    } else {
      switch (token.type) {
        case TokenType.Symbol: {
          returnValue = this.parseSymbolExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Integer:
        case TokenType.Float: {
          returnValue = this.parseNumberExpr({ tokens, index, env });
          break;
        }
        case TokenType.Char: {
          returnValue = this.parseCharactorExpr({ tokens, index, env });
          break;
        }
        case TokenType.String: {
          returnValue = this.parseStringExpr({ tokens, index, env });
          break;
        }
        case TokenType.Boolean: {
          returnValue = this.parseBooleanExpr({ tokens, index, env });
          break;
        }
        case TokenType.Operator: {
          returnValue = this.parseUnaryOperatorExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.LBracket: {
          returnValue = this.parseSliceOrTupleExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.LParen: {
          returnValue = this.parseParenExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.LCurlyBracket: {
          returnValue = this.parseCurlyBracketExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.If: {
          returnValue = this.parseIfExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Match: {
          returnValue = this.parseMatchExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Let:
        case TokenType.Var: {
          return this.parseLetAssignment({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
        }
        case TokenType.Read:
        case TokenType.Write: {
          returnValue = this.parseReadWriteExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Semicolon: {
          return {
            expr: {
              type: AstType.Ignore,
              typeValue: TypeValues.unit,
              env,
              token,
            },
            index: index + 1,
          };
        }
        case TokenType.Defer: {
          return this.parseDeferExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
        }
        case TokenType.Try: {
          returnValue = this.parseTryExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Await: {
          returnValue = this.parseAwaitExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        case TokenType.Recur: {
          returnValue = this.parseRecurExpr({
            tokens,
            index,
            env,
            caller,
            parserData,
          });
          break;
        }
        default: {
          throw this.formatErrorMessage(
            token,
            `Unknown token: ${JSON.stringify(token)}`
          );
        }
      }
    }

    return this.parsePrimaryEnd({
      primaryExpr: returnValue.expr,
      tokens,
      index: returnValue.index,
      env: returnValue.expr.env,
      caller,
      parserData,
    });
  }

  private parsePrimaryEnd({
    primaryExpr,
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    primaryExpr: Expr;
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const token = tokens[index];
    if (!token) {
      return {
        expr: primaryExpr,
        index,
      };
    } else if (token.type === TokenType.Dot) {
      // parsePropertyAccessExpr
      const returnValue = this.parsePropertyAccessExpr({
        expr: primaryExpr,
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
        env: returnValue.expr.env,
        caller,
        parserData,
      });
    } else if (token.type === TokenType.LBracket) {
      // parseIndexAccessExpr
      const returnValue = this.parseIndexAccessExpr({
        expr: primaryExpr,
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
        env: returnValue.expr.env,
        caller,
        parserData,
      });
    } else if (
      primaryExpr.typeValue.type === "Function" &&
      (token.type === TokenType.LParen || token.value === "<")
    ) {
      // parseCallFunctionExpr
      const returnValue = this.parseCallFunctionExpr({
        callee: primaryExpr,
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
        env: returnValue.expr.env,
        caller,
        parserData,
      });
    } else if (
      primaryExpr.typeValue.type === "Enum" &&
      token.type === TokenType.LParen
    ) {
      // parseCallEnumExpr
      const returnValue = this.parseCallEnumExpr({
        callee: primaryExpr,
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      return this.parsePrimaryEnd({
        primaryExpr: returnValue.expr,
        tokens,
        index: returnValue.index,
        env: returnValue.expr.env,
        caller,
        parserData,
      });
    } else if (tokens[index].type === TokenType.As) {
      const typeTokenIndex = index + 1;
      const {
        env: nextEnv,
        index: nextIndex,
        typeValue: castedType,
      } = synthesizeTypeFromTokens({
        tokens,
        index: typeTokenIndex,
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
      });
      index = nextIndex;
      env = nextEnv;
      return {
        expr: {
          type: AstType.TypeCast,
          env,
          expr: primaryExpr,
          token: tokens[typeTokenIndex],
          typeValue: castedType,
        },
        index,
      };
    } /* else if (
      primaryExpr.typeValue.type === "Enum" &&
      token.type === TokenType.Is
    ) {
      // parseIsOperatorExpr
      const returnValue = this.parseIsOperatorExpr(
        primaryExpr,
        tokens,
        index,
        env,
        caller
      );
      return this.parsePrimaryEnd(
        returnValue.expr,
        tokens,
        returnValue.index,
        returnValue.expr.env,
        caller
      );
    }*/ else {
      return {
        expr: primaryExpr,
        index,
      };
    }
  }

  private parseDeferExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
    applyEnv,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    applyEnv?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Defer) {
      throw this.formatErrorMessage(tokens[index], "Expected 'defer'");
    }
    const deferTokenIndex = index;
    index = index + 1;

    const { expr: nextExpr, index: nextIndex } = this.parseBlockExpressions({
      tokens,
      index,
      env,
      caller,
      parserData,
    });

    return {
      expr: {
        type: AstType.Defer,
        expr: nextExpr,
        typeValue: TypeValues.unit,
        env: applyEnv ? nextExpr.env : env,
        token: tokens[deferTokenIndex],
      },
      index: nextIndex,
    };
  }

  private parseBinOpRHS({
    tokens,
    exprPrecedence,
    LHS,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    exprPrecedence: number;
    LHS: Expr;
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    // if it's binop, find its precedence
    while (true) {
      const token = tokens[index];

      // Not an operator
      if (!token || !stringIsOperator(token.value)) {
        return { expr: LHS, index };
      }

      const operatorString: string = token.value;
      const operatorPrecendence = getEnvInfixOperatorPrecedence(
        env,
        operatorString
      );
      if (!operatorPrecendence) {
        // operator not found
        return { expr: LHS, index };
      } else if (operatorPrecendence.precedence < exprPrecedence) {
        // If this is a binop that binds at least as tightly as the current binop,
        // consume it, otherwise we are done.
        return { expr: LHS, index };
      }

      // Okay, we know this is a binop
      const binaryOperatorToken = token;
      index = index + 1; // eat binop

      // eslint-disable-next-line prefer-const
      let {
        expr: RHS,
        // eslint-disable-next-line prefer-const
        index: nextIndex,
        // eslint-disable-next-line prefer-const
      } = this.parsePrimary({ tokens, index, env, caller, parserData });
      env = RHS.env;
      if (!RHS) {
        return { expr: RHS, index: nextIndex };
      }

      // If BinOp binds less tightly with RHS than the operator after RHS, let
      // the pending operator take RHS as its LHS.
      const nextToken = tokens[nextIndex];
      const nextOperatorString = nextToken.value;
      const nextOperatorPrecedence: OperatorPrecedence | undefined =
        stringIsOperator(nextOperatorString)
          ? getEnvInfixOperatorPrecedence(env, nextOperatorString)
          : undefined;

      if (
        nextOperatorPrecedence &&
        operatorPrecendence.precedence < nextOperatorPrecedence.precedence
      ) {
        const { expr, index: nextNextIndex } = this.parseBinOpRHS({
          tokens,
          exprPrecedence: operatorPrecendence.precedence + 1,
          LHS: RHS,
          index: nextIndex,
          env,
          caller,
          parserData,
        });
        if (!expr) {
          return { expr, index: nextNextIndex };
        }
        RHS = expr;
        index = nextNextIndex;
      } else {
        index = nextIndex;
      }

      // Find the infix function
      const valueTypes = getEnvValueTypesByVariableName(
        env,
        operatorString,
        "value"
      );
      const matchedFunctions = valueTypes.filter(
        (valueType) => valueType.type.type === "Function"
      );
      const matchedFunctionErrors: Error[] = [];
      // Try all matchedFunctions to see if there is a match
      const parserReturns: ParserReturn[] = [];
      const parsedFunctions: ValueType[] = [];
      for (const matchedFunction of matchedFunctions) {
        try {
          const functionType = matchedFunction.type as TFunction;
          const {
            functionArguments,
            functionTypeArguments,
            functionRegionArguments,
          } = getFunctionArgumentsInOrder(
            functionType,
            functionType.parameterTypes,
            [LHS, RHS],
            [],
            env
          );
          if (!functionArguments) {
            throw this.formatErrorMessage(
              binaryOperatorToken,
              `Mismatched function arguments.
Expected: (${functionType.parameterTypes
                .map(
                  (parameter) =>
                    (parameter.name ? `${parameter.name}: ` : "") +
                    typeToString(parameter.type, {
                      hideTypeParameterKind: true,
                    })
                )
                .join(", ")})
Got:      (${[LHS, RHS]
                .map((arg) => {
                  return typeToString(arg.typeValue, {
                    hideTypeParameterKind: true,
                  });
                })
                .join(", ")})`
            );
          }
          if (!functionTypeArguments || !functionRegionArguments) {
            throw this.formatErrorMessage(
              binaryOperatorToken,
              `Mismatched type arguments.
Expected: <${functionType.typeParameters
                .map((typeParameter) => `${typeToString(typeParameter)}`)
                .join(", ")}>
Got:      <${[].map((type) => typeToString(type)).join(", ")}>`
            );
          }

          const newFunctionType = applyTypeAndRegionArgumentsToType({
            env,
            type: { ...functionType },
            typeArguments: functionTypeArguments,
            regionArguments: functionRegionArguments,
            typeParameterToTypeArgumentMap: {},
            regionParameterToRegionArgumentMap: {},
          }) as TFunction;
          // save the return value to a temporary variable
          const returnType = newFunctionType.returnType;
          const { env: nextNextEnv, value: tempVariable } =
            this.generateTempVariableForHoldingValue({
              env,
              token: binaryOperatorToken,
              valueType: returnType,
            });
          parserReturns.push({
            expr: {
              type: AstType.CallFunction,
              callee: {
                type: AstType.Variable,
                variableName: operatorString,
                variableId: matchedFunction.id,
                frameLevel: matchedFunction.frameLevel,
                typeValue: newFunctionType,
                env,
                isMutable: false,
                token: binaryOperatorToken,
              },
              functionArguments: [LHS, RHS],
              typeValue: newFunctionType.returnType,
              env: nextNextEnv,
              token: binaryOperatorToken,
              tempVariableName: tempVariable.variableName,
            },
            index,
          });
          parsedFunctions.push(matchedFunction);
        } catch (error) {
          // console.error(error);
          // Ignore the error
          matchedFunctionErrors.push(error);
        }
      }

      if (parserReturns.length === 0) {
        throw this.formatErrorMessage(
          binaryOperatorToken,
          `Cannot find function '${operatorString}'
Below are the possible functions:

${matchedFunctions
  .map(
    (func, i) => `- ${func.variableName}: ${typeToString(func.type)}

${matchedFunctionErrors[i]}`
  )
  .join("\n")}
          `
        );
      } else if (parserReturns.length > 1) {
        throw this.formatErrorMessage(
          binaryOperatorToken,
          `Ambiguous function "${operatorString}"
Found possible functions:
- ${parsedFunctions
            .map(
              (func, i) => `${func.variableName}: ${typeToString(func.type)}

${matchedFunctionErrors[i] ?? ""}`
            )
            .join("\n- ")}`
        );
      } else {
        LHS = parserReturns[0].expr;
        if (LHS.type === AstType.CallFunction) {
          LHS = {
            ...LHS,
            isOperator: "binary",
          };
        }
      }
    }
  }

  private parseUnaryOperatorExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const operatorToken = tokens[index];
    if (tokens[index].type !== TokenType.Operator) {
      throw this.formatErrorMessage(tokens[index], "Expected operator");
    }
    index = index + 1;

    // Parse argument
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    env = expr.env;
    index = nextIndex;

    // Find the unary function
    const valueTypes = getEnvValueTypesByVariableName(
      env,
      operatorToken.value,
      "value"
    );
    const matchedFunctions = valueTypes.filter(
      (valueType) => valueType.type.type === "Function"
    );
    const matchedFunctionErrors: Error[] = [];
    // Try all matchedFunctions to see if there is a match
    const parserReturns: ParserReturn[] = [];
    const parsedFunctions: ValueType[] = [];
    for (const matchedFunction of matchedFunctions) {
      try {
        const functionType = matchedFunction.type as TFunction;
        const {
          functionArguments,
          functionTypeArguments,
          functionRegionArguments,
        } = getFunctionArgumentsInOrder(
          functionType,
          functionType.parameterTypes,
          [expr],
          [],
          env
        );
        if (!functionArguments) {
          throw this.formatErrorMessage(
            operatorToken,
            `Mismatched function arguments.
Expected: (${functionType.parameterTypes
              .map(
                (parameter) =>
                  (parameter.name ? `${parameter.name}: ` : "") +
                  typeToString(parameter.type, {
                    hideTypeParameterKind: true,
                  })
              )
              .join(", ")})
Got:      (${[expr]
              .map((arg) => {
                return typeToString(arg.typeValue, {
                  hideTypeParameterKind: true,
                });
              })
              .join(", ")})`
          );
        }
        if (!functionTypeArguments || !functionRegionArguments) {
          throw this.formatErrorMessage(
            operatorToken,
            `Mismatched type arguments.
Expected: <${functionType.typeParameters
              .map((typeParameter) => `${typeToString(typeParameter)}`)
              .join(", ")}>
Got:      <${[].map((type) => typeToString(type)).join(", ")}>`
          );
        }

        const newFunctionType = applyTypeAndRegionArgumentsToType({
          env,
          type: { ...functionType },
          typeArguments: functionTypeArguments,
          regionArguments: functionRegionArguments,
          typeParameterToTypeArgumentMap: {},
          regionParameterToRegionArgumentMap: {},
        }) as TFunction;
        // save the return value to a temporary variable
        const returnType = newFunctionType.returnType;
        const { env: nextNextEnv, value: tempVariable } =
          this.generateTempVariableForHoldingValue({
            env,
            token: operatorToken,
            valueType: returnType,
          });
        parserReturns.push({
          expr: {
            type: AstType.CallFunction,
            callee: {
              type: AstType.Variable,
              variableName: operatorToken.value,
              variableId: matchedFunction.id,
              frameLevel: matchedFunction.frameLevel,
              typeValue: newFunctionType,
              env,
              isMutable: false,
              token: operatorToken,
            },
            functionArguments: [expr],
            typeValue: newFunctionType.returnType,
            env: nextNextEnv,
            token: operatorToken,
            tempVariableName: tempVariable.variableName,
          },
          index,
        });
        parsedFunctions.push(matchedFunction);
      } catch (error) {
        // console.error(error);
        // Ignore the error
        matchedFunctionErrors.push(error);
      }
    }

    if (parserReturns.length === 0) {
      throw this.formatErrorMessage(
        operatorToken,
        `Cannot find function '${operatorToken.value}'
Below are the possible functions:

${matchedFunctions
  .map(
    (func, i) => `- ${func.variableName}: ${typeToString(func.type)}

${matchedFunctionErrors[i]}`
  )
  .join("\n")}
          `
      );
    } else if (parserReturns.length > 1) {
      throw this.formatErrorMessage(
        operatorToken,
        `Ambiguous function "${operatorToken.value}"
Found possible functions:
- ${parsedFunctions
          .map(
            (func, i) => `${func.variableName}: ${typeToString(func.type)}

${matchedFunctionErrors[i] ?? ""}`
          )
          .join("\n- ")}`
      );
    } else {
      const ret = parserReturns[0];
      const callFunctionExpr: CallFunctionExpr = ret.expr as CallFunctionExpr;
      return {
        expr: {
          ...callFunctionExpr,
          isOperator: "unary",
        },
        index: ret.index,
      };
    }
  }

  private parseBlockExpressions({
    tokens,
    index,
    env,
    caller,
    parserData,
    tempVariableName,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    tempVariableName?: string;
  }): { index: number; expr: BlockExpr } {
    let exprs: Expr[] = [];
    let isSingleExpression = false;
    const blockTokenIndex = index;
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      isSingleExpression = true;
    } else {
      index = index + 1;
    }

    env = pushEnvFrame(env);
    let nextEnv = env;
    while (true) {
      const token = tokens[index];
      if (!isSingleExpression && !token) {
        throw this.formatErrorMessage(token, "Expected '}' for function body");
      }
      if (!isSingleExpression && token.type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      const { expr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
        env: nextEnv,
        caller,
        parserData,
      });

      if (tokens[nextIndex].type === TokenType.Assign) {
        const { expr: assignmentExpr, index: nextNextIndex } =
          this.parseAssignmentExpr({
            lhs: expr,
            tokens,
            index: nextIndex,
            env: expr.env,
            caller,
            parserData,
          });
        exprs.push(assignmentExpr);
        nextEnv = assignmentExpr.env;
        index = nextNextIndex;
      } else {
        exprs.push(expr);
        nextEnv = expr.env;
        index = nextIndex;
      }

      if (isSingleExpression) {
        break;
      }
    }

    const lastExpr: Expr | null = exprs[exprs.length - 1] ?? null;
    if (!isSingleExpression) {
      exprs = exprs.filter((expr) => expr.type !== AstType.Ignore);
      if (
        !lastExpr ||
        tokens[index - 2].type ===
          TokenType.Semicolon /*&& !isSingleExpression */
      ) {
        exprs.push({
          type: AstType.Value,
          tag: "primitive",
          value: "()",
          typeValue: { type: "()", kind: "Free", permission: "own" },
          env: nextEnv,
          token: tokens[index - 1],
        });
      }
    }

    // NOTE: Needs to put this before `env.popFrame` to get `returnType`.
    const returnExpr = exprs[exprs.length - 1];
    const returnType = returnExpr.typeValue;
    const { env: nextNextEnv, referedVariable } = this.setVariableAsConsumed(
      nextEnv,
      returnExpr
    );
    if (referedVariable) {
      throw this.formatErrorMessage(
        returnExpr.token,
        "Cannot return a reference defined in the function body, not the function parameter."
      );
    }
    env = nextNextEnv;

    // Run the deferred expressions
    for (let i = exprs.length - 1; i >= 0; i--) {
      const expr = exprs[i];
      if (expr.type === AstType.Defer) {
        // evaluate the defer again.
        const { expr: deferExpr } = this.parseDeferExpr({
          tokens,
          index: tokens.findIndex((token) => token === expr.token),
          caller,
          env,
          parserData,
          applyEnv: true,
        });
        env = deferExpr.env;
      }
    }

    if (!tempVariableName) {
      // save the return value to a temporary variable
      const { env: nextNextNextEnv, value } =
        this.generateTempVariableForHoldingValue({
          env,
          token: tokens[blockTokenIndex],
          valueType: returnType,
          deltaFrame: -1,
        });
      env = nextNextNextEnv;
      tempVariableName = value.variableName;
    }

    env = popEnvFrame(env);
    return {
      index,
      expr: {
        type: AstType.Block,
        exprs,
        env,
        typeValue: returnType,
        token: tokens[blockTokenIndex],
        tempVariableName,
      },
    };
  }

  private setVariableAsConsumed(
    env: Environment,
    expr: Expr
  ): { env: Environment; referedVariable?: ReferedVariable } {
    /*
    // FIXME:
    if (expr.type === AstType.PropertyAccess) {
      {
        // If it's accessing a linear type,
        // then we throw error showing that
        // dot access is not allowed for linear types.
        if (
          expr.typeValue.kind === "Type" ||
          expr.typeValue.kind === "Linear"
        ) {
          const referenceType = typeIsReferenceOrMutableReference(
            expr.typeValue
          );
          if (referenceType) {
            throw this.formatErrorMessage(
              expr.token,
              `Cannot access "${expr.typeValue.kind}" value "${
                expr.propertyName
              }" with dot access.

Please consider using reference instead. For example:

let ref = (${referenceType}${exprToString(expr)})
`
            );
          } else {
            throw this.formatErrorMessage(
              expr.token,
              `Cannot access "${expr.typeValue.kind}" value "${
                expr.propertyName
              }" with dot access.
Please consider using destructuring instead. For example:

let {${expr.propertyName}} = ${exprToString(expr.expr)}`
            );
          }
        } else {
          try {
            // It's accessing a Free type, so no need to consume.
            // But we need to check if the variable is consumed.
            this.trySettingVariableAsReference({
              env,
              expr,
              isMutableReference: false,
              isForAssignment: false,
            });
          } catch (error) {
            throw formatErrorMessage({
              modulePath: this.modulePath,
              inputString: this.inputString,
              token: expr.token,
              errorMessage: `Cannot access the property below because "${exprToString(
                expr.expr
              )}" is already consumed:
${exprToString(expr)}`,
              cause: error,
            });
          }
        }
        return { env, referedVariable: undefined };
      }
    } else if (expr.type === AstType.IndexAccess) {
      if (expr.typeValue.kind === "Type" || expr.typeValue.kind === "Linear") {
        throw this.formatErrorMessage(
          expr.token,
          `Cannot access "${expr.typeValue.kind}" value of "${exprToString(
            expr.expr
          )}" with index access.
Please consider using reference instead. For example:

let ref = (&${exprToString(expr)})
`
        );
      } else {
        try {
          // It's accessing a Free type, so no need to consume.
          // But we need to check if the variable is consumed.
          this.trySettingVariableAsReference({
            env,
            expr,
            isMutableReference: false,
            isForAssignment: false,
          });
        } catch (error) {
          throw formatErrorMessage({
            modulePath: this.modulePath,
            inputString: this.inputString,
            token: expr.token,
            errorMessage: `Cannot access the value below because "${exprToString(
              expr.expr
            )}" is already consumed:
${exprToString(expr)}`,
            cause: error,
          });
        }
      }
    }
    */

    try {
      switch (expr.type) {
        case AstType.Variable: {
          return setEnvVariableAsConsumed({
            env,
            variableName: expr.variableName,
            consumedAtToken: expr.token,
          });
        }
        // Below are all the expressions that have `tempVariableName`.
        // case AstType.Reference:
        case AstType.ReadWrite:
        case AstType.CallFunction:
        case AstType.If:
        case AstType.Match:
        case AstType.Assignment:
        case AstType.Block: {
          return setEnvVariableAsConsumed({
            env,
            variableName: expr.tempVariableName,
            consumedAtToken: expr.token,
          });
        }
        default: {
          return { env, referedVariable: undefined };
        }
      }
    } catch (error) {
      throw formatErrorMessage({
        modulePath: this.modulePath,
        inputString: this.inputString,
        token: expr.token,
        errorMessage: `Cannot consume variable: ${exprToString(expr)}`,
        cause: error,
      });
    }
  }

  private trySettingVariableAsReference({
    env,
    expr,
    isMutableReference,
    isForAssignment,
  }: {
    env: Environment;
    expr: Expr;
    isMutableReference: boolean;
    isForAssignment: boolean;
  }): { resetConsumedVariable?: boolean; env: Environment } {
    env = pushEnvFrame(env);
    // Set the reference
    const {
      env: nextEnv,
      referedVariable,
      resetConsumedVariable,
    } = this.increaseVariableReferenceCount({
      env,
      expr: expr,
      isMutableReference,
      isForAssignment,
    });
    env = nextEnv;
    // Unset the reference
    env = decrementVariableReferenceCount({
      env,
      referedVariable,
    });
    env = popEnvFrame(env);

    return {
      resetConsumedVariable,
      env,
    };
  }

  private increaseVariableReferenceCount({
    env,
    expr,
    isMutableReference,
    isForAssignment,
  }: {
    env: Environment;
    expr: Expr;
    isMutableReference: boolean;
    isForAssignment?: boolean;
  }): {
    env: Environment;
    referedVariable: ReferedVariable;
    resetConsumedVariable?: boolean;
  } {
    try {
      switch (expr.type) {
        case AstType.Variable: {
          return increaseEnvVariableReferenceCount({
            env,
            variableName: expr.variableName,
            isMutableReference,
            token: expr.token,
            isForAssignment,
          });
        }
        case AstType.PropertyAccess:
        case AstType.IndexAccess: {
          const v = expr.expr;
          if (v.type !== AstType.Variable) {
            throw new Error("Expected variable");
          } else {
            return this.increaseVariableReferenceCount({
              env,
              expr: v,
              isMutableReference,
              isForAssignment,
            });
          }
        }
        default: {
          throw new Error("Expected variable");
        }
      }
    } catch (error) {
      throw formatErrorMessage({
        modulePath: this.modulePath,
        inputString: this.inputString,
        token: expr.token,
        errorMessage: `Failed to create ${
          isMutableReference ? "mutable reference" : "immutable reference"
        } for:
${exprToString(expr)}\n`,
        cause: error,
      });
    }
  }

  private parseExternExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Extern) {
      throw this.formatErrorMessage(tokens[index], "Expected extern");
    }
    const externTokenIndex = index;
    index = index + 1;

    // TODO: Specify the language, like "C" or "JavaScript"
    let language: "c" | "mo" = "c";
    if (
      tokens[index].type === TokenType.String &&
      tokens[index].value.match(/^(c|mo)$/i)
    ) {
      language = tokens[index].value.toLowerCase() as "c" | "mo";
      index = index + 1;
    }

    const variables: ExternVariable[] = [];
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for extern block"
      );
    }
    index = index + 1;
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '}' for extern block"
        );
      }
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      let variableName: string | undefined = undefined;
      const variableNameTokenIndex = index;
      if (language === "c" && tokens[index].type === TokenType.Identifier) {
        variableName = tokens[index].value;
        index = index + 1;
      } else if (language === "mo") {
        if (
          tokens[index].type === TokenType.Identifier &&
          tokens[index].value.startsWith("@")
        ) {
          variableName = `${tokens[index].value}`;
          index = index + 1;
        } else {
          throw this.formatErrorMessage(
            tokens[index],
            `Expected symbol for extern variable name for language "mo", but got ${JSON.stringify(
              tokens[index]
            )}`
          );
        }
      } else {
        throw this.formatErrorMessage(
          tokens[index],
          `Expected identifier for extern variable name, but got ${JSON.stringify(
            tokens[index]
          )}`
        );
      }

      if (tokens[index].type !== TokenType.Colon) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected ':' for extern variable type"
        );
      }
      index = index + 1;

      const {
        typeValue,
        index: nextIndex,
        env: nextEnv,
      } = synthesizeTypeFromTokens({
        tokens,
        index,
        env,
        functionName: variableName,
        parseExpression: this.makeParseExpression({ caller, parserData }),
      });
      index = nextIndex;
      env = nextEnv;

      variables.push({
        name: variableName,
        typeValue,
      });

      // Add variable to env
      const { env: nextNextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName,
          type: typeValue,
          isMutable: false,
          kind: "value",
          isExported,
          token: tokens[variableNameTokenIndex],
        },
      });
      env = nextNextEnv;

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
      }
    }

    return {
      expr: {
        type: AstType.Extern,
        language,
        variables,
        typeValue: TypeValues.unit,
        env,
        token: tokens[externTokenIndex],
      },
      index,
    };
  }

  private parseIfExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.If) {
      throw this.formatErrorMessage(tokens[index], "Expected if");
    }
    const ifTokenIndex = index;
    index = index + 1;

    // Generate temp variable for holding the return value
    const { env: nextEnv, value: tempVariable } =
      this.generateTempVariableForHoldingValue({
        env,
        token: tokens[ifTokenIndex],
        valueType: TypeValues.unit,
      });
    env = nextEnv;
    const tempVariableName = tempVariable.variableName;

    const cases: IfCase[] = [];
    while (true) {
      if (tokens[index].type !== TokenType.LParen) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '(' for 'if' expression"
        );
      }
      // Parse condition
      const { expr: conditionExpr, index: nextIndex } = this.parseExpression({
        tokens,
        index,
        env,
        caller,
        parserData,
      });
      index = nextIndex;

      // Parse body
      const { expr: bodyExpr, index: nextNextIndex } =
        this.parseBlockExpressions({
          tokens,
          index,
          env: conditionExpr.env,
          caller,
          parserData,
          tempVariableName,
        });
      index = nextNextIndex;

      cases.push({
        condition: conditionExpr,
        body: bodyExpr,
      });

      if (tokens[index].type === TokenType.Else) {
        index = index + 1;

        if (tokens[index].type === TokenType.If) {
          index += 1;
          continue;
        } else {
          // Last else
          // Parse body
          const { expr: bodyExpr, index: nextNextIndex } =
            this.parseBlockExpressions({
              tokens,
              index,
              env: conditionExpr.env,
              caller,
              parserData,
              tempVariableName,
            });
          index = nextNextIndex;

          cases.push({
            condition: undefined,
            body: bodyExpr,
          });
          break;
        }
      } else {
        break;
      }
    }

    if (cases.length === 0) {
      throw this.formatErrorMessage(
        tokens[ifTokenIndex],
        "Expected if expression body"
      );
    }

    const expectedReturnType =
      cases.length === 1 ? TypeValues.unit : cases[0].body.typeValue;

    // Check if all cases have the same return type
    const returnTypes = cases.map((case_) => case_.body.typeValue);
    const hasDifferentReturnTypes = returnTypes.some(
      (returnType) => !checkType(expectedReturnType, returnType, env)
    );
    if (hasDifferentReturnTypes) {
      throw this.formatErrorMessage(
        tokens[ifTokenIndex],
        `Mismatched return types:
Expected: ${typeToString(expectedReturnType)}
Found:    
- ${returnTypes.map((returnType) => typeToString(returnType)).join("\n- ")}
`
      );
    }

    // Update the tempVariable type
    env = updateExistingValueType(env, tempVariable, {
      ...tempVariable,
      type: expectedReturnType,
    });

    // Merge and check all environments
    env = mergeAndCheckEnv(env, cases);

    return {
      expr: {
        type: AstType.If,
        cases,
        typeValue: expectedReturnType,
        env,
        token: tokens[ifTokenIndex],
        tempVariableName,
      },
      index,
    };
  }

  private parseMatchExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Match) {
      throw this.formatErrorMessage(tokens[index], "Expected match");
    }
    const matchTokenIndex = index;
    index = index + 1;

    const variableTokenIndex = index;
    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '(' for 'match' expression"
      );
    }
    const { expr: matchedEnum, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    if (matchedEnum.type !== AstType.Variable) {
      throw this.formatErrorMessage(
        tokens[variableTokenIndex],
        "Only variable can be matched right now. For example, `match x { ... }`, but not `match x.a.b { ... }` "
      );
    }

    if (matchedEnum.typeValue.type !== "Enum") {
      throw this.formatErrorMessage(
        tokens[index - 1],
        `Expected enum, but got ${typeToString(matchedEnum.typeValue)}`
      );
    }

    // Generate temp variable for holding the return value
    const { env: nextEnv, value: tempVariable } =
      this.generateTempVariableForHoldingValue({
        env,
        token: tokens[matchTokenIndex],
        valueType: TypeValues.unit,
      });
    env = nextEnv;
    const tempVariableName = tempVariable.variableName;

    const cases: MatchCase[] = [];
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for match expression"
      );
    }
    index = index + 1;
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '}' for match expression"
        );
      }
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      if (tokens[index].value !== "_") {
        // parse case
        const { expr: caseExpr, index: nextIndex } = this.parsePrimary({
          tokens,
          index,
          env,
          caller,
          parserData,
        });
        index = nextIndex;
        const caseExprType = caseExpr.typeValue;
        if (caseExprType.type !== "Enum" || !caseExprType.selectedVariantName) {
          throw this.formatErrorMessage(
            tokens[index - 1],
            `Expected enum with selected variant, but got ${exprToString(
              caseExpr
            )}`
          );
        }

        /*
        // Check if the enum type matches
        if (!checkType(matchedEnum.typeValue, caseExprType, env)) {
          throw this.formatErrorMessage(
            tokens[index - 1],
            `Mismatched types between matched enum and case enum:
${typeToString(matchedEnum.typeValue)}
${typeToString(caseExprType)}
`
          );
        }
        */

        const variantName = caseExprType.selectedVariantName;

        const newEnv = this.setSelectedVariantName({
          enumExpr: matchedEnum,
          variantName,
          env,
        });

        if (tokens[index].type !== TokenType.FatArrow) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '=>' for case"
          );
        }
        index = index + 1;

        // parse body
        const { expr: blockExpr, index: nextNextIndex } =
          this.parseBlockExpressions({
            tokens,
            index,
            env: newEnv,
            caller,
            parserData,
            tempVariableName,
          });
        index = nextNextIndex;
        cases.push({
          case: caseExpr,
          body: blockExpr,
          variantName,
        });
      } else {
        // Default case
        index = index + 1;

        if (tokens[index].type !== TokenType.FatArrow) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '=>' for default case"
          );
        }
        index = index + 1;

        // parse body
        const { expr: blockExpr, index: nextIndex } =
          this.parseBlockExpressions({
            tokens,
            index,
            env,
            caller,
            parserData,
            tempVariableName,
          });
        index = nextIndex;
        cases.push({
          case: undefined,
          variantName: "*", // "*" means default
          body: blockExpr,
        });
      }

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
        continue;
      }
    }

    // Exhausive check
    // Make sure all variants are covered, unless there is a default case
    const hasDefault = cases.some((case_) => case_.variantName === "*");
    if (!hasDefault) {
      const matchedEnumType = matchedEnum.typeValue;
      const matchedEnumTypeVariants = matchedEnumType.variants.map(
        (variant) => variant.name
      );
      const caseVariants = cases.map((case_) => case_.variantName);
      const uncoveredVariants = matchedEnumTypeVariants.filter(
        (variant) => !caseVariants.includes(variant)
      );
      if (uncoveredVariants.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Not all variants are covered. Missing variants:
${uncoveredVariants.join(", ")}
`
        );
      }
    } else {
      // Make sure default is the last case
      const defaultCaseIndex = cases.findIndex(
        (case_) => case_.variantName === "*"
      );
      if (defaultCaseIndex !== cases.length - 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Default case must be the last case`
        );
      }
    }

    // Check each cases body returnValue type matches
    if (cases.length === 0) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected at least one case"
      );
    }
    const returnType = cases[0].body.typeValue;
    for (let i = 1; i < cases.length; i++) {
      const caseReturnType = cases[i].body.typeValue;
      if (!checkType(returnType, caseReturnType, env)) {
        throw this.formatErrorMessage(
          tokens[index],
          `Mismatched types between cases:
${typeToString(returnType)}
${typeToString(caseReturnType)}
`
        );
      }
    }

    // Update the tempVariable type
    env = updateExistingValueType(env, tempVariable, {
      ...tempVariable,
      type: returnType,
    });

    // Merge and check all environments
    env = mergeAndCheckEnv(env, cases);

    return {
      expr: {
        type: AstType.Match,
        matchedEnum,
        cases,
        typeValue: returnType,
        env,
        token: tokens[matchTokenIndex],
        tempVariableName,
      },
      index,
    };
  }

  private setSelectedVariantName({
    enumExpr,
    variantName,
    env,
  }: {
    enumExpr: Expr;
    variantName: string;
    env: Environment;
  }): Environment {
    if (enumExpr.typeValue.type !== "Enum") {
      throw new Error(
        `Expected enum, but got ${typeToString(enumExpr.typeValue)}`
      );
    }
    // FIXME: Support reference of enum.
    const enumType: TEnum = enumExpr.typeValue;

    // Check if variantName exists
    const matchedVariant = enumType.variants.find(
      (variant) => variant.name === variantName
    );
    if (!matchedVariant) {
      throw new Error(`Unknown variant "${variantName}"`);
    }

    switch (enumExpr.type) {
      case AstType.Variable: {
        const variableName = enumExpr.variableName;
        const values = getEnvValueTypesByVariableName(env, variableName);
        if (values.length === 0) {
          throw new Error(`Unknown variable "${variableName}"`);
        }
        const value = values[values.length - 1];
        if (value.type.type !== "Enum") {
          throw new Error(`Expected enum, but got ${typeToString(value.type)}`);
        } // FIXME: Support reference of enum.
        const enumType: TEnum = value.type;
        const newEnumType: TEnum = {
          ...enumType,
          selectedVariantName: variantName,
        };
        const newValueType: ValueType = {
          ...value,
          type: newEnumType,
        };

        return updateExistingValueType(env, value, newValueType);
      }
      default: {
        break;
      }
    }

    return env;
  }

  private parseLetAssignment({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (
      tokens[index].type !== TokenType.Let &&
      tokens[index].type !== TokenType.Var
    ) {
      throw this.formatErrorMessage(tokens[index], 'Expected "let" or "var"');
    }
    const isMutable: boolean = tokens[index].type === TokenType.Var;
    const letTokenIndex = index;
    index = index + 1;

    if (tokens[index].type === TokenType.LCurlyBracket) {
      return this.parseDestructuringAssignmentExpression({
        tokens,
        index,
        env,
        caller,
        parserData,
        isMutable,
      });
    }

    let variableNameTokenIndex = index;
    let variableName: string | undefined = undefined;
    let operatorPrecedence: OperatorPrecedence | undefined = undefined;
    if (tokens[index].type === TokenType.Identifier) {
      variableName = tokens[index].value;
      index = index + 1;
    } else if (tokens[index].type === TokenType.LParen) {
      if (
        tokens[index + 1].type === TokenType.Operator &&
        tokens[index + 2].type === TokenType.RParen
      ) {
        variableNameTokenIndex = index + 1;
        variableName = tokens[index + 1].value;
        operatorPrecedence = getEnvInfixOperatorPrecedence(env, variableName);
        index = index + 3;
      } else {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected operator like (++) for let assignment"
        );
      }
    } else {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for let assignment"
      );
    }

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
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
      });
      userDefinedVariableType = typeValue;
      index = nextIndex;
      env = nextEnv;

      const { env: nextNextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName,
          type: userDefinedVariableType,
          kind: "value",
          isMutable,
          isExported,
          isUninitialized: true,
          token: tokens[variableNameTokenIndex],
        },
      });
      env = nextNextEnv;
    }

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for const assignment"
      );
    }
    index = index + 1;

    // Check if it's a function declaration
    if (!userDefinedVariableType) {
      try {
        const { typeValue } = synthesizeFunctionTypeFromTokens({
          tokens,
          index: tokens[index].type === TokenType.Async ? index + 1 : index,
          env,
          parseExpression: this.makeParseExpression({ caller, parserData }),
          withFunctionBody: false,
          functionName: variableName,
        });
        userDefinedVariableType = typeValue;
        const { env: nextEnv } = addEnvValueType({
          env,
          valueType: {
            variableName,
            type: userDefinedVariableType,
            kind: "value",
            isMutable,
            isExported,
            isUninitialized: true,
            token: tokens[variableNameTokenIndex],
          },
        });
        env = nextEnv;
      } catch (error) {
        // console.error(error);
        // Ignore the error
      }
    }

    const { expr: value, index: nextNextIndex } = this.parseExpression({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    if (!value) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected expression for const assignment"
      );
    }
    index = nextNextIndex;
    env = value.env;

    let variableType: Type = value.typeValue;
    let variableId: string | undefined = undefined;
    // Check if type matches
    if (userDefinedVariableType !== null) {
      const { userDefinedType: nextUserDefinedType, givenType: nextGivenType } =
        synthesizeTypes({
          userDefinedType: userDefinedVariableType,
          givenType: variableType,
          typeParameterToTypeArgumentMap: {},
          regionParameterToRegionArgumentMap: {},
        });
      userDefinedVariableType = nextUserDefinedType;
      variableType = nextGivenType;

      if (
        userDefinedVariableType.type === "Function" &&
        variableType.type === "Function"
      ) {
        variableType.functionId = userDefinedVariableType.functionId;
        variableId = userDefinedVariableType.functionId;
      }

      // Check if the type matches
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
    }

    const finalType = userDefinedVariableType ?? variableType;
    if (finalType.permission === "write" && !isMutable) {
      finalType.permission = "read";
    }
    if (finalType.permission === "read" && isMutable) {
      throw this.formatErrorMessage(
        tokens[letTokenIndex],
        `Expected "let" for "read" value.`
      );
    }

    // Add variable to env
    const { env: nextEnv, value: valueType } = addEnvValueType({
      env,
      valueType: {
        variableName,
        type: finalType,
        kind: "value",
        isMutable,
        isExported,
        isUninitialized: false,
        operatorPrecedence,
        token: tokens[variableNameTokenIndex],
      },
      preventDuplicate: true,
      variableId,
    });
    env = nextEnv;

    // Consume RHS value if necessary
    const { env: nextNextEnv /* referedVariable */ } =
      this.setVariableAsConsumed(env, value);
    env = nextNextEnv;

    /*
    if (referedVariable) {
      env = setEnvVariableReferedVariable({
        env,
        variableNameToken: tokens[variableNameTokenIndex],
        referedVariable,
      });
    }
    */

    return {
      expr: {
        type: AstType.LetAssignment,
        variableName,
        variableId: valueType.id,
        isMutable,
        variableType: finalType,
        right: value,
        typeValue: TypeValues.unit,
        frameLevel: getEnvCurrentFrameLevel(env),
        env,
        token: tokens[letTokenIndex],
      },
      index,
    };
  }

  private parseReadWriteExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (
      tokens[index].type !== TokenType.Read &&
      tokens[index].type !== TokenType.Write
    ) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "read" or "write"'
      );
    }
    const readWriteTokenIndex = index;
    index = index + 1;

    const isRead = tokens[readWriteTokenIndex].type === TokenType.Read;

    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    env = expr.env;

    const newTypeValue: Type = {
      ...expr.typeValue,
    };
    if (newTypeValue.permission === "read") {
      if (!isRead) {
        throw this.formatErrorMessage(
          tokens[readWriteTokenIndex],
          `Cannot write to a read-only value:
${exprToString(expr)}`
        );
      }
    }
    if (
      isRead === false // write
    ) {
      // Check if the value is mutable
      if (
        ("isMutable" in expr && !expr.isMutable) ||
        expr.typeValue.permission === "read"
      ) {
        throw this.formatErrorMessage(
          tokens[readWriteTokenIndex],
          `Cannot "write" to an immutable value:
${exprToString(expr)}`
        );
      }
    }
    newTypeValue.permission = isRead ? "read" : "write";
    // newTypeValue.kind = "Free";

    // Check if the value is consumed
    try {
      // It's accessing a Free type, so no need to consume.
      // But we need to check if the variable is consumed.
      this.trySettingVariableAsReference({
        env,
        expr,
        isMutableReference: false,
        isForAssignment: false,
      });
    } catch (error) {
      throw formatErrorMessage({
        modulePath: this.modulePath,
        inputString: this.inputString,
        token: expr.token,
        errorMessage: `Cannot access the value below because "${exprToString(
          expr
        )}" is already consumed:
${exprToString(expr)}`,
        cause: error,
      });
    }

    // Increase the reference count
    const { env: nextEnv, referedVariable } =
      this.increaseVariableReferenceCount({
        env,
        expr,
        isMutableReference: !isRead,
        isForAssignment: false,
      });
    // Create temp variable for holding the value
    const { env: nextNextEnv, value: tempVariable } =
      this.generateTempVariableForHoldingValue({
        env: nextEnv,
        token: tokens[readWriteTokenIndex],
        valueType: newTypeValue,
        referedVariable,
      });

    return {
      expr: {
        type: AstType.ReadWrite,
        typeValue: newTypeValue,
        env: nextNextEnv,
        token: tokens[readWriteTokenIndex],
        expr,
        permission: isRead ? "read" : "write",
        tempVariableName: tempVariable.variableName,
      },
      index,
    };
  }

  private destructureRecordType({
    env,
    destructurings,
    value,
    recordType,
  }: {
    env: Environment;
    destructurings: Destructuring[];
    value: Expr;
    recordType: TRecord;
  }): Environment {
    const destructuredLinearFields: string[] = [];
    // Check if the type of `value` matches the type of destructurings
    for (let i = 0; i < destructurings.length; i++) {
      const { name, asName, isMutable } = destructurings[i];
      const property = recordType.properties.find((p) => p.name === name);
      if (!property) {
        throw this.formatErrorMessage(
          destructurings[i].token,
          `Cannot find the property \`${name}\` in the following type:
${typeToString(recordType, { extractTypeConstructor: true })}`
        );
      }
      const propertyType = property.type;

      if (
        "isMutable" in value &&
        !value.isMutable &&
        isMutable &&
        propertyType.kind !== "Free"
      ) {
        throw formatErrorMessages({
          modulePath: this.modulePath,
          inputString: this.inputString,
          tokenAndErrorList: [
            {
              token: destructurings[i].token,
              errorMessage: `Cannot destructure an immutable value with mutable field "${name}"`,
            },
            {
              token: value.token,
              errorMessage: `Immutable value is defined here:`,
            },
          ],
        });
      }

      // Add variable to env
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: asName ?? name,
          type: propertyType,
          kind: "value",
          isMutable: isMutable,
          token: destructurings[i].token,
        },
        preventDuplicate: true,
      });
      env = nextEnv;

      if (propertyType.kind === "Linear" || propertyType.kind === "Type") {
        destructuredLinearFields.push(name);
      }
    }

    // Check if all linear fields are destructured
    const hasLinearField = recordType.properties.some(
      (p) => p.type.kind === "Linear" || p.type.kind === "Type"
    );
    if (destructuredLinearFields.length > 0) {
      for (const property of recordType.properties) {
        if (
          (property.type.kind === "Linear" || property.type.kind === "Type") &&
          !destructuredLinearFields.includes(property.name)
        ) {
          throw this.formatErrorMessage(
            destructurings[0].token,
            `The Linear field "${property.name}" needs to be destructured
  because the following Linear fields are destructured:
  ${destructuredLinearFields.map((x) => `"${x}"`).join(", ")}`
          );
        }
      }
    } else {
      // Check if all linear fields are consumed
      const linearFields = recordType.properties.filter(
        (p) => p.type.kind === "Linear" || p.type.kind === "Type"
      );
      if (linearFields.length > 0) {
        throw this.formatErrorMessage(
          destructurings[0].token,
          `The following Linear fields need to be destructured:
${linearFields.map((x) => `"${x.name}"`).join(", ")}`
        );
      }
    }

    if (hasLinearField) {
      // Consumes the value
      const { env: nextEnv } = this.setVariableAsConsumed(env, value);
      env = nextEnv;
    }

    return env;
  }

  private destructureValue({
    destructurings,
    value,
    env,
    tokens,
    index,
    isMutable,
    curlyBracketTokenIndex,
  }: {
    destructurings: Destructuring[];
    value: Expr;
    env: Environment;
    tokens: Token[];
    index: number;
    isMutable: boolean;
    curlyBracketTokenIndex: number;
    isReference?: "&" | "&!";
  }): ParserReturn {
    const valueType = value.typeValue;
    switch (valueType.type) {
      case "Record": {
        env = this.destructureRecordType({
          env,
          destructurings,
          value,
          recordType: valueType,
        });
        break;
      }
      case "TypeConstructor": {
        /*
        if (typeIsReferenceOrMutableReference(valueType)) {
          env = this.increaseVariableReferenceCount({
            env,
            expr: value,
            isMutableReference: true,
            isForAssignment: true,
          }).env;
          
        }*/

        if (valueType.typeValue.type !== "Record") {
          throw this.formatErrorMessage(
            tokens[index],
            `Cannot destructure the following type:
  ${typeToString(valueType)}`
          );
        }
        env = this.destructureRecordType({
          env,
          destructurings,
          value,
          recordType: valueType.typeValue,
        });
        break;
      }
      case "Enum": {
        if (!valueType.selectedVariantName) {
          throw this.formatErrorMessage(
            tokens[index],
            `Cannot destructure the following enum because no variant is selected:
${typeToString(valueType)}`
          );
        } else {
          const variant = valueType.variants.find(
            (v) => v.name === valueType.selectedVariantName
          );
          if (!variant) {
            throw this.formatErrorMessage(
              tokens[index],
              `Cannot find the variant "${
                valueType.selectedVariantName
              }" in the following type:
${typeToString(valueType)}`
            );
          }
          const destructuredLinearFields: string[] = [];
          // Check if the type of `value` matches the type of destructurings
          for (let i = 0; i < destructurings.length; i++) {
            const { name, asName, isMutable } = destructurings[i];
            const property = variant.parameterTypes.find(
              (p) => p.name === name
            );
            if (!property) {
              throw this.formatErrorMessage(
                tokens[index],
                `Cannot find the property \`${name}\` in the following type:
${typeToString(valueType, { extractTypeConstructor: true })}`
              );
            }
            const propertyType = property.type;

            if (
              "isMutable" in value &&
              !value.isMutable &&
              isMutable &&
              propertyType.kind !== "Free"
            ) {
              throw this.formatErrorMessage(
                tokens[index],
                `Cannot destructure an immutable enum with mutable field "${name}"`
              );
            }

            // Add variable to env
            const { env: nextEnv } = addEnvValueType({
              env,
              valueType: {
                variableName: asName ?? name,
                type: propertyType,
                kind: "value",
                isMutable: isMutable,
                token: destructurings[i].token,
              },
              preventDuplicate: true,
            });
            env = nextEnv;

            if (propertyType.kind === "Linear") {
              destructuredLinearFields.push(name);
            }
          }

          // Check if all linear fields are destructured
          if (destructuredLinearFields.length > 0) {
            for (const property of variant.parameterTypes) {
              if (
                property.type.kind === "Linear" &&
                !destructuredLinearFields.includes(property.name)
              ) {
                throw this.formatErrorMessage(
                  tokens[index - 1],
                  `The linear field "${property.name}" needs to be destructured
because the following Linear fields are destructured:
${destructuredLinearFields.map((x) => `"${x}"`).join(", ")}`
                );
              }
            }
          }
        }
        break;
      }
      default: {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot destructure the following type:
${typeToString(valueType)}`
        );
      }
    }

    return {
      expr: {
        type: AstType.DestructuringAssignment,
        left: destructurings,
        right: value,
        isMutable,
        env,
        typeValue: TypeValues.unit,
        token: tokens[curlyBracketTokenIndex],
      },
      index,
    };
  }

  private parseDestructuringAssignmentExpression({
    tokens,
    index,
    env,
    caller,
    parserData,
    isMutable,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isMutable: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for destructuring assignment"
      );
    }
    const curlyBracketTokenIndex = index;
    index = index + 1;

    const destructurings: Destructuring[] = [];
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '}' for destructuring assignment"
        );
      }

      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      let isMutable_ = isMutable;
      if (tokens[index].type === TokenType.Var) {
        isMutable_ = true;
        index = index + 1;
      }

      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for the field."
        );
      }
      const name = tokens[index].value;
      let nameToken = tokens[index];
      index = index + 1;

      let asName: string | undefined = undefined;
      if (tokens[index].type === TokenType.As) {
        index = index + 1;
        if (tokens[index].type !== TokenType.Identifier) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected identifier for new name of the field."
          );
        }
        asName = tokens[index].value;
        nameToken = tokens[index];
        index = index + 1;
      }

      destructurings.push({
        name,
        asName,
        isMutable: isMutable_,
        token: nameToken,
      });

      if (tokens[index].type === TokenType.Comma) {
        index = index + 1;
      }
    }

    if (tokens[index].type !== TokenType.Assign) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '=' for destructuring assignment"
      );
    }
    index = index + 1;

    const { expr: value, index: nextIndex } = this.parseExpression({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;

    return this.destructureValue({
      destructurings,
      value,
      env,
      tokens,
      index,
      curlyBracketTokenIndex,
      isMutable,
    });
  }

  private parseTypeAlias({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Type) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "type" for type alias'
      );
    }
    const typeTokenIndex = index;
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for type alias"
      );
    }
    const typeName = tokens[index].value;
    const typeNameTokenIndex = index;
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
    const { env: nextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: typeName,
        type: {
          type: "unknown",
          kind: "Free",
          permission: "own",
          typeName,
        },
        kind: "type",
        isExported,
        token: tokens[typeNameTokenIndex],
      },
    });
    env = nextEnv;

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
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
      permission: "own",
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
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
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
          `Cannot set ${typeName} as 'Free' because below is '${kind}':
${typeToString(nextTypeValue)}`
        );
      } else if (
        userDefinedKind &&
        userDefinedKind === "Linear" &&
        kind === "Type"
      ) {
        throw this.formatErrorMessage(
          tokens[userDefinedKindTokenIndex],
          `Cannot set ${typeName} as 'Linear' because it contains '${kind}' data.`
        );
      } else if (userDefinedKind === "Type" && kind === "Linear") {
        throw this.formatErrorMessage(
          tokens[userDefinedKindTokenIndex],
          `Cannot set ${typeName} as 'Type' because below is 'Linear':
${typeToString(nextTypeValue)}`
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
        permission: "own",
      };
    }

    const typeConstructor: TTypeConstructor = {
      type: "TypeConstructor",
      kind,
      permission: "own",
      name: typeName,
      typeConstructorId: generateValueTypeId(env, typeName),
      typeParameters,
      regionParameters,
      typeValue,
    };

    const { env: nextNextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: typeName,
        type: typeConstructor,
        kind: "type",
        isExported,
        token: tokens[typeNameTokenIndex],
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;

    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.TypeAlias,
        typeName,
        typeValue: typeConstructor,
        env,
        token: tokens[typeTokenIndex],
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
  private parseClassExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Class) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "class" for typeclass declaration'
      );
    }
    const classTokenIndex = index;
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected identifier for "class"'
      );
    }
    const typeclassName = tokens[index].value;
    const classNameTokenIndex = index;
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
    const { env: nextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: typeclassName,
        type: {
          type: "unknown",
          kind: "Free",
          permission: "own",
          typeName: typeclassName,
        },
        kind: "type",
        isExported,
        token: tokens[classNameTokenIndex],
      },
    });
    env = nextEnv;

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
      });
      index = nextIndex;
      typeParameters = tp;
      regionParameters = rp;
      env = nextEnv;
    }

    // QUESTION: Does `extends` work for typeclass?
    // Should we use `with` instead?
    const functions: TClassFunction[] = [];
    const functionNameTokens: Token[] = [];
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

      let functionNameTokenIndex = index;
      let functionName = tokens[index].value;
      let functionTypeTokenIndex = index + 2;
      if (
        tokens[index].type === TokenType.Identifier &&
        tokens[index + 1].type === TokenType.Colon
      ) {
        // already set
      } else if (
        tokens[index].type === TokenType.LParen &&
        tokens[index + 1].type === TokenType.Operator &&
        tokens[index + 2].type === TokenType.RParen &&
        tokens[index + 3].type === TokenType.Colon
      ) {
        functionNameTokenIndex = index + 1;
        functionName = tokens[index + 1].value;
        functionTypeTokenIndex = index + 4;
      } else {
        throw this.formatErrorMessage(
          tokens[index],
          `Please define functions in "class" like below:
    
    class Show<T> {
      show: (x: T)-> string;
    }
              `
        );
      }
      functionNameTokens.push(tokens[functionNameTokenIndex]);

      // Parse function type
      const {
        env: nextEnv,
        index: nextIndex,
        typeValue: functionType,
      } = synthesizeFunctionTypeFromTokens({
        tokens,
        index: functionTypeTokenIndex,
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
        withFunctionBody: false,
      });
      index = nextIndex;
      env = nextEnv;

      if (functionType.typeParameters.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Type parameters are not allowed in class functions as it uses the type parameters defined in the class itself:

${typeToString(functionType)}
`
        );
      }
      // Add the typeParameters and regionParameters of the class to the functionType
      functionType.typeParameters = typeParameters;
      functionType.regionParameters = regionParameters;

      let functionExpr: FunctionExpr | undefined = undefined;
      if (tokens[index].type === TokenType.LCurlyBracket) {
        // There is a function body
        const { expr: functionExpr_, index: nextIndex } =
          this.parseAnonymousFunction({
            tokens,
            index: functionTypeTokenIndex,
            env,
            caller,
            parserData,
            functionName,
          });
        index = nextIndex;
        functionExpr = functionExpr_ as FunctionExpr;
        functionExpr.typeValue = functionType;
      }

      // Check if the function name is already defined in the class
      if (functions.some((func) => func.name === functionName)) {
        throw this.formatErrorMessage(
          tokens[functionNameTokenIndex],
          `Function "${functionName}" is already defined in the class`
        );
      }

      // functionType.typeParameters = typeParameters; // NOTE: This is wrong
      functions.push({
        name: functionName,
        func: functionType,
        functionExpr,
      });

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
        continue;
      }
    }

    const class_: TClass = {
      type: "Class",
      kind: "Free",
      permission: "own",
      name: typeclassName,
      classId: generateValueTypeId(env, typeclassName),
      typeParameters,
      regionParameters,
      functions,
      isInstance: false,
    };

    // Add to environment
    const { env: nextNextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: typeclassName,
        type: TypeValues.unit,
        class: class_,
        kind: "class",
        isExported,
        token: tokens[classNameTokenIndex],
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;

    // add pre-defined functions to env
    for (let i = 0; i < functions.length; i++) {
      const func = functions[i];
      if (func.functionExpr) {
        const { env: nextEnv } = addEnvValueType({
          env,
          valueType: {
            variableName: func.name,
            type: func.func,
            kind: "value",
            isExported,
            token: functionNameTokens[i],
          },
          deltaFrame: -1,
        });
        env = nextEnv;
      }
    }

    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.Class,
        class: class_,
        typeValue: TypeValues.unit,
        env,
        token: tokens[classTokenIndex],
      },
      index,
    };
  }

  private parseInstanceExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Instance) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "instance" for instance'
      );
    }
    const instanceTokenIndex = index;
    index = index + 1;

    // NOTE: This is necessary for type parameters:
    env = pushEnvFrame(env);

    // Instance type parameters
    const instanceTypeParameters: TTypeParameter[] = [];
    const instanceRegionParameters: TRegionParameter[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
      });
      index = nextIndex;
      instanceTypeParameters.push(...tp);
      instanceRegionParameters.push(...rp);
      env = nextEnv;
    }

    if (tokens[index].type !== TokenType.Identifier) {
      // FIXME: Allow module access
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for instance"
      );
    }
    const typeclassName = tokens[index].value;
    const classNameTokenIndex = index;
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
    const typeclass = typeclasses[0].class;
    if (!typeclass) {
      throw this.formatErrorMessage(
        tokens[index],
        `Cannot find class "${typeclassName}"`
      );
    }

    const class_: TClass = {
      ...typeclass,
      instanceRegionParameters,
      instanceTypeParameters,
      isInstance: true,
    };

    // Parse class type arguments
    let typeArguments: Type[] = [];
    let regionArguments: Region[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeArguments: nextTypeArguments,
        regionArguments: nextRegionArguments,
        env: nextEnv,
      } = synthesizeTypeAndRegionArgumentsFromTokens({
        tokens,
        index,
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
      });
      index = nextIndex;
      typeArguments = nextTypeArguments;
      regionArguments = nextRegionArguments;
      env = nextEnv;
    }

    // Apply type arguments to typeclass
    const newClass = applyTypeAndRegionArgumentsToClass({
      env,
      class_,
      typeArguments,
      regionArguments,
      typeParameterToTypeArgumentMap: {},
      regionParameterToRegionArgumentMap: {},
    }) as TClass;

    // Parse typeclass body
    const functions: TClassFunction[] = [];
    const functionNameTokens: Token[] = [];
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

      let functionNameTokenIndex = index;
      let functionName = tokens[index].value;
      let functionTypeTokenIndex = index + 2;
      if (
        tokens[index].type === TokenType.Identifier &&
        tokens[index + 1].type === TokenType.Colon
      ) {
        // already set
      } else if (
        tokens[index].type === TokenType.LParen &&
        tokens[index + 1].type === TokenType.Operator &&
        tokens[index + 2].type === TokenType.RParen &&
        tokens[index + 3].type === TokenType.Colon
      ) {
        functionNameTokenIndex = index + 1;
        functionName = tokens[index + 1].value;
        functionTypeTokenIndex = index + 4;
      } else {
        throw this.formatErrorMessage(
          tokens[functionNameTokenIndex],
          `Please define functions in "instance" like below:

instance Show<T> {
  show: (x: T)-> string {
    // ...
  };
}
          `
        );
      }
      functionNameTokens.push(tokens[functionNameTokenIndex]);

      // Parse the function
      const { expr: functionExpr_, index: nextIndex } =
        this.parseAnonymousFunction({
          tokens,
          index: functionTypeTokenIndex,
          env,
          caller,
          parserData,
          functionName,
        });
      index = nextIndex;
      const functionExpr = functionExpr_ as FunctionExpr;
      const functionType = functionExpr.typeValue;

      if (functionType.typeParameters.length > 0) {
        throw this.formatErrorMessage(
          functionExpr.token,
          `Type parameters are not allowed in class functions as it uses the type parameters defined in the class itself:

${typeToString(functionType)}
`
        );
      }

      functions.push({
        name: functionName,
        func: functionType,
        functionExpr,
      });

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
        continue;
      }
    }

    // Check if all functions in class are implemented correctly
    for (const typeclassFunction of newClass.functions) {
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
    newClass.functions = functions;

    // Add each function to env
    for (let i = 0; i < functions.length; i++) {
      const func = functions[i];
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: func.name,
          type: func.func,
          kind: "value",
          isExported,
          token: functionNameTokens[i],
        },
        deltaFrame: -1,
      });
      env = nextEnv;
    }

    // Add instance to environment
    const { env: nextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: typeclassName,
        type: TypeValues.unit,
        class: newClass,
        kind: "value", // NOTE: We need to set it to "value" instead of "class" because we need to use it as a value
        isExported,
        token: tokens[classNameTokenIndex],
      },
      deltaFrame: -1,
    });
    env = nextEnv;
    env = popEnvFrame(env);

    return {
      expr: {
        type: AstType.Class,
        typeValue: TypeValues.unit,
        class: newClass,
        env,
        token: tokens[instanceTokenIndex],
      },
      index,
    };
  }

  private parseEffectExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Effect) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "effect" for effect declaration'
      );
    }
    const effectTokenIndex = index;
    index = index + 1;

    if (tokens[index].type !== TokenType.Identifier) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected identifier for effect name"
      );
    }
    const effectName = tokens[index].value;
    const effectNameTokenIndex = index;
    index = index + 1;

    // effectName has to be UpperCamelCase
    if (!isUpperCamelCase(effectName)) {
      throw this.formatErrorMessage(
        tokens[index - 1],
        "Effect name has to be UpperCamelCase"
      );
    }

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
      });
      index = nextIndex;
      typeParameters = tp;
      regionParameters = rp;
      env = nextEnv;
    }

    const fakeEffect: TEffect = {
      effectName,
      effectId: generateValueTypeId(env, effectName),
      operations: [],
      type: "Effect",
      regionParameters: regionParameters,
      typeParameters: typeParameters,
    };
    const { env: nextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: effectName,
        type: {
          type: "unknown",
          kind: "Free",
          permission: "own",
          typeName: effectName,
        },
        effect: fakeEffect,
        kind: "effect",
        isExported,
        token: tokens[effectNameTokenIndex],
      },
    });
    env = nextEnv;

    // Parse effect body
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for effect body"
      );
    }
    index = index + 1;
    const operations: TEffectOperation[] = [];
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '}' for effect body"
        );
      }

      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for effect operation"
        );
      }
      const operationName = tokens[index].value;
      const operationNameTokenIndex = index;
      index = index + 1;

      if (tokens[index].type !== TokenType.Colon) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected ':' for effect operation type"
        );
      }
      index = index + 1;

      // parse function type
      const {
        index: nextIndex,
        typeValue: functionType,
        env: nextEnv,
      } = synthesizeFunctionTypeFromTokens({
        tokens,
        index,
        env,
        parseExpression: this.makeParseExpression({ caller, parserData }),
        withFunctionBody: false,
      });
      index = nextIndex;
      env = nextEnv;

      if (functionType.typeParameters.length > 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Type parameters are not allowed in effect operations as it uses the type parameters defined in the effect itself`
        );
      }
      if (!functionType.effects.some((e) => checkEffect(fakeEffect, e, env))) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          `Effect operations must use the effect "${effectName}".
Please consider adding the effect to the function type like below:

${operationName}: ${typeToString(
            {
              ...functionType,
              effects: [fakeEffect, ...functionType.effects],
            },
            { hideTypeParameterKind: true }
          )};
`
        );
      }

      functionType.typeParameters = typeParameters;
      functionType.regionParameters = regionParameters;

      // Check if there is already an operation with the same name
      if (operations.some((op) => op.name === operationName)) {
        throw this.formatErrorMessage(
          tokens[operationNameTokenIndex],
          `There is already an operation with the same name "${operationName}"`
        );
      }

      operations.push({
        name: operationName,
        func: functionType,
      });

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
        continue;
      }
    }

    // Add to environment
    const effectType: TEffect = {
      type: "Effect",
      effectName,
      effectId: fakeEffect.effectId,
      operations,
      regionParameters,
      typeParameters,
    };
    const { env: nextNextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: effectName,
        type: TypeValues.unit,
        effect: effectType,
        kind: "effect",
        isExported,
        token: tokens[effectNameTokenIndex],
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;
    env = popEnvFrame(env);
    return {
      expr: {
        type: AstType.Effect,
        effect: effectType,
        typeValue: TypeValues.unit,
        env,
        token: tokens[effectTokenIndex],
      },
      index,
    };
  }

  private parseEnum({
    tokens,
    index,
    env,
    caller,
    parserData,
    isExported,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
    isExported?: boolean;
  }): ParserReturn {
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
    const enumNameTokenIndex = index;
    index = index + 1;

    // NOTE: This is necessary for type parameters and recursive type alias
    env = pushEnvFrame(env);
    const { env: nextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: enumName,
        type: {
          type: "unknown",
          kind: "Free",
          permission: "own",
          typeName: enumName,
        },
        kind: "type",
        isExported,
        token: tokens[enumNameTokenIndex],
      },
    });
    env = nextEnv;

    // Type parameters
    let typeParameters: TTypeParameter[] = [];
    let regionParameters: TRegionParameter[] = [];
    if (tokens[index].value === "<") {
      const {
        index: nextIndex,
        typeParameters: tp,
        regionParameters: rp,
        env: nextEnv,
      } = synthesizeTypeAndRegionParametersFromTokens({
        tokens,
        index,
        env,
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
    const enumVariantTokenIndexes: number[] = [];
    while (true) {
      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for enum value"
        );
      }
      const enumVariantName = tokens[index].value;
      enumVariantTokenIndexes.push(index);
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
          parseExpression: this.makeParseExpression({ caller, parserData }),
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

      if (
        tokens[index].type === TokenType.Semicolon ||
        tokens[index].type === TokenType.Comma
      ) {
        index = index + 1;
        continue;
      }
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
        `Cannot set ${enumName} as 'Free' because its variants contain '${kind}' data.`
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
    } else if (
      userDefinedKind &&
      userDefinedKind === "Type" &&
      kind === "Linear"
    ) {
      throw this.formatErrorMessage(
        tokens[userDefinedKindTokenIndex],
        `Cannot set ${enumName} as 'Type' because its variants contain 'Linear' data.`
      );
    } else {
      kind = userDefinedKind ? userDefinedKind : kind;
    }

    const enumType: TEnum = {
      type: "Enum",
      kind,
      permission: "own",
      enumName,
      typeParameters,
      regionParameters,
      variants: enumVariants,
      selectedVariantName:
        enumVariants.length === 1 ? enumVariants[0].name : undefined,
    };

    // Add to environment
    const { env: nextNextEnv } = addEnvValueType({
      env,
      valueType: {
        variableName: enumName,
        type: enumType,
        kind: "type",
        isExported,
        token: tokens[enumNameTokenIndex],
      },
      deltaFrame: -1,
    });
    env = nextNextEnv;
    env = popEnvFrame(env);

    // Add enum variants to environment
    for (let i = 0; i < enumType.variants.length; i++) {
      const variant = enumType.variants[i];
      const newEnumType: TEnum = {
        ...enumType,
        selectedVariantName: variant.name,
      };
      const { env: nextEnv } = addEnvValueType({
        env,
        valueType: {
          variableName: variant.name,
          type: newEnumType,
          kind: "value",
          isExported,
          // isExported: false, // We use special syntax to access enum variants
          // eg: import { Option { Some, None } } from "std/option"
          token: tokens[enumVariantTokenIndexes[i]],
        },
      });
      env = nextEnv;
    }

    return {
      expr: {
        type: AstType.Enum,
        enumName,
        typeValue: enumType,
        env,
        token: tokens[enumTokenIndex],
      },
      index,
    };
  }

  /*
  private parseReferenceExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].value !== "&" && tokens[index].value !== "&!") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '&' or '&!' for reference expression"
      );
    }
    const referenceTokenIndex = index;
    const isMutableReference = tokens[index].value === "&!";
    index = index + 1;

    const valueTokenIndex = index;
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    env = expr.env;

    switch (expr.type) {
      case AstType.Variable: {
        const variableName = expr.variableName;
        const variableType = expr.typeValue;
        if (
          !expr.isMutable &&
          typeIsReferenceOrMutableReference(expr.typeValue) !== "&!" &&
          isMutableReference
        ) {
          throw this.formatErrorMessage(
            tokens[valueTokenIndex],
            `Cannot create mutable reference to immutable variable "${variableName}"`
          );
        }

        const { env: nextEnv, referedVariable } =
          this.increaseVariableReferenceCount({
            env,
            expr,
            isMutableReference,
          });
        env = nextEnv;

        // save the reference value to a temporary variable
        const referenceType: TTypeConstructor = {
          ...(isMutableReference
            ? TypeValues.MutableReference
            : TypeValues.Reference),
          typeParameters: [
            {
              type: "TypeParameter",
              kind: "Type",
              permission: "own",
              name: "T",
              appliedType: variableType,
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
        };
        const { value: tempVariable, env: nextNextEnv } =
          this.generateTempVariableForHoldingValue({
            env,
            token: tokens[referenceTokenIndex],
            valueType: referenceType,
            referedVariable,
          });
        env = nextNextEnv;

        return {
          expr: {
            type: AstType.Reference,
            expr,
            isMutableReference: isMutableReference,
            typeValue: referenceType,
            env,
            token: tokens[referenceTokenIndex],
            tempVariableName: tempVariable.variableName,
          },
          index,
        };
      }
      case AstType.PropertyAccess:
      case AstType.IndexAccess: {
        console.log("-here: ", typeToString(expr.typeValue));
        if (
          !expr.isMutable &&
          typeIsReferenceOrMutableReference(expr.typeValue) !== "&!" &&
          isMutableReference
        ) {
          throw this.formatErrorMessage(
            tokens[valueTokenIndex],
            `Cannot create mutable reference to immutable value "${exprToString(
              expr
            )}"`
          );
        }

        const { env: nextEnv, referedVariable } =
          this.increaseVariableReferenceCount({
            env,
            expr,
            isMutableReference,
          });
        env = nextEnv;

        // save the reference value to a temporary variable
        const appliedTypeValue = expr.typeValue;
        const referenceType: TTypeConstructor = {
          ...(isMutableReference
            ? TypeValues.MutableReference
            : TypeValues.Reference),
          typeParameters: [
            {
              type: "TypeParameter",
              kind: "Type",
              permission: "own",
              name: "T",
              appliedType: appliedTypeValue,
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
        };

        const { value: tempVariable, env: nextNextEnv } =
          this.generateTempVariableForHoldingValue({
            env,
            token: tokens[referenceTokenIndex],
            valueType: referenceType,
            referedVariable,
          });
        env = nextNextEnv;

        return {
          expr: {
            type: AstType.Reference,
            expr,
            isMutableReference: isMutableReference,
            typeValue: referenceType,
            env,
            token: tokens[referenceTokenIndex],
            tempVariableName: tempVariable.variableName,
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

  private parseDereferenceExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].value !== "*") {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '*' for dereference expression"
      );
    }
    const dereferenceTokenIndex = index;
    index = index + 1;

    const valueTokenIndex = index;
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    env = expr.env;

    if (!typeIsReferenceOrMutableReference(expr.typeValue)) {
      throw this.formatErrorMessage(
        tokens[valueTokenIndex],
        `Cannot dereference non-reference type: ${typeToString(
          expr.typeValue
        )}\n${exprToString(expr)}`
      );
    }
    const referenceTypeValue = expr.typeValue as TTypeConstructor;
    const referenceAppliedType =
      referenceTypeValue.typeParameters[0]?.appliedType;
    if (!referenceAppliedType) {
      throw this.formatErrorMessage(
        tokens[valueTokenIndex],
        `Cannot dereference reference to unknown type`
      );
    }

    // Next token is =. This expression is for assignment
    if (tokens[index].type === TokenType.Assign) {
      if (referenceTypeValue.name !== "&!") {
        throw this.formatErrorMessage(
          tokens[valueTokenIndex],
          `Cannot update value to an immutable reference.`
        );
      }
    } else if (
      (referenceAppliedType.kind === "Linear" ||
        referenceAppliedType.kind === "Type") &&
      !typeIsReferenceOrMutableReference(referenceAppliedType)
    ) {
      throw this.formatErrorMessage(
        tokens[valueTokenIndex],
        `Cannot dereference Linear type: ${typeToString(
          referenceAppliedType
        )}\n${exprToString(expr)}`
      );
    }

    switch (expr.type) {
      case AstType.Variable:
      case AstType.Reference:
      case AstType.Dereference:
      case AstType.PropertyAccess: {
        return {
          expr: {
            type: AstType.Dereference,
            expr,
            typeValue: referenceAppliedType,
            env,
            token: tokens[dereferenceTokenIndex],
          },
          index,
        };
      }
      default: {
        throw this.formatErrorMessage(
          tokens[index],
          `Unable to dereference:
${exprToString(expr)}`
        );
      }
    }
  }
  */

  private parseTryExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Try) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "try" for try expression'
      );
    }
    const tryTokenIndex = index;
    index = index + 1;
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for try expression"
      );
    }

    const rCurlyBracketIndex = this.findTokenIndexForRBracket(tokens, index);
    if (rCurlyBracketIndex < 0) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '}' for try expression"
      );
    }

    index = rCurlyBracketIndex + 1;
    env = pushEnvFrame(env);
    const effectHandlers: TEffect[] = [];
    const effectOperationStartTokenIndexes: number[] = [];
    // const parserDataListToCheckForAbort: ParserData[] = [];
    const withTokenIndex = index;
    let endTryWithTokenIndex = index;
    while (true) {
      if (!tokens[index] || tokens[index].type !== TokenType.With) {
        endTryWithTokenIndex = index;
        break;
      }
      index = index + 1;

      if (tokens[index].type !== TokenType.Identifier) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for effect name"
        );
      }
      const effectName = tokens[index].value;

      // Find the effect from env
      const effects = getEnvValueTypesByVariableName(env, effectName, "effect");
      if (effects.length === 0) {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot find effect "${effectName}"`
        );
      } else if (effects.length > 1) {
        throw this.formatErrorMessage(
          tokens[index],
          `Found multiple effects with the same name "${effectName}"`
        );
      }
      const effect = effects[0].effect;
      if (!effect) {
        throw this.formatErrorMessage(
          tokens[index],
          `Cannot find effect "${effectName}"`
        );
      }
      index = index + 1;

      // Parse effect type arguments
      let typeArguments: Type[] = [];
      let regionArguments: Region[] = [];
      if (tokens[index].value === "<") {
        const {
          index: nextIndex,
          typeArguments: nextTypeArguments,
          regionArguments: nextRegionArguments,
          env: nextEnv,
        } = synthesizeTypeAndRegionArgumentsFromTokens({
          tokens,
          index,
          env,
          parseExpression: this.makeParseExpression({ caller, parserData }),
        });
        index = nextIndex;
        typeArguments = nextTypeArguments;
        regionArguments = nextRegionArguments;
        env = nextEnv;
      }

      // Apply type arguments to effect
      const newEffect = applyTypeAndRegionArgumentsToEffect({
        env,
        effect,
        typeArguments,
        regionArguments,
        typeParameterToTypeArgumentMap: {},
        regionParameterToRegionArgumentMap: {},
      });

      // Parse effect body
      const operations: TEffectOperation[] = [];
      const operationTokens: Token[] = [];
      if (tokens[index].type !== TokenType.LCurlyBracket) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected '{' for effect body"
        );
      }
      index = index + 1;
      while (true) {
        if (!tokens[index]) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '}' for effect body"
          );
        }

        if (tokens[index].type === TokenType.RCurlyBracket) {
          index = index + 1;
          break;
        }

        if (tokens[index].type !== TokenType.Identifier) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected identifier for effect operation"
          );
        }
        const operationName = tokens[index].value;
        operationTokens.push(tokens[index]);
        index = index + 1;

        if (tokens[index].type !== TokenType.Colon) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected ':' for effect operation type"
          );
        }
        index = index + 1;

        // NOTE: We only parse the function signature here.
        // We parse its body after we finish parsing the try body.
        // parse function signature
        effectOperationStartTokenIndexes.push(index);
        const { index: nextIndex, typeValue: functionType } =
          synthesizeFunctionTypeFromTokens({
            tokens,
            index,
            env,
            parseExpression: this.makeParseExpression({ caller, parserData }),
            withFunctionBody: false,
          });
        index = nextIndex;
        operations.push({
          name: operationName,
          func: functionType,
          functionExpr: undefined,
        });
        if (tokens[index].type !== TokenType.LCurlyBracket) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '{' for effect operation body"
          );
        }
        // Find the end of the function body
        const rCurlyBracketIndex = this.findTokenIndexForRBracket(
          tokens,
          index
        );
        if (rCurlyBracketIndex < 0) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected '}' for effect operation body"
          );
        }
        index = rCurlyBracketIndex + 1;

        if (
          tokens[index].type === TokenType.Semicolon ||
          tokens[index].type === TokenType.Comma
        ) {
          index = index + 1;
          continue;
        }
      }

      // Check if the effect is implemented correctly
      for (let i = 0; i < newEffect.operations.length; i++) {
        const effectOperation = newEffect.operations[i];
        const matchedOperations = operations.filter(
          (operation) => operation.name === effectOperation.name
        );
        if (matchedOperations.length === 0) {
          throw this.formatErrorMessage(
            tokens[index],
            `Operation "${effectOperation.name}" is not implemented:
Expected: ${typeToString(effectOperation.func)}`
          );
        } else if (matchedOperations.length > 1) {
          throw this.formatErrorMessage(
            tokens[index],
            `Found multiple implementations for operation "${
              effectOperation.name
            }":
- ${matchedOperations
              .map((operation) => typeToString(operation.func))
              .join("\n- ")}`
          );
        } else {
          const matchedOperation = matchedOperations[0];
          if (!checkType(effectOperation.func, matchedOperation.func, env)) {
            throw this.formatErrorMessage(
              operationTokens[i],
              `Mismatched function type:
Expected: ${typeToString(effectOperation.func)}
Got:      ${typeToString(matchedOperation.func)}`
            );
          } else {
            // NOTE: Line below is wrong, because for example,
            // effectOperation.func might have effects <GiveInt, *>
            // while matchedOperation.func might have effects <GiveInt> only.
            //
            // matchedOperation.func = effectOperation.func;
          }
        }
      }

      // Add operations to env
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i];
        const { env: nextEnv } = addEnvValueType({
          env,
          valueType: {
            variableName: operation.name,
            type: operation.func,
            kind: "value",
            token: operationTokens[i],
          },
        });
        env = nextEnv;
      }

      // Add to effectHandlers
      effectHandlers.push({
        ...newEffect,
        operations,
        isHandler: true,
      });

      // Check if each operation effects matches the newCaller effects
      const newCaller: TFunction = {
        ...caller,
        effects: [...caller.effects, ...effectHandlers],
      };
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i];
        if (!checkFunctionEffects(operation.func, newCaller, env)) {
          throw this.formatErrorMessage(
            operationTokens[i],
            `Mismatched effects:
Expected: ${effectsToString(operation.func.effects)}
Got:      ${effectsToString(newCaller.effects)}`
          );
        }
      }
    }

    if (effectHandlers.length === 0) {
      throw this.formatErrorMessage(
        tokens[withTokenIndex],
        "Expected handlers."
      );
    }

    // Parse the try body
    index = tryTokenIndex + 1;
    const newCaller: TFunction = {
      ...caller,
      effects: [...caller.effects, ...effectHandlers],
    };
    const { expr: tryExpr, index: nextIndex } = this.parseBlockExpressions({
      tokens,
      index,
      env,
      caller: newCaller,
      parserData,
    });
    index = nextIndex;
    env = tryExpr.env;
    const returnType = tryExpr.typeValue;

    // Check if all abort types matches the returnType
    // Parse each effect operation body
    let it = 0;
    for (let i = 0; i < effectHandlers.length; i++) {
      const operations = effectHandlers[i].operations;
      for (let j = 0; j < operations.length; j++) {
        const operation = operations[j];
        const operationTokenIndex = effectOperationStartTokenIndexes[it];
        it = it + 1;

        // Parse the anonymous function
        const { expr: functionExpr_ } = this.parseAnonymousFunction({
          tokens,
          index: operationTokenIndex,
          env,
          caller,
          parserData,
          effectOperationAbortType: returnType,
          functionName: operation.name,
        });
        const functionExpr = functionExpr_ as FunctionExpr;
        operation.functionExpr = functionExpr;
      }
    }

    return {
      expr: {
        type: AstType.Try,
        body: tryExpr,
        effectHandlers,
        env: popEnvFrame(env),
        token: tokens[tryTokenIndex],
        typeValue: returnType,
      },
      index: endTryWithTokenIndex,
    };
  }

  private parseAwaitExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Await) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "await" for await expression'
      );
    }

    // Check if the caller is a function that returns a promise
    if (!typeIsFunctionTypeThatReturnsPromise(caller)) {
      throw this.formatErrorMessage(
        tokens[index],
        `Cannot use "await" in a function that does not return a Promise:
${typeToString(caller)}
Please consider adding "Promise" to the return type.  
`
      );
    }

    const awaitTokenIndex = index;
    index = index + 1;

    const valueTokenIndex = index;
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    env = expr.env;

    const promiseType = typeIsPromise(expr.typeValue);
    if (!promiseType) {
      throw this.formatErrorMessage(
        tokens[valueTokenIndex],
        `Cannot await non-promise type: ${typeToString(expr.typeValue)}`
      );
    }
    const valueType = promiseType.typeParameters[0]?.appliedType;
    if (!valueType) {
      throw this.formatErrorMessage(
        tokens[valueTokenIndex],
        `Cannot await promise to unknown type`
      );
    }

    // Consumes the promise
    const { env: nextNextEnv } = this.setVariableAsConsumed(env, expr);
    env = nextNextEnv;

    return {
      expr: {
        type: AstType.Await,
        env,
        expr,
        token: tokens[awaitTokenIndex],
        typeValue: valueType,
      },
      index,
    };
  }

  private parseRecurExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Recur) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "recur" for recur expression'
      );
    }
    const recurTokenIndex = index;
    index = index + 1;

    if (tokens[index].type !== TokenType.LParen) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '(' for recur expression arguments"
      );
    }

    const {
      index: nextIndex,
      env: nextEnv,
      functionArguments,
      calleeTypeValue,
    } = this.parseFunctionCallArguments({
      calleeType: caller,
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    index = nextIndex;
    env = nextEnv;

    return {
      expr: {
        type: AstType.Recur,
        env,
        functionArguments,
        token: tokens[recurTokenIndex],
        typeValue: calleeTypeValue.returnType,
      },
      index,
    };
  }

  private parseInfixPrecedenceExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
    if (
      tokens[index].type !== TokenType.Infix &&
      tokens[index].type !== TokenType.Infixl &&
      tokens[index].type !== TokenType.Infixr
    ) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected 'infix', 'infixl', or 'infixr' operator"
      );
    }
    const infixToken = tokens[index];
    index = index + 1;

    if (tokens[index].type !== TokenType.Integer) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected positive integer for infix operator precedence"
      );
    }
    const precedence = parseInt(tokens[index].value);
    if (isNaN(precedence) || precedence <= 0) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected positive integer for infix operator precedence"
      );
    }

    index = index + 1;
    if (tokens[index].type !== TokenType.Operator) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected operator for infix operator"
      );
    }
    const operator = tokens[index].value;
    index = index + 1;

    const associativity = infixToken.value as "infix" | "infixl" | "infixr";
    const nextEnv = addEnvOperatorPrecedence(
      env,
      operator,
      associativity,
      precedence
    );
    return {
      expr: {
        type: AstType.Infix,
        associativity,
        operator,
        precedence,
        env: nextEnv,
        token: infixToken,
        typeValue: TypeValues.unit,
      },
      index,
    };
  }

  private parseImportAndExportDestructurings({
    tokens,
    index,
  }: {
    tokens: Token[];
    index: number;
  }): { destructurings: Destructuring[]; index: number } {
    if (tokens[index].type !== TokenType.LCurlyBracket) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected '{' for import. Qualified import is not implemented yet"
      );
    }
    index = index + 1;
    const destructurings: Destructuring[] = [];
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(tokens[index], "Expected '}' for import");
      }

      if (tokens[index].type === TokenType.RCurlyBracket) {
        index = index + 1;
        break;
      }

      if (
        tokens[index].type !== TokenType.Identifier &&
        tokens[index].value !== "*"
      ) {
        throw this.formatErrorMessage(
          tokens[index],
          "Expected identifier for import"
        );
      }
      const nameToken = tokens[index];
      const name = nameToken.value;
      index = index + 1;

      let asName: string | undefined = undefined;
      if (tokens[index].type === TokenType.As) {
        index = index + 1;
        if (tokens[index].type !== TokenType.Identifier) {
          throw this.formatErrorMessage(
            tokens[index],
            'Expected identifier for "as"'
          );
        }
        asName = tokens[index].value;
        index = index + 1;
      }

      destructurings.push({ name, asName, isMutable: false, token: nameToken });

      if (tokens[index].type === TokenType.Comma) {
        index = index + 1;
      }
    }

    return {
      destructurings,
      index,
    };
  }

  private parseExportExpr({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Export) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "export" for export statement'
      );
    }
    const exportTokenIndex = index;
    index = index + 1;

    const token = tokens[index];
    let exportExpr: Expr | undefined = undefined;
    switch (token.type) {
      case TokenType.Let: {
        const { expr, index: nextIndex } = this.parseLetAssignment({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Extern: {
        const { expr, index: nextIndex } = this.parseExternExpr({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Type: {
        const { expr, index: nextIndex } = this.parseTypeAlias({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Class: {
        const { expr, index: nextIndex } = this.parseClassExpr({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Effect: {
        const { expr, index: nextIndex } = this.parseEffectExpr({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Instance: {
        const { expr, index: nextIndex } = this.parseInstanceExpr({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.Enum: {
        const { expr, index: nextIndex } = this.parseEnum({
          tokens,
          index,
          env,
          caller,
          parserData,
          isExported: true,
        });
        index = nextIndex;
        env = expr.env;
        exportExpr = expr;
        break;
      }
      case TokenType.LCurlyBracket: {
        // export {*} from "module.mo";
        const { destructurings, index: nextIndex } =
          this.parseImportAndExportDestructurings({
            tokens,
            index,
          });
        index = nextIndex;

        if (tokens[index].type !== TokenType.From) {
          throw this.formatErrorMessage(
            tokens[index],
            'Expected "from" for import'
          );
        }
        index = index + 1;

        if (tokens[index].type !== TokenType.String) {
          throw this.formatErrorMessage(
            tokens[index],
            "Expected string literal for the module path to import"
          );
        }
        const modulePath = tokens[index].value;
        const moduleTokenIndex = index;
        index = index + 1;

        const qualifiedName: string | undefined = undefined;
        const { env: nextEnv, module } = this.importModule({
          env,
          modulePath,
          qualifiedName,
          destructurings,
          importToken: tokens[exportTokenIndex],
          moduleToken: tokens[moduleTokenIndex],
          isExported: true,
        });

        return {
          expr: {
            type: AstType.Export,
            expr: {
              type: AstType.Import,
              modulePath,
              module,
              destructurings,
              qualifiedName,
              typeValue: TypeValues.unit,
              env: nextEnv,
              token: tokens[exportTokenIndex],
            },
            typeValue: TypeValues.unit,
            env: nextEnv,
            token: tokens[exportTokenIndex],
          },
          index,
        };
      }
      default: {
        throw this.formatErrorMessage(
          tokens[index],
          `Invalid export statement`
        );
      }
    }

    if (!exportExpr) {
      throw this.formatErrorMessage(tokens[index], `Invalid export statement`);
    }

    return {
      expr: {
        type: AstType.Export,
        expr: exportExpr,
        typeValue: TypeValues.unit,
        env,
        token: tokens[exportTokenIndex],
      },
      index,
    };
  }

  private importModule({
    env,
    modulePath,
    qualifiedName,
    destructurings,
    importToken,
    moduleToken,
    isExported,
  }: {
    env: Environment;
    modulePath: string;
    qualifiedName?: string;
    destructurings: Destructuring[];
    importToken?: Token;
    moduleToken?: Token;
    isExported?: boolean;
  }): { module: TModule; env: Environment } {
    if (modulePath.startsWith("std/")) {
      // std library
      modulePath = path.relative(
        path.dirname(this.modulePath.replace(/^file:\/\//, "")),
        path.resolve(this.stdPath, modulePath.replace("std/", "./"))
      );
    }

    if (!modulePath.startsWith(".")) {
      throw new Error("Only local relative path is supported for now");
    }
    // FIXME: Support other protocol like https://
    let moduleAbsolutePath =
      "file://" +
      path.resolve(
        path.dirname(this.modulePath.replace(/^file:\/\//, "")),
        modulePath
      );
    const extname = path.extname(moduleAbsolutePath);
    if (!extname) {
      moduleAbsolutePath = moduleAbsolutePath + ".mo";
    } else if (extname !== ".mo") {
      throw new Error("Only .mo file is supported for now");
    }
    let module: TModule | undefined = undefined;
    try {
      module = this.loadModule(moduleAbsolutePath);
    } catch (error) {
      throw formatErrorMessage({
        token: moduleToken ?? emptyToken,
        errorMessage: `Failed to load module "${moduleAbsolutePath}".`,
        inputString: this.inputString,
        modulePath: this.modulePath,
        cause: error,
      });
    }

    // Check destructurings
    if (destructurings.some((d) => d.name === "*")) {
      // Import everything
      if (destructurings.length > 1) {
        throw this.formatErrorMessage(
          destructurings[0].token ?? emptyToken,
          "Cannot import everything with other variables"
        );
      }
      if (qualifiedName) {
        throw this.formatErrorMessage(
          importToken ?? emptyToken,
          "Cannot import everything with qualified name"
        );
      }
      if (destructurings[0].asName) {
        throw this.formatErrorMessage(
          destructurings[0].token ?? emptyToken,
          'Cannot import everything with "as"'
        );
      }

      // Import values
      const moduleFrame = module.env.frames[0];
      for (const value of moduleFrame.values) {
        if (value.isExported) {
          const { env: nextEnv } = addEnvValueType({
            env,
            valueType: { ...value, isExported: !!isExported },
          });
          env = nextEnv;
        }
      }

      // Set infix precedence
      for (const operatorKey in module.env.operatorPrecedenceMap) {
        const operatorPrecedence =
          module.env.operatorPrecedenceMap[operatorKey];
        env = addEnvOperatorPrecedence(
          env,
          operatorPrecedence.operator,
          operatorPrecedence.associativity,
          operatorPrecedence.precedence
        );
      }
    } else {
      for (const destructuring of destructurings) {
        const variableName = destructuring.name;
        const values = getEnvValueTypesByVariableName(module.env, variableName);
        let importedCount = 0;
        for (const value of values) {
          if (value.isExported) {
            importedCount += 1;
            const { env: nextEnv } = addEnvValueType({
              env,
              valueType: {
                ...value,
                variableName: destructuring.asName ?? variableName,
                isExported: !!isExported,
              },
            });
            env = nextEnv;
          }
        }
        if (importedCount === 0) {
          throw this.formatErrorMessage(
            destructuring.token ?? emptyToken,
            `Cannot find exported variable "${variableName}" in module "${modulePath}"`
          );
        }
      }

      // Set infix precedence
      for (const operatorKey in module.env.operatorPrecedenceMap) {
        const operatorPrecedence =
          module.env.operatorPrecedenceMap[operatorKey];
        env = addEnvOperatorPrecedence(
          env,
          operatorPrecedence.operator,
          operatorPrecedence.associativity,
          operatorPrecedence.precedence
        );
      }
    }

    return {
      module,
      env,
    };
  }

  private parseImportExpr({
    tokens,
    index,
    env,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
  }): ParserReturn {
    if (tokens[index].type !== TokenType.Import) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "import" for import statement'
      );
    }
    const importTokenIndex = index;
    index = index + 1;

    const qualifiedName: string | undefined = undefined;

    const { destructurings, index: nextIndex } =
      this.parseImportAndExportDestructurings({
        tokens,
        index,
      });
    index = nextIndex;

    if (tokens[index].type !== TokenType.From) {
      throw this.formatErrorMessage(
        tokens[index],
        'Expected "from" for import'
      );
    }
    index = index + 1;

    if (tokens[index].type !== TokenType.String) {
      throw this.formatErrorMessage(
        tokens[index],
        "Expected string literal for the module path to import"
      );
    }
    const modulePath = tokens[index].value;
    const moduleTokenIndex = index;
    index = index + 1;

    const { env: nextEnv, module } = this.importModule({
      env,
      modulePath,
      qualifiedName,
      destructurings,
      importToken: tokens[importTokenIndex],
      moduleToken: tokens[moduleTokenIndex],
    });

    return {
      expr: {
        type: AstType.Import,
        modulePath,
        module,
        destructurings,
        qualifiedName,
        typeValue: TypeValues.unit,
        env: nextEnv,
        token: tokens[importTokenIndex],
      },
      index,
    };
  }

  private findTokenIndexForRBracket(tokens: Token[], index: number): number {
    let endBracketType = TokenType.RParen;
    const startBracketType = tokens[index].type;
    if (startBracketType === TokenType.LCurlyBracket) {
      endBracketType = TokenType.RCurlyBracket;
    } else if (startBracketType === TokenType.LParen) {
      endBracketType = TokenType.RParen;
    } else if (startBracketType === TokenType.LBracket) {
      endBracketType = TokenType.RBracket;
    } else {
      throw this.formatErrorMessage(tokens[index], "Expected '{', '(' or '['");
    }
    index = index + 1;
    let count = 1;
    let endIndex = -1;
    while (true) {
      if (!tokens[index]) {
        throw this.formatErrorMessage(
          tokens[index - 1],
          `Expected '${endBracketType}'`
        );
      }

      if (tokens[index].type === endBracketType) {
        count = count - 1;
        if (count === 0) {
          endIndex = index;
          break;
        }
      } else if (tokens[index].type === startBracketType) {
        count = count + 1;
      }

      index = index + 1;
    }

    return endIndex;
  }

  /**
   * expression
   *  ::= primary binoprhs
   * @param tokens
   * @param index
   */
  private parseExpression({
    tokens,
    index,
    env,
    caller,
    parserData,
  }: {
    tokens: Token[];
    index: number;
    env: Environment;
    caller: TFunction;
    parserData: ParserData;
  }): ParserReturn {
    const { expr, index: nextIndex } = this.parsePrimary({
      tokens,
      index,
      env,
      caller,
      parserData,
    });
    if (!expr || expr.type === AstType.Ignore) {
      return { expr, index: nextIndex };
    } else {
      return this.parseBinOpRHS({
        tokens,
        exprPrecedence: 0,
        LHS: expr,
        index: nextIndex,
        env: expr.env,
        caller,
        parserData,
      });
    }
  }

  private parse(tokens: Token[]): { ast: Expr[]; env: Environment } {
    let index = 0;
    const exprs: Expr[] = [];
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });
    const emptyParserData: ParserData = {
      callSites: [],
    };

    // Load the std/prelude.mo
    // NOTE: .mo files inside std/ will not load prelude.mo
    if (!this.modulePath.startsWith(`file://${this.stdPath}`)) {
      const { env: nextEnv } = this.importModule({
        destructurings: [
          {
            name: "*",
            isMutable: false,
            token: emptyToken,
          },
        ],
        env,
        modulePath: "std/prelude",
      });
      env = nextEnv;
    }

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
          const { expr, index: nextIndex } = this.parseLetAssignment({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
            isExported: false,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Extern: {
          const { expr, index: nextIndex } = this.parseExternExpr({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Type: {
          const { expr, index: nextIndex } = this.parseTypeAlias({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Class: {
          const { expr, index: nextIndex } = this.parseClassExpr({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Effect: {
          const { expr, index: nextIndex } = this.parseEffectExpr({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Instance: {
          const { expr, index: nextIndex } = this.parseInstanceExpr({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Enum: {
          const { expr, index: nextIndex } = this.parseEnum({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Export: {
          const { expr, index: nextIndex } = this.parseExportExpr({
            tokens,
            index,
            env,
            caller: emptyFunctionThatHasMoreEffects,
            parserData: emptyParserData,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Import: {
          const { expr, index: nextIndex } = this.parseImportExpr({
            tokens,
            index,
            env,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        case TokenType.Infix:
        case TokenType.Infixl:
        case TokenType.Infixr: {
          const { expr, index: nextIndex } = this.parseInfixPrecedenceExpr({
            tokens,
            index,
            env,
          });
          if (expr) {
            exprs.push(expr);
          }
          index = nextIndex;
          env = expr.env;
          break;
        }
        default: {
          throw this.formatErrorMessage(
            tokens[index],
            "Invalid top-level expression"
          );
        }
      }
    }
    const retExprs = exprs.filter((expr) => expr.type !== AstType.Ignore);
    return {
      ast: retExprs,
      env,
    };
  }

  public generateModule(): TModule {
    return {
      type: "Module",
      ast: this.ast,
      env: this.env,
      modulePath: this.modulePath,
    };
  }
}
