import { getVariablesFromEnv } from "../../env";
import {
  typeImplementsFn,
  typeImplementsFuture,
} from "../../evaluator/trait-checking";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isArrayType, isUnitType } from "../../types/guards";
import { isTempVariableName } from "../../utils";
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
} from "../utils";
import { generateDeferredDupExpressions } from "./drop-dup";
import { generateExpr } from "./expr";

export function generateAssignment(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Skip compile-time only assignments (e.g., p.* = value where p is a compile-time pointer)
  if (expr.$?.isCompileTimeOnlyAssignment) {
    return "";
  }

  let lhs = expr.args[0]!;
  const rhs = expr.args[1]!;

  let isInitialization = false;
  if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
    isInitialization = true;
    lhs = lhs.args[0]!; // Get the actual variable being assigned
  }

  // Module-level mutable variables are handled in generateMainWrapper.
  // Skip them here to avoid duplicate declarations.
  if (isInitialization && exprIsAtom(lhs) && lhs.$?.env) {
    const varName = lhs.token.value;
    const variables = getVariablesFromEnv(lhs.$.env, varName);
    if (
      variables.length > 0 &&
      variables[variables.length - 1]!.isModuleLevel
    ) {
      return "";
    }
  }

  if (
    exprIsFunctionCall(lhs) &&
    exprIsFunctionCallOf(lhs, BuiltinKeywords.comptime)
  ) {
    // compile-time variable
    return "";
  }

  // Check if LHS is a field/index access into a compile-time variable
  // e.g., p1.x = 5 where p1 is compile-time
  // e.g., arr(0) = 10 where arr is compile-time
  if (lhs.$?.pathCollection && lhs.$?.pathCollection.length > 0) {
    const path = lhs.$.pathCollection[0];
    if (path && path.length >= 2) {
      const baseVariableName = path[0];
      if (typeof baseVariableName === "string" && lhs.$?.env) {
        const variables = getVariablesFromEnv(lhs.$.env, baseVariableName);
        if (
          variables.length > 0 &&
          variables[variables.length - 1]!.isCompileTimeOnly
        ) {
          // Base variable is compile-time, so this assignment should not generate code
          return "";
        }
      }
    }
  }

  // Check if LHS is a simple variable name that refers to a compile-time variable
  if (exprIsAtom(lhs) && lhs.$?.env) {
    const varName = lhs.token.value;
    const variables = getVariablesFromEnv(lhs.$.env, varName);
    if (
      variables.length > 0 &&
      variables[variables.length - 1]!.isCompileTimeOnly
    ) {
      // Compile-time variable - skip code generation
      return "";
    }
  }

  if (!lhs.$?.type) {
    return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
  }
  const lhsCode = generateExpr(lhs, indent, context);

  // Check if we need to save the old value into temp variable
  let skippedTempVar = false;
  if (expr.$?.variableName) {
    const tempVarName = expr.$.variableName;

    // In state machines, temp variables live in the state struct as sm->var_{id} fields.
    // When the LHS is a state machine field (sm->), we cannot declare a local temp var.
    // Instead, we save the old value directly into the state struct field.
    const functionContext = context as FunctionGenerationContext;
    const inStateMachine =
      (functionContext.inAsyncStateMachine ||
        functionContext.inEffectStateMachine) &&
      lhsCode.startsWith("sm->");

    if (inStateMachine) {
      // Look up the temp var in the state machine variables map to get its field name
      let capturedVar = functionContext.stateMachineVariables?.get(tempVarName);
      if (!capturedVar && functionContext.stateMachineVariables) {
        for (const [, cv] of functionContext.stateMachineVariables) {
          if (cv.name === tempVarName) {
            capturedVar = cv;
            break;
          }
        }
      }
      if (capturedVar && capturedVar.kind !== "outer") {
        // Save old value to state machine field before reassignment
        const smFieldName = `var_${capturedVar.id}`;
        if (!isUnitType(lhs.$.type)) {
          context.emitter.emitLine(
            `${indent}sm->${smFieldName} = ${lhsCode}; // Save old value for deferred drop`
          );
        }
      } else {
        // No matching field found — skip (should not happen in practice)
        skippedTempVar = true;
      }
    } else {
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
  }

  // Handle array assignments specially
  if (isArrayType(lhs.$.type)) {
    // Since we use struct wrappers consistently, we can use direct struct assignment
    const rhsCode = generateExpr(rhs, indent, context);

    // Check if RHS is a closure construction
    const rhsIsClosureConstruction =
      exprIsFunctionCall(rhs) &&
      rhs.$?.closureFunctionValue &&
      rhs.$?.type &&
      typeImplementsFn(rhs.$.type);

    // Handle deferred dup expressions for RHS
    const functionContext = context as FunctionGenerationContext;
    let finalRhsCode = rhsCode;
    if (
      !rhsIsClosureConstruction &&
      rhs.$?.deferredDupExpressions &&
      rhs.$.deferredDupExpressions.length > 0
    ) {
      // If RHS has a variable name, we need to declare it first
      if (rhs.$?.variableName && rhs.$?.type) {
        const rhsVarName = getVariableNameForCodegen(
          rhs.$.variableName,
          rhs.$.env
        );
        // Only emit the variable declaration if it's not the same as rhsCode
        if (rhsVarName !== rhsCode.trim()) {
          // Use convertedRuntimeType if available (e.g., comptime_str -> str)
          const effectiveType = rhs.$.convertedRuntimeType || rhs.$.type;
          const rhsTypeStr = getTypeString(effectiveType, context);
          context.emitter.emitLine(
            `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
          );
        }
      }

      generateDeferredDupExpressions(rhs, indent, functionContext);
      // Use the dup result variable instead of the original
      const dupExpr = rhs.$.deferredDupExpressions[0]!;
      if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
        finalRhsCode = getVariableNameForCodegen(
          dupExpr.$.variableName,
          dupExpr.$.env
        );
      }
    }

    if (isInitialization) {
      // For initialization
      const varTypeAndName = getVariableTypeString(
        lhs.$.type,
        generateExpr(lhs, indent, context),
        context
      );
      context.emitter.emitLine(`${indent}${varTypeAndName} = ${finalRhsCode};`);
    } else {
      // For assignment to existing array variable, use direct struct assignment
      context.emitter.emitLine(`${indent}${lhsCode} = ${finalRhsCode};`);
    }
  } else {
    // Non-array assignment - use existing logic
    const rhsCode = generateExpr(rhs, indent, context);

    // Check if RHS is a closure construction
    const rhsIsClosureConstruction =
      exprIsFunctionCall(rhs) &&
      rhs.$?.closureFunctionValue &&
      rhs.$?.type &&
      typeImplementsFn(rhs.$.type);

    // Handle deferred dup expressions for RHS
    const functionContext = context as FunctionGenerationContext;
    let finalRhsCode = rhsCode;
    if (
      !rhsIsClosureConstruction &&
      rhs.$?.deferredDupExpressions &&
      rhs.$.deferredDupExpressions.length > 0
    ) {
      // If RHS has a variable name, we need to declare it first
      if (rhs.$?.variableName && rhs.$?.type) {
        const rhsVarName = getVariableNameForCodegen(
          rhs.$.variableName,
          rhs.$.env
        );
        // Only emit the variable declaration if it's not the same as rhsCode
        if (rhsVarName !== rhsCode.trim()) {
          // Use convertedRuntimeType if available (e.g., comptime_str -> str)
          const effectiveType = rhs.$.convertedRuntimeType || rhs.$.type;
          const rhsTypeStr = getTypeString(effectiveType, context);
          context.emitter.emitLine(
            `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
          );
        }
      }

      generateDeferredDupExpressions(rhs, indent, functionContext);
      // Use the dup result variable instead of the original
      const dupExpr = rhs.$.deferredDupExpressions[0]!;
      if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
        finalRhsCode = getVariableNameForCodegen(
          dupExpr.$.variableName,
          dupExpr.$.env
        );
      }
    }

    // Check if we need to cast closure types
    // const lhsType = lhs.$.type;
    // const rhsType = rhs.$?.type;
    // if (
    //   lhsType &&
    //   rhsType &&
    //   isClosureType(lhsType) &&
    //   isClosureType(rhsType)
    // ) {
    //   // Note: All closure types are now the same (no base vs specific distinction)
    //   // since captureType is no longer part of ClosureType
    //   // No cast needed
    // }

    if (!isUnitType(lhs.$.type)) {
      // For Impl(Future(...)) bindings, use RHS's actual async block type if available
      // This ensures task := run_task(b) uses run_task's state machine type
      const lhsType = lhs.$.type;
      const rhsType = rhs.$?.type;
      let rhsAsyncStructName: string | undefined;

      // Special case: if RHS is a temp variable from a function call returning Future,
      // we should use the temp variable's already-declared type instead of inferring from lhsType
      // Temp variables have the pattern _yoXXXXXXXX_temp_NNNNN
      const rhsIsTempVar = isTempVariableName(
        rhs.$!.env.modulePath,
        finalRhsCode.trim()
      );

      // If RHS is a temp variable, check if it has a stored async struct name
      if (rhsIsTempVar && context.tempVarAsyncStructNames) {
        rhsAsyncStructName = context.tempVarAsyncStructNames.get(
          finalRhsCode.trim()
        );
      }

      const shouldUseFutureType =
        isInitialization &&
        rhsType &&
        typeImplementsFuture(lhsType) &&
        typeImplementsFuture(rhsType);

      let cTypeString: string;
      if (rhsIsTempVar && shouldUseFutureType) {
        if (rhsAsyncStructName) {
          cTypeString = `${rhsAsyncStructName}*`;
        } else {
          cTypeString = getTypeString(rhsType!, context);
        }
      } else if (shouldUseFutureType && rhsAsyncStructName) {
        // Use the async block's struct name directly
        cTypeString = `${rhsAsyncStructName}*`;
      } else {
        cTypeString = getTypeString(
          shouldUseFutureType ? rhsType! : lhsType,
          context
        );
      }

      // In state machines, sm->var_xxx members are already declared in the struct,
      // so skip the type prefix even for initialization assignments
      const isSmVar =
        (functionContext.inAsyncStateMachine ||
          functionContext.inEffectStateMachine) &&
        lhsCode.startsWith("sm->");

      context.emitter.emitLine(
        `${indent}${isInitialization && !isSmVar ? cTypeString + " " : ""}${lhsCode} = ${finalRhsCode};`
      );
    }
  }

  return skippedTempVar ? "" : (expr.$?.variableName ?? "");
}
