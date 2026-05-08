import type { Location } from "vscode-languageserver";
import type { Environment } from "../env";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
} from "../expr";
import { TokenType, type Token } from "../token";
import type { EnumType, StructType } from "../types/definitions";
import {
  isEnumType,
  isSourceNamespaceType,
  isPtrType,
  isStructType,
  isTypeHierarchyType,
  isUnionType,
} from "../types/guards";
import {
  isStructValue,
  isTypeValue,
  isTraitValue,
  isFunctionValue,
  type StructValue,
} from "../value";
import type { LspDocumentManager } from "./document-manager";
import {
  findTokenAtPosition,
  findBestExpressionMatch,
  modulePathToUri,
} from "./utils";

/**
 * Handle textDocument/definition requests.
 */
export function handleDefinition(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): Location | null {
  let module = docManager.getModule(uri);
  if (!module || module.moduleError) {
    const fallback = docManager.getLastGoodModule(uri);
    if (fallback) {
      module = fallback;
    } else if (!module) {
      return null;
    }
  }

  const exprs = module.evaluator.getProgram();
  const tokens = module.evaluator.getTokens();

  const tokenAtPosition = findTokenAtPosition(tokens, line, character);

  if (!tokenAtPosition) {
    return null;
  }

  // Check if this is an import path string — go to the imported module file
  if (tokenAtPosition.type === TokenType.String) {
    const importLocation = findImportDefinition(exprs, tokenAtPosition);
    if (importLocation) return importLocation;
  }

  const foundExpr = findBestExpressionMatch(exprs, tokenAtPosition, line);

  if (!foundExpr || !exprIsAtom(foundExpr)) {
    return null;
  }

  const expr: AtomExpr = foundExpr;
  const env = expr.$?.env;

  if (!env) {
    return null;
  }

  const tokenText = tokenAtPosition.value;

  // Try field definition first — if the token is the field name in a property
  // access (e.g., `x` in `p.x` or `origin` in `Point.origin()`), resolve via
  // the receiver type's fields/traits/impls. This takes priority over variable
  // lookup because the env may contain a variable with the same name that
  // points to a less precise location (e.g., the struct definition).
  const fieldDefLocation = findFieldDefinitionLocation(
    exprs,
    foundExpr,
    tokenAtPosition
  );
  if (fieldDefLocation) return fieldDefLocation;

  // Check if this is an enum variant constructor (e.g., `Red` in `.Red`)
  const enumVariantLocation = findEnumVariantDefinition(
    expr,
    tokenText,
    docManager
  );
  if (enumVariantLocation) return enumVariantLocation;

  const foundDefinition = findVariableDefinition(env, tokenText);

  if (!foundDefinition) {
    return null;
  }

  const { definitionToken, definitionModulePath } = foundDefinition;
  const defUri = modulePathToUri(definitionModulePath);

  return {
    uri: defUri,
    range: {
      start: {
        line: definitionToken.position.row,
        character: definitionToken.position.column,
      },
      end: {
        line: definitionToken.position.row,
        character:
          definitionToken.position.column + definitionToken.value.length,
      },
    },
  };
}

/**
 * Find the location of an imported module from an import path string token.
 * Walks the AST looking for import("path") calls containing the target token,
 * then extracts the resolved module path from the import expression's value.
 */
function findImportDefinition(
  exprs: Expr[],
  stringToken: Token
): Location | null {
  let result: Location | null = null;

  const search = (expr: Expr) => {
    if (result) return;
    if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      // Check if this is import("...") where the string arg matches our token
      if (
        exprIsAtom(funcCallExpr.func) &&
        (funcCallExpr.func as AtomExpr).token.value === "import" &&
        funcCallExpr.args.length >= 1
      ) {
        const importArg = funcCallExpr.args[0]!;
        if (
          exprIsAtom(importArg) &&
          (importArg as AtomExpr).token.position.row ===
            stringToken.position.row &&
          (importArg as AtomExpr).token.position.column ===
            stringToken.position.column
        ) {
          // The import expression's value should be a StructValue
          // which has an env with the resolved module path
          const importValue = funcCallExpr.$?.value;
          if (importValue && isStructValue(importValue)) {
            const modulePath = importValue.type.env.modulePath;
            if (modulePath) {
              result = {
                uri: modulePathToUri(modulePath),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              };
              return;
            }
          }
        }
      }
      search(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        search(arg);
      }
    }
  };

  for (const expr of exprs) {
    search(expr);
  }
  return result;
}

/**
 * Search through environment frames to find a variable definition.
 */
function findVariableDefinition(
  env: Environment,
  variableName: string
): { definitionToken: Token; definitionModulePath: string } | null {
  try {
    // Search local scopes
    for (
      let frameIndex = env.frames.length - 1;
      frameIndex >= 0;
      frameIndex--
    ) {
      const frame = env.frames[frameIndex];
      if (frame?.variables) {
        for (const variable of frame.variables) {
          if (variable.name === variableName) {
            return {
              definitionToken: variable.token,
              definitionModulePath: variable.token.modulePath,
            };
          }
        }
      }
    }

    // Search module values for the symbol
    for (
      let frameIndex = env.frames.length - 1;
      frameIndex >= 0;
      frameIndex--
    ) {
      const frame = env.frames[frameIndex];
      if (frame?.variables) {
        for (const variable of frame.variables) {
          if (variable.value && isStructValue(variable.value[0])) {
            const moduleValue = variable.value[0] as StructValue;
            if (moduleValue.type && moduleValue.type.fields) {
              for (const element of moduleValue.type.fields) {
                if (element && element.label === variableName) {
                  return {
                    definitionToken: element.exprs.expr.token,
                    definitionModulePath: element.exprs.expr.token.modulePath,
                  };
                }
              }
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Find the definition of a field or method accessed via `.` (property access).
 * Walks the AST to find a parent `.` call where the target expression is the
 * field name (second arg), resolves the receiver type, then locates the field
 * definition token in the struct/union/enum/trait/impl definition.
 */
function findFieldDefinitionLocation(
  exprs: Expr[],
  targetExpr: Expr,
  targetToken: Token
): Location | null {
  const fieldName = targetToken.value;

  // Find the parent "." call
  const dotCall = findParentDotCallForExpr(exprs, targetExpr);
  if (!dotCall) return null;

  const receiver = dotCall.args[0];
  if (!receiver) return null;

  let receiverType = receiver.$?.type;
  if (!receiverType) return null;

  // Unwrap TypeValue for type-level access (e.g., `Point.origin`)
  if (
    isTypeHierarchyType(receiverType) &&
    receiver.$?.value &&
    isTypeValue(receiver.$.value)
  ) {
    receiverType = receiver.$.value.value;
  }

  // Auto-dereference pointers
  while (isPtrType(receiverType)) {
    receiverType = receiverType.childType;
  }

  // Check struct/union fields for definition token
  if (isStructType(receiverType) || isUnionType(receiverType)) {
    const structType = receiverType as StructType;
    for (const field of structType.fields) {
      if (field.label === fieldName && field.exprs?.expr?.token) {
        const token = field.exprs.expr.token;
        return {
          uri: modulePathToUri(token.modulePath),
          range: {
            start: {
              line: token.position.row,
              character: token.position.column,
            },
            end: {
              line: token.position.row,
              character: token.position.column + token.value.length,
            },
          },
        };
      }
    }
  }

  // Check trait fields (methods from impl blocks)
  if (receiverType.trait) {
    for (const tf of receiverType.trait.fields) {
      if (tf.label === fieldName) {
        // First check if the trait field's expr token directly names the field
        // (this works for direct trait definitions like `trait(method : fn(...))`)
        if (tf.exprs?.expr?.token && tf.exprs.expr.token.value === fieldName) {
          const token = tf.exprs.expr.token;
          return {
            uri: modulePathToUri(token.modulePath),
            range: {
              start: {
                line: token.position.row,
                character: token.position.column,
              },
              end: {
                line: token.position.row,
                character: token.position.column + token.value.length,
              },
            },
          };
        }

        // For impl-injected fields, the expr token points to the `impl` call
        // instead of the field name. Search the AST for impl() calls that
        // contain a labeled arg `fieldName : ...` and return that label token.
        const implLabelToken = findImplFieldLabelToken(
          exprs,
          fieldName,
          receiverType.typeName
        );
        if (implLabelToken) {
          return {
            uri: modulePathToUri(implLabelToken.modulePath),
            range: {
              start: {
                line: implLabelToken.position.row,
                character: implLabelToken.position.column,
              },
              end: {
                line: implLabelToken.position.row,
                character:
                  implLabelToken.position.column + implLabelToken.value.length,
              },
            },
          };
        }
      }

      // Check named trait impl entries (stored with label="" and TraitValue)
      if (
        tf.label === "" &&
        tf.assignedValue &&
        isTraitValue(tf.assignedValue)
      ) {
        const traitVal = tf.assignedValue;
        const traitType = traitVal.type;
        for (let i = 0; i < traitType.fields.length; i++) {
          const sf = traitType.fields[i]!;
          if (sf.label === fieldName) {
            // Try to get definition from the trait field's expression token
            if (sf.exprs?.expr?.token) {
              const token = sf.exprs.expr.token;
              return {
                uri: modulePathToUri(token.modulePath),
                range: {
                  start: {
                    line: token.position.row,
                    character: token.position.column,
                  },
                  end: {
                    line: token.position.row,
                    character: token.position.column + token.value.length,
                  },
                },
              };
            }
            // Fallback: try the function value's definition token
            const value = traitVal.fields[i];
            if (isFunctionValue(value) && value.body?.token) {
              const token = value.body.token;
              return {
                uri: modulePathToUri(token.modulePath),
                range: {
                  start: {
                    line: token.position.row,
                    character: token.position.column,
                  },
                  end: {
                    line: token.position.row,
                    character: token.position.column + token.value.length,
                  },
                },
              };
            }
          }
        }
      }
    }
  }

  // Check module fields
  if (isSourceNamespaceType(receiverType)) {
    for (const field of receiverType.fields) {
      if (field.label === fieldName && field.exprs?.expr?.token) {
        const token = field.exprs.expr.token;
        return {
          uri: modulePathToUri(token.modulePath),
          range: {
            start: {
              line: token.position.row,
              character: token.position.column,
            },
            end: {
              line: token.position.row,
              character: token.position.column + token.value.length,
            },
          },
        };
      }
    }
  }

  return null;
}

/**
 * Find the definition of an enum variant constructor (e.g., `Red` in `.Red`).
 * Searches the AST of the module where the enum is defined for the `enum()` call
 * that contains the variant name as an argument.
 */
function findEnumVariantDefinition(
  expr: AtomExpr,
  variantName: string,
  docManager: LspDocumentManager
): Location | null {
  let enumType: EnumType | null = null;

  const type = expr.$?.type;
  if (type && isEnumType(type)) {
    // Direct enum type (e.g., `Red` in `.Red` for simple variants)
    enumType = type as EnumType;
  } else if (
    type &&
    isTypeHierarchyType(type) &&
    expr.$?.value &&
    isTypeValue(expr.$.value)
  ) {
    // TypeValue wrapping an enum (e.g., `Square` in `.Square(i32(5))`)
    const innerType = expr.$.value.value;
    if (isEnumType(innerType)) {
      enumType = innerType as EnumType;
    }
  }

  if (!enumType) return null;

  // Verify this variant exists in the enum
  if (!enumType.variants.some((v) => v.name === variantName)) return null;

  // Find the module where the enum is defined
  const enumModulePath = enumType.env.modulePath;
  if (!enumModulePath) return null;

  const enumModule = docManager.getModule(modulePathToUri(enumModulePath));
  if (!enumModule) return null;

  const enumExprs = enumModule.evaluator.getProgram();
  return findEnumVariantTokenInAst(enumExprs, variantName, enumType.typeName);
}

/**
 * Search an AST for an `enum()` call assigned to `enumTypeName` and return
 * the token of a matching variant arg.
 */
function findEnumVariantTokenInAst(
  exprs: Expr[],
  variantName: string,
  enumTypeName: string | undefined
): Location | null {
  let result: Location | null = null;

  const search = (expr: Expr, insideTargetEnum: boolean) => {
    if (result) return;
    if (!exprIsFunctionCall(expr)) return;
    const fnExpr = expr as FnCallExpr;

    // Check for `TypeName :: enum(...)` assignment pattern
    if (
      exprIsFunctionCallOf(fnExpr, "::") &&
      fnExpr.args.length >= 2 &&
      exprIsAtom(fnExpr.args[0]!) &&
      enumTypeName &&
      (fnExpr.args[0] as AtomExpr).token.value === enumTypeName
    ) {
      // Recurse into the RHS with insideTargetEnum=true
      search(fnExpr.args[1]!, true);
      return;
    }

    if (insideTargetEnum && exprIsFunctionCallOf(fnExpr, "enum")) {
      for (const arg of fnExpr.args) {
        const variantToken = getVariantNameToken(arg);
        if (variantToken && variantToken.value === variantName) {
          result = {
            uri: modulePathToUri(variantToken.modulePath),
            range: {
              start: {
                line: variantToken.position.row,
                character: variantToken.position.column,
              },
              end: {
                line: variantToken.position.row,
                character:
                  variantToken.position.column + variantToken.value.length,
              },
            },
          };
          return;
        }
      }
    }

    // Recurse into sub-expressions
    search(fnExpr.func, insideTargetEnum);
    for (const arg of fnExpr.args) {
      search(arg, insideTargetEnum);
    }
  };

  for (const topExpr of exprs) {
    search(topExpr, false);
  }
  return result;
}

/**
 * Extract the variant name token from an enum variant arg expression.
 * Variants can be: bare identifier `Red`, call with fields `Some(value : T)`,
 * or GADT form with `-> recur(...)`.
 */
function getVariantNameToken(expr: Expr): Token | null {
  // Bare identifier: `Red`
  if (exprIsAtom(expr)) {
    return (expr as AtomExpr).token;
  }
  // Call with fields: `Some(value : T)` or GADT: `IntVal(i : i32) -> recur(i32)`
  // or discriminant: `(Red) = 0`
  if (exprIsFunctionCall(expr)) {
    const fnExpr = expr as FnCallExpr;
    // `Some(value : T)` — func is the variant name atom
    if (exprIsAtom(fnExpr.func)) {
      return (fnExpr.func as AtomExpr).token;
    }
    // Could be wrapped in other calls (e.g., GADT `->` call or discriminant `=`)
    // Try recursing into func
    return getVariantNameToken(fnExpr.func);
  }
  return null;
}
function findParentDotCallForExpr(
  exprs: Expr[],
  targetExpr: Expr
): FnCallExpr | null {
  let result: FnCallExpr | null = null;

  const search = (expr: Expr) => {
    if (result) return;
    if (!exprIsFunctionCall(expr)) return;
    const fnExpr = expr as FnCallExpr;

    if (
      exprIsFunctionCallOf(fnExpr, ".") &&
      fnExpr.args.length === 2 &&
      fnExpr.args[1] === targetExpr
    ) {
      result = fnExpr;
      return;
    }

    search(fnExpr.func);
    for (const arg of fnExpr.args) {
      search(arg);
    }
  };

  for (const topExpr of exprs) {
    search(topExpr);
  }
  return result;
}

/**
 * Search the AST for impl() calls to find the label token for a named field.
 * impl(Type, fieldName : value) → the `fieldName` atom token.
 * The label is the first arg of a `:` call inside the impl's arg list.
 */
function findImplFieldLabelToken(
  exprs: Expr[],
  fieldName: string,
  typeName: string | undefined
): Token | null {
  let result: Token | null = null;

  const search = (expr: Expr) => {
    if (result) return;
    if (!exprIsFunctionCall(expr)) return;
    const fnExpr = expr as FnCallExpr;

    if (exprIsFunctionCallOf(fnExpr, "impl") && fnExpr.args.length >= 2) {
      // Verify the first arg is the target type
      const typeArg = fnExpr.args[0];
      if (
        typeArg &&
        exprIsAtom(typeArg) &&
        typeName &&
        typeArg.token.value === typeName
      ) {
        // Search remaining args for `fieldName : ...` (parsed as `:` call)
        for (let i = 1; i < fnExpr.args.length; i++) {
          const arg = fnExpr.args[i]!;
          if (
            exprIsFunctionCall(arg) &&
            exprIsFunctionCallOf(arg as FnCallExpr, ":")
          ) {
            const labelCall = arg as FnCallExpr;
            if (
              labelCall.args.length >= 1 &&
              exprIsAtom(labelCall.args[0]!) &&
              labelCall.args[0]!.token.value === fieldName
            ) {
              result = labelCall.args[0]!.token;
              return;
            }
          }
        }
      }
    }

    // Recurse into sub-expressions
    search(fnExpr.func);
    for (const arg of fnExpr.args) {
      search(arg);
    }
  };

  for (const topExpr of exprs) {
    search(topExpr);
  }
  return result;
}
