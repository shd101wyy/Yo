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
  ArrayType,
  isArrayType,
  isClosureType,
  isEnumType,
  isEnumTypeWithReferenceSemantics,
  isFunctionType,
  isMutPtrType,
  isMutRefType,
  isPtrType,
  isRefType,
  isSliceType,
  isStructType,
  isStructTypeWithReferenceSemantics,
  isTupleType,
  isUnionType,
  isUnitType,
  SliceType,
  Type,
  TypeTag,
  typeToString,
} from "../../types";
import {
  isArrayValue,
  isBooleanValue,
  isClosureValue,
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
  sanitizeForCIdentifier,
  shouldAvoidConst,
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
  let result: string;

  switch (expr.tag) {
    case ExprTag.FuncCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context);
      break;
  }

  // Check if this expression needs to call dup (increment reference count)
  if (
    expr.$?.needsToCallDup &&
    expr.$?.type &&
    shouldAvoidConst(expr.$?.type)
  ) {
    result = `__yo_incr_rc(${result})`;
  }

  return result;
}

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const selfArg = expr.args[0];
    const disposeFnArg = expr.args[1];
    if (!selfArg) {
      return `// Error: __yo_decr_rc requires at least 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);

    // If dispose function is provided, generate it; otherwise use NULL
    let disposeFnCode = "NULL";
    if (disposeFnArg) {
      const rawDisposeFnCode = generateExpr(disposeFnArg, indent, context);
      // Cast the function pointer to the expected void(*)(void*) type
      disposeFnCode = `(void(*)(void*))${rawDisposeFnCode}`;
    }

    return `__yo_decr_rc(${selfCode}, ${disposeFnCode})`;
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc(${selfCode})`;
  }

  // borrow - handle this first before other expressions
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.borrow)) {
    const firstExpr = expr.args[0];
    const secondExpr = expr.args[1];

    if (!firstExpr || !secondExpr) {
      return `// Error: borrow requires two arguments`;
    }

    // Extract borrowed value expressions (can be single value or tuple)
    const borrowedValueExprs: Expr[] = [];
    if (
      exprIsFunctionCall(firstExpr) &&
      exprIsFunctionCallOf(firstExpr, BuiltinKeywords.tuple)
    ) {
      borrowedValueExprs.push(...firstExpr.args);
    } else {
      borrowedValueExprs.push(firstExpr);
    }

    // Extract lambda expression - should be of form: parameter => body or (param1, param2) => body
    if (
      !exprIsFunctionCall(secondExpr) ||
      !exprIsFunctionCallOf(secondExpr, "=>", 2)
    ) {
      return `// Error: Expected lambda expression (=>) as second argument to borrow`;
    }

    const borrowBindingExprs: Expr[] = [];
    const lambdaParamsExpr = secondExpr.args[0]!;
    if (
      exprIsFunctionCall(lambdaParamsExpr) &&
      exprIsFunctionCallOf(lambdaParamsExpr, BuiltinKeywords.tuple)
    ) {
      borrowBindingExprs.push(...lambdaParamsExpr.args);
    } else {
      borrowBindingExprs.push(lambdaParamsExpr);
    }
    const lambdaBody = secondExpr.args[1]!;

    if (borrowedValueExprs.length !== borrowBindingExprs.length) {
      return `// Error: Borrowed ${borrowedValueExprs.length} references, but lambda has ${borrowBindingExprs.length} parameters`;
    }

    // Check if this borrow expression returns a value
    const borrowReturnType = expr.$?.type;
    const tempVar = expr.$?.variableName;
    const isReturningValue =
      borrowReturnType && !isUnitType(borrowReturnType) && tempVar;

    // Generate a borrow block
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;

    if (tempVariableName && valueType) {
      // Declare temp variable for the borrow result
      if (!isUnitType(valueType)) {
        context.emitter.emitLine(
          `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
        );
      }
    }

    context.emitter.emitLine(`${indent}{ // borrow block`);

    // Generate reference declarations for each borrowed value
    for (let i = 0; i < borrowedValueExprs.length; i++) {
      const borrowedExpr = borrowedValueExprs[i]!;
      const bindingExpr = borrowBindingExprs[i]!;

      if (!exprIsAtom(bindingExpr)) {
        context.emitter.emitLine(
          `${indent}  // Error: Expected identifier for borrow binding`
        );
        continue;
      }

      const bindingName = bindingExpr.token.value;
      const borrowedCode = generateExpr(borrowedExpr, indent + "  ", context);

      // Get the actual type from the borrowed expression
      const borrowedType = borrowedExpr.$?.type;
      if (borrowedType) {
        // Generate reference variable with the correct type
        const typeStr = getTypeString(borrowedType, context);
        context.emitter.emitLine(
          `${indent}  ${typeStr} ${bindingName} = ${borrowedCode};`
        );
      } else {
        // Fallback if no type information available
        context.emitter.emitLine(
          `${indent}  // Error: No type information for borrowed expression`
        );
      }
    }

    // Generate the lambda body
    if (lambdaBody) {
      const bodyCode = generateExpr(lambdaBody, indent + "  ", context);
      if (bodyCode) {
        // Check if the lambda body has control flow (like return statements)
        const hasControlFlow = lambdaBody.$?.controlFlow;

        if (hasControlFlow) {
          // If lambda has control flow (return), just execute it without assignment
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        } else if (isReturningValue) {
          // If borrow returns a value and no control flow, assign the lambda result to the temp variable
          context.emitter.emitLine(`${indent}  ${tempVar} = ${bodyCode};`);
        } else {
          // If borrow doesn't return a value, just execute the lambda body
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }
      }
    }

    context.emitter.emitLine(`${indent}} // end borrow block`);

    // Return the temp variable name if this borrow returns a value and has no control flow
    const hasControlFlow = lambdaBody?.$?.controlFlow;
    return isReturningValue && !hasControlFlow ? tempVar! : "";
  }

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

        // Use -> for ref types (which are pointers), . for regular types
        const memberAccessOp =
          rhsType &&
          (isStructTypeWithReferenceSemantics(rhsType) ||
            isEnumTypeWithReferenceSemantics(rhsType))
            ? "->"
            : ".";

        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${rhsCode}${memberAccessOp}${fieldName}; // Destructuring ${label}`
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
          const shouldSkipConst = isMutable || shouldAvoidConst(lhs.$.type);
          context.emitter.emitLine(
            `${indent}${shouldSkipConst ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        } else {
          // Copying from another array - use direct struct assignment
          const varTypeAndName = getVariableTypeString(
            lhs.$.type,
            varName,
            context
          );
          const rhsCode = generateExpr(rhs, indent, context);
          const shouldSkipConst = isMutable || shouldAvoidConst(lhs.$.type);
          context.emitter.emitLine(
            `${indent}${shouldSkipConst ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        }
      } else {
        // Non-array initialization - use existing logic
        const rhsCode = generateExpr(rhs, indent, context);

        // Special handling for slice initialization.
        if (isPtrType(lhs.$.type) && isSliceType(lhs.$.type.type)) {
          const sliceType = lhs.$.type.type; // Get the slice type directly
          const varTypeAndName = getVariableTypeString(
            sliceType,
            varName,
            context
          );
          const shouldSkipConst = isMutable || shouldAvoidConst(sliceType);
          context.emitter.emitLine(
            `${indent}${shouldSkipConst ? "" : "const "}${varTypeAndName} = ${rhsCode};`
          );
        } else {
          // Normal initialization
          const varTypeAndName = getVariableTypeString(
            lhs.$.type,
            varName,
            context
          );
          const shouldSkipConst = isMutable || shouldAvoidConst(lhs.$.type);
          context.emitter.emitLine(
            `${indent}${shouldSkipConst ? "" : "const "}${varTypeAndName} = ${rhsCode};`
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
        const shouldSkipConst = isMutable || shouldAvoidConst(lhs.$.type);
        context.emitter.emitLine(
          `${indent}${shouldSkipConst ? "" : "const "}${varTypeAndName} = ${rhsCode};`
        );
      } else {
        // For assignment to existing array variable, use direct struct assignment
        context.emitter.emitLine(`${indent}${lhsCode} = ${rhsCode};`);
      }
    } else {
      // Non-array assignment - use existing logic
      const rhsCode = generateExpr(rhs, indent, context);
      if (!isUnitType(lhs.$.type)) {
        const shouldSkipConst =
          !isInitialization || isMutable || shouldAvoidConst(lhs.$.type);
        const constQualifier = shouldSkipConst ? "" : "const ";
        context.emitter.emitLine(
          `${indent}${constQualifier}${isInitialization ? getTypeString(lhs.$.type, context) + " " : ""}${lhsCode} = ${rhsCode};`
        );
      }
    }

    return expr.$?.variableName ?? "";
  }
  // already computed and it's not unit value
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type)
  ) {
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
      // Expression form: begin block that returns a value
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
    } else {
      // Statement form: begin block without returning a value
      context.emitter.emitLine(`${indent}{ // begin block`);
      const argsCode = expr.args.map((arg) =>
        generateExpr(arg, indent + "  ", context)
      );
      argsCode.forEach((argCode) => {
        if (argCode) {
          context.emitter.emitLine(`${indent}  ${argCode};`);
        }
      });
      context.emitter.emitLine(`${indent}} // end begin block`);
      return "";
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

    // Special case: *(arr(0:3)) or *(arr(:)) should create slice values directly
    if (exprIsFunctionCall(arg)) {
      const funcType = arg.func.$?.type;
      if (funcType && isArrayType(funcType)) {
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(arr(start:end)) -> create slice value directly
          const arrayCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(
                (funcType as ArrayType).elementType,
                context
              ),
            });
          }
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(arr(:)) -> create slice value for whole array
          const arrayCode = generateExpr(arg.func!, indent, context);
          const arrayType = funcType as ArrayType;
          const elementType = arrayType.elementType;

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(elementType, context),
            });
          }

          if (isNumberValue(arrayType.length)) {
            return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
          } else {
            return `/* Error: Cannot slice array with non-compile-time length */`;
          }
        }
      } else if (
        funcType &&
        (isSliceType(funcType) ||
          (isPtrType(funcType) && isSliceType(funcType.type)))
      ) {
        // Handle slice-from-slice: *(slice(start:end))
        const sliceBaseType = isSliceType(funcType)
          ? (funcType as SliceType)
          : (funcType.type as SliceType);
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(slice(start:end)) -> create sub-slice
          const sliceCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(sliceBaseType.elementType, context),
            });
          }
          return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(slice(:)) -> create slice copy of whole slice
          const sliceCode = generateExpr(arg.func!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.elementType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              elementType: getTypeString(sliceBaseType.elementType, context),
            });
          }
          return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
        }
      }
    }

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
  // borrow
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.borrow)) {
    // This case should not be reached since borrow is handled at the top
    return `// Error: borrow should be handled at top of generateFuncCall`;
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
  // __yo_decr_rc
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const arg = expr.args[0]!;
    const disposeFnArg = expr.args[1];
    const argCode = generateExpr(arg, indent, context);

    // If dispose function is provided, generate it; otherwise use NULL
    let disposeFnCode = "NULL";
    if (disposeFnArg) {
      const rawDisposeFnCode = generateExpr(disposeFnArg, indent, context);
      // Cast the function pointer to the expected void(*)(void*) type
      disposeFnCode = `(void(*)(void*))${rawDisposeFnCode}`;
    }

    return `__yo_decr_rc(${argCode}, ${disposeFnCode})`;
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
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // for loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.for)) {
    return generateForLoop(expr, indent, context);
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
  // consume
  // compt_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.consume) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error)
  ) {
    // no-op in C, just return empty string
    return "";
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
    } else if (isClosureType(functionType)) {
      // Handle closure calls - following Rust model
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
      if (runtimeArgExprs) {
        return `// Error: Closure calls are not yet implemented in C codegen`;
        /*
        // Generate closure value and function arguments
        const closureCode = generateExpr(expr.func, indent, context);
        const args = runtimeArgExprs.map((arg) => {
          return generateExpr(arg, indent, context);
        });

        // Get the closure type and its function value to find the call function
        const closureType = functionType as ClosureType;
        const closureValue = expr.func.$?.value;

        console.log(
          `DEBUG: Closure call - functionType: ${typeToString(functionType)}, closureValue: ${closureValue ? valueToString(closureValue) : "undefined"}, expr.func.$: ${expr.func.$ ? "exists" : "undefined"}`
        );
        console.log(
          `DEBUG: expr.func.$.type:`,
          expr.func.$?.type ? typeToString(expr.func.$?.type) : "undefined"
        );
        console.log(
          `DEBUG: expr.func.$.value:`,
          expr.func.$?.value ? valueToString(expr.func.$?.value) : "undefined"
        );
        console.log(`DEBUG: expr.func:`, exprToString(expr.func));

        // For runtime closures, we need to get the function info from the type system
        // since the closure value is not available at compile time
        let functionCName: string;
        if (closureValue && isClosureValue(closureValue)) {
          // Compile-time closure - we have the actual closure value
          const functionValue = closureValue.functionValue;
          const cName = context.functions[functionValue.funcId]?.cName;

          if (!cName) {
            return `// Error: No C function name found for closure function ${functionValue.funcId}`;
          }
          functionCName = cName;
        } else {
          // Runtime closure - we need to find the function from collected functions
          // Look for functions with closure kinds that match this closure type
          const matchingFunctions = Object.values(context.functions).filter(
            (f) => f.value.type.closureKind === closureType.callType.closureKind
          );

          if (matchingFunctions.length === 1) {
            functionCName = matchingFunctions[0]!.cName;
          } else {
            return `// Error: Cannot determine closure function name for runtime closure (found ${matchingFunctions.length} candidates)`;
          }
        }

        // Call the static function with closure as first argument, followed by other args
        // For FnMut and Fn, pass closure by reference; for FnMove, pass by value
        const closureKind = closureType.callType.closureKind;
        let closureArg: string;
        if (closureKind === "FnMut" || closureKind === "Fn") {
          closureArg = `&(${closureCode})`; // Pass by reference
        } else {
          closureArg = closureCode; // Pass by value (FnMove)
        }

        const allArgs = [closureArg, ...args];
        const argsList = allArgs.join(", ");
        const returnType = closureType.callType.return.type;

        if (isUnitType(returnType)) {
          // If the closure returns unit, just call it without assignment
          context.emitter.emitLine(`${indent}${functionCName}(${argsList});`);
          return ""; // No return value
        } else {
          // If it returns a value, assign to a temp variable or return directly
          const tempVar = expr.$?.variableName;
          const returnTypeStr = getTypeString(returnType, context);
          if (tempVar) {
            context.emitter.emitLine(
              `${indent}${returnTypeStr} ${tempVar} = ${functionCName}(${argsList});`
            );
            return tempVar; // Return the temp variable name
          } else {
            return `${functionCName}(${argsList})`;
          }
        }
        */
      } else {
        return `// Error: Failed to transpile closure call - no runtime args`;
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const structType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[structType.id]?.cName;
        const labels = structType.elements.map((element) => element.label);
        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          if (structType.isReferenceSemantics) {
            // For ref struct, call the constructor function
            const argsList = runtimeArgExprs
              .map((arg) => generateExpr(arg, indent, context))
              .join(", ");

            const constructorName = `__yo_new_${cName}`;
            return `${constructorName}(${argsList})`;
          } else {
            // For regular struct, generate struct initialization as before
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

            // Use constructor function for ref enums, struct literal for value enums
            if (enumType.isReferenceSemantics) {
              const constructorName = `__yo_new_${cName}_${variantName}`;
              const argValues = runtimeArgExprs
                .map((arg) => generateExpr(arg, indent, context))
                .join(", ");
              return `${constructorName}(${argValues})`;
            } else {
              return `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`;
            }
          }
        }
      }
    } else if (isArrayType(functionType)) {
      // Array access by index: arr[index] or arr(index)
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    } else if (isSliceType(functionType)) {
      // Slice access by index: slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    } else if (
      functionType &&
      isPtrType(functionType) &&
      isSliceType(functionType.type)
    ) {
      // Slice access by index for pointer to slice (but we generate slice as value): slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    }
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  // Handle control flow atoms first (before checking computed values)
  if (expr.token.value === "continue") {
    return "continue";
  }

  if (expr.token.value === "break") {
    return "break";
  }

  if (expr.$?.value && !isUnknownValue(expr.$.value)) {
    return generateComptValue(expr.$.value, context);
  }

  /*
  // Check if we're in a closure function and this variable is captured
  const functionContext = context as FunctionGenerationContext; // Type assertion to access function-specific context
  if (
    functionContext.currentClosureCaptures &&
    functionContext.currentClosureCaptures.includes(expr.token.value)
  ) {
    // We're accessing a captured variable in a closure function
    const closureKind = functionContext.currentClosureKind;

    if (closureKind === "FnMut") {
      // For FnMut, closure parameter is a pointer, and captured variables are also pointers
      return `*(closure_struct->${expr.token.value})`;
    } else if (closureKind === "Fn") {
      // For Fn, closure parameter is a const pointer, and captured variables are const pointers
      return `*(closure_struct->${expr.token.value})`;
    } else {
      // For FnMove, closure parameter is by value, and captured variables are values
      return `closure_struct.${expr.token.value}`;
    }
  }
  */

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
      if (enumType.isReferenceSemantics) {
        const constructorName = `__yo_new_${cName}_${value.variantName}`;
        return `${constructorName}()`;
      } else {
        return `(${cName}){ .tag = ${variantTag} }`;
      }
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

      // Use constructor function for ref enums, struct literal for value enums
      if (enumType.isReferenceSemantics) {
        const constructorName = `__yo_new_${cName}_${value.variantName}`;
        const argValues = value.elements
          .map((element) => generateComptValue(element, context))
          .join(", ");
        return `${constructorName}(${argValues})`;
      } else {
        return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${fields.join(", ")} } } }`;
      }
    }
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      if (type.isReferenceSemantics) {
        // For ref struct compile-time values, use constructor function
        const fieldValues = value.elements.map((element) =>
          generateComptValue(element, context)
        );

        const constructorName = `__yo_new_${cName}`;
        return `${constructorName}(${fieldValues.join(", ")})`;
      } else {
        // For regular struct compile-time values, generate as before
        const fields = value.elements.map((element, index) => {
          const fieldValue = element;
          const fieldName = type.elements[index]!.label;
          const fieldCode = generateComptValue(fieldValue, context);
          return `.${fieldName} = ${fieldCode}`;
        });

        return `(${cName}){ ${fields.join(", ")} }`;
      }
    }
  } else if (isArrayValue(value)) {
    // For array values, generate struct wrapper initialization
    const arrayType = value.type;
    const arrayTypeName = getTypeString(arrayType, context);
    const elementCodes = value.elements.map((element) =>
      generateComptValue(element, context)
    );
    return `(${arrayTypeName}){ .data = { ${elementCodes.join(", ")} } }`;
  } else if (isClosureValue(value)) {
    // For closure values, generate only the captured data (following Rust model)
    const closureType = value.type;
    const cName = context.types[closureType.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for closure ${typeToString(closureType)}`;
    }

    // Generate closure initialization with only captured data
    if (value.captureValue && isStructValue(value.captureValue)) {
      // Closure with captures - generate compile-time closure
      const captureStruct = value.captureValue;
      const fieldCodes: string[] = [];

      for (let i = 0; i < captureStruct.elements.length; i++) {
        const element = captureStruct.elements[i];
        if (element) {
          const fieldCode = generateComptValue(element, context);
          fieldCodes.push(fieldCode);
        }
      }

      return `(${cName}){ ${fieldCodes.join(", ")} }`;
    } else if (
      closureType.captureType &&
      isStructType(closureType.captureType)
    ) {
      // TODO: Runtime closure with captures - commented out for closure system simplification
      return `// TODO: Runtime closure generation not yet implemented with new closure system`;
      /*
      // Runtime closure with captures - use field names as variable names
      const captureType = closureType.captureType;
      const closureKind = closureType.callType.closureKind;
      /*
      const fieldCodes: string[] = [];

      for (let i = 0; i < captureType.elements.length; i++) {
        const element = captureType.elements[i];
        if (element) {
          // For runtime closures, use the field label as the variable name
          // For FnMut and Fn, we need to capture by reference (&variable)
          // For FnMove, we capture by value (variable)
          if (closureKind === "FnMut" || closureKind === "Fn") {
            fieldCodes.push(`&${element.label}`);
          } else {
            // FnMove or default - capture by value
            fieldCodes.push(element.label);
          }
        }
      }

      return `(${cName}){ ${fieldCodes.join(", ")} }`;
      */
    } else {
      // Closure without captures - generate empty struct with dummy field
      return `(${cName}){ 0 }`;
    }
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
    // Special handling for slice types: even if they appear as pointer types in AST,
    // they should use dot notation because we generate them as struct values
    else if (isPtrType(objectType) && isSliceType(objectType.type)) {
      // For slice types, always use dot notation regardless of pointer level in AST
      return `${objectCode}.${fieldName}`;
    }
    // Check if the object is pointer or reference
    else if (
      isPtrType(objectType) ||
      isMutPtrType(objectType) ||
      isRefType(objectType) ||
      isMutRefType(objectType)
    ) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
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
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${fieldName}`;
          } else {
            // Multiple levels of dereference: **(ptr).field
            const dereferencedObjectCode = `${"*".repeat(dereferenceLevel - 1)}(${objectCode})`;
            return `${dereferencedObjectCode}->${fieldName}`;
          }
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
      // Check if this is a reference-counted type (ref struct or ref enum)
      if (
        isStructTypeWithReferenceSemantics(objectType) ||
        isEnumTypeWithReferenceSemantics(objectType)
      ) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${fieldName}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${fieldName}`;
      }
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
  if (expr.$) {
    const tempVar = expr.$.variableName;
    const valueType = expr.$.type;
    const isUnit = valueType && isUnitType(valueType);

    // For unit types, don't declare a temporary variable
    if (!isUnit && tempVar) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
    }

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

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // Generate the begin block contents directly without assignment
            generateLoopBody(value, indent + "  ", context);
          } else {
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, indent + "  ", context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${indent}  ${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (!isUnit && tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              context.emitter.emitLine(`${indent}  ${tempVar} = ${valueCode};`);
            }
          }
          context.emitter.emitLine(`${indent}}`);
        }
      }
    }

    // For unit types, return empty string; for others, return temp variable
    return isUnit ? "" : (tempVar ?? "");
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is not evaluated */';
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
function generateMatchExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$) {
    return `/* "match" expression is not evaluated */`;
  }
  const tempVariableName = expr.$.variableName;
  const valueType = expr.$.type;
  const isUnit = valueType && isUnitType(valueType);

  // Create temp variable declaration
  if (!isUnit && tempVariableName) {
    const varType = getTypeString(valueType, context);
    context.emitter.emitLine(`${indent}${varType} ${tempVariableName};`);
  }

  // Generate the matched value
  const matchedValueCode = generateExpr(expr.args[0]!, indent, context);
  const matchValueType = expr.args[0]!.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires an enum type`;
  }

  // Check if it's a pointer/reference type OR reference semantics type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType:
    | TypeTag.Ptr
    | TypeTag.MutPtr
    | TypeTag.Ref
    | TypeTag.MutRef
    | "ref_semantics"
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
  } else if (isEnumTypeWithReferenceSemantics(matchValueType)) {
    // ref enum types are represented as pointers in C
    enumType = matchValueType;
    ptrOrRefType = "ref_semantics";
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
      `${indent}if (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      const bodyCode = generateExpr(
        pointerCase.caseBody,
        indent + "  ",
        context
      );
      if (!isUnit && tempVariableName) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateExpr(nullCase.caseBody, indent + "  ", context);
      if (!isUnit && tempVariableName) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate optimized simple enum matching
    context.emitter.emitLine(
      `${indent}switch (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode}) {`
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
          if (!isUnit && tempVariableName) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType === "ref_semantics" || ptrOrRefType ? matchedValueCode + "->tag" : "(" + matchedValueCode + ").tag"}) {`
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
        caseValue.func.tag === ExprTag.Atom &&
        caseValue.func.token.value === "." &&
        caseValue.args.length >= 1 // Allow 1 or more arguments for destructuring
      ) {
        const variantName = caseValue.args[0]!.token.value; // Get the variant name
        const variantTag = getEnumVariantCName(enumType, variantName, context);

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Handle destructuring patterns like .Point(point) => { ... }
        if (caseValue.args.length > 1) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.elements) {
            // Generate local variable declarations for destructured fields
            for (
              let fieldIndex = 0;
              fieldIndex <
              Math.min(caseValue.args.length - 1, variant.elements.length);
              fieldIndex++
            ) {
              const destructuredVar = caseValue.args[fieldIndex + 1]!; // Skip the variant name
              const variantElement = variant.elements[fieldIndex];

              if (destructuredVar.tag === ExprTag.Atom && variantElement) {
                const varName = destructuredVar.token.value;
                const fieldName = variantElement.label || `field_${fieldIndex}`;
                const fieldType = getTypeString(variantElement.type, context);

                // Generate variable declaration and assignment
                const accessPrefix =
                  ptrOrRefType === "ref_semantics" || ptrOrRefType ? "->" : ".";
                context.emitter.emitLine(
                  `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                );
              }
            }
          }
        }

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
        if (!isUnit && tempVariableName) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }
        context.emitter.emitLine(`${indent}  break;`);
      }
      // Handle destructuring patterns like .Point(point) => { ... }
      else if (
        caseValue &&
        caseBody &&
        exprIsFunctionCall(caseValue) &&
        exprIsFunctionCall(caseValue.func) &&
        caseValue.func.func.tag === ExprTag.Atom &&
        caseValue.func.func.token.value === "." &&
        caseValue.func.args.length === 1
      ) {
        // Extract variant name from .Point(point) pattern
        const variantName = caseValue.func.args[0]!.token.value;
        const variantTag = getEnumVariantCName(enumType, variantName, context);
        const destructuringParams = caseValue.args;

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Generate local variable declarations for destructured fields
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant && variant.elements && destructuringParams.length > 0) {
          for (
            let fieldIndex = 0;
            fieldIndex <
            Math.min(destructuringParams.length, variant.elements.length);
            fieldIndex++
          ) {
            const destructuredVar = destructuringParams[fieldIndex]!;
            const variantElement = variant.elements[fieldIndex];

            if (destructuredVar.tag === ExprTag.Atom && variantElement) {
              const varName = destructuredVar.token.value;

              // Skip if variable name is "_" (ignore pattern)
              if (varName !== "_") {
                const fieldName = variantElement.label || `field_${fieldIndex}`;
                const fieldType = getTypeString(variantElement.type, context);

                // Generate variable declaration and assignment
                const accessPrefix =
                  ptrOrRefType === "ref_semantics" || ptrOrRefType ? "->" : ".";
                context.emitter.emitLine(
                  `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                );
              }
            }
          }
        }

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
        if (!isUnit && tempVariableName) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }
        context.emitter.emitLine(`${indent}  break;`);
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);
  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
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
  }
  // __yo_noop
  else if (BuiltinFunctions.__yo_noop.includes(functionName)) {
    return "";
  }
  // __yo_return_self
  else if (BuiltinFunctions.__yo_return_self.includes(functionName)) {
    // This is a special case where we just return the first argument
    return `(*${args[0]!})`;
  }
  // __yo_decr_rc
  else if (BuiltinFunctions.__yo_decr_rc.includes(functionName)) {
    // Handle 1 or 2 arguments - second argument is dispose function (optional)
    let disposeFnArg = "NULL";
    if (args[1]) {
      // Cast the function pointer to the expected void(*)(void*) type
      disposeFnArg = `(void(*)(void*))${args[1]}`;
    }
    return `__yo_decr_rc((void*)(${args[0]!}), ${disposeFnArg})`;
  }
  // Handle other operators that are not defined in Yo
  else {
    return `/* Unhandled operator ${functionName} */`;
  }
}

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
function generateWhileLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    const conditionCode = generateExpr(conditionExpr, indent, context);

    context.emitter.emitLine(`${indent}while (${conditionCode}) {`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    const conditionCode = generateExpr(conditionExpr, indent, context);
    const stepCode = generateStepExpression(stepExpr, context);

    // Generate for loop: for (; condition; step) { body }
    context.emitter.emitLine(
      `${indent}for (; ${conditionCode}; ${stepCode}) {`
    );
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}

/**
 * Generate C code for for loop expression
 * Converts Yo for loops to C for loops with array iteration
 */
function generateForLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length !== 2) {
    context.emitter.emitLine(
      `${indent}/* Error: for loop expects 2 arguments, got ${args.length} */`
    );
    return "";
  }

  const itemsExpr = args[0]!; // Array/slice expression
  const arrowExpr = args[1]!; // lambda expression: (bindings) => body

  if (
    !exprIsFunctionCall(arrowExpr) ||
    !exprIsFunctionCallOf(arrowExpr, "=>", 2)
  ) {
    context.emitter.emitLine(
      `${indent}/* Error: for loop second argument must be => expression */`
    );
    return "";
  }

  const bindingExpr = arrowExpr.args[0]!;
  const bodyExpr = arrowExpr.args[1]!;

  // Generate the array expression
  const arrayCode = generateExpr(itemsExpr, indent, context);

  // Extract variable names from bindings
  let elementVarName: string | undefined;
  let indexVarName: string | undefined;

  // Parse the binding expression to extract variable names
  if (exprIsAtom(bindingExpr)) {
    // Simple case: for arr, elem => body
    elementVarName = bindingExpr.token.value;
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.mut)
  ) {
    // Mutable element: for arr, mut(elem) => body
    if (bindingExpr.args[0] && exprIsAtom(bindingExpr.args[0])) {
      elementVarName = bindingExpr.args[0].token.value;
    }
  } else if (
    exprIsFunctionCall(bindingExpr) &&
    exprIsFunctionCallOf(bindingExpr, BuiltinKeywords.tuple)
  ) {
    // Tuple case: for arr, (elem, index) => body
    const firstArg = bindingExpr.args[0];
    const secondArg = bindingExpr.args[1];

    if (firstArg) {
      if (exprIsAtom(firstArg)) {
        elementVarName = firstArg.token.value;
      } else if (
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, BuiltinKeywords.mut) &&
        firstArg.args[0] &&
        exprIsAtom(firstArg.args[0])
      ) {
        elementVarName = firstArg.args[0].token.value;
      }
    }

    if (secondArg && exprIsAtom(secondArg)) {
      indexVarName = secondArg.token.value;
    }
  }

  if (!elementVarName) {
    context.emitter.emitLine(
      `${indent}/* Error: could not extract element variable name from for loop binding */`
    );
    return "";
  }

  // Get the type information from the evaluated expressions
  const itemsType = itemsExpr.$?.type;

  // Generate unique index variable name if not provided
  const actualIndexVarName =
    indexVarName || `__index_${Math.random().toString(36).substr(2, 9)}`;

  // Get type strings for variable declarations
  let elementTypeStr = "int"; // default fallback
  let arrayLength = "0"; // default fallback

  if (itemsType && isArrayType(itemsType)) {
    elementTypeStr = getTypeString(itemsType.elementType, context);
    // Extract the numeric value from the length Value
    const lengthValue = itemsType.length;
    if (lengthValue && isNumberValue(lengthValue)) {
      arrayLength = lengthValue.value.toString();
    }
  } else if (
    itemsType &&
    (isSliceType(itemsType) ||
      (isPtrType(itemsType) && isSliceType(itemsType.type)))
  ) {
    // Handle slice iteration
    const sliceType = isSliceType(itemsType)
      ? (itemsType as SliceType)
      : (itemsType.type as SliceType);
    elementTypeStr = getTypeString(sliceType.elementType, context);
    arrayLength = `${arrayCode}.length`; // Use runtime length from slice
  }

  // Generate the C for loop
  // For arrays, we iterate through indices and access elements
  context.emitter.emitLine(
    `${indent}for (size_t ${actualIndexVarName} = 0; ${actualIndexVarName} < ${arrayLength}; ${actualIndexVarName}++) {`
  );

  // Declare the element variable and assign from array
  context.emitter.emitLine(
    `${indent}  ${elementTypeStr} ${elementVarName} = ${arrayCode}.data[${actualIndexVarName}];`
  );

  // If the user provided an index variable name, declare it as an alias to actualIndexVarName
  if (indexVarName && indexVarName !== actualIndexVarName) {
    context.emitter.emitLine(
      `${indent}  size_t ${indexVarName} = ${actualIndexVarName};`
    );
  }

  // Generate the loop body
  generateLoopBody(bodyExpr, indent + "  ", context);

  context.emitter.emitLine(`${indent}}`);

  return "";
}
