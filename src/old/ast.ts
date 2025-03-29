import { Token } from "../token";
import {
  TBoolean,
  TEnum,
  TFunction,
  TModule,
  TPrimitive,
  TPrimitiveWithValue,
  TTrait,
  TTypeConstructor,
  TUnit,
  Type,
  traitToString,
  typeParametersToString,
  typeToString,
} from "../type-checker";
import { Environment } from "./env";
import { stringIsOperator } from "./operator";

export enum AstType {
  // values
  Value = "value",
  Record = "record",

  // variable
  Variable = "variable",
  PropertyAccess = "property-access",
  IndexAccess = "index-access",

  // reference and dereference
  // Reference = "reference",
  // Dereference = "dereference",

  // operators
  UnaryOperator = "unop",
  IsOperator = "isop",

  // assignment
  LetAssignment = "let=",
  DestructuringAssignment = "destructuring=",
  Assignment = "=",
  TypeAlias = "type=",

  // parameters
  TypeParameter = "type-parameter",
  FunctionParameter = "function-parameter",

  // function
  FunctionPrototype = "function-prototype",
  Function = "function",
  CallFunction = "call-function",
  CallEnum = "call-enum",
  CallTypeConstructor = "call-type-constructor",

  // Trait
  Trait = "trait",

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

  // recur
  Recur = "recur",

  // infix
  Infix = "infix",

  // type casting
  TypeCast = "type-cast",

  // dereference
  Dereference = "dereference",

  // reference
  Reference = "reference",
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
  | TraitExpr
  // | UnaryOperatorExpr
  | IsOperatorExpr
  | VariableExpr
  // | ReferenceExpr
  // | DereferenceExpr
  | PropertyAccessExpr
  | IndexAccessExpr
  | ValueExpr
  | CallFunctionExpr
  | CallEnumExpr
  | CallTypeConstructorExpr
  | IfExpr
  | MatchExpr
  | IgnoreExpr
  | BlockExpr
  | DeferExpr
  | ExportExpr
  | ImportExpr
  | RecurExpr
  | InfixPrecedenceExpr
  | TypeCastExpr
  | DereferenceExpr
  | ReferenceExpr;

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
  tempVariableName: string;
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

export type ArrayValueExpr = {
  type: AstType.Value;
  tag: "array";
  values: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
};

export type TupleValueExpr = {
  type: AstType.Value;
  tag: "tuple";
  elements: Expr[];
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

export type ValueExpr =
  | PrimitiveValueExpr
  | RecordValueExpr
  | ArrayValueExpr
  | TupleValueExpr;

export type VariableExpr = {
  type: AstType.Variable;
  variableName: string;
  /**
   * variableId in ValueType in Environment.
   */
  variableId: string;
  frameLevel: number;
  typeValue: Type;
  isMutable: boolean;
  env: Environment;
  token: Token;
  // isFreeVariable: boolean;
};

/*
export type ReferenceExpr = {
  type: AstType.Reference;
  expr: Expr;
  isMutableReference: boolean;
  typeValue: TTypeConstructor;
  env: Environment;
  token: Token;
  tempVariableName: string;
};

export type DereferenceExpr = {
  type: AstType.Dereference;
  expr: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};
*/

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

export type IsOperatorExpr = {
  type: AstType.IsOperator;
  left: Expr;
  right: TEnum;
  typeValue: TBoolean;
  env: Environment;
  token: Token;
};

/*
export type UnaryOperatorExpr = {
  type: AstType.UnaryOperator;
  operator: TokenType.LogicalNot;
  expr: Expr;
  typeValue: Type;
  env: Environment;
  token: Token;
};
*/

export type LetAssignmentExpr = {
  type: AstType.LetAssignment;
  variableName: string;
  variableId: string;
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
  /**
   * This is the name of the temporary variable that holds
   * the old value of the left expression.
   */
  tempVariableName: string;
};

export type Destructuring = {
  name: string;
  asName?: string;
  isMutable: boolean;
  token: Token;
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
  typeValue: TTypeConstructor;
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

export type TraitExpr = {
  type: AstType.Trait;
  typeValue: TUnit;
  trait: TTrait;
  env: Environment;
  token: Token;
};

export type FunctionExpr = {
  type: AstType.Function;
  /**
   * frameLevel at which the function is defined.
   */
  frameLevel: number;
  // freeVariables: ValueType[];
  body: BlockExpr;
  typeValue: TFunction;
  env: Environment;
  token: Token;
};

export type ExternVariable = {
  name: string;
  typeValue: Type;
};

export type ExternExpr = {
  type: AstType.Extern;
  language: "c" | "mo";
  variables: ExternVariable[];
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type CallFunctionExpr = {
  type: AstType.CallFunction;
  function: Expr;
  functionArguments: Expr[];
  typeValue: Type;
  env: Environment;
  token: Token;
  isOperator?: "unary" | "binary";
  /**
   * This is the name of the temporary variable that holds
   * the result of the function.
   */
  tempVariableName: string;
};

export type RecurExpr = {
  type: AstType.Recur;
  typeValue: Type;
  env: Environment;
  token: Token;
  functionArguments: Expr[];
  /**
   * If set to true, we enable the tail call optimization.
   */
  isLastExpr?: boolean;
};

export type CallEnumExpr = {
  type: AstType.CallEnum;
  variantArguments: Expr[];
  typeValue: TEnum;
  env: Environment;
  token: Token;
  tempVariableName: string;
};

export type CallTypeConstructorExpr = {
  type: AstType.CallTypeConstructor;
  expr: Expr;
  typeValue: TTypeConstructor;
  env: Environment;
  token: Token;
  tempVariableName: string;
};

export type IfCase = {
  condition?: Expr; // If no condition, then it's `else`.
  body: BlockExpr;
};

export type IfExpr = {
  type: AstType.If;
  cases: IfCase[];
  typeValue: Type;
  env: Environment;
  token: Token;
  tempVariableName: string;
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
  tempVariableName: string;
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
  destructurings: Destructuring[];
  typeValue: TUnit;
  env: Environment;
  token: Token;
};

export type InfixPrecedenceExpr = {
  type: AstType.Infix;
  typeValue: TUnit;
  env: Environment;
  token: Token;
  associativity: "infix" | "infixl" | "infixr";
  precedence: number;
  operator: string;
};

export type TypeCastExpr = {
  type: AstType.TypeCast;
  /**
   * Casted type.
   */
  typeValue: Type;
  env: Environment;
  token: Token;
  expr: Expr;
};

export type DereferenceExpr = {
  type: AstType.Dereference;
  /**
   * Dereferenced type.
   */
  typeValue: Type;
  env: Environment;
  token: Token;
  expr: Expr;
};

export type ReferenceExpr = {
  type: AstType.Reference;
  /**
   * Reference type.
   */
  typeValue: Type;
  env: Environment;
  token: Token;
  expr: Expr;
  isMutableReference: boolean;
};

export function exprToString(expr: Expr, indentation = ""): string {
  switch (expr.type) {
    case AstType.Value:
      switch (expr.tag) {
        case "primitive":
          if (expr.typeValue.type === "char") {
            return `'${expr.value}'`;
          } else if (expr.typeValue.type === "symbol") {
            return `${JSON.stringify(expr.value)}`;
          }
          return expr.value;
        case "record":
          return `{${expr.properties
            .map(({ name, value }) => `${name}: ${exprToString(value)}`)
            .join(", ")}}`;
        case "array":
          return `[${expr.values
            .map((expr) => exprToString(expr))
            .join(", ")}]`;
        case "tuple":
          return `(${expr.elements
            .map((expr) => exprToString(expr))
            .join(", ")}${expr.elements.length === 1 ? "," : ""})`;
        default:
          throw new Error(`Unknown value tag ${expr}`);
      }
    case AstType.Variable:
      if (stringIsOperator(expr.variableName)) {
        return `(${expr.variableName})`;
      }
      return expr.variableName;
    case AstType.PropertyAccess:
      if (expr.expr.type === AstType.Trait) {
        return `${traitToString(expr.expr.trait, {
          extractTypeConstructor: false,
        })}.${expr.propertyName}`;
      }
      return `${exprToString(expr.expr)}.${expr.propertyName}`;
    case AstType.IndexAccess:
      return `${exprToString(expr.expr)}[${expr.indexes
        .map((expr) => exprToString(expr))
        .join(", ")}]`;
    /*
      case AstType.UnaryOperator:
      return `${expr.operator}${exprToString(expr.expr)}`;
    */
    case AstType.IsOperator:
      return `${exprToString(expr.left)} is ${typeToString(expr.right)}`;
    case AstType.LetAssignment:
      return `${expr.isMutable ? "var" : "let"} ${
        stringIsOperator(expr.variableName)
          ? `(${expr.variableName})`
          : expr.variableName
      }${
        /*expr.variableType.type === "Function"
          ? ""
          :*/ `: ${typeToString(expr.variableType, {
          hideTypeParameterKind: true,
        })}`
      } = ${exprToString(expr.right)}`;
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
      })};`;
    }
    case AstType.Trait:
      return `${traitToString(expr.trait, {
        extractTypeConstructor: true,
      })}`;
    case AstType.Enum:
      return `${typeToString(expr.typeValue, {
        extractTypeConstructor: true,
      })}`;
    case AstType.Function: {
      return `${typeToString(expr.typeValue, {
        isFunctionImplementation: true,
      })} -> ${exprToString(expr.body)}`;
    }
    case AstType.CallFunction: {
      const functionType = expr.function.typeValue;
      if (functionType.type !== "Function") {
        throw new Error(
          `Expected callee to be a function, but got ${typeToString(
            functionType
          )}`
        );
      }
      if (expr.isOperator === "unary") {
        return `(${exprToString(expr.function).replace(
          /^\((.+?)\)$/,
          "$1"
        )}${exprToString(expr.functionArguments[0])})`;
      } else if (expr.isOperator === "binary") {
        return `(${exprToString(expr.functionArguments[0])} ${exprToString(
          expr.function
        ).replace(/^\((.+?)\)$/, "$1")} ${exprToString(
          expr.functionArguments[1]
        )})`;
      } else {
        return `${exprToString(expr.function)}${typeParametersToString(
          functionType.typeParameters,
          functionType.typeConstraints,
          {
            hideTypeParameterKind: true,
          }
        )}(${expr.functionArguments
          .map((expr) => exprToString(expr))
          .join(", ")})`;
      }
    }
    case AstType.CallEnum:
      return `${typeToString(expr.typeValue)}${
        /*typeParametersToString(
        expr.typeValue.typeParameters,
        expr.typeValue.regionParameters,
        {
          hideTypeParameterKind: true,
        }
      )*/ ""
      }${
        expr.variantArguments.length > 0
          ? `(${expr.variantArguments
              .map((expr) => exprToString(expr))
              .join(", ")})`
          : ""
      }`;
    case AstType.CallTypeConstructor:
      return `${typeToString(expr.typeValue, {
        extractTypeConstructor: false,
        hideTypeParameterKind: true,
      })} ${exprToString(expr.expr)}`;
    case AstType.If: {
      let result = "";
      const cases = expr.cases;
      for (let i = 0; i < cases.length; i++) {
        const case_ = cases[i];
        if (case_.condition) {
          result += `if (${exprToString(case_.condition)}) ${exprToString(
            case_.body
          )}`;
        } else {
          result += `${exprToString(case_.body)}`;
        }

        if (i !== cases.length - 1) {
          result += " else ";
        }
      }
      return result;
    }
    case AstType.Match: {
      return `match (${exprToString(expr.matchedEnum)}) {\n${expr.cases
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
        .join(",\n")}\n}`;
    }
    case AstType.Ignore:
      return ``;
    case AstType.Block: {
      return `{\n${expr.exprs
        .map((expr) =>
          exprToString(expr)
            .split("\n")
            .map((l) => "  " + indentation + l)
            .join(`\n`)
        )
        .join(";\n")}
${indentation}}`;
    }
    case AstType.Defer: {
      return `defer ${exprToString(expr.expr)}`;
    }
    case AstType.Export: {
      if (expr.expr.type === AstType.Import) {
        const importExpr = expr.expr as ImportExpr;
        return `export ${
          importExpr.destructurings.length === 1 &&
          importExpr.destructurings[0].name === "*"
            ? `*`
            : `{ ${importExpr.destructurings
                .map((destructuring) => {
                  return `${destructuring.name}${
                    destructuring.asName ? ` as ${destructuring.asName}` : ""
                  }`;
                })
                .join(", ")} }`
        } from "${importExpr.modulePath}";`;
      } else {
        return `export ${exprToString(expr.expr)}`;
      }
    }
    case AstType.Import: {
      if (expr.qualifiedName) {
        return `import * as ${expr.qualifiedName} from "${expr.modulePath}";`;
      } else {
        return `import ${
          expr.destructurings.length === 1 &&
          expr.destructurings[0].name === "*"
            ? "*"
            : `{ ${expr.destructurings
                .map((destructuring) => {
                  return `${destructuring.name}${
                    destructuring.asName ? ` as ${destructuring.asName}` : ""
                  }`;
                })
                .join(", ")} }`
        } from "${expr.modulePath}";`;
      }
    }
    case AstType.Extern: {
      return `extern "${expr.language}" {\n${expr.variables
        .map((variable) => {
          return `  ${variable.name}: ${typeToString(variable.typeValue)};`;
        })
        .join("\n")}\n}`;
    }
    case AstType.Recur: {
      return `recur(${expr.functionArguments
        .map((expr) => exprToString(expr))
        .join(", ")})`;
    }
    case AstType.Infix: {
      return `${expr.associativity} ${expr.precedence} ${expr.operator};`;
    }
    case AstType.TypeCast: {
      return `(${exprToString(expr.expr)} as ${typeToString(expr.typeValue)})`;
    }
    case AstType.Reference: {
      return `(${expr.isMutableReference ? "@" : "&"}${exprToString(
        expr.expr
      )})`;
    }
    case AstType.Dereference: {
      return `(*${exprToString(expr.expr)})`;
    }
    default:
      throw new Error(`exprToString: Unknown expr type ${expr}`);
  }
}
