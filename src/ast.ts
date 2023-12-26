import { Environment, ValueType } from "./env";
import { Token, TokenType } from "./token";
import {
  TBoolean,
  TClass,
  TEnum,
  TFunction,
  TModule,
  TPrimitive,
  TPrimitiveWithValue,
  TTypeConstructor,
  TUnit,
  Type,
  TypeKind,
  typeAndRegionParametersToString,
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

  // reference and dereference
  Reference = "reference",
  Dereference = "dereference",

  // operators
  BinaryOperator = "binop",
  UnaryOperator = "unop",
  IsOperator = "isop",

  // assignment
  LetAssignment = "let=",
  DestructuringAssignment = "destructuring=",
  Assignment = "=",
  TypeAlias = "type=",
  Class = "class",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",
  CallEnum = "call-enum",

  // enum
  Enum = "enum",

  // extern
  Extern = "extern",

  // control flow
  If = "if",
  Match = "match",

  // ignore
  Ignore = "ignore",

  // block expression
  Block = "block",

  // defer
  Defer = "defer",

  // export/import
  Export = "export",
  Import = "import",
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
 * All Expr should have `typeValue` and `env` attribute.
 */
export type Expr =
  | FunctionExpr
  | ExternExpr
  | LetAssignmentExpr
  | AssignmentExpr
  | DestructuringAssignmentExpr
  | TypeAliasExpr
  | EnumExpr
  | ClassExpr
  | UnaryOperatorExpr
  | BinaryOperatorExpr
  | IsOperatorExpr
  | VariableExpr
  | ReferenceExpr
  | DereferenceExpr
  | PropertyAccessExpr
  | IndexAccessExpr
  | ValueExpr
  | CallFunctionExpr
  | CallEnumExpr
  | IfExpr
  | MatchExpr
  | IgnoreExpr
  | BlockExpr
  | DeferExpr
  | ExportExpr
  | ImportExpr;

export type IgnoreExpr = {
  type: AstType.Ignore;
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type BlockExpr = {
  type: AstType.Block;
  exprs: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type DeferExpr = {
  type: AstType.Defer;
  expr: BlockExpr;
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type RecordValueExpr = {
  type: AstType.Value;
  tag: "record";
  properties: { name: string; value: Expr }[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type SliceValueExpr = {
  type: AstType.Value;
  tag: "slice";
  values: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type PrimitiveValueExpr = {
  type: AstType.Value;
  tag: "primitive";
  value: string;
  typeValue: TPrimitive | TPrimitiveWithValue;
  env: Environment;
  token: Token;
};

export type ValueExpr = PrimitiveValueExpr | RecordValueExpr | SliceValueExpr;

export type VariableExpr = {
  type: AstType.Variable;
  name: string;
  frameLevel: number;
  typeValue: Type;
  isMutable: boolean;
  env: Environment;
  token: Token;
  // isFreeVariable: boolean;
};

export type ReferenceExpr = {
  type: AstType.Reference;
  expr: Expr;
  isMutableReference: boolean;
  typeValue: TTypeConstructor;
  env: Environment;
  token: Token;
};

export type DereferenceExpr = {
  type: AstType.Dereference;
  expr: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type PropertyAccessExpr = {
  type: AstType.PropertyAccess;
  propertyName: string;
  expr: Expr;
  typeValue: Type;
  isMutable: boolean;
  env: Environment;
  token: Token;
};

export type IndexAccessExpr = {
  type: AstType.IndexAccess;
  indexes: Expr[];
  expr: Expr;
  typeValue: Type;
  isMutable: boolean;
  env: Environment;
  token: Token;
};

export type BinaryOperatorExpr = {
  type: AstType.BinaryOperator;
  operator: OperatorType;
  left: Expr;
  right: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type IsOperatorExpr = {
  type: AstType.IsOperator;
  left: Expr;
  right: TEnum;
  typeValue: TBoolean;
  env: Environment;
  token: Token;
};

export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type LetAssignmentExpr = {
  type: AstType.LetAssignment;
  variableName: string;
  isMutable: boolean;
  variableType: Type;
  frameLevel: number;
  right: Expr;
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type AssignmentExpr = {
  type: AstType.Assignment;
  left: Expr;
  right: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type Destructuring = {
  name: string;
  asName?: string;
  isMutable: boolean;
};

export type DestructuringAssignmentExpr = {
  type: AstType.DestructuringAssignment;
  left: Destructuring[];
  right: Expr;
  isMutable: boolean;
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type TypeAliasExpr = {
  type: AstType.TypeAlias;
  typeName: string;
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type EnumExpr = {
  type: AstType.Enum;
  enumName: string;
  typeValue: TEnum;
  env: Environment;
  token: Token;
};

export type ClassExpr = {
  type: AstType.Class;
  typeValue: TClass;
  env: Environment;
  token: Token;
};

export type FunctionPrototype = {
  type: AstType.FunctionPrototype;
  functionName?: string; // If not set, it's an anonymous function
  typeValue: TFunction;
  token: Token;
};

export type FunctionExpr = {
  type: AstType.Function;
  prototype: FunctionPrototype;
  /**
   * frameLevel at which the function is defined.
   */
  frameLevel: number;
  freeVariables: ValueType[];
  body: Expr[];
  typeValue: TFunction;
  env: Environment;
  token: Token;
};

export type ExternExpr = {
  type: AstType.Extern;
  prototype: FunctionPrototype;
  typeValue: TFunction;
  env: Environment;
  token: Token;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  callee: Expr;
  typeArguments: Type[];
  functionArguments: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type CallEnumExpr = {
  type: AstType.CallEnum;
  variantArguments: Expr[];
  typeValue: TEnum;
  env: Environment;
  token: Token;
};

export type IfExpr = {
  type: AstType.If;
  condition: Expr;
  then: Expr[];
  else: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type MatchCase = {
  case?: Expr;
  variantName: string;
  body: BlockExpr;
};

export type MatchExpr = {
  type: AstType.Match;
  matchedEnum: Expr;
  cases: MatchCase[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type ExportExpr = {
  type: AstType.Export;
  expr: Expr;
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type ImportExpr = {
  type: AstType.Import;
  modulePath: string;
  module: TModule;
  qualifiedName?: string;
  destructurings: {
    name: string;
    asName?: string;
  }[];
  typeValue: TUnit;
  env: Environment;
  token: Token;
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

export function isComparisonOperator(operatorToken: Token) {
  return (
    operatorToken.type === TokenType.LessThan ||
    operatorToken.type === TokenType.LessThanOrEqual ||
    operatorToken.type === TokenType.GreaterThan ||
    operatorToken.type === TokenType.GreaterThanOrEqual ||
    operatorToken.type === TokenType.Equal ||
    operatorToken.type === TokenType.NotEqual
  );
}

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
  let kind: TypeKind = "Free";
  properties.forEach(({ value }) => {
    if (kind === "Free") {
      kind = value.typeValue.kind as TypeKind;
    }
  });

  return {
    type: "Record",
    kind,
    properties: properties.map(({ name, value }) => {
      return {
        name,
        type: value.typeValue,
      };
    }),
  };
}

export function exprToString(expr: Expr | FunctionPrototype) {
  switch (expr.type) {
    case AstType.Value:
      switch (expr.tag) {
        case "primitive":
          if (expr.typeValue.type === "char") {
            return JSON.stringify(expr.value);
          }
          return expr.value;
        case "record":
          return `{${expr.properties
            .map(({ name, value }) => `${name}: ${exprToString(value)}`)
            .join(", ")}}`;
        case "slice":
          return `[${expr.values
            .map((expr) => exprToString(expr))
            .join(", ")}]`;
        default:
          throw new Error(`Unknown value tag ${expr}`);
      }
    case AstType.Variable:
      if ("id" in expr.typeValue) {
        return `@${expr.typeValue.id}`;
      }
      return expr.name;
    case AstType.PropertyAccess:
      return `${exprToString(expr.expr)}.${expr.propertyName}`;
    case AstType.IndexAccess:
      return `${exprToString(expr.expr)}[${expr.indexes
        .map((expr) => exprToString(expr))
        .join(", ")}]`;
    case AstType.BinaryOperator:
      return `${exprToString(expr.left)} ${expr.operator} ${exprToString(
        expr.right
      )}`;
    case AstType.UnaryOperator:
      return `${expr.operator}${exprToString(expr.expr)}`;
    case AstType.IsOperator:
      return `${exprToString(expr.left)} is ${typeToString(expr.right)}`;
    case AstType.LetAssignment:
      return `let${expr.isMutable ? " mut" : ""} ${
        expr.variableName
      }: ${typeToString(expr.variableType, {
        hideTypeParameterKind: true,
      })} = ${exprToString(expr.right)}`;
    case AstType.DestructuringAssignment: {
      const isMutable = expr.isMutable;
      return `let${isMutable ? " mut" : ""} {${expr.left
        .map((destructuring) => {
          return `${isMutable ? "" : destructuring.isMutable ? "mut " : ""}${
            destructuring.name
          }${destructuring.asName ? `: ${destructuring.asName}` : ""}`;
        })
        .join(", ")}} = ${exprToString(expr.right)}`;
    }
    case AstType.Assignment:
      return `(${exprToString(expr.left)} = ${exprToString(expr.right)})`;
    case AstType.TypeAlias: {
      return `type ${typeToString(expr.typeValue, {
        extractTypeConstructor: "all",
        hideTypeParameterKind: true,
      })}`;
    }
    case AstType.Class:
      return `${typeToString(expr.typeValue, {
        extractTypeConstructor: true,
      })}`;
    case AstType.Enum:
      return `${typeToString(expr.typeValue, {
        extractTypeConstructor: true,
      })}`;
    case AstType.Function:
      return `${
        expr.prototype.functionName
          ? `function ${expr.prototype.functionName}`
          : ``
      }${typeAndRegionParametersToString(
        expr.prototype.typeValue.typeParameters,
        expr.prototype.typeValue.regionParameters
      )}(${expr.prototype.typeValue.parameterTypes
        .map(
          (p) =>
            `${p.isMutable ? "mut " : ""}${p.name}: ${typeToString(p.type, {
              hideTypeParameterKind: true,
            })}${p.defaultValue ? `=${exprToString(p.defaultValue)}` : ""}`
        )
        .join(", ")}):${typeToString(expr.prototype.typeValue.returnType, {
        hideTypeParameterKind: true,
      })} ${expr.prototype.functionName ? "" : " => "} {\n${expr.body
        .map((expr) =>
          exprToString(expr)
            .split("\n")
            .map((l) => "  " + l)
            .join("\n")
        )
        .join(";\n")}\n}`;
    case AstType.CallFunction:
      return `${exprToString(expr.callee)}${
        expr.typeArguments.length > 0
          ? `<${expr.typeArguments.map((type) => typeToString(type))}>`
          : ""
      }(${expr.functionArguments
        .map((expr) => exprToString(expr))
        .join(", ")})`;
    case AstType.CallEnum:
      return `${typeToString(expr.typeValue)}${
        expr.variantArguments.length > 0
          ? `(${expr.variantArguments
              .map((expr) => exprToString(expr))
              .join(", ")})`
          : ""
      }`;
    case AstType.If:
      return `if ${exprToString(expr.condition)} {\n${expr.then
        .map((expr) => "  " + exprToString(expr))
        .join(";\n")} 
} else {\n${expr.else.map((expr) => "  " + exprToString(expr)).join(";\n")}
}`;
    case AstType.Match: {
      return `match ${exprToString(expr.matchedEnum)} {\n${expr.cases
        .map((matchCase) => {
          return `  ${
            !matchCase.case ? "default" : `case ${exprToString(matchCase.case)}`
          }: {\n${matchCase.body.exprs
            .map((expr) =>
              exprToString(expr)
                .split("\n")
                .map((l) => "    " + l)
                .join("\n")
            )
            .join(";\n")}\n  }`;
        })
        .join("\n")}\n}`;
    }
    case AstType.Ignore:
      return ``;
    case AstType.Block: {
      return `{\n${expr.exprs
        .map((expr) =>
          exprToString(expr)
            .split("\n")
            .map((l) => "  " + l)
            .join("\n")
        )
        .join(";\n")}
}`;
    }
    case AstType.FunctionPrototype: {
      return `${expr.functionName ?? ``}${typeAndRegionParametersToString(
        expr.typeValue.typeParameters,
        expr.typeValue.regionParameters
      )}(${expr.typeValue.parameterTypes
        .map((p) => `${p.name}: ${typeToString(p.type)}`)
        .join(", ")}):${typeToString(expr.typeValue.returnType)}`;
    }
    case AstType.Extern: {
      return `extern ${
        expr.prototype.functionName ?? ``
      }${typeAndRegionParametersToString(
        expr.prototype.typeValue.typeParameters,
        expr.prototype.typeValue.regionParameters
      )}(${expr.prototype.typeValue.parameterTypes
        .map(
          (p) =>
            `${p.name}: ${typeToString(p.type, {
              hideTypeParameterKind: true,
            })}`
        )
        .join(", ")}):${typeToString(expr.prototype.typeValue.returnType, {
        hideTypeParameterKind: true,
      })}`;
    }
    case AstType.Reference: {
      return `(${expr.isMutableReference ? "&!" : "&"}${exprToString(
        expr.expr
      )})`;
    }
    case AstType.Dereference: {
      return `(*${exprToString(expr.expr)})`;
    }
    case AstType.Defer: {
      return `defer ${exprToString(expr.expr)}`;
    }
    case AstType.Export: {
      return `export ${exprToString(expr.expr)}`;
    }
    case AstType.Import: {
      if (expr.qualifiedName) {
        return `import * as ${expr.qualifiedName} from "${expr.modulePath}";`;
      } else {
        return `import { ${expr.destructurings
          .map((destructuring) => {
            return `${destructuring.name}${
              destructuring.asName ? ` as ${destructuring.asName}` : ""
            }`;
          })
          .join(", ")} } from "${expr.modulePath}";`;
      }
    }
    default:
      throw new Error(`Unknown expr type ${expr}`);
  }
}
