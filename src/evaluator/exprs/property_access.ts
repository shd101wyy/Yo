import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import {
  createUsizeType,
  EnumType,
  isArrayType,
  isEnumType,
  isModuleType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isSliceType,
  isStructType,
  isTupleType,
  isUnionType,
  ModuleElement,
  TupleElement,
  typeToString,
} from "../../types";
import {
  createEnumValue,
  createTypeValue,
  createUnknownValue,
  isEnumValue,
  isModuleValue,
  isStructValue,
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { isValidVariableName } from "../utils";

export function evaluatePropertyAccess({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
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
    if (!variant.elements) {
      expr.$ = {
        env,
        type: newEnumType,
        // FIXME: Support expr.value for comptime evaluation.
        value: createEnumValue(newEnumType, variantName, []),
        isMutable: false,
        pathCollection: [],
      };

      propertyExpr.$ = {
        env,
        type: newEnumType,
        isMutable: false,
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
        isMutable: false,
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
  objectExpr = context.evaluateExpression({
    expr: objectExpr,
    env,
    context: { ...context },
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
    if (isPtrType(objectExpr.$?.type) || isMutPtrType(objectExpr.$?.type)) {
      const pointerType = objectExpr.$.type;
      const baseType = pointerType.type;

      // For pointer dereference, determine mutability:
      // The dereferenced value is mutable if the pointer type allows writes
      // and we have mutable access through the origin object
      const ptrTypeAllowsWrite = isMutPtrType(pointerType);

      let resultIsMutable: boolean;

      if (
        exprIsAtom(objectExpr) &&
        objectExpr.token.type === TokenType.Identifier
      ) {
        // Direct variable dereference: x.* where x is a pointer parameter
        // Only the pointer type matters for mutability
        resultIsMutable = ptrTypeAllowsWrite;
      } else {
        // Dereference through property access: c.ptr.* where c.ptr is a pointer
        // Check if the origin type allows mutable access
        const originType = objectExpr.$.originType;
        if (
          originType &&
          (isMutRefType(originType) || isMutPtrType(originType))
        ) {
          // Origin is a mutable reference/pointer, so we can mutate through it
          resultIsMutable = ptrTypeAllowsWrite;
        } else if (
          originType &&
          (isRefType(originType) || isPtrType(originType))
        ) {
          // Origin is an immutable reference/pointer, so we cannot mutate through it
          resultIsMutable = false;
        } else {
          // Origin is owned (by-value), so dereference mutability depends only on pointer type
          // In Rust: even `fn foo(c: Container)` allows `c.mutable_ptr.*` = value
          resultIsMutable = ptrTypeAllowsWrite;
        }
      }

      expr.$ = {
        env,
        type: baseType,
        value: undefined,
        isMutable: resultIsMutable,
        originType: pointerType, // Set origin type to the pointer type to track mutability path
        isAccessingProperty: true,
        pathCollection: [],
      };
      propertyExpr.$ = expr.$;
      return expr;
    } else if (
      isRefType(objectExpr.$?.type) ||
      isMutRefType(objectExpr.$?.type)
    ) {
      const refType = objectExpr.$.type;
      const baseType = refType.type;

      // For reference dereference, determine mutability:
      // The dereferenced value is mutable if the reference type allows writes
      // and we have mutable access through the origin object
      const refTypeAllowsWrite = isMutRefType(refType);

      let resultIsMutable: boolean;

      if (
        exprIsAtom(objectExpr) &&
        objectExpr.token.type === TokenType.Identifier
      ) {
        // Direct variable dereference: x.* where x is a reference parameter
        // Only the reference type matters for mutability
        resultIsMutable = refTypeAllowsWrite;
      } else {
        // Dereference through property access: c.val.* where c.val is a reference
        // Check if the origin type allows mutable access
        const originType = objectExpr.$.originType;
        if (
          originType &&
          (isMutRefType(originType) || isMutPtrType(originType))
        ) {
          // Origin is a mutable reference/pointer, so we can mutate through it
          resultIsMutable = refTypeAllowsWrite;
        } else if (
          originType &&
          (isRefType(originType) || isPtrType(originType))
        ) {
          // Origin is an immutable reference/pointer, so we cannot mutate through it
          resultIsMutable = false;
        } else {
          // Origin is owned (by-value), so dereference mutability depends only on reference type
          // In Rust: even `fn foo(c: Container)` allows `c.mutable_ref.*` = value
          resultIsMutable = refTypeAllowsWrite;
        }
      }

      expr.$ = {
        env,
        type: baseType,
        value: undefined,
        isMutable: resultIsMutable,
        originType: refType, // Set origin type to the reference type to track mutability path
        isAccessingProperty: true,
        pathCollection: [],
      };
      propertyExpr.$ = expr.$;
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
          errorMessage: `Expected identifier for enum variant, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      }

      // Check if it's accessing comptime field
      {
        const propertyName = propertyExpr.token.value;
        const field = typeValue.value.module.elements.find(
          (method) => method.label === propertyName
        );
        if (field) {
          expr.$ = {
            env,
            type: field.type,
            value: field.assignedValue!,
            isMutable: false,
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
      if (!variant.elements) {
        expr.$ = {
          env,
          type: newEnumType,
          // FIXME: Support expr.value for comptime evaluation.
          value: createEnumValue(newEnumType, variantName, []),
          isMutable: objectExpr.$.isMutable,
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
          isMutable: objectExpr.$.isMutable,
          isAccessingProperty: true,
          pathCollection: [],
        };

        propertyExpr.$ = expr.$;
      }
      return expr;
    }
    // Accessing compt fields of a struct/union type.
    else if (isStructType(typeValue.value) || isUnionType(typeValue.value)) {
      if (!isValidVariableName(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for struct type method, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      }
      const propertyName = propertyExpr.token.value;
      // Check if the type method exists
      const field = typeValue.value.module.elements.find(
        (property) => property.label === propertyName
      );
      if (field) {
        expr.$ = {
          env,
          type: field.type,
          value: field.assignedValue!,
          isMutable: false,
          pathCollection: [],
          isAccessingProperty: true,
        };
        propertyExpr.$ = expr.$;
        return expr;
      } else {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Struct type property "${propertyName}" not found in struct type`,
        });
      }
    }
    // Accessing methods of an array type (e.g., Array(i32, 5).fill)
    else if (isArrayType(typeValue.value)) {
      if (!exprIsAtom(propertyExpr)) {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Expected identifier for array type method, got:\n${exprToString(
            propertyExpr
          )}`,
        });
      }
      const propertyName = propertyExpr.token.value;

      if (propertyName === "fill") {
        // Signal to the function call handler that this is a special array fill method
        // We'll return undefined so function.ts can handle the actual call with arguments
        expr.$ = undefined;
        return expr;
      } else {
        throw formatErrorMessage({
          token: propertyExpr.token,
          errorMessage: `Array type method "${propertyName}" not found. Available methods: fill`,
        });
      }
    }
  }

  let objectType = objectExpr.$?.type;
  const originalObjectType = objectExpr.$?.type; // Capture before dereferencing

  // QUESTION: Should we allow only one round here? Like zig.
  while (
    objectType &&
    (isPtrType(objectType) ||
      isMutPtrType(objectType) ||
      isRefType(objectType) ||
      isMutRefType(objectType))
  ) {
    // Dereference the pointer or reference type
    objectType = objectType.type;
  }

  if (
    isTupleType(objectType) ||
    isStructType(objectType) ||
    isUnionType(objectType)
  ) {
    const elements: TupleElement[] = objectType.elements;
    const objectExprValue = objectExpr.$!.value;

    // Check if it's accessing the tuple element by
    // - number index: point.0
    // - label name:   point.x
    if (exprIsAtom(propertyExpr)) {
      if (propertyExpr.token.type === TokenType.Integer) {
        // Accessing by index is only allowed for tuples.
        if (!isTupleType(objectExpr.$?.type)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Accessing tuple element by index is only allowed for tuples.`,
          });
        }

        const index = parseInt(propertyExpr.token.value, 10);
        if (isNaN(index)) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Expected integer for tuple index, got:\n${exprToString(
              propertyExpr
            )}`,
          });
        }

        const runtimeElementsCount = elements.filter(
          (element) => !element.isCompileTimeOnly
        ).length;

        if (index < 0 || index >= runtimeElementsCount) {
          throw formatErrorMessage({
            token: propertyExpr.token,
            errorMessage: `Index out of bounds: ${index} for accessing element in:\n${typeToString(
              objectExpr.$?.type
            )}`,
          });
        }
        const tupleElement = elements[index]!;

        // Determine if field access should be mutable and set origin type
        let fieldIsMutable: boolean;

        // Set origin type: use existing originType or the original object type
        const fieldOriginType = objectExpr.$.originType || originalObjectType;

        if (
          originalObjectType &&
          (isRefType(originalObjectType) ||
            isMutRefType(originalObjectType) ||
            isPtrType(originalObjectType) ||
            isMutPtrType(originalObjectType))
        ) {
          // Object is accessed through a reference/pointer
          // Check if we can mutate through the origin
          if (
            fieldOriginType &&
            (isMutRefType(fieldOriginType) || isMutPtrType(fieldOriginType))
          ) {
            fieldIsMutable = true; // Can mutate through mutable reference/pointer
          } else if (
            fieldOriginType &&
            (isRefType(fieldOriginType) || isPtrType(fieldOriginType))
          ) {
            fieldIsMutable = false; // Cannot mutate through immutable reference/pointer
          } else {
            fieldIsMutable = objectExpr.$.isMutable; // Fall back to object mutability
          }
        } else {
          // Object is owned (by-value), field mutability depends on object binding mutability
          // In Rust: `fn foo(c: Container)` does NOT allow field reassignment
          // but `fn foo(mut c: Container)` does allow field reassignment
          fieldIsMutable = objectExpr.$.isMutable;
        }

        expr.$ = {
          env,
          type: tupleElement.type,
          isMutable: fieldIsMutable,
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
            values = objectExprValue.elements;
          } else if (isStructValue(objectExprValue)) {
            values = objectExprValue.elements;
          }
          expr.$.value = values?.[index];
        }
        return expr;
      } else if (isValidVariableName(propertyExpr)) {
        const label = propertyExpr.token.value;
        {
          const tupleElementIndex = elements.findIndex(
            // NOTE: To access comptime only field, use the type instead, not the value.
            // The value can only access runtime fields.
            (element) => element.label === label
          );
          if (tupleElementIndex < 0) {
            if (isModuleType(objectExpr.$?.type)) {
              throw formatErrorMessage({
                token: propertyExpr.token,
                errorMessage: `Module element "${label}" not found in module type`,
              });
            }

            // It could be method call
            expr.$ = undefined;
            return expr;
          }
          const tupleElement = elements[tupleElementIndex]!;

          // Determine if field access should be mutable and set origin type
          let fieldIsMutable: boolean;

          // Set origin type: use existing originType or the original object type
          const fieldOriginType =
            objectExpr.$?.originType || originalObjectType;

          if (
            originalObjectType &&
            (isRefType(originalObjectType) ||
              isMutRefType(originalObjectType) ||
              isPtrType(originalObjectType) ||
              isMutPtrType(originalObjectType))
          ) {
            // Object is accessed through a reference/pointer
            // Check if we can mutate through the origin
            if (
              fieldOriginType &&
              (isMutRefType(fieldOriginType) || isMutPtrType(fieldOriginType))
            ) {
              fieldIsMutable = true; // Can mutate through mutable reference/pointer
            } else if (
              fieldOriginType &&
              (isRefType(fieldOriginType) || isPtrType(fieldOriginType))
            ) {
              fieldIsMutable = false; // Cannot mutate through immutable reference/pointer
            } else {
              fieldIsMutable = objectExpr.$!.isMutable; // Fall back to object mutability
            }
          } else {
            // Object is owned (by-value), field mutability depends on object binding mutability
            // In Rust: `fn foo(c: Container)` does NOT allow field reassignment
            // but `fn foo(mut c: Container)` does allow field reassignment
            fieldIsMutable = objectExpr.$!.isMutable;
          }

          expr.$ = {
            env,
            type: tupleElement.type,
            isMutable: fieldIsMutable,
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
                values = objectExprValue.elements;
              } else if (isStructValue(objectExprValue)) {
                values = objectExprValue.elements;
              }

              let value = values?.[tupleElementIndex];
              if (!value) {
                value = createUnknownValue(tupleElement.type);
              }

              expr.$.value = value;
            }
          }
          return expr;
        }
      }
    }
  } else if (isModuleType(objectType)) {
    const elements: ModuleElement[] = objectType.elements;
    const objectExprValue = objectExpr.$!.value;

    // Check if it's accessing the tuple element by
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
          const tupleElementIndex = elements.findIndex(
            (element) => element.label === label
          );
          if (tupleElementIndex < 0) {
            if (isModuleType(objectExpr.$?.type)) {
              throw formatErrorMessage({
                token: propertyExpr.token,
                errorMessage: `Module element "${label}" not found in module type`,
              });
            }

            // It could be method call
            expr.$ = undefined;
            return expr;
          }
          const tupleElement = elements[tupleElementIndex]!;
          expr.$ = {
            env,
            type: tupleElement.type,
            isMutable: objectExpr.$!.isMutable,
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
                values = objectExprValue.elements;
              }

              let value = values?.[tupleElementIndex];
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
        const fieldIndex = (selectedVariant.elements ?? []).findIndex(
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

        const field = (selectedVariant.elements ?? [])[fieldIndex]!;

        expr.$ = {
          env,
          type: field.type,
          value: undefined,
          isMutable: objectExpr.$!.isMutable,
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
          expr.$.value = variantValue.elements[fieldIndex];
        }

        propertyExpr.$ = expr.$;
        return expr;
      } else {
        // It could be enum method call, so we ignore here.
      }
    }
  }
  // Getting the length of array
  else if (
    isArrayType(objectType) &&
    exprIsAtom(propertyExpr) &&
    exprIsAtomOf(propertyExpr, "length")
  ) {
    const lengthValue = objectType.length;
    expr.$ = {
      env,
      type: lengthValue.type,
      value: lengthValue,
      isMutable: true,
      pathCollection: [],
      isAccessingProperty: true,
    };
    propertyExpr.$ = expr.$;
    return expr;
  }
  // Getting the length of slice
  else if (
    isSliceType(objectType) &&
    exprIsAtom(propertyExpr) &&
    exprIsAtomOf(propertyExpr, "length")
  ) {
    expr.$ = {
      env,
      type: createUsizeType(),
      value: undefined,
      isMutable: true,
      pathCollection: [],
      isAccessingProperty: true,
    };
    propertyExpr.$ = expr.$;
    return expr;
  }

  // TODO: Evaluate the module method call
  // Since we fail to evaluate the property access
  // it could be an ~~uniform function call~~ module method call.
  expr.$ = undefined;
  return expr;
}
