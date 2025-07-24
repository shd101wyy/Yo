import {
  AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  isArrayType,
  isEnumType,
  isFunctionType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  Type,
  TypeTag,
  typeToString,
} from "../../types";
import {
  isArrayValue,
  isBooleanValue,
  isComptStringValue,
  isEnumValue,
  isFunctionValue,
  isNumberValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "../../value";
import { BuiltinYoInlineFunctions } from "../constants";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
} from "../utils";
import { generateArrayFillCall, isArrayFillMethodCall } from "./array";

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  switch (expr.tag) {
    case ExprTag.FuncCall:
      return generateFuncCall(expr, indent, context);
    case ExprTag.Atom:
      return generateAtom(expr, context);
  }
}

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    const arg = expr.args[0];
    if (arg) {
      const argCode = generateExpr(arg, indent, context);
      return `return ${argCode}`;
    } else {
      return "return";
    }
  }

  // Array.fill method call (macro-like expansion)
  if (isArrayFillMethodCall(expr)) {
    return generateArrayFillCall(expr, indent, context);
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    let lhs = expr.args[0]!;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.given, 1)
    ) {
      // implicit variable, just use the inner expression
      lhs = lhs.args[0]!;
    }

    let isMutable = false;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
    ) {
      // mutable variable, just use the inner expression
      isMutable = true;
      lhs = lhs.args[0]!;
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const varName = lhs.token.value;
    const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

    context.emitter.emitLine(
      // NOTE: We cannot assign "const" here.
      `${indent}${isMutable ? "" : ""}${varTypeAndName};`
    );
    return "";
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    // Check if it's destructurings
    if (expr.$?.runtimeDestructurings) {
      const runtimeDestructurings = expr.$.runtimeDestructurings;
      const rhsCode = generateExpr(rhs, indent, context);
      const rhsType = rhs.$?.type;
      runtimeDestructurings.forEach(({ label, type, variableName }) => {
        const varTypeAndName = getVariableTypeString(
          type,
          variableName,
          context
        );
        let fieldName = label.match(/^\d+$/) ? `_${label}` : label;

        if (rhsType && isTupleType(rhsType) && !label.match(/^\d+$/)) {
          const index = rhsType.elements.findIndex((el) => el.label === label);
          fieldName = index >= 0 ? `_${index}` : fieldName;
        }

        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${rhsCode}.${fieldName}; // Destructuring ${label}`
        );
      });
      return "";
    }

    let isMutable = false;
    // let isImplicit = false;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.given, 1)
    ) {
      // isImplicit = true;
      lhs = lhs.args[0]!; // Get the actual variable being assigned
    }

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
    ) {
      isMutable = true;
      lhs = lhs.args[0]!; // Get the actual variable being mutated
    }

    if (exprIsAtom(lhs)) {
      const varName = lhs.token.value;
      if (!lhs.$?.type) {
        return `// Error: No type information for variable ${varName}\n`;
      }

      // Handle array initialization specially
      if (isArrayType(lhs.$.type)) {
        // Check if RHS is an array literal
        if (
          exprIsFunctionCall(rhs) &&
          exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
        ) {
          // Direct initialization with array literal
          const varTypeAndName = getVariableTypeString(
            lhs.$.type,
            varName,
            context
          );
          const rhsCode = generateExpr(rhs, indent, context);
          context.emitter.emitLine(
            `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        } else {
          // Copying from another array - use direct struct assignment
          const varTypeAndName = getVariableTypeString(
            lhs.$.type,
            varName,
            context
          );
          const rhsCode = generateExpr(rhs, indent, context);
          context.emitter.emitLine(
            `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        }
      } else {
        // Non-array initialization - use existing logic
        const varTypeAndName = getVariableTypeString(
          lhs.$.type,
          varName,
          context
        );
        const rhsCode = generateExpr(rhs, indent, context);
        if (!isUnitType(lhs.$.type)) {
          context.emitter.emitLine(
            `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        }
      }
      return "";
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    let isInitialization = false;
    let isMutable = false;
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      isInitialization = true;
      lhs = lhs.args[0]!; // Get the actual variable being assigned
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
    ) {
      // compile-time variable
      return "";
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.given, 1)
    ) {
      // implicit variable, just use the inner expression
      lhs = lhs.args[0]!;
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.mut, 1)
    ) {
      // mutable variable, just use the inner expression
      isMutable = true;
      lhs = lhs.args[0]!;
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const lhsCode = generateExpr(lhs, indent, context);

    // Check if we need to save the old value into temp variable
    if (expr.$?.variableName) {
      const tempVarName = expr.$.variableName;
      const tempVarNameAndType = getVariableTypeString(
        lhs.$.type,
        tempVarName,
        context
      );

      // Handle array assignment specially
      if (isArrayType(lhs.$.type)) {
        // For array, use direct struct assignment
        context.emitter.emitLine(
          `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
        );
      } else {
        if (!isUnitType(lhs.$.type)) {
          context.emitter.emitLine(
            `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
          );
        }
      }
    }

    // Handle array assignments specially
    if (isArrayType(lhs.$.type)) {
      // Since we use struct wrappers consistently, we can use direct struct assignment
      const rhsCode = generateExpr(rhs, indent, context);
      if (isInitialization) {
        // For initialization
        const varTypeAndName = getVariableTypeString(
          lhs.$.type,
          generateExpr(lhs, indent, context),
          context
        );
        context.emitter.emitLine(
          `${indent}${isMutable ? "" : "const "}${varTypeAndName} = ${rhsCode};`
        );
      } else {
        // For assignment to existing array variable, use direct struct assignment
        context.emitter.emitLine(`${indent}${lhsCode} = ${rhsCode};`);
      }
    } else {
      // Non-array assignment - use existing logic
      const rhsCode = generateExpr(rhs, indent, context);
      if (!isUnitType(lhs.$.type)) {
        context.emitter.emitLine(
          `${indent}${isInitialization && !isMutable ? "const " : ""}${isInitialization ? getTypeString(lhs.$.type, context) + " " : ""}${lhsCode} = ${rhsCode};`
        );
      }
    }

    return expr.$?.variableName ?? "";
  }
  // already computed
  // NOTE: This has to be below the assignment checks
  else if (expr.$?.value && !isUnknownValue(expr.$?.value)) {
    const value: Value = expr.$.value;
    return generateComptValue(value, context);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;
    if (tempVariableName && valueType) {
      if (!isUnitType(valueType) && !expr.$?.controlFlow) {
        context.emitter.emitLine(
          `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
        );
      }

      // Evaluate each argument
      context.emitter.emitLine(`${indent}{ // begin block`);
      const argsCode = expr.args.map((arg) =>
        generateExpr(arg, indent + "  ", context)
      );
      argsCode.forEach((argCode) => {
        if (argCode) {
          context.emitter.emitLine(`${indent}  ${argCode};`);
        }
      });
      if (!isUnitType(valueType) && !expr.$?.controlFlow) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${argsCode[argsCode.length - 1]};`
        );
      }
      context.emitter.emitLine(`${indent}} // end begin block`);

      return isUnitType(valueType) || expr.$?.controlFlow
        ? ""
        : tempVariableName;
    }
  }
  // cond
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return generateCondExpression(expr, indent, context);
  }
  // match
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    return generateMatchExpression(expr, indent, context);
  }
  // ptr or ref value
  else if (
    exprIsFunctionCallOf(expr, BuiltinKeywords.Ptr, 1) ||
    exprIsFunctionCallOf(expr, BuiltinKeywords.MutPtr, 1) ||
    exprIsFunctionCallOf(expr, BuiltinKeywords.Ref, 1) ||
    exprIsFunctionCallOf(expr, BuiltinKeywords.MutRef, 1)
  ) {
    const type = expr.$?.type;
    if (!type) {
      return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
    }
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);

    // For pointer/reference creation, we need to be careful about constness
    // Simply use the address-of operator without an explicit cast to avoid const issues
    return `(&${argCode})`;
  }
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const cName = context.types[expr.$?.type?.id ?? ""]?.cName;
    if (runtimeArgExprs && cName) {
      // Generate tuple initialization
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");
      return `(${cName}){ ${argsList} }`;
    } else if (expr.args.length === 0) {
      // unit
      return "";
    }
  }
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const arrayType = expr.$?.type;
    if (isArrayType(arrayType) && runtimeArgExprs) {
      // Generate struct wrapper initialization
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");
      const arrayTypeName = getTypeString(arrayType, context);
      return `(${arrayTypeName}){ .data = { ${argsList} } }`;
    }
  }
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      // Generate recur call with arguments
      const argsList = runtimeArgExprs
        .map((arg) => generateExpr(arg, indent, context))
        .join(", ");
      return `${context.currentFunctionName}(${argsList})`;
    } else {
      return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
    }
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `sizeof(${argCode})`; // Use sizeof operator on the argument
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const args = runtimeArgExprs.map((arg) => {
        return generateExpr(arg, indent, context);
      });

      return generateYoInlineFunctionCall(expr.func.token.value, args);
    }
  }
  // anonymous function (fn(x) -> body)
  else if (
    exprIsFunctionCallOf(expr, "->", 2) &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
  ) {
    // Anonymous functions should have been evaluated and have a function value
    const functionValue = expr.$?.value;
    if (isFunctionValue(functionValue)) {
      return generateComptValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // other function call
  else {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;
    if (isFunctionType(functionType)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      if (runtimeArgExprs) {
        // Generate arg list
        const args = runtimeArgExprs.map((arg) => {
          return generateExpr(arg, indent, context);
        });
        const argsList = args.join(", ");

        if (isFunctionValue(functionValue)) {
          // Check if it's function vaue whose body only contains Yo operator
          const operatorFunctionName =
            isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
          if (operatorFunctionName) {
            return generateYoInlineFunctionCall(operatorFunctionName, args);
          }

          // Get new function type, which might be specialized.
          const functionType =
            functionValue.specializedType ?? functionValue.type;
          // Normal function call
          const cFuncName = context.functions[functionValue.funcId]?.cName;
          if (cFuncName) {
            // Generate function call
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);
              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(functionType.return.type, context)} ${tempVar} = ${cFuncName}(${argsList});`
                );
                return tempVar; // Return the temp variable name
              }
            }
          }
        } else {
          // Might be extern function, a built-in, or a function parameter
          const externFunction = context.externFunctions[functionType.id];
          if (externFunction) {
            // Generate extern function call
            const cFuncName = externFunction.cName;
            return `${cFuncName}(${argsList})`;
          } else {
            // Function parameter call (e.g., callback(x))
            const funcCode = generateExpr(expr.func, indent, context);
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);
              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable or return directly
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(functionType.return.type, context)} ${tempVar} = ${funcCode}(${argsList});`
                );
                return tempVar; // Return the temp variable name
              } else {
                return `${funcCode}(${argsList})`;
              }
            }
          }
        }
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[functionValue.value.id]?.cName;
        const labels = functionValue.value.elements.map(
          (element) => element.label
        );
        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          // Generate struct initialization
          const argsList = runtimeArgExprs
            .map((arg, index) => {
              return (
                `.${labels[index]!} = ` + generateExpr(arg, indent, context)
              );
            })
            .join(", ");
          return `(${cName}){ ${argsList} }`;
        }
      }
      // union
      // union is supposed to have only one member initialized
      else if (isUnionType(functionValue.value)) {
        const arg = expr.args[0]!;
        if (
          arg &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, ":", 2)
        ) {
          const labelExpr = arg.args[0]!;
          const fieldExpr = arg.args[1]!;
          const cName = context.types[functionValue.value.id]?.cName;
          if (cName && exprIsAtom(labelExpr) && fieldExpr) {
            const label = labelExpr.token.value;
            const fieldCode = generateExpr(fieldExpr, indent, context);
            return `(${cName}){ .${label} = ${fieldCode} }`;
          }
        }
      }
      // enum
      else if (isEnumType(functionValue.value)) {
        const enumType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[enumType.id]?.cName;
        if (enumType.selectedVariantName && runtimeArgExprs && cName) {
          // Check if this enum can be optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);
          if (nullablePointerType) {
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );

            if (variant) {
              if (!variant.elements || variant.elements.length === 0) {
                // This is the "None" case - return NULL
                return "NULL";
              } else if (variant.elements.length === 1) {
                // This is the "Some" case - return the pointer value directly
                const pointerValue = generateExpr(
                  runtimeArgExprs[0]!,
                  indent,
                  context
                );
                return pointerValue;
              }
            }
          }

          // Check if this enum can be optimized as a simple C enum
          const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
          if (simpleEnumOptimizable) {
            const variantName = enumType.selectedVariantName;
            // For simple enums, just return the enum constant
            return getEnumVariantCName(enumType, variantName, context);
          }

          // Generate enum initialization (fallback for non-optimized enums)
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            const argsList = runtimeArgExprs
              .map((arg, index) => {
                if (variant.elements) {
                  const element = variant.elements[index];
                  if (element) {
                    return (
                      `.${element.label} = ` +
                      generateExpr(arg, indent, context)
                    );
                  }
                  return ""; // Skip if no element matches
                } else {
                  return "";
                }
              })
              .filter((s) => s) // Remove empty strings
              .join(", ");
            return `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`;
          }
        }
      }
    } else if (isArrayType(functionType)) {
      // Array access by index
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    }
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  if (expr.$?.value && !isUnknownValue(expr.$.value)) {
    return generateComptValue(expr.$.value, context);
  }

  return expr.token.value;
}

/**
 * Generate C code for a compile-time value - extracted from original codegen-c.ts
 */
function generateComptValue(value: Value, context: CodeGenContext): string {
  if (isNumberValue(value)) {
    // For numbers, we can directly return the value as a string
    return valueToString(value);
  } else if (isBooleanValue(value)) {
    // For booleans, return true/false
    return value.value ? "true" : "false";
  } else if (isComptStringValue(value)) {
    // For strings, return the C string literal with proper escaping
    return JSON.stringify(value.value);
  } else if (isEnumValue(value)) {
    // For enums, check if it's optimized as nullable pointer
    const enumType = value.type;
    const nullablePointerType = canOptimizeAsNullablePointer(enumType);

    if (nullablePointerType) {
      // Generate optimized nullable pointer construction
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant) {
        return `// Error: Variant ${value.variantName} not found in enum`;
      }

      if (!variant.elements || variant.elements.length === 0) {
        // This is the null case (None variant)
        return "NULL";
      } else if (variant.elements.length === 1 && value.elements.length === 1) {
        // This is the pointer case (Some variant)
        return generateComptValue(value.elements[0]!, context);
      }
    }

    // Check if this enum can be optimized as a simple C enum
    const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
    if (simpleEnumOptimizable) {
      // For simple enums, just return the enum constant
      return getEnumVariantCName(enumType, value.variantName, context);
    }

    // Generate regular tagged union construction
    const cName = context.types[enumType.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for enum ${typeToString(enumType)}`;
    }

    const variantTag = getEnumVariantCName(
      enumType,
      value.variantName,
      context
    );

    if (!value.elements || value.elements.length === 0) {
      // Variant with no data
      return `(${cName}){ .tag = ${variantTag} }`;
    } else {
      // Variant with data
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant || !variant.elements) {
        return `// Error: Variant ${value.variantName} not found or has no elements`;
      }

      const fields = value.elements.map((element, index) => {
        const fieldName = variant.elements![index]!.label || "field";
        const fieldCode = generateComptValue(element, context);
        return `.${fieldName} = ${fieldCode}`;
      });

      return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${fields.join(", ")} } } }`;
    }
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      const fields = value.elements.map((element, index) => {
        const fieldValue = element;
        const fieldName = type.elements[index]!.label;
        const fieldCode = generateComptValue(fieldValue, context);
        return `.${fieldName} = ${fieldCode}`;
      });

      return `(${cName}){ ${fields.join(", ")} }`;
    }
  } else if (isArrayValue(value)) {
    // For array values, generate struct wrapper initialization
    const arrayType = value.type;
    const arrayTypeName = getTypeString(arrayType, context);
    const elementCodes = value.elements.map((element) =>
      generateComptValue(element, context)
    );
    return `(${arrayTypeName}){ .data = { ${elementCodes.join(", ")} } }`;
  } else if (isFunctionValue(value)) {
    // For function values, we need to register them and return their C function name
    const cName = context.functions[value.funcId]?.cName;
    if (cName) {
      return cName; // Return the function name as a function pointer
    } else {
      return `// Error: No C function name found for function value with ID ${value.funcId}\n`;
    }
  } else if (isTypeValue(value)) {
    // For type values, we can return the C type name if available
    const type = value.value;
    if (type) {
      if (context.types[type.id]) {
        return context.types[type.id]!.cName;
      } else {
        return `/* Error: No C type name found for type ${typeToString(type)} */`;
      }
    }
  }

  return ""; // No need to generate. It might be module value, etc
}

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
function generateFieldAccess(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return "/* ERROR: field access requires exactly 2 arguments */";
  }

  const objectExpr = expr.args[0];
  const fieldExpr = expr.args[1];

  if (!objectExpr || !fieldExpr) {
    return "/* ERROR: invalid field access arguments */";
  }

  const objectCode = generateExpr(objectExpr, indent, context);
  const objectType = objectExpr.$?.type;
  const objectValue = objectExpr.$?.value;

  if (exprIsAtom(fieldExpr)) {
    const fieldName = fieldExpr.token.value;

    // Check if the object is an enum type
    if (isEnumType(objectType)) {
      const enumType = objectType;

      // Check if this enum is optimized as a nullable pointer
      const nullablePointerType = canOptimizeAsNullablePointer(enumType);
      if (nullablePointerType) {
        // For optimized nullable pointer enums, direct field access should be simplified
        // ptr.value becomes ptr (since ptr is already the pointer)
        // NOTE: No need to check fieldName, as the nullablePointerType always only has one field
        // if (fieldName === "value") {
        return objectCode; // Return the pointer directly
        // }
      }

      // For enum field access, we need to determine which variant contains this field
      // and generate the appropriate path: object.data.VariantName.fieldName
      for (const variant of enumType.variants) {
        if (variant.elements) {
          for (const element of variant.elements) {
            if (element.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${fieldName}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no elements.
      // Like: Color.Red
      if (!!variant && !variant.elements && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Check if the object is pointer or reference
    else if (
      isPtrType(objectType) ||
      isMutPtrType(objectType) ||
      isRefType(objectType) ||
      isMutRefType(objectType)
    ) {
      if (fieldName === "*") {
        // Dereference the pointer/reference
        return `*(${objectCode})`; // Dereference the pointer/reference
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (
          isPtrType(currentType) ||
          isMutPtrType(currentType) ||
          isRefType(currentType) ||
          isMutRefType(currentType)
        ) {
          dereferenceLevel++;
          currentType = currentType.type;
        }
        if (dereferenceLevel > 0) {
          // Dereference the pointer/reference
          const dereferencedObjectCode = `${"*".repeat(dereferenceLevel)}(${objectCode})`;
          // Access the field on the dereferenced object
          return `${dereferencedObjectCode}.${fieldName}`;
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${fieldName}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.elements.findIndex(
          (element) => element.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    } else {
      // For C structs and unions, access fields directly
      return `${objectCode}.${fieldName}`;
    }
  }

  return "/* ERROR: field name must be an identifier */";
}

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
function generateCondExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if the cond expression has been evaluated and has a variable name
  if (expr.$ && expr.$.variableName) {
    const tempVar = expr.$.variableName;
    const varType = getTypeString(expr.$.type, context);

    // Generate the conditional logic as statements before this expression
    // We need to declare the variable and generate the if-else logic
    context.emitter.emitLine(`${indent}${varType} ${tempVar};`);

    // Generate if-else chain for each condition => value pair
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          const ifKeyword = i === 0 ? "if" : "else if";

          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true
          ) {
            context.emitter.emitLine(`${indent}else {`);
          } else {
            // Generate condition outside the block
            const conditionCode = generateExpr(condition, indent, context);
            context.emitter.emitLine(
              `${indent}${ifKeyword} (${conditionCode}) {`
            );
          }

          // Generate the value expression INSIDE the conditional block
          const valueCode = generateExpr(value, indent + "  ", context);
          context.emitter.emitLine(`${indent}  ${tempVar} = ${valueCode};`);
          context.emitter.emitLine(`${indent}}`);
        }
      }
    }

    return tempVar;
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is missing $.variableName */';
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
function generateMatchExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const tempVariableName = expr.$?.variableName;
  const valueType = expr.$?.type;
  if (!tempVariableName || !valueType) {
    return `// Error: "match" expression is missing $.variableName or $.type`;
  }

  // Create temp variable declaration
  context.emitter.emitLine(
    `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
  );

  // Generate the matched value
  const matchedValueCode = generateExpr(expr.args[0]!, indent, context);
  const matchValueType = expr.args[0]!.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires an enum type`;
  }

  // Check if it's a pointer/reference type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | undefined = undefined;

  let enumType: Type;
  if (
    isPtrType(matchValueType) ||
    isMutPtrType(matchValueType) ||
    isRefType(matchValueType) ||
    isMutRefType(matchValueType)
  ) {
    enumType = matchValueType.type;
    ptrOrRefType = matchValueType.tag;
  } else {
    enumType = matchValueType;
  }

  if (!isEnumType(enumType)) {
    return `// Error: "match" expression requires an enum type`;
  }
  const enumCName = context.types[enumType.id]?.cName;
  if (!enumCName) {
    return `// Error: "match" expression enum type ${enumType.typeName} has no C name`;
  }

  // Check if this enum is optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate optimized nullable pointer matching using if/else instead of switch
    const caseExprs = expr.args.slice(1);

    // Find which variant is the null case and which is the pointer case
    let nullCase: { caseBody: Expr } | null = null;
    let pointerCase: { caseBody: Expr; variantName: string } | null = null;

    for (const caseExpr of caseExprs) {
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value;

          // Find the variant in the enum type
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            if (!variant.elements || variant.elements.length === 0) {
              // This is the null case
              nullCase = { caseBody };
            } else if (variant.elements.length === 1) {
              // This is the pointer case
              pointerCase = { caseBody, variantName };
            }
          }
        }
      }
    }

    // Generate the optimized if/else structure
    context.emitter.emitLine(
      `${indent}if (${ptrOrRefType ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      const bodyCode = generateExpr(
        pointerCase.caseBody,
        indent + "  ",
        context
      );
      context.emitter.emitLine(`${indent}  ${tempVariableName} = ${bodyCode};`);
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateExpr(nullCase.caseBody, indent + "  ", context);
      context.emitter.emitLine(`${indent}  ${tempVariableName} = ${bodyCode};`);
    }

    context.emitter.emitLine(`${indent}}`);
    return tempVariableName;
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate optimized simple enum matching
    context.emitter.emitLine(
      `${indent}switch (${ptrOrRefType ? "*" : ""}${matchedValueCode}) {`
    );

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value;
          const variantTag = getEnumVariantCName(
            enumType,
            variantName,
            context
          );

          // Generate the case label
          context.emitter.emitLine(`${indent}case ${variantTag}:`);

          // Generate the body of the case
          const bodyCode = generateExpr(caseBody, indent + "  ", context);
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return tempVariableName;
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType ? "*" : ""}(${matchedValueCode}).tag) {`
  );

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // This is a case => value pair
      const caseValue = caseExpr.args[0];
      let caseBody = caseExpr.args[1];

      if (
        caseValue &&
        caseBody &&
        // caseValue now has to be a variant:
        exprIsFunctionCall(caseValue) &&
        exprIsFunctionCallOf(caseValue, ".", 1)
      ) {
        const variantName = caseValue.args[0]!.token.value; // Get the variant name
        const variantTag = getEnumVariantCName(enumType, variantName, context);

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateExpr(caseBody, indent + "  ", context);
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
        context.emitter.emitLine(`${indent}  break;`);
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);
  return tempVariableName; // Return the temp variable name
}

/**
 * Generate a return statement for a function body expression - extracted from original codegen-c.ts
 */
export function generateReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  switch (expr.tag) {
    case ExprTag.Atom: {
      // Use generateExpressionAsCode to handle compile-time values
      const atomCode = generateAtom(expr, context);
      context.emitter.emitLine(`${indent}return ${atomCode};`);
      break;
    }
    case ExprTag.FuncCall: {
      const funcCallCode = generateFuncCall(expr, indent, context);
      if (!exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
        context.emitter.emitLine(`${indent}return ${funcCallCode};`);
      } else {
        context.emitter.emitLine(`${indent}${funcCallCode};`);
      }
      break;
    }
  }
}

/**
 * Generate Yo operator function call - extracted from original codegen-c.ts
 */
function generateYoInlineFunctionCall(
  functionName: string,
  args: string[]
): string {
  // +
  if (BuiltinFunctions.__yo_op_add.includes(functionName)) {
    return `((${args[0]!}) + (${args[1]!}))`;
  }
  // -
  else if (BuiltinFunctions.__yo_op_sub.includes(functionName)) {
    return `((${args[0]!}) - (${args[1]!}))`;
  }
  // *
  else if (BuiltinFunctions.__yo_op_mul.includes(functionName)) {
    return `((${args[0]!}) * (${args[1]!}))`;
  }
  // /
  else if (BuiltinFunctions.__yo_op_div.includes(functionName)) {
    return `((${args[0]!}) / (${args[1]!}))`;
  }
  // %
  else if (BuiltinFunctions.__yo_op_mod.includes(functionName)) {
    return `((${args[0]!}) % (${args[1]!}))`;
  }
  // neg -
  else if (BuiltinFunctions.__yo_op_neg.includes(functionName)) {
    return `(-(${args[0]!}))`;
  }
  // ==
  else if (BuiltinFunctions.__yo_op_eq.includes(functionName)) {
    return `((${args[0]!}) == (${args[1]!}))`;
  }
  // !=
  else if (BuiltinFunctions.__yo_op_neq.includes(functionName)) {
    return `((${args[0]!}) != (${args[1]!}))`;
  }
  // <
  else if (BuiltinFunctions.__yo_op_lt.includes(functionName)) {
    return `((${args[0]!}) < (${args[1]!}))`;
  }
  // <=
  else if (BuiltinFunctions.__yo_op_lte.includes(functionName)) {
    return `((${args[0]!}) <= (${args[1]!}))`;
  }
  // >
  else if (BuiltinFunctions.__yo_op_gt.includes(functionName)) {
    return `((${args[0]!}) > (${args[1]!}))`;
  }
  // >=
  else if (BuiltinFunctions.__yo_op_gte.includes(functionName)) {
    return `((${args[0]!}) >= (${args[1]!}))`;
  }
  // &&
  else if (BuiltinFunctions.__yo_op_and.includes(functionName)) {
    return `((${args[0]!}) && (${args[1]!}))`;
  }
  // ||
  else if (BuiltinFunctions.__yo_op_or.includes(functionName)) {
    return `((${args[0]!}) || (${args[1]!}))`;
  }
  // !
  else if (BuiltinFunctions.__yo_op_not.includes(functionName)) {
    return `(!(${args[0]!}))`;
  }
  // &
  else if (BuiltinFunctions.__yo_op_bit_and.includes(functionName)) {
    return `((${args[0]!}) & (${args[1]!}))`;
  }
  // |
  else if (BuiltinFunctions.__yo_op_bit_or.includes(functionName)) {
    return `((${args[0]!}) | (${args[1]!}))`;
  }
  // ^
  else if (BuiltinFunctions.__yo_op_xor.includes(functionName)) {
    return `((${args[0]!}) ^ (${args[1]!}))`;
  }
  // ~
  else if (BuiltinFunctions.__yo_op_bit_complement.includes(functionName)) {
    return `(~(${args[0]!}))`;
  }
  // <<
  else if (BuiltinFunctions.__yo_op_bit_left_shift.includes(functionName)) {
    return `((${args[0]!}) << (${args[1]!}))`;
  }
  // >>
  else if (BuiltinFunctions.__yo_op_bit_right_shift.includes(functionName)) {
    return `((${args[0]!}) >> (${args[1]!}))`;
  } else {
    return `/* Unhandled operator ${functionName} */`;
  }
}
