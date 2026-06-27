import { BuiltinFunctions, exprIsAtom, type FnCallExpr } from "../../expr";
import type { TraitType, Type } from "../../types/definitions";
import {
  isDynType,
  isEnumType,
  isFunctionType,
  isSourceNamespaceType,
  isNewtypeType,
  isReferenceStructType,
  isPtrType,
  isStructType,
  isTupleType,
} from "../../types/guards";
import {
  isFunctionValue,
  isStructValue,
  isTraitValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import type { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  type CodeGenContext,
  getEnumVariantCName,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import { generateComptimeValue } from "./comptime-value";
import { generateExpr } from "./expr";

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
export function generateFieldAccess(
  expr: FnCallExpr,
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

    // Evidence passing: if we're in a function with evidence params,
    // evidence field accesses that match evidence params should resolve to
    // the evidence fn ptr parameter, not the resolved handler function.
    const functionContext = context as FunctionGenerationContext;
    if (functionContext.currentEvidenceParams && exprIsAtom(objectExpr)) {
      const objectLabel = objectExpr.token.value;
      const key = `${objectLabel}.${fieldName}`;
      const ep = functionContext.currentEvidenceParams.get(key);
      if (ep) {
        return ep.cParamName;
      }
    }

    // State machine capture: when inside an async or effect state machine,
    // evidence record member fields (e.g., exn.throw, io.await) are stored
    // in the state machine's __capture struct rather than as flat C params.
    // Resolve the field access through sm->__capture.<fieldName>.
    if (
      exprIsAtom(objectExpr) &&
      (functionContext.inAsyncStateMachine ||
        functionContext.inEffectStateMachine) &&
      objectType &&
      (isStructType(objectType) || isSourceNamespaceType(objectType))
    ) {
      // Check if this is a known evidence field whose value was not
      // resolved at compile time (i.e., is a runtime using/given param).
      const isUnresolvedEvidence =
        !objectValue ||
        isUnknownValue(
          Array.isArray(objectValue) ? objectValue[0] : objectValue
        );
      if (isUnresolvedEvidence) {
        const objFields = objectType.fields;
        const matchingField = objFields.find((f) => f.label === fieldName);
        if (matchingField && isFunctionType(matchingField.type)) {
          // If the object is a closure parameter (lives in a __yo_param_<i>
          // SM slot, not in __capture), route through that slot instead.
          // See [[yo-anon-closure-param-name-extraction]].
          // Walk all matching SM vars; prefer one with an alias (closure
          // params) since that's where set_effect writes the bundle.
          const objectVarName = objectExpr.token.value;
          if (
            functionContext.stateMachineVariables &&
            functionContext.stateMachineFieldAliases
          ) {
            for (const [
              varId,
              capturedVar,
            ] of functionContext.stateMachineVariables) {
              if (capturedVar.name === objectVarName) {
                const aliased =
                  functionContext.stateMachineFieldAliases.get(varId);
                if (aliased) {
                  return `sm->${aliased}.${fieldName}`;
                }
              }
            }
            // Fallback: any name-matching var (no alias) — emit its var_<id>
            // slot so the body reads from the same place set_effect's
            // mappings write (when no synthetic slot is in play).
            for (const [
              varId,
              capturedVar,
            ] of functionContext.stateMachineVariables) {
              if (
                capturedVar.name === objectVarName &&
                capturedVar.kind !== "outer"
              ) {
                return `sm->var_${varId}.${fieldName}`;
              }
            }
          }
          return `sm->__capture.${fieldName}`;
        }
      }
    }

    // Check if this field access is actually a method access (function from type's trait or nested traits)
    // This includes both direct type methods and methods from nested traits
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Late dispatch resolution: when the evaluator left expr.$.value unresolved
    // (e.g., in a generic impl body that was specialized after the body was
    // type-checked, like recursive `derive(T, Clone)` triggering Box(T).clone
    // → T.clone before T.clone was registered), look up the method on the
    // concrete object type's trait at codegen emit time and emit the direct
    // C function call instead of treating the field as a struct member.
    //
    // We resolve through the object type's trait fields. We skip ___drop/
    // ___dup/___dispose here because they are handled by the dedicated Rc
    // fallback below (which uses a slightly different lookup path).
    if (
      objectType &&
      !BuiltinFunctions.___dispose.includes(fieldName) &&
      !BuiltinFunctions.___drop.includes(fieldName) &&
      !BuiltinFunctions.___dup.includes(fieldName)
    ) {
      let typeTrait: TraitType | null = null;
      let underlyingType: Type = objectType;
      // Strip pointer layers to find the underlying value type.
      while (isPtrType(underlyingType)) {
        underlyingType = underlyingType.childType;
      }
      if (isStructType(underlyingType) || isEnumType(underlyingType)) {
        typeTrait = underlyingType.trait;
      } else if (isReferenceStructType(underlyingType)) {
        typeTrait = (underlyingType as { trait?: TraitType }).trait ?? null;
      }
      if (typeTrait) {
        // Skip if the type has a real data field with this name — then it's
        // a genuine field access, not a method call.
        const hasDataField =
          (isStructType(underlyingType) &&
            underlyingType.fields.some((f) => f.label === fieldName)) ||
          (isReferenceStructType(underlyingType) &&
            (underlyingType as { fields?: { label: string }[] }).fields?.some(
              (f) => f.label === fieldName
            ));
        if (!hasDataField) {
          // 1) Check direct top-level trait fields (e.g., methods declared
          //    on the type's primary trait, or ___drop/___dup/___dispose).
          const direct = typeTrait.fields.find(
            (field) =>
              field.label === fieldName &&
              field.assignedValue &&
              isFunctionValue(field.assignedValue)
          );
          if (direct && isFunctionValue(direct.assignedValue)) {
            const fv = direct.assignedValue;
            const cFunctionName =
              context.functions[fv.funcId]?.cName || fv.funcId;
            return cFunctionName;
          }
          // 2) Check nested trait impls (e.g., derive(T, Clone) adds an
          //    unlabeled trait field whose value is a TraitValue containing
          //    `clone`). This is the late-dispatch case for recursive impls.
          for (const traitField of typeTrait.fields) {
            if (
              traitField.label === "" &&
              traitField.assignedValue &&
              isTraitValue(traitField.assignedValue)
            ) {
              const implTraitValue = traitField.assignedValue;
              const methodIdx = implTraitValue.type.fields.findIndex(
                (f) => f.label === fieldName
              );
              if (methodIdx >= 0) {
                const methodValue = implTraitValue.fields[methodIdx];
                if (methodValue && isFunctionValue(methodValue)) {
                  const cFunctionName =
                    context.functions[methodValue.funcId]?.cName ||
                    methodValue.funcId;
                  return cFunctionName;
                }
              }
            }
          }
        }
      }
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

    // Module namespace field access (e.g. fcntl_io.O_NONBLOCK)
    // Modules are compile-time values and have no runtime C representation.
    // The field access should resolve directly to the field value/identifier.
    if (isSourceNamespaceType(objectType) || isStructValue(objectValue)) {
      const fieldValue = expr.$?.value;

      if (fieldValue) {
        if (isUnknownValue(fieldValue)) {
          if (fieldValue.variableName) {
            return getVariableNameForCodegen(
              fieldValue.variableName,
              expr.$?.env
            );
          }
          // Check if this module member is captured in an async state machine
          // (e.g., Exception.throw captured as an effect param)
          if (
            (functionContext.inAsyncStateMachine ||
              functionContext.inEffectStateMachine) &&
            functionContext.stateMachineVariables
          ) {
            for (const [
              ,
              capturedVar,
            ] of functionContext.stateMachineVariables) {
              if (
                capturedVar.name === fieldName &&
                capturedVar.kind === "outer"
              ) {
                return `sm->__capture.${fieldName}`;
              }
            }
          }
        } else if (!isStructValue(fieldValue)) {
          return generateComptimeValue(fieldValue, context, expr);
        }
      }

      return getVariableNameForCodegen(fieldName, expr.$?.env);
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
              // Found the field in this variant. A reference-semantics enum
              // (`ref(enum(…))`) value is a pointer, so its variant data must be
              // reached with `->`, not `.` (mirrors match.ts's accessPrefix).
              const variantName = variant.name;
              const accessOp = enumType.isReferenceSemantics ? "->" : ".";
              return `${objectCode}${accessOp}data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
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
      if (isReferenceStructType(objectType)) {
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
