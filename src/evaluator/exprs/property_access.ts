import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  exprIsAtom,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import {
  areTypesCompatible,
  EnumType,
  getValueOfSomeTypeFromEnv,
  isEnumType,
  isFunctionType,
  isModuleType,
  isPtrType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isUnionType,
  ModuleField,
  TypeField,
  typeToString,
} from "../../types";
import {
  createEnumValue,
  createTypeValue,
  createUnknownValue,
  isEnumValue,
  isFunctionValue,
  isModuleValue,
  isStructValue,
  isTraitValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isValidVariableName } from "../utils";
import {
  findMethodFromGenericImplForTrait,
  findMethodsFromGenericImpls,
} from "../values/impl";

export function evaluatePropertyAccess({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, ".")) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "." for property access, got:\n${exprToString(expr)}`,
    });
  }

  if (exprIsFunctionCallOf(expr, ".", 1)) {
    // Expect the argument to be an identifier
    const propertyExpr = expr.args[0]!;
    if (!exprIsAtom(propertyExpr) && !isValidVariableName(propertyExpr)) {
      throw formatErrorMessage({
        token: propertyExpr.token,
        errorMessage: `Expected identifier for enum variant access, got:\n${exprToString(
          propertyExpr
        )}`,
      });
    }

    const expectedEnumType = context.expectedType?.type;
    if (!isEnumType(expectedEnumType)) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `Failed to infer enum variant type.`,
      });
    }
    const variantName = propertyExpr.token.value;
    const enumType = expectedEnumType;

    const variant = enumType.variants.find(
      (variant) => variant.name === variantName
    );
    if (!variant) {
      throw formatErrorMessage({
        token: propertyExpr.token,
        errorMessage: `Enum variant "${variantName}" not found in enum`,
      });
    }
    const newEnumType: EnumType = {
      ...enumType,
      selectedVariantName: variantName,
    };

    /**
     * This is for case like
     * Color :: enum Red, Green, Blue;
     * r := Color.Red;
     */
    if (!variant.fields) {
      expr.$ = {
        env,
        type: newEnumType,
        // FIXME: Support expr.value for comptime evaluation.
        value: createEnumValue(newEnumType, variantName, []),
        pathCollection: [],
      };

      propertyExpr.$ = {
        env,
        type: newEnumType,
        pathCollection: [],
      };
    } else {
      /**
       * This is for case like
       * Shape := enum Circle(i32), Square(i32, i32);
       * c := Shape.Circle(3);
       */
      const enumTypeValue = createTypeValue(newEnumType);
      expr.$ = {
        env,
        value: enumTypeValue,
        type: enumTypeValue.type,
        pathCollection: [],
      };

      propertyExpr.$ = expr.$;
    }
    return expr;
  }

  if (!exprIsFunctionCallOf(expr, ".", 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "." with 2 arguments, got:\n${exprToString(expr)}`,
    });
  }

  let objectExpr = expr.args[0]!;
  const propertyExpr = expr.args[1]!;

  // Evaluate object
  // Note: We don't pass expectedType when evaluating the object, because the expectedType
  // applies to the final property access result, not to the object itself.
  // For example, in `use_id(bi).*`, the expectedType might be i32, but use_id(bi) returns Box(i32).
  objectExpr = evaluateExpression({
    expr: objectExpr,
    env,
    context: { ...context, expectedType: undefined },
  });
  if (objectExpr.$?.env) {
    env = objectExpr.$?.env;
  }

  // NOTE: We shouldn't check borrowings here,
  // because it might be like:
  //   &(point.x); // point.x is borrowed
  //
  //   &(point.y) here objectExpr is Point, if we check borrowing here it will throw error.
  //
  // Check borrowings
  // checkBorrowings(context.borrowings, objectExpr);

  // Check if it's .* for dereference
  if (exprIsAtom(propertyExpr) && propertyExpr.token.value === "*") {
    if (isPtrType(objectExpr.$?.type)) {
      const pointerType = objectExpr.$.type;
      let baseType = pointerType.childType;

      // CRITICAL: If the child type is a SomeType, we need to resolve it from the environment
      // to get the properly constrained version (e.g., with where clause trait constraints).
      // This is necessary because during function specialization, SomeTypes might be created
      // that reference the type parameter name but don't carry over the trait.fields from
      // the original where clause constraints.
      // QUESTION: Is this correct? This fix is related to hash_set.yo
      if (isSomeType(baseType)) {
        baseType = getValueOfSomeTypeFromEnv(env, baseType);
      }

      expr.$ = {
        env,
        type: baseType,
        value: undefined,
        originType: pointerType, // Set origin type to the pointer type to track mutability path
        isAccessingProperty: true,
        pathCollection: [],
      };
      propertyExpr.$ = expr.$;

      // CRITICAL: Create a temp variable marked as NOT owning the RC value (borrowed).
      // This ensures that when this dereferenced value is returned from a function,
      // the ownership analysis in begin.ts will correctly identify it as borrowed
      // and insert a ___dup call. Without this, returning `self.*` from a function
      // would cause use-after-free bugs.
      attachTempVariableToExpr(expr, false);

      return expr;
    }
  }

  if (isTypeValue(objectExpr.$?.value)) {
    const typeValue = objectExpr.$.value;
    if (isEnumType(typeValue.value)) {
      // Expect propertyExpr to be a symbol atom
      if (!exprIsAtom(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for enum variant, got:\n${exprToString(propertyExpr)}`,
        });
      }

      // Check if it's accessing comptime field
      {
        const propertyName = propertyExpr.token.value;
        const field = typeValue.value.trait.fields.find(
          (method) => method.label === propertyName
        );
        if (field) {
          expr.$ = {
            env,
            type: field.type,
            value: field.assignedValue!,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }
      }

      const variantName = propertyExpr.token.value;
      // Check if variantName is a valid enum variant
      const enumType = typeValue.value;
      const variant = enumType.variants.find(
        (variant) => variant.name === variantName
      );
      if (!variant) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Enum variant "${variantName}" not found in enum`,
        });
      }
      const newEnumType: EnumType = {
        ...enumType,
        selectedVariantName: variantName,
      };

      /**
       * This is for case like
       * Color :: enum Red, Green, Blue;
       * Red :: Color.Red;
       */
      if (!variant.fields) {
        expr.$ = {
          env,
          type: newEnumType,
          // FIXME: Support expr.value for comptime evaluation.
          value: createEnumValue(newEnumType, variantName, []),
          isAccessingProperty: true,
          pathCollection: [],
        };

        propertyExpr.$ = expr.$;
      } else {
        /**
         * This is for case like
         * Shape := enum Circle(i32), Square(i32, i32);
         * c := Shape.Circle(3);
         */
        const enumTypeValue = createTypeValue(newEnumType);
        expr.$ = {
          env,
          type: enumTypeValue.type,
          value: enumTypeValue,
          isAccessingProperty: true,
          pathCollection: [],
        };

        propertyExpr.$ = expr.$;
      }
      return expr;
    }
    // Accessing compt fields of a struct/union/dyn etc type.
    else if (typeValue.value.trait) {
      if (!isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for type method, got:\n${exprToString(propertyExpr)}`,
        });
      }
      const propertyName = propertyExpr.token.value;
      // Check if the type method exists
      // Use findLast to get the most recently added field (handles duplicates from impl blocks)
      const field = typeValue.value.trait.fields.findLast(
        (property) => property.label === propertyName
      );
      if (field) {
        // Use the type from the assigned value if it exists, otherwise use field.type
        const actualType = field.assignedValue?.type ?? field.type;

        expr.$ = {
          env,
          type: actualType,
          value: field.assignedValue!,
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found in type's own trait
        // Check if there's a generic impl for this type (e.g., impl(forall(T), *(T), {...}))
        const genericMethods = findMethodsFromGenericImpls({
          concreteType: typeValue.value,
          methodName: propertyName,
          env,
        });
        if (genericMethods.length > 0) {
          const method = genericMethods[0]!;
          expr.$ = {
            env,
            type: method.type,
            value: method.value,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }

        // Still not found - return undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getMethodsByNameFromEnv to find the method
        // in implicit given implementations (like TypeMethods)
        expr.$ = undefined;
        return expr;
      }
    }
    // Accessing module field
    else if (isModuleType(typeValue.value)) {
      if (!isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for type method, got:\n${exprToString(propertyExpr)}`,
        });
      }
      const propertyName = propertyExpr.token.value;
      const moduleType = typeValue.value;

      // Check if the type method exists in the module's own fields
      const field = moduleType.fields.find(
        (property) => property.label === propertyName
      );
      if (field) {
        expr.$ = {
          env,
          type: field.type,
          value:
            field.assignedValue ?? createUnknownValue(field.type, field.label),
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found in type's own module
        // Return expr with expr.$ = undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getMethodsByNameFromEnv to find the method
        // in implicit given implementations (like TypeMethods)
        expr.$ = undefined;
        return expr;
      }
    }
    // Access trait field
    else if (isTraitType(typeValue.value)) {
      if (!isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for type method, got:\n${exprToString(propertyExpr)}`,
        });
      }
      const propertyName = propertyExpr.token.value;
      const traitType = typeValue.value;

      // Special case: If the ModuleType has a receiverType set (from a subtype expression like (T <: PrintSelf)),
      // we need to look up the actual method implementation from the receiver type's trait.
      if (traitType.receiverType && traitType.receiverType.trait) {
        // Look for the impl'd trait that matches this trait type
        for (const field of traitType.receiverType.trait.fields) {
          if (
            field.label === "" &&
            field.assignedValue &&
            isTraitValue(field.assignedValue)
          ) {
            const implTraitValue = field.assignedValue;
            const implTraitType = implTraitValue.type;

            // Check if this impl trait matches our trait type using areTypesCompatible
            if (
              !areTypesCompatible(
                { type: traitType, env },
                { type: implTraitType, env }
              )
            ) {
              continue;
            }

            // Now look for the method in this matched impl trait
            const methodIndex = implTraitType.fields.findIndex(
              (f) => f.label === propertyName && isFunctionType(f.type)
            );
            if (methodIndex >= 0) {
              const method = implTraitType.fields[methodIndex]!;
              if (isFunctionType(method.type)) {
                // Get the actual function value from the trait value
                const methodValue = implTraitValue.fields[methodIndex];
                if (methodValue) {
                  // Use the function value's specialized type if available
                  let methodType = method.type;
                  if (
                    isFunctionValue(methodValue) &&
                    methodValue.specializedType
                  ) {
                    methodType = methodValue.specializedType;
                  }
                  expr.$ = {
                    env,
                    type: methodType,
                    value: methodValue,
                    pathCollection: [],
                    isAccessingProperty: true,
                  };
                  propertyExpr.$ = expr.$;
                  return expr;
                }
              }
            }
          }
        }

        // Not found in receiverType.trait.fields - try generic impl registry
        // This handles cases like `impl(forall(T : Type), Box(T), Isolation(...))`
        const genericMethod = findMethodFromGenericImplForTrait({
          concreteType: traitType.receiverType,
          traitType,
          methodName: propertyName,
          env,
        });
        if (genericMethod) {
          expr.$ = {
            env,
            type: genericMethod.type,
            value: genericMethod.value,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }
      }

      // Check if the type method exists in the trait's own fields
      const field = traitType.fields.find(
        (property) => property.label === propertyName
      );
      if (field) {
        expr.$ = {
          env,
          type: field.type,
          value:
            field.assignedValue ?? createUnknownValue(field.type, field.label),
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found in type's own trait
        // Return expr with expr.$ = undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getMethodsByNameFromEnv to find the method
        // in implicit given implementations (like TypeMethods)
        expr.$ = undefined;
        return expr;
      }
    }
  }

  let objectType = objectExpr.$?.type;
  const originalObjectType = objectExpr.$?.type; // Capture before dereferencing

  // QUESTION: Should we allow only one round here? Like zig.
  while (objectType && isPtrType(objectType)) {
    // Dereference the pointer or reference type
    objectType = objectType.childType;
  }

  if (
    isTupleType(objectType) ||
    isStructType(objectType) ||
    isUnionType(objectType)
  ) {
    const fields: TypeField[] = objectType.fields;
    const objectExprValue = objectExpr.$!.value;

    // Check if it's accessing the tuple field by
    // - number index: point.0
    // - label name:   point.x
    if (exprIsAtom(propertyExpr)) {
      if (propertyExpr.token.type === TokenType.Integer) {
        // Accessing by index is only allowed for tuples.
        if (!isTupleType(objectExpr.$?.type)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Accessing tuple field by index is only allowed for tuples.`,
          });
        }

        const index = parseInt(propertyExpr.token.value, 10);
        if (isNaN(index)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Expected integer for tuple index, got:\n${exprToString(propertyExpr)}`,
          });
        }

        const runtimeElementsCount = fields.filter(
          (field) => !field.isCompileTimeOnly
        ).length;

        if (index < 0 || index >= runtimeElementsCount) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Index out of bounds: ${index} for accessing field in:\n${typeToString(
              objectExpr.$?.type
            )}`,
          });
        }
        const tupleElement = fields[index]!;

        // Set origin type: use existing originType or the original object type
        const fieldOriginType = objectExpr.$.originType || originalObjectType;

        expr.$ = {
          env,
          type: tupleElement.type,
          originType: fieldOriginType,
          isAccessingProperty: true,
          pathCollection: [
            [
              objectExpr.$.variableName ?? "?", // FIXME
              propertyExpr.token.value,
            ],
          ],
        };
        propertyExpr.$ = expr.$;

        // TODO: Support comptime value
        // expr.value = ...
        if (objectExprValue) {
          let values: (Value | undefined)[] = [];
          if (isTupleValue(objectExprValue)) {
            values = objectExprValue.fields;
          } else if (isStructValue(objectExprValue)) {
            values = objectExprValue.fields;
          }
          expr.$.value = values?.[index];
        }

        attachTempVariableToExpr(expr, false); // NOTE: This should not take the ownership of the value

        return expr;
      } else if (isValidVariableName(propertyExpr)) {
        const label = propertyExpr.token.value;
        {
          const tupleFieldIndex = fields.findIndex(
            // NOTE: To access comptime only field, use the type instead, not the value.
            // The value can only access runtime fields.
            (field) => field.label === label
          );
          if (tupleFieldIndex < 0) {
            if (isModuleType(objectExpr.$?.type)) {
              throw formatErrorMessage({
                token: propertyExpr.token,
                errorMessage: `Module field "${label}" not found in module type`,
              });
            }

            // It could be method call
            expr.$ = undefined;
            return expr;
          }
          const tupleElement = fields[tupleFieldIndex]!;

          // Set origin type: use existing originType or the original object type
          const fieldOriginType =
            objectExpr.$?.originType || originalObjectType;

          expr.$ = {
            env,
            type: tupleElement.type,
            originType: fieldOriginType,
            isAccessingProperty: true,
            pathCollection: [
              [
                objectExpr.$!.variableName ?? "?", // FIXME
                propertyExpr.token.value,
              ],
            ],
          };
          propertyExpr.$ = expr.$;

          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            if (isUnknownValue(objectExprValue)) {
              expr.$.value = createUnknownValue(tupleElement.type);
            } else {
              let values: (Value | undefined)[] = [];
              if (isTupleValue(objectExprValue)) {
                values = objectExprValue.fields;
              } else if (isStructValue(objectExprValue)) {
                values = objectExprValue.fields;
              }

              let value = values?.[tupleFieldIndex];
              if (!value) {
                value = createUnknownValue(tupleElement.type);
              }

              expr.$.value = value;
            }
          }

          attachTempVariableToExpr(expr, false); // NOTE: This should not take the ownership of the value

          return expr;
        }
      }
    }
  } else if (isModuleType(objectType)) {
    const fields: ModuleField[] = objectType.fields;
    const objectExprValue = objectExpr.$!.value;

    // Check if it's accessing the tuple field by
    // - label name:   SomeModule.some_function
    if (exprIsAtom(propertyExpr)) {
      if (propertyExpr.token.type === TokenType.Integer) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Accessomg module field by index is not allowed, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      } else if (isValidVariableName(propertyExpr)) {
        const label = propertyExpr.token.value;

        {
          const tupleFieldIndex = fields.findIndex(
            (field) => field.label === label
          );
          if (tupleFieldIndex < 0) {
            if (isModuleType(objectExpr.$?.type)) {
              throw formatErrorMessage({
                token: propertyExpr.token,
                errorMessage: `Module field "${label}" not found in module type`,
              });
            }

            // It could be method call
            expr.$ = undefined;
            return expr;
          }
          const tupleElement = fields[tupleFieldIndex]!;
          expr.$ = {
            env,
            type: tupleElement.type,
            isAccessingProperty: true,
            pathCollection: [
              [
                objectExpr.$!.variableName ?? "?", // FIXME
                propertyExpr.token.value,
              ],
            ],
          };
          propertyExpr.$ = expr.$;

          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            if (isUnknownValue(objectExprValue)) {
              expr.$.value = createUnknownValue(tupleElement.type);
            } else {
              let values: (Value | undefined)[] = [];
              if (isModuleValue(objectExprValue)) {
                values = objectExprValue.fields;
              }

              let value = values?.[tupleFieldIndex];
              if (!value && tupleElement.isCompileTimeOnly) {
                value = createUnknownValue(tupleElement.type);
              }

              expr.$.value = value;
            }
          }
          return expr;
        }
      }
    }
  } else if (isEnumType(objectType)) {
    if (exprIsAtom(propertyExpr)) {
      if (!isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for enum variant property, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      }

      const propertyName = propertyExpr.token.value;
      const selectedVariant = objectType.variants.find(
        (variant) => variant.name === objectType.selectedVariantName
      );
      if (selectedVariant) {
        // Check if the property exists in the selected variant
        const fieldIndex = (selectedVariant.fields ?? []).findIndex(
          (property) => property.label === propertyName
        );
        if (fieldIndex < 0) {
          /*
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Enum variant property "${propertyName}" not found in enum variant "${objectType.selectedVariantName}"`,
          });
          */
          // It could be method call
          expr.$ = undefined;
          return expr;
        }

        const field = (selectedVariant.fields ?? [])[fieldIndex]!;

        expr.$ = {
          env,
          type: field.type,
          value: undefined,
          pathCollection: [
            [
              objectExpr.$!.variableName ?? "?", // FIXME
              propertyExpr.token.value,
            ],
          ],
          isAccessingProperty: true,
        };

        // handle comptime value
        const variantValue = objectExpr.$?.value;
        if (
          variantValue &&
          isEnumValue(variantValue) &&
          variantValue.variantName === selectedVariant.name
        ) {
          expr.$.value = variantValue.fields[fieldIndex];
        }

        propertyExpr.$ = expr.$;

        return expr;
      } else {
        // It could be enum method call, so we ignore here.
      }
    }
  }

  // TODO: Evaluate the module method call
  // Since we fail to evaluate the property access
  // it could be an ~~uniform function call~~ module method call.
  expr.$ = undefined;
  return expr;
}
