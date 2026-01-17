import { getVariablesFromEnv } from "../../env";
import {
  AtomExpr,
  BuiltinFunctions,
  Expr,
  exprIsAtom,
  FuncCallExpr,
} from "../../expr";
import {
  isDynType,
  isEnumType,
  isFunctionType,
  isNewtypeType,
  isObjectType,
  isPtrType,
  isSliceType,
  isStructType,
  isTupleType,
  isUnitType,
  TraitType,
  Type,
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
  isTupleValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "../../value";
import { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import { checkVariableIsClosureCaptured } from "./closure-utils";
import { generateExpr } from "./generation";

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
export function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  const functionContext = context as FunctionGenerationContext;

  // Handle control flow atoms first (before checking unit type or other values)
  // These need to return the keyword string even though they have unit type

  // Handle control flow atoms first (before checking computed values or variable names)
  if (expr.token.value === "continue") {
    // For 3-argument while loops, continue should jump to the continue label
    // which is before the step expression
    if (functionContext.currentContinueLabel) {
      return `goto ${functionContext.currentContinueLabel}`;
    }
    return "continue";
  }

  if (expr.token.value === "break") {
    return "break";
  }

  if (expr.token.value === "return") {
    return "return";
  }

  // For unit-typed expressions (excluding control flow which was handled above), return empty string
  if (expr.$?.type && isUnitType(expr.$.type)) {
    return "";
  }

  // Check if we're in a closure function and this variable is captured
  // Type assertion to access function-specific context

  // Check if we're in a state machine and this is a captured variable
  if (functionContext.inStateMachine && functionContext.stateMachineVariables) {
    const varName = expr.token.value;

    // Check if this variable is locally shadowed (e.g., in match destructuring)
    // If so, use the local C variable instead of the state machine field
    if (functionContext.localShadowedVariables?.has(varName)) {
      return varName;
    }

    // Check if this variable is in the state machine
    // IMPORTANT: Look up by variable ID from environment, not by name!
    // This handles variable shadowing correctly - shadowed variables have the same name but different IDs
    let foundInStateMachine = false;
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!; // Most recent scope
        const varId = variable.isOwningTheSameRcValueAs
          ? variable.isOwningTheSameRcValueAs.id
          : variable.id;

        // Check if this variable ID is in the state machine
        const capturedVar = functionContext.stateMachineVariables.get(varId);
        if (capturedVar) {
          // This is a state machine variable - access it through sm->
          // Use kind to determine field name:
          // - "outer": Use __capture.varName (sm->__capture.varName)
          // - "local": Use var_{varId} (sm->var_{varId})
          const fieldName =
            capturedVar.kind === "outer"
              ? `__capture.${varName}`
              : `var_${varId}`;
          foundInStateMachine = true;
          return `sm->${fieldName}`;
        }
      }
    }

    // Fallback: if we don't have env info or didn't find it by ID, search by name
    // This handles captured variables from outer scopes (capture struct) where we might not have env
    if (!foundInStateMachine) {
      for (const [
        varId,
        capturedVar,
      ] of functionContext.stateMachineVariables) {
        if (capturedVar.name === varName) {
          // Found by name - this should only happen for outer captured variables
          const fieldName =
            capturedVar.kind === "outer"
              ? `__capture.${varName}`
              : `var_${varId}`;
          foundInStateMachine = true;
          return `sm->${fieldName}`;
        }
      }
    }

    // Variable not found directly - check if it's borrowing from a captured variable
    // This handles the case where we reference `future1` but only `temp_2198` (its owner) is captured
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheSameRcValueAs) {
          // This variable is borrowing - try to find the owner in state machine
          const ownerName = variable.isOwningTheSameRcValueAs.name;
          const ownerId = variable.isOwningTheSameRcValueAs.id;

          for (const [
            varId,
            capturedVar,
          ] of functionContext.stateMachineVariables) {
            if (capturedVar.name === ownerName || varId === ownerId) {
              const fieldName =
                capturedVar.kind === "outer"
                  ? `__capture.${ownerName}`
                  : `var_${varId}`;
              return `sm->${fieldName}`;
            }
          }
        }
      }
    }

    // Variable not in stateMachineVariables - it's a local C variable in the resume function
    // Just use the variable name (don't regenerate its value)
    if (expr.$?.variableName) {
      return getVariableNameForCodegen(expr.$.variableName, expr.$.env);
    }
  }

  // If this atom has a temp variable name (e.g., for Rc values), use that instead of regenerating code
  // This prevents regenerating constructor calls for temp variables that should just use their variable names
  // BUT: if this is a captured variable in a closure, we should use closure access instead
  // ALSO: if this is a compile-time only variable with a value, inline it instead
  if (expr.$?.variableName) {
    // Check if this is a compile-time only variable - if so, inline the value
    if (expr.$?.env && expr.$?.value && !isUnknownValue(expr.$.value)) {
      const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
      if (
        variables.length > 0 &&
        variables[variables.length - 1]!.isCompileTimeOnly
      ) {
        return generateComptValue(expr.$.value, context, expr);
      }
    }

    // Check if this is a captured variable in a closure - if so, don't use temp variable name
    if (
      functionContext.currentClosureCaptures &&
      functionContext.currentClosureCaptures.includes(expr.token.value) &&
      expr.$?.env &&
      functionContext.currentClosureCaptureFrameLevel !== undefined &&
      checkVariableIsClosureCaptured(
        expr.token.value,
        expr.$.env,
        functionContext.currentClosureCaptureFrameLevel
      )
    ) {
      // Don't return early - let it fall through to closure capture logic
    } else {
      // Otherwise check if this variable has a parameterAlias in the environment
      return getVariableNameForCodegen(expr.$.variableName, expr.$?.env);
    }
  }

  // Check if this atom has a compile-time value
  // This is only reached for closure-captured variables (non-closure variables return early above)
  // For closure-captured variables, we should NOT inline their values - we access them via closure context
  // So this code path should never actually inline a value for variables
  if (expr.$?.value) {
    if (isUnknownValue(expr.$.value)) {
      // For unknown values (like mutually recursive function references), we should NOT inline
      // Instead, fall through to use the variable name from the token
      // This handles cases like is_even referencing is_odd before is_odd is defined
    } else {
      // Only inline if this is NOT a variable (e.g., it's a literal constant without a variable name)
      // But all variables should have been handled above, so this is just for safety
      return generateComptValue(expr.$.value, context, expr);
    }
  }

  const isClosureCaptured =
    expr.$?.env && functionContext.currentClosureCaptureFrameLevel !== undefined
      ? checkVariableIsClosureCaptured(
          expr.token.value,
          expr.$.env,
          functionContext.currentClosureCaptureFrameLevel
        )
      : false;

  if (
    functionContext.currentClosureCaptures &&
    functionContext.currentClosureCaptures.includes(expr.token.value) &&
    functionContext.currentClosureCaptureFrameLevel !== undefined &&
    (expr.$?.env ? isClosureCaptured : true) // If no env info, trust currentClosureCaptures
  ) {
    // We're accessing a captured variable in a closure function
    // The closure_context parameter is a void* that points directly to the capture struct
    // Need to cast it to the appropriate capture struct type

    const captureTypeCName = functionContext.currentClosureCaptureTypeCName;
    if (captureTypeCName) {
      // Cast void* closure_context directly to the capture struct pointer
      return `((${captureTypeCName}*)closure_context)->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
    }
    // Fallback to old approach if we can't determine the type (should not happen)
    return `closure_context->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
  }

  // Fallback: Check if this is a closure function by looking at the current function name and finding its type
  if (
    functionContext.currentFunctionName &&
    !functionContext.currentClosureCaptures
  ) {
    // Find the function value being generated
    const currentFunctionEntry = Object.values(functionContext.functions).find(
      (entry) => entry.cName === functionContext.currentFunctionName
    );

    if (currentFunctionEntry && currentFunctionEntry.value.type.isClosure) {
      // This is a closure function, find its closure type
      const closureTypeEntry = Object.values(functionContext.types).find(
        (t) =>
          isFunctionType(t.type) &&
          t.type.isClosure &&
          t.type === currentFunctionEntry.value.type
      );

      if (closureTypeEntry) {
        // Note: captureType is no longer on ClosureType, use naming convention
        const captureStructName = `${closureTypeEntry.cName}_capture`;
        return `((${captureStructName}*)closure_context->data)->${getVariableNameForCodegen(expr.token.value, expr.$?.env)}`;
      }
    }
  }

  // Check if this is a function variable - if so, use its C function name
  // This handles mutually recursive functions where the value might be UnknownValue
  if (expr.$?.env) {
    const variables = getVariablesFromEnv(expr.$.env, expr.token.value);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;

      // Check if the variable has a function value (or UnknownValue with function type)
      if (variable.value && isFunctionValue(variable.value)) {
        // Look up the C function name
        const cFuncName = context.functions[variable.value.funcId]?.cName;
        if (cFuncName) {
          return cFuncName;
        }
      } else if (
        isFunctionType(variable.type) &&
        (isUnknownValue(variable.value) || variable.value === undefined)
      ) {
        // For UnknownValue or undefined with function type (mutual recursion case),
        // we need to find the function ID another way.
        // The function should have been registered in context.functions
        // Try to find it by matching the variable name
        const functionEntry = Object.entries(context.functions).find(
          ([_funcId, entry]) => {
            // Check if this function's definition matches our variable
            // This is a heuristic - we match by checking if any specialization
            // of the function has a matching variable name
            return entry.value.funcName === expr.token.value;
          }
        );

        if (functionEntry) {
          return functionEntry[1].cName;
        }
      }
    }
  }

  // Check if this variable has a parameterAlias (used in anonymous functions
  // where the actual parameter name differs from the expected interface parameter name)
  const varNameToUse = getVariableNameForCodegen(expr.token.value, expr.$?.env);
  return varNameToUse;
}

/**
 * Generate C code for a compile-time value - extracted from original codegen-c.ts
 */
export function generateComptValue(
  value: Value,
  context: CodeGenContext,
  _sourceExpr?: Expr
): string {
  if (isNumberValue(value)) {
    // For numbers, we can directly return the value as a string
    return valueToString(value);
  } else if (isBooleanValue(value)) {
    // For booleans, return true/false
    return value.value ? "true" : "false";
  } else if (isComptStringValue(value)) {
    // Check if there's a converted runtime type (e.g., compt_string -> str or [u8])
    const targetType =
      _sourceExpr?.$?.convertedRuntimeType || _sourceExpr?.$?.type;

    // Check if the target type is a newtype wrapping a slice (e.g., str)
    // Newtypes are transparent in C (just typedefs), so we generate the underlying slice
    if (
      targetType &&
      isNewtypeType(targetType) &&
      targetType.fields.length === 1
    ) {
      const wrappedType = targetType.fields[0]!.type;
      if (isSliceType(wrappedType)) {
        const newtypeCType = getTypeString(targetType, context);
        const stringLiteral = JSON.stringify(value.value);
        const stringLength = Buffer.byteLength(value.value, "utf8");

        // Newtypes are zero-cost abstractions, so we just generate the slice value
        return `(${newtypeCType}){ .data = (uint8_t*)${stringLiteral}, .length = ${stringLength} }`;
      }
    }

    // Check if the target type is a slice (e.g., [u8])
    // In Yo, [u8] is a fat pointer (slice value), represented as a struct with data+length
    if (targetType && isSliceType(targetType)) {
      const sliceCType = getTypeString(targetType, context);
      const stringLiteral = JSON.stringify(value.value);
      const stringLength = Buffer.byteLength(value.value, "utf8");

      // Generate slice struct value (fat pointer)
      return `(${sliceCType}){ .data = (uint8_t*)${stringLiteral}, .length = ${stringLength} }`;
    }

    // For regular strings, return the C string literal with proper escaping
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

      if (!variant.fields || variant.fields.length === 0) {
        // This is the null case (None variant)
        return "NULL";
      } else if (variant.fields.length === 1 && value.fields.length === 1) {
        // This is the pointer case (Some variant)
        return generateComptValue(value.fields[0]!, context);
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

    if (!value.fields || value.fields.length === 0) {
      // Variant with no data
      return `(${cName}){ .tag = ${variantTag} }`;
    } else {
      // Variant with data
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant || !variant.fields) {
        return `// Error: Variant ${value.variantName} not found or has no fields`;
      }

      // Filter out unit type fields
      const nonUnitFields = value.fields
        .map((field, index) => {
          const variantElement = variant.fields![index];
          if (variantElement && !isUnitType(variantElement.type)) {
            const fieldName = sanitizeForCIdentifier(variantElement.label);
            const fieldCode = generateComptValue(field, context);
            return `.${fieldName} = ${fieldCode}`;
          }
          return null;
        })
        .filter((f) => f !== null);

      // If all fields are unit types, just return the tag
      if (nonUnitFields.length === 0) {
        return `(${cName}){ .tag = ${variantTag} }`;
      }

      return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${nonUnitFields.join(", ")} } } }`;
    }
  } else if (isTupleValue(value)) {
    // For tuple values, generate tuple struct initialization with numeric field names
    const type = value.type;
    const cName = context.types[type.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for tuple ${typeToString(type)}\n`;
    }

    const fields = value.fields.map((field, index) => {
      const fieldCode = generateComptValue(field, context);
      // Tuples always use numeric field names _0, _1, _2...
      return `._${index} = ${fieldCode}`;
    });

    return `(${cName}){ ${fields.join(", ")} }`;
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      // Handle newtype as zero-cost abstraction
      if (
        type.isNewtype &&
        type.fields.length === 1 &&
        value.fields.length === 1
      ) {
        // For newtype, just use the underlying value with a cast
        const underlyingValue = generateComptValue(value.fields[0]!, context);
        return `((${cName})(${underlyingValue}))`;
      }

      if (type.isReferenceSemantics) {
        // For object compile-time values, use constructor function
        const fieldValues = value.fields.map((field) =>
          generateComptValue(field, context)
        );

        const constructorName = `__yo_new_${cName}`;
        return `${constructorName}(${fieldValues.join(", ")})`;
      } else {
        // For regular struct compile-time values, generate as before
        const fields = value.fields.map((field, index) => {
          const fieldValue = field;
          // For tuples, use numeric field names _0, _1, _2...
          // For regular structs, use the actual field labels
          const fieldName = isTupleType(type)
            ? `_${index}`
            : sanitizeForCIdentifier(type.fields[index]!.label);
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
export function generateFieldAccess(
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

    // Check if this field access is actually a method access (function from type's trait or nested traits)
    // This includes both direct type methods and methods from nested traits
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Fallback: Check if this is an Rc method call (___drop, ___dup, ___dispose)
    // Sometimes, we only called addRcFunctionSignaturesToStructType / addRcFunctionSignaturesToEnumType
    // So they are using the `undefined` function value, before we actually update its trait fields.
    if (
      !expr.$?.value &&
      (BuiltinFunctions.___dispose.includes(fieldName) ||
        BuiltinFunctions.___drop.includes(fieldName) ||
        BuiltinFunctions.___dup.includes(fieldName)) &&
      objectType
    ) {
      // For Rc methods, we need to look up the function from the type's trait
      // and return the function name directly instead of treating it as field access
      let typeTrait: TraitType | null = null;

      if (isStructType(objectType)) {
        typeTrait = objectType.trait;
      } else if (isEnumType(objectType)) {
        typeTrait = objectType.trait;
      }

      if (typeTrait) {
        // Find the function in the type's trait
        const functionElement = typeTrait.fields.find(
          (field) =>
            field.label === fieldName &&
            field.assignedValue &&
            isFunctionValue(field.assignedValue)
        );

        if (functionElement && isFunctionValue(functionElement.assignedValue)) {
          const functionValue = functionElement.assignedValue;
          const cFunctionName =
            context.functions[functionValue.funcId]?.cName ||
            functionValue.funcId;
          return cFunctionName;
        } else {
          return `/* ERROR: Rc method ${fieldName} not found in type module */`;
        }
      } else {
        return `/* ERROR: No module found for Rc method ${fieldName} */`;
      }
    }

    // Handle newtype field access - just return the object itself (zero-cost abstraction)
    if (isNewtypeType(objectType) && objectType.fields.length === 1) {
      // For newtype, accessing the single field just returns the value itself
      // since newtype is typedef'd to the underlying type
      const singleField = objectType.fields[0];
      if (singleField && singleField.label === fieldName) {
        return objectCode;
      }
    }

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
        if (variant.fields) {
          for (const field of variant.fields) {
            if (field.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no fields.
      // Like: Color.Red
      if (!!variant && !variant.fields && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Check if the object is pointer or reference
    else if (isPtrType(objectType)) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
        // Ensure proper parenthesization: (*ptr) not *(ptr)
        return `(*${objectCode})`; // Dereference the pointer/reference
      }
      // Special handling for slice types: pointer-to-slice field access
      // (but not dereference which was already handled above)
      else if (isSliceType(objectType.childType)) {
        // For pointer-to-slice, use arrow notation for field access
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (isPtrType(currentType)) {
          dereferenceLevel++;
          currentType = currentType.childType;
        }

        // IMPORTANT: For reference-semantics types (objects), the type is already a pointer in C.
        // So *(MyBox) in Yo becomes MyBox** in C, which requires 2 dereferences, not 1.
        // We need to add an extra dereference level for reference-semantics types.
        if (
          dereferenceLevel > 0 &&
          isStructType(currentType) &&
          currentType.isReferenceSemantics
        ) {
          dereferenceLevel++;
        }

        // Check if the dereferenced type is a newtype accessing its single field
        if (isNewtypeType(currentType) && currentType.fields.length === 1) {
          const singleField = currentType.fields[0];
          if (singleField && singleField.label === fieldName) {
            // For newtype, accessing the single field through a pointer just dereferences the pointer
            // since newtype is typedef'd to the underlying type
            if (dereferenceLevel === 1) {
              return `(*${objectCode})`;
            } else {
              return `${"*".repeat(dereferenceLevel)}(${objectCode})`;
            }
          }
        }

        if (dereferenceLevel > 0) {
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
          } else {
            // Multiple levels of dereference: (*ptr)->field for ptr**
            // Need to parenthesize the dereferenced expression to get correct precedence
            const dereferencedObjectCode = `(${"*".repeat(dereferenceLevel - 1)}${objectCode})`;
            return `${dereferencedObjectCode}->${sanitizeForCIdentifier(fieldName)}`;
          }
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.fields.findIndex(
          (field) => field.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    }
    // Handle dynamic dispatch method access
    else if (isDynType(objectType)) {
      // For dyn types, access methods through vtable
      // e.g. s.speak becomes s.vtable->speak (Dyn is value type, vtable is pointer)
      return `${objectCode}.vtable->${sanitizeForCIdentifier(fieldName)}`;
    } else {
      // For C structs and unions, access fields directly
      // Check if this is a reference-counted type (object)
      if (isObjectType(objectType)) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
      }
    }
  }

  return "/* ERROR: field name must be an identifier */";
}
