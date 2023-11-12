import { Environment, ValueType, getEnvValueTypesByVariableName } from "./env";
import { Token, TokenType } from "./token";
import {
  TFunction,
  TInterface,
  TPrimitive,
  TUnit,
  Type,
  checkType,
  typeToString,
} from "./type-checker";

export enum AstType {
  // values
  Value = "value",
  Record = "record",

  // variable
  Variable = "variable",
  PropertyAccess = "property-access",
  IndexAccess = "index-access",

  // operators
  BinaryOperator = "binop",
  UnaryOperator = "unop",

  // assignment
  ConstantAssigment = "const=",
  LetAssignment = "let=",
  Assignment = "=",
  TypeAlias = "type=",
  Interface = "interface",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",

  // enum
  Enum = "enum",

  // extern
  Extern = "extern",

  // control flow
  If = "if",

  // ignore
  Ignore = "ignore",
}

export enum OperatorType {
  LessThan = "<",
  LessThanOrEqual = "<=",
  Equal = "==",
  NotEqual = "!=",
  Add = "+",
  Subtract = "-",
  Multiply = "*",
  Divide = "/",
  Modulo = "%",
}

/**
 * All Expr should have `typeValue` attribute.
 */
export type Expr = (
  | FunctionExpr
  | ExternExpr
  | AssignmentExpr
  | TypeAliasExpr
  | InterfaceExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | VariableExpr
  | PropertyAccessExpr
  | IndexAccessExpr
  | ValueExpr
  | CallFunctionExpr
  | IfExpr
  | IgnoreExpr
) & { typeValue: Type };

export type TopLevelExpr = Expr | FunctionExpr;

export type IgnoreExpr = {
  type: AstType.Ignore;
  typeValue: TUnit;
};

export type RecordValueExpr = {
  type: AstType.Value;
  tag: "record";
  typeValue: Type;
  properties: { name: string; value: Expr }[];
};

export type SliceValueExpr = {
  type: AstType.Value;
  tag: "slice";
  typeValue: Type;
  values: Expr[];
};

export type PrimitiveValueExpr = {
  type: AstType.Value;
  tag: "primitive";
  typeValue: TPrimitive;
};

export type ValueExpr = PrimitiveValueExpr | RecordValueExpr | SliceValueExpr;

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
  typeValue: Type;
  frameLevel: number;
  // isFreeVariable: boolean;
};

export type PropertyAccessExpr = {
  type: AstType.PropertyAccess;
  propertyName: string;
  expr: Expr;
  typeValue: Type;
};

export type IndexAccessExpr = {
  type: AstType.IndexAccess;
  indexes: Expr[];
  expr: Expr;
  typeValue: Type;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator: OperatorType;
  left: Expr;
  right: Expr;
  typeValue: Type;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
  typeValue: Type;
};

/*
export type TypeValueExpr = {
  type: AstType.TypeValue;
  value: string;
};
*/

export type AssignmentExpr = {
  type: AstType.ConstantAssigment; // | AstType.LetAssignment; // | AstType.Assignment;
  variableName: string;
  variableType: Type;
  frameLevel: number;
  right: Expr;
  typeValue: TUnit;
};

export type TypeAliasExpr = {
  type: AstType.TypeAlias;
  typeName: string;
  typeValue: Type;
};

export type InterfaceExpr = {
  type: AstType.Interface;
  interfaceName: string;
  typeValue: TInterface;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName?: string; // If not set, it's an anonymous function
  typeValue: TFunction;
};

export type FunctionExpr = {
  type: AstType.Function;
  prototype: FunctionPrototype;
  /**
   * frameLevel at which the function is defined.
   */
  frameLevel: number;
  freeVariables: ValueType[];
  typeValue: TFunction;
  body: Expr[];
};

export type ExternExpr = {
  type: AstType.Extern;
  prototype: FunctionPrototype;
  typeValue: TFunction;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  callee: Expr;
  functionArguments: Expr[];
  typeValue: Type;
};

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
  typeValue: Type;
};

/**
 * 1 is the lowest precedence
 */
const BinopPrecedence: { [key: string]: number } = {
  [TokenType.Equal]: 10,
  [TokenType.NotEqual]: 10,
  [TokenType.LessThan]: 20,
  [TokenType.LessThanOrEqual]: 20,
  [TokenType.GreaterThan]: 20,
  [TokenType.GreaterThanOrEqual]: 20,
  [TokenType.Add]: 30,
  [TokenType.Subtract]: 30,
  [TokenType.Multiply]: 40,
  [TokenType.Divide]: 40,
  [TokenType.Modulo]: 40,
};

export function getTokenPrecedence(token: Token | undefined): number {
  if (!token) {
    return -1;
  }
  if (token.type in BinopPrecedence) {
    return BinopPrecedence[token.type];
  } else {
    return -1;
  }
}

export function synthesizeRecordType(
  properties: {
    name: string;
    value: Expr;
  }[]
): Type {
  return {
    type: "Record",
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: value.typeValue,
      };
    }),
  };
}

/**
 * Get the real functionArgumentsInOrder by matching the functionArguments with the functionType
 * If not match, then return null
 * @param functionArguments
 * @param functionType
 * @returns
 */
export function getFunctionArgumentsInOrder(
  functionArguments: Expr[],
  functionType: TFunction,
  env: Environment
): Expr[] | null {
  const functionArgumentsInOrder: (Expr | null)[] =
    functionType.parameterTypes.map((pt) => pt.defaultValue);
  const functionParameterTypes = functionType.parameterTypes;

  for (let i = 0; i < functionArguments.length; i++) {
    const argument = functionArguments[i];
    if (Array.isArray(argument)) {
      return null;
    }

    // Keyword argument
    if (argument.type === AstType.ConstantAssigment) {
      const keyword = argument.variableName;
      const value = argument.right;
      const argumentPositionIndex = functionParameterTypes.findIndex(
        (pt) => pt.name === keyword
      );
      if (argumentPositionIndex < 0) {
        return null;
      } else {
        functionArgumentsInOrder[argumentPositionIndex] = value;
      }
    } else {
      if (i >= functionArgumentsInOrder.length) {
        return null;
      }
      // Positional argument
      functionArgumentsInOrder[i] = argument;
    }
  }

  // If functionArgumentsInOrder has any null, then it's not a match
  if (functionArgumentsInOrder.some((arg) => arg === null)) {
    return null;
  } else {
    // Check if the functionArgumentsInOrder has the same types as the functionParameterTypes
    for (let i = 0; i < functionArgumentsInOrder.length; i++) {
      const argument = functionArgumentsInOrder[i];
      const parameterType = functionParameterTypes[i];
      if (
        !argument ||
        Array.isArray(argument) ||
        !checkType(parameterType.type, argument.typeValue, env)
      ) {
        return null;
      }
    }

    return functionArgumentsInOrder as Expr[];
  }
}

export function getFunctionsOfCallerFromEnv(
  callerType: Type,
  functionName: string,
  env: Environment
) {
  const functionTypes = getEnvValueTypesByVariableName(env, functionName);
  // Find the functions that takes `expr` as the first argument
  const matchedFunctions = functionTypes.filter((functionType) => {
    if (functionType.type.type !== "Function") {
      return false;
    }
    const firstArgumentType = functionType.type.parameterTypes[0];
    if (!firstArgumentType) {
      return false;
    }
    return checkType(firstArgumentType.type, callerType, env);
  });
  return matchedFunctions;
}

export function getFunctionFromEnv(
  functionName: string,
  functionArguments: Expr[],
  env: Environment
) {
  const functionsInEnv = getEnvValueTypesByVariableName(env, functionName);
  if (functionsInEnv.length === 0) {
    throw new Error(`Cannot find function ${functionName}`);
  } else {
    // Find the function that matches the signature
    const matchedFunctions = functionsInEnv.filter((functionInEnv) => {
      if (functionInEnv.type.type !== "Function") {
        return false;
      }

      const functionArgumentsInOrder = getFunctionArgumentsInOrder(
        functionArguments,
        functionInEnv.type,
        env
      );
      return !!functionArgumentsInOrder;
    });
    if (matchedFunctions.length > 1) {
      throw new Error(
        `Ambiguous function call ${functionName} with arguments ${JSON.stringify(
          functionArguments
        )}
Found possible functions:
- ${matchedFunctions
          .map((func) => `${func.variableName}: ${typeToString(func.type)}`)
          .join("\n- ")}
        `
      );
    }
    const matchedFunction = matchedFunctions[0];
    if (!matchedFunction || matchedFunction.type.type !== "Function") {
      throw new Error(`Function "${functionName}" not found`);
    } else {
      return matchedFunction;
    }
  }
}

/**
 * NOTE: We allow the function overloading by checking the first argument type.
 * @param prototype
 * @param env
 */
export function getMatchedOverloadingFunction(
  prototype: FunctionPrototype,
  env: Environment
): ValueType[] {
  if (!prototype.functionName) {
    // Anonymous function
    return [];
  }

  const functionsInEnv = getEnvValueTypesByVariableName(
    env,
    prototype.functionName
  );

  if (
    prototype.typeValue.parameterTypes.length === 0 &&
    functionsInEnv.length !== 0
  ) {
    // Function without parameter is not allowed to be overloaded
    return functionsInEnv;
  }

  // Find the functions that takes `expr` as the first argument
  const matchedFunctions = functionsInEnv.filter((functionInEnv) => {
    if (functionInEnv.type.type !== "Function") {
      return false;
    }
    const firstArgumentType = functionInEnv.type.parameterTypes[0];
    if (!firstArgumentType) {
      return false;
    }
    return checkType(
      firstArgumentType.type,
      prototype.typeValue.parameterTypes[0].type,
      env
    );
  });

  return matchedFunctions;
}
