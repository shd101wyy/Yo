import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  exprIsAtom,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import type { EnumType, ModuleField, TypeField } from "../../types/definitions";
import { getValueOfSomeTypeFromEnv } from "../../types/env-lookup";
import {
  isArcType,
  isEnumType,
  isFunctionType,
  isModuleType,
  isPtrType,
  isSomeType,
  isStructType,
  isTraitType,
  isTupleType,
  isUnionType,
} from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createEnumValue,
  createTypeValue,
  createUnknownValue,
  isArrayValue,
  isEnumValue,
  isFunctionValue,
  isModuleValue,
  isPtrValue,
  isStructValue,
  isTraitValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";
import {
  findAssociatedTypeFromGenericImpls,
  findMethodFromGenericImplForTrait,
  findMethodsFromGenericImpls,
} from "../values/impl";
import { evaluateExpression } from "./expr";

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
      (_variant) => _variant.name === variantName
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
      // to get the properly constrained version (e.g., with where-clause constraints).
      // This is necessary because during function specialization, SomeTypes might be created
      // that reference the type parameter name but don't carry over the env-scoped constraints.
      // QUESTION: Is this correct? This fix is related to hash_set.yo
      if (isSomeType(baseType)) {
        baseType = getValueOfSomeTypeFromEnv(env, baseType);
      }

      // Check for compile-time pointer dereference
      const objectValue = objectExpr.$?.value;
      if (isPtrValue(objectValue)) {
        // For compile-time pointers, get the dereferenced value
        // If targetValue[0] is an ArrayValue, use targetIndex to get the element
        // Otherwise, targetValue[0] is the value itself (targetIndex should be 0)
        const target = objectValue.targetValue[0];
        let dereferencedValue: Value;
        if (isArrayValue(target)) {
          dereferencedValue = target.elements[objectValue.targetIndex]!;
        } else {
          dereferencedValue = target;
        }
        expr.$ = {
          env,
          type: baseType,
          value: dereferencedValue,
          originType: pointerType,
          isAccessingProperty: true,
          pathCollection: [],
          // Pass through the targetValue array so assignments can update it
          sourceVariable: objectExpr.$.sourceVariable,
        };
        // Store a reference to the pointer's targetValue and targetIndex for compile-time assignment
        (
          expr.$ as { ptrTargetValue?: [Value]; ptrTargetIndex?: number }
        ).ptrTargetValue = objectValue.targetValue;
        (
          expr.$ as { ptrTargetValue?: [Value]; ptrTargetIndex?: number }
        ).ptrTargetIndex = objectValue.targetIndex;
        propertyExpr.$ = expr.$;
        return expr;
      }

      // Handle UnknownValue for CTFE - dereference returns an UnknownValue of the base type
      if (isUnknownValue(objectValue)) {
        const dereferencedValue = createUnknownValue(baseType, {
          variableName: objectValue.variableName
            ? `${objectValue.variableName}.*`
            : undefined,
          env,
          context,
        });
        if (objectValue.isRuntimeOnly && isUnknownValue(dereferencedValue)) {
          dereferencedValue.isRuntimeOnly = true;
        }
        expr.$ = {
          env,
          type: baseType,
          value: dereferencedValue,
          originType: pointerType,
          isAccessingProperty: true,
          pathCollection: [],
        };
        propertyExpr.$ = expr.$;
        return expr;
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

    // Arc dereference: arc.(*) returns borrowed reference to inner value
    if (isArcType(objectExpr.$?.type)) {
      const arcType = objectExpr.$.type;
      let baseType = arcType.childType;

      if (isSomeType(baseType)) {
        baseType = getValueOfSomeTypeFromEnv(env, baseType);
      }

      expr.$ = {
        env,
        type: baseType,
        value: undefined,
        originType: arcType,
        isAccessingProperty: true,
        pathCollection: [],
      };
      propertyExpr.$ = expr.$;

      // Borrowed — the inner value's lifetime is managed by Arc
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
        (_variant) => _variant.name === variantName
      );
      if (!variant) {
        // Before throwing, check if the property is an impl'd method
        // (same pattern used for struct types at the generic impl lookup below)
        const genericMethods = findMethodsFromGenericImpls({
          concreteType: typeValue.value,
          methodName: variantName,
          env,
        });
        if (genericMethods.length === 1) {
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
        if (genericMethods.length > 1) {
          // Multiple matches — defer to function.ts for disambiguation
          expr.$ = undefined;
          return expr;
        }

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
    // Accessing comptime fields of a struct/union/dyn etc type.
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
        // First check if the field has an assigned value (e.g., from impl providing Error : str)
        // This takes precedence over the unassignedSomeType placeholder
        if (field.assignedValue) {
          // Use the type from the assigned value
          const actualType = field.assignedValue.type;

          expr.$ = {
            env,
            type: actualType,
            value: field.assignedValue,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }

        // Check if this is an associated type (has unassignedSomeType but no assignedValue)
        // If so, return a TypeValue containing the SomeType placeholder
        if (field.unassignedSomeType) {
          const someTypeValue = createTypeValue(field.unassignedSomeType);
          expr.$ = {
            env,
            type: someTypeValue.type,
            value: someTypeValue,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }

        // Use field.type if no assigned value exists
        expr.$ = {
          env,
          type: field.type,
          value: undefined,
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found directly in type's own trait
        // Check impl'd trait values (fields with empty label that contain trait values)
        // These are created by impl(Type, Trait(...)) and contain associated type values
        // NOTE: Only resolve non-function values here (like associated types).
        // Function values (methods) should be deferred to function.ts for proper overload resolution.
        for (const implField of typeValue.value.trait.fields) {
          if (
            implField.label === "" &&
            implField.assignedValue &&
            isTraitValue(implField.assignedValue)
          ) {
            const implTraitValue = implField.assignedValue;
            const implTraitType = implTraitValue.type;
            // Search for the property in the impl'd trait
            const fieldIndex = implTraitType.fields.findIndex(
              (f) => f.label === propertyName
            );
            if (fieldIndex >= 0) {
              const traitField = implTraitType.fields[fieldIndex]!;
              const fieldValue = implTraitValue.fields[fieldIndex];

              // Skip function types - let function.ts handle method resolution
              // This allows proper overload resolution when multiple impls have the same method
              if (isFunctionType(traitField.type)) {
                continue;
              }

              if (fieldValue) {
                expr.$ = {
                  env,
                  type: fieldValue.type,
                  value: fieldValue,
                  pathCollection: [],
                  isAccessingProperty: true,
                };
                propertyExpr.$ = expr.$;
                return expr;
              } else if (traitField.unassignedSomeType) {
                // Associated type without assigned value
                const someTypeValue = createTypeValue(
                  traitField.unassignedSomeType
                );
                expr.$ = {
                  env,
                  type: someTypeValue.type,
                  value: someTypeValue,
                  pathCollection: [],
                  isAccessingProperty: true,
                };
                propertyExpr.$ = expr.$;
                return expr;
              }
            }
          }
        }

        // Check if there's a generic impl for this type (e.g., impl(forall(T), *(T), {...}))
        const genericMethods = findMethodsFromGenericImpls({
          concreteType: typeValue.value,
          methodName: propertyName,
          env,
        });
        // Only resolve here if there's exactly one match.
        // If there are multiple (e.g., multiple TryFrom implementations),
        // defer to function.ts which can resolve based on call arguments.
        if (genericMethods.length === 1) {
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

        // Check for associated types from generic impls (e.g., Self.Item from Iterator(T))
        const associatedType = findAssociatedTypeFromGenericImpls({
          concreteType: typeValue.value,
          propertyName,
          env,
        });
        if (associatedType) {
          expr.$ = {
            env,
            type: associatedType.type,
            value: associatedType.value,
            pathCollection: [],
            isAccessingProperty: true,
          };
          propertyExpr.$ = expr.$;
          return expr;
        }

        // Still not found - return undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getTypeTraitMethodsByNameFromEnv to find the method
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
            field.assignedValue ??
            createUnknownValue(field.type, {
              variableName: field.label,
              env,
              context,
            }),
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found in type's own module
        // Return expr with expr.$ = undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getTypeTraitMethodsByNameFromEnv to find the method
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
            field.assignedValue ??
            createUnknownValue(field.type, {
              variableName: field.label,
              env,
              context,
            }),
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // Property not found in type's own trait
        // Return expr with expr.$ = undefined to allow function.ts
        // to handle this as a uniform function call (method call)
        // function.ts will call getTypeTraitMethodsByNameFromEnv to find the method
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

        const fieldCount = fields.length;

        if (index < 0 || index >= fieldCount) {
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

        const indexPathCollection =
          objectExpr.$.pathCollection && objectExpr.$.pathCollection.length > 0
            ? objectExpr.$.pathCollection.map((p) => [
                ...p,
                propertyExpr.token.value,
              ])
            : [[objectExpr.$.variableName ?? "?", propertyExpr.token.value]];
        expr.$ = {
          env,
          type: tupleElement.type,
          originType: fieldOriginType,
          isAccessingProperty: true,
          pathCollection: indexPathCollection,
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

          const labelPathCollection =
            objectExpr.$!.pathCollection &&
            objectExpr.$!.pathCollection.length > 0
              ? objectExpr.$!.pathCollection.map((p) => [
                  ...p,
                  propertyExpr.token.value,
                ])
              : [[objectExpr.$!.variableName ?? "?", propertyExpr.token.value]];
          expr.$ = {
            env,
            type: tupleElement.type,
            originType: fieldOriginType,
            isAccessingProperty: true,
            pathCollection: labelPathCollection,
          };
          propertyExpr.$ = expr.$;

          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            if (isUnknownValue(objectExprValue)) {
              const fieldUnknown = createUnknownValue(tupleElement.type, {
                env,
                context,
              });
              if (
                objectExprValue.isRuntimeOnly &&
                isUnknownValue(fieldUnknown)
              ) {
                fieldUnknown.isRuntimeOnly = true;
              }
              expr.$.value = fieldUnknown;
            } else {
              let values: (Value | undefined)[] = [];
              if (isTupleValue(objectExprValue)) {
                values = objectExprValue.fields;
              } else if (isStructValue(objectExprValue)) {
                values = objectExprValue.fields;
              }

              let value = values?.[tupleFieldIndex];
              if (!value) {
                value = createUnknownValue(tupleElement.type, { env, context });
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
          const moduleFieldIndex = fields.findIndex(
            (field) => field.label === label
          );
          if (moduleFieldIndex < 0) {
            if (isModuleType(objectExpr.$?.type)) {
              // Check if this module is still being evaluated (circular import).
              // If so, the field might exist but hasn't been exported yet.
              if (
                objectExprValue &&
                isModuleValue(objectExprValue) &&
                objectExprValue.isLoading
              ) {
                throw formatErrorMessage({
                  token: propertyExpr.token,
                  errorMessage: `Field "${label}" is not yet available from this module. In a circular import, only fields exported before the import of the current module are accessible. Reorder your exports or break the cycle.`,
                });
              }
              throw formatErrorMessage({
                token: propertyExpr.token,
                errorMessage: `Module field "${label}" not found in module type`,
              });
            }

            // It could be method call
            expr.$ = undefined;
            return expr;
          }
          const moduleField = fields[moduleFieldIndex]!;
          const modulePathCollection =
            objectExpr.$!.pathCollection &&
            objectExpr.$!.pathCollection.length > 0
              ? objectExpr.$!.pathCollection.map((p) => [
                  ...p,
                  propertyExpr.token.value,
                ])
              : [[objectExpr.$!.variableName ?? "?", propertyExpr.token.value]];
          expr.$ = {
            env,
            type: moduleField.type,
            isAccessingProperty: true,
            pathCollection: modulePathCollection,
          };
          propertyExpr.$ = expr.$;

          // TODO: Support comptime value
          // expr.value = ...
          if (objectExprValue) {
            if (isUnknownValue(objectExprValue)) {
              const fieldUnknown = createUnknownValue(moduleField.type, {
                env,
                context,
              });
              if (
                objectExprValue.isRuntimeOnly &&
                isUnknownValue(fieldUnknown)
              ) {
                fieldUnknown.isRuntimeOnly = true;
              }
              expr.$.value = fieldUnknown;
            } else {
              let values: (Value | undefined)[] = [];
              if (isModuleValue(objectExprValue)) {
                values = objectExprValue.fields;
              }

              let value = values?.[moduleFieldIndex];
              if (!value) {
                value = createUnknownValue(moduleField.type, { env, context });
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
