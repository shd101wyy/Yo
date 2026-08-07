import { getVariablesFromEnv } from "../../env";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  type FnCallExpr,
  hasAnyControlFlow,
} from "../../expr";
import type { Type } from "../../types/definitions";
import {
  isEnumType,
  isReferenceStructType,
  isPtrType,
  isReferenceEnumType,
  isUnitType,
} from "../../types/guards";
import { TypeTag } from "../../types/tags";
import { isBooleanValue, isNumberValue, type Value } from "../../value";
import { type FunctionGenerationContext } from "../functions/context";
import {
  codeContainsReturnStatement,
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  type CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  getVariableNameForCodegen,
  sanitizeForCIdentifier,
} from "../utils";
import {
  generateDeferredDropExpressions,
  generateDeferredDupExpressions,
} from "./drop-dup";
import { generateExpr } from "./expr";
import { getStateMachineFieldName } from "../async/state-machine";

/**
 * Check if a generated code string represents control flow (goto, break, continue, return)
 * that should NOT be assigned to a temp variable.
 */
function isControlFlowCode(code: string): boolean {
  return (
    code === "" ||
    code === "break" ||
    code === "continue" ||
    code.startsWith("goto") ||
    // Word-boundary + string-literal masking: identifiers like `return_flag`
    // (issue: struct-literal-in-match-arm-not-assigned) and the word `return`
    // INSIDE a generated string literal (issue:
    // cond-arm-return-inside-string-literal) are NOT control flow.
    codeContainsReturnStatement(code)
  );
}

/**
 * Generate case body for match/cond expressions, handling begin blocks specially
 * Returns the body code string for assignment to temp variable
 */
function generateCaseBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle begin blocks specially
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    const beginArgs = bodyExpr.args;

    // Update pendingDeferredDrops for this begin block
    // IMPORTANT: Concatenate with previous drops so early returns drop ALL enclosing scope vars
    const functionContext = context as FunctionGenerationContext;
    const previousPendingDeferredDrops = functionContext.pendingDeferredDrops;
    const currentDrops = bodyExpr.$?.deferredDropExpressions ?? [];
    functionContext.pendingDeferredDrops = [
      ...currentDrops,
      ...(previousPendingDeferredDrops ?? []),
    ];
    const previousConsumedVarDrops = functionContext.consumedVarPendingDrops;
    const currentConsumedDrops =
      bodyExpr.$?.consumedVariableDropExpressions ?? [];
    functionContext.consumedVarPendingDrops = [
      ...currentConsumedDrops,
      ...(previousConsumedVarDrops ?? []),
    ];

    // Generate each statement except the last one
    for (let j = 0; j < beginArgs.length - 1; j++) {
      const arg = beginArgs[j]!;
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
      // Stop after control flow (dead code may lack metadata)
      if (hasAnyControlFlow(arg.$?.controlFlow)) {
        break;
      }
    }

    // Get the final expression code for return/assignment
    let finalExprCode = "";
    if (beginArgs.length > 0) {
      const finalExpr = beginArgs[beginArgs.length - 1]!;
      // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
      if (
        finalExpr.$?.deferredDupExpressions &&
        finalExpr.$.deferredDupExpressions.length > 0
      ) {
        // First generate the expression that produces the value to be duped.
        // This is needed because the dup references a temp variable from the
        // expression (e.g., self._scheme produces temp_N = self->_scheme, and
        // the dup is temp_N+1 = dup(temp_N)). Without this, temp_N is never
        // declared. Mirrors the handling in begin.ts.
        if (finalExpr.$?.variableName) {
          const savedVariableName = finalExpr.$.variableName;
          finalExpr.$.variableName = undefined;
          const rawExprCode = generateExpr(finalExpr, indent, context);
          finalExpr.$.variableName = savedVariableName;

          const exprType = getTypeString(finalExpr.$.type!, context);
          const exprTempVar = getVariableNameForCodegen(
            savedVariableName,
            finalExpr.$.env
          );

          if (exprTempVar !== rawExprCode) {
            context.emitter.emitLine(
              `${indent}${exprType} ${exprTempVar} = ${rawExprCode};`
            );
          }
        }

        generateDeferredDupExpressions(
          finalExpr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original expression
        const dupExpr = finalExpr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalExprCode = getVariableNameForCodegen(
            dupExpr.$.variableName,
            dupExpr.$.env
          );
        } else {
          finalExprCode = generateExpr(finalExpr, indent, context);
        }
      } else {
        finalExprCode = generateExpr(finalExpr, indent, context);
      }
    }

    // Generate deferred drop expressions for the begin block — but NOT when the
    // final expression exits via control flow (return/unwind/break/continue).
    // On that path the control-flow exit (e.g. `return`) has already flushed
    // pendingDeferredDrops, which — per the concatenation above (line ~75) —
    // INCLUDES this begin block's drops. Re-emitting them here double-frees: the
    // drops land BEFORE the `return` (finalExprCode is returned, not yet emitted),
    // so they execute, then the return's own flush already dropped the same
    // temps. This is the intermittent SIGTRAP-in-malloc double-free on
    // `match(o, .Some => return(f(x.clone())), …)`. See
    // issues/yo-self-codegen-intermittent-sigtrap.md.
    const beginFinalExpr =
      beginArgs.length > 0 ? beginArgs[beginArgs.length - 1] : undefined;
    const beginFinalExits = beginFinalExpr
      ? hasAnyControlFlow(beginFinalExpr.$?.controlFlow)
      : false;
    if (bodyExpr.$?.deferredDropExpressions && !beginFinalExits) {
      generateDeferredDropExpressions(bodyExpr, indent, context);
    }

    // Restore previous pending deferred drops
    functionContext.pendingDeferredDrops = previousPendingDeferredDrops;
    functionContext.consumedVarPendingDrops = previousConsumedVarDrops;

    return finalExprCode;
  } else {
    // For non-begin expressions, check for deferred dup expressions
    if (bodyExpr.$?.deferredDupExpressions) {
      generateDeferredDupExpressions(
        bodyExpr,
        indent,
        context as FunctionGenerationContext
      );
    }
    return generateExpr(bodyExpr, indent, context);
  }
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
export function generateMatchExpression(
  expr: FnCallExpr,
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
    // Record the C declaration so the drop-emission gate does not skip this
    // (declared) temp's drop as if undeclared (a skipped live-RC drop leaks).
    context.declaredCVarNames?.add(tempVariableName);
  }

  // Generate the matched value
  const subjectExpr = expr.args[0]!;
  let matchedValueCode = generateExpr(subjectExpr, indent, context);
  const matchValueType = subjectExpr.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires a valid type`;
  }

  // If the subject expression has a temp variable name (i.e. the evaluator
  // allocated a temp var for it and registered a deferred drop on that name),
  // we must materialize the temp var here. Otherwise inlining the subject
  // straight into `switch (...)` leaves the deferred drop referring to an
  // undeclared identifier. See issues/inline-enum-match-subject-phantom-drop.md.
  //
  // Skip the temp-var declaration when the subject is a `ref`-param atom:
  // emitting `T name = (*name);` shadows the pointer parameter and causes a
  // C redefinition error. Mirror the same guard used in begin.ts.
  if (subjectExpr.$?.variableName) {
    const subjectVarName = getVariableNameForCodegen(
      subjectExpr.$.variableName,
      subjectExpr.$.env
    );
    let isInoutAtom = false;
    if (exprIsAtom(subjectExpr) && subjectExpr.$?.env) {
      const vars = getVariablesFromEnv(
        subjectExpr.$.env,
        subjectExpr.$.variableName
      );
      if (vars.length > 0 && vars[vars.length - 1]!.isRef) {
        isInoutAtom = true;
      }
    }
    if (!isInoutAtom && matchedValueCode !== subjectVarName) {
      const subjectTypeStr = getTypeString(matchValueType, context);
      context.emitter.emitLine(
        `${indent}${subjectTypeStr} ${subjectVarName} = ${matchedValueCode};`
      );
      matchedValueCode = subjectVarName;
    }
  }

  // Check if this is a primitive type match (integer, bool)
  if (expr.$.isPrimitiveMatch) {
    return generatePrimitiveMatchExpression(
      expr,
      indent,
      context,
      matchedValueCode,
      matchValueType,
      tempVariableName,
      isUnit
    );
  }

  // Check if it's a pointer/reference type OR reference semantics type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.Ptr | "ref_semantics" | undefined = undefined;

  let enumType: Type;
  if (isPtrType(matchValueType)) {
    enumType = matchValueType.childType;
    ptrOrRefType = matchValueType.tag;
  } else if (isReferenceStructType(matchValueType)) {
    enumType = matchValueType;
    ptrOrRefType = "ref_semantics";
  } else if (isReferenceEnumType(matchValueType)) {
    // ref(enum(…)) is a heap pointer in C — access tag/data via `->`.
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
    let pointerCase: {
      caseBody: Expr;
      variantName: string;
      casePattern: Expr;
    } | null = null;

    for (const caseExpr of caseExprs) {
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // Skip non-executed cases (comptime branch elimination)
        if (!caseExpr.args[0]?.$?.caseExecuted) continue;

        const caseValue = caseExpr.args[0]!; // .None, .Some(ptr)
        const caseBody = caseExpr.args[1]!;

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".") // Destructuring pattern like .None
        ) {
          nullCase = { caseBody };
        } else {
          // Destructuring pattern like .Some(value)
          // Handle destructuring pattern
          const variantExpr = (caseValue as FnCallExpr).func;
          // Check if variant is a field access like .Some
          if (
            variantExpr &&
            exprIsFunctionCall(variantExpr) &&
            exprIsFunctionCallOf(variantExpr, ".")
          ) {
            const variantNameExpr = variantExpr.args[0]!;
            if (variantNameExpr && exprIsAtom(variantNameExpr)) {
              const variantName = variantNameExpr.token.value;
              pointerCase = {
                caseBody,
                variantName,
                casePattern: caseValue,
              };
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
      // For nullable pointer optimization with destructuring pattern like .Some(value),
      // we need to bind the destructured variable to the pointer value
      let destructuredVarName: string | undefined;
      if (
        exprIsFunctionCall(pointerCase.casePattern) &&
        pointerCase.casePattern.args.length > 0
      ) {
        // Destructuring pattern: .Some(value)
        const destructuredVar = pointerCase.casePattern.args[0];
        if (destructuredVar && exprIsAtom(destructuredVar)) {
          destructuredVarName = sanitizeForCIdentifier(
            destructuredVar.token.value
          );
          const varType = nullablePointerType;
          // Declare and bind the destructured variable to the pointer
          context.emitter.emitLine(
            `${indent}  ${getTypeString(varType, context)} ${destructuredVarName} = ${matchedValueCode};`
          );
          context.declaredCVarNames?.add(destructuredVarName);
        }
      }

      // Add destructured variable to localShadowedVariables so it uses the local C var
      const functionContext = context as FunctionGenerationContext;
      if (
        destructuredVarName &&
        (functionContext.inAsyncStateMachine ||
          functionContext.inEffectStateMachine)
      ) {
        if (!functionContext.localShadowedVariables) {
          functionContext.localShadowedVariables = new Set();
        }
        functionContext.localShadowedVariables.add(destructuredVarName);
      }

      const bodyCode = generateCaseBody(
        pointerCase.caseBody,
        indent + "  ",
        context
      );

      // Remove destructured variable from localShadowedVariables after generating body
      if (destructuredVarName && functionContext.localShadowedVariables) {
        functionContext.localShadowedVariables.delete(destructuredVarName);
      }

      // Check if body has control flow (goto, return, break, continue) - don't assign temp in that case
      const hasControlFlow = isControlFlowCode(bodyCode);
      if (!isUnit && tempVariableName && !hasControlFlow) {
        // For nullable pointer match, the body returns the actual value
        // If bodyCode is empty or just returns the matched value itself, use the matched value
        const resultCode = bodyCode || matchedValueCode;
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${resultCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateCaseBody(
        nullCase.caseBody,
        indent + "  ",
        context
      );
      // Check if body has control flow (goto, return, break, continue) - don't assign temp in that case
      const hasControlFlow = isControlFlowCode(bodyCode);
      if (!isUnit && tempVariableName && !hasControlFlow) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
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

    // Set insideMatch flag so nested break statements use goto instead of break
    const savedInsideMatch = context.insideMatch;
    context.insideMatch = true;

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // Skip non-executed cases (comptime branch elimination)
        if (!caseExpr.args[0]?.$?.caseExecuted) continue;

        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsAtom(caseValue) &&
          caseValue.token.value === "_"
        ) {
          // Wildcard pattern "_" — generate default case
          context.emitter.emitLine(`${indent}default: {`);

          const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
          if (
            !isUnit &&
            tempVariableName &&
            bodyCode &&
            !isControlFlowCode(bodyCode)
          ) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }

          context.emitter.emitLine(`${indent}  break;`);
          context.emitter.emitLine(`${indent}}`);
        } else if (
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
          context.emitter.emitLine(`${indent}case ${variantTag}: {`);

          // Generate the body of the case
          const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
          if (
            !isUnit &&
            tempVariableName &&
            bodyCode &&
            !isControlFlowCode(bodyCode)
          ) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }

          // Always emit break to exit the switch case
          // (nested break to exit loop is handled by generateAtom with insideMatch flag)
          context.emitter.emitLine(`${indent}  break;`);
          context.emitter.emitLine(`${indent}}`); // close case block scope
        }
      }
    }

    // Restore insideMatch flag
    context.insideMatch = savedInsideMatch;
    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType === "ref_semantics" || ptrOrRefType ? matchedValueCode + "->tag" : "(" + matchedValueCode + ").tag"}) {`
  );

  // Set insideMatch flag so nested break statements use goto instead of break
  const savedInsideMatch = context.insideMatch;
  context.insideMatch = true;

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // Skip non-executed cases (comptime branch elimination)
      if (!caseExpr.args[0]?.$?.caseExecuted) continue;

      // This is a case => value pair
      const caseValue = caseExpr.args[0];
      let caseBody = caseExpr.args[1];

      // Check for wildcard pattern "_" — generate default case
      if (
        caseValue &&
        caseBody &&
        exprIsAtom(caseValue) &&
        caseValue.token.value === "_"
      ) {
        context.emitter.emitLine(`${indent}default: {`);

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (
          !isUnit &&
          tempVariableName &&
          bodyCode &&
          !isControlFlowCode(bodyCode)
        ) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        context.emitter.emitLine(`${indent}  break;`);
        context.emitter.emitLine(`${indent}}`);
      } else if (
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
        context.emitter.emitLine(`${indent}case ${variantTag}: {`);

        // Handle destructuring patterns like .Point(point) => { ... }
        if (caseValue.args.length > 1) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.fields) {
            // Get destructuring params (skip the variant name at index 0)
            const destructuringParams = caseValue.args.slice(1);

            // Check if we have labeled destructuring
            const hasLabeledParams = destructuringParams.some(
              (param) =>
                exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
            );

            if (hasLabeledParams) {
              // Handle labeled destructuring like .Circle(r : radius)
              for (const param of destructuringParams) {
                if (
                  exprIsFunctionCall(param) &&
                  exprIsFunctionCallOf(param, ":", 2)
                ) {
                  const labelExpr = param.args[0]!;
                  const variableExpr = param.args[1]!;

                  if (!exprIsAtom(labelExpr)) {
                    continue;
                  }

                  const label = labelExpr.token.value;

                  // Find the field with matching label
                  const variantElement = variant.fields.find(
                    (f) => f.label === label
                  );
                  if (!variantElement) {
                    continue;
                  }

                  // Skip unit type fields - they don't exist in the generated struct
                  if (isUnitType(variantElement.type)) {
                    continue;
                  }

                  // Handle the variable part (could be identifier or _)
                  if (exprIsAtom(variableExpr)) {
                    const rawVarName = variableExpr.token.value;

                    // Skip if variable name is "_" (ignore pattern)
                    if (rawVarName !== "_") {
                      const varName = sanitizeForCIdentifier(rawVarName);
                      const fieldName = sanitizeForCIdentifier(label);
                      const fieldType = getTypeString(
                        variantElement.type,
                        context
                      );

                      // Generate variable declaration and assignment
                      const accessPrefix =
                        ptrOrRefType === "ref_semantics" || ptrOrRefType
                          ? "->"
                          : ".";
                      context.emitter.emitLine(
                        `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                      );

                      // Check if this variable needs to be stored in the state machine
                      const functionContext =
                        context as FunctionGenerationContext;
                      if (
                        (functionContext?.inAsyncStateMachine ||
                          functionContext?.inEffectStateMachine) &&
                        functionContext.stateMachineVariables
                      ) {
                        let varId: string | undefined;

                        if (variableExpr.$?.env) {
                          const vars = getVariablesFromEnv(
                            variableExpr.$.env,
                            rawVarName
                          );
                          if (vars.length > 0) {
                            varId = vars[vars.length - 1]!.id;
                          }
                        }

                        if (
                          varId &&
                          functionContext.stateMachineVariables.has(varId)
                        ) {
                          const smField = getStateMachineFieldName(
                            varId,
                            "local",
                            functionContext.stateMachineFieldAliases
                          );
                          context.emitter.emitLine(
                            `${indent}  sm->${smField} = ${varName};`
                          );
                        }
                      }
                    }
                  }
                }
              }
            } else {
              // Handle positional destructuring
              // Generate local variable declarations for destructured fields
              for (
                let fieldIndex = 0;
                fieldIndex < destructuringParams.length &&
                fieldIndex < variant.fields.length;
                fieldIndex++
              ) {
                const destructuredVar = destructuringParams[fieldIndex]!;
                const variantElement = variant.fields[fieldIndex];

                if (exprIsAtom(destructuredVar) && variantElement) {
                  // Skip unit type fields - they don't exist in the generated struct
                  if (isUnitType(variantElement.type)) {
                    continue;
                  }

                  const rawVarName = destructuredVar.token.value;

                  // Skip if variable name is "_" (ignore pattern)
                  if (rawVarName !== "_") {
                    const varName = sanitizeForCIdentifier(rawVarName);
                    const fieldName = sanitizeForCIdentifier(
                      variantElement.label
                    );
                    const fieldType = getTypeString(
                      variantElement.type,
                      context
                    );

                    // Generate variable declaration and assignment
                    const accessPrefix =
                      ptrOrRefType === "ref_semantics" || ptrOrRefType
                        ? "->"
                        : ".";
                    context.emitter.emitLine(
                      `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                    );
                    // Check if this variable needs to be stored in the state machine
                    // For async contexts, pattern-matched variables that are used across await points
                    // need to be stored in the state machine structure
                    const functionContext =
                      context as FunctionGenerationContext;
                    if (
                      (functionContext?.inAsyncStateMachine ||
                        functionContext?.inEffectStateMachine) &&
                      functionContext.stateMachineVariables
                    ) {
                      // Find the variable ID by searching through state machine variables
                      // The state machine tracks variables by their ID
                      let varId: string | undefined;

                      // Try to get ID from expr metadata if available
                      // if (destructuredVar.$?.id) {
                      //   varId = destructuredVar.$.id;
                      // } else
                      if (destructuredVar.$?.env) {
                        // Try to look up in environment
                        const vars = getVariablesFromEnv(
                          destructuredVar.$.env,
                          rawVarName
                        );
                        if (vars.length > 0) {
                          varId = vars[vars.length - 1]!.id;
                        }
                      }

                      if (
                        varId &&
                        functionContext.stateMachineVariables.has(varId)
                      ) {
                        // This variable crosses an await boundary, store it in state machine
                        context.emitter.emitLine(
                          `${indent}  sm->${getStateMachineFieldName(varId, "local", functionContext.stateMachineFieldAliases)} = ${varName};`
                        );
                      }
                    }
                  }
                }
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
            `${indent}  ${getTypeString(matchValueType, context)} ${sanitizeForCIdentifier(renameExpr.token.value)} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (
          !isUnit &&
          tempVariableName &&
          bodyCode &&
          !isControlFlowCode(bodyCode)
        ) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Always emit break to exit the switch case
        // (nested break to exit loop is handled by generateAtom with insideMatch flag)
        context.emitter.emitLine(`${indent}  break;`);
        context.emitter.emitLine(`${indent}}`); // close case block scope
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
        context.emitter.emitLine(`${indent}case ${variantTag}: {`);

        // Generate local variable declarations for destructured fields
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant && variant.fields && destructuringParams.length > 0) {
          // Check if we have labeled destructuring
          const hasLabeledParams = destructuringParams.some(
            (param) =>
              exprIsFunctionCall(param) && exprIsFunctionCallOf(param, ":", 2)
          );

          if (hasLabeledParams) {
            // Handle labeled destructuring like .Circle(r : radius)
            for (const param of destructuringParams) {
              if (
                exprIsFunctionCall(param) &&
                exprIsFunctionCallOf(param, ":", 2)
              ) {
                const labelExpr = param.args[0]!;
                const variableExpr = param.args[1]!;

                if (!exprIsAtom(labelExpr)) {
                  continue;
                }

                const label = labelExpr.token.value;

                // Find the field with matching label
                const variantElement = variant.fields.find(
                  (f) => f.label === label
                );
                if (!variantElement) {
                  continue;
                }

                // Handle the variable part (could be identifier or _)
                if (exprIsAtom(variableExpr)) {
                  const rawVarName = variableExpr.token.value;

                  // Skip if variable name is "_" (ignore pattern)
                  if (rawVarName !== "_") {
                    const varName = sanitizeForCIdentifier(rawVarName);
                    if (isUnitType(variantElement.type)) {
                      context.emitter.emitLine(
                        `${indent}  // ${varName} is unit type (no value)`
                      );
                    } else {
                      const fieldName = sanitizeForCIdentifier(label);
                      const fieldType = getTypeString(
                        variantElement.type,
                        context
                      );

                      // Generate variable declaration and assignment
                      const accessPrefix =
                        ptrOrRefType === "ref_semantics" || ptrOrRefType
                          ? "->"
                          : ".";
                      context.emitter.emitLine(
                        `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                      );

                      // Check if this variable needs to be stored in the state machine
                      const functionContext =
                        context as FunctionGenerationContext;
                      if (
                        (functionContext?.inAsyncStateMachine ||
                          functionContext?.inEffectStateMachine) &&
                        functionContext.stateMachineVariables
                      ) {
                        let varId: string | undefined;

                        if (variableExpr.$?.env) {
                          const vars = getVariablesFromEnv(
                            variableExpr.$.env,
                            varName
                          );
                          if (vars.length > 0) {
                            varId = vars[vars.length - 1]!.id;
                          }
                        }

                        if (
                          varId &&
                          functionContext.stateMachineVariables.has(varId)
                        ) {
                          context.emitter.emitLine(
                            `${indent}  sm->${getStateMachineFieldName(varId, "local", functionContext.stateMachineFieldAliases)} = ${varName};`
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } else {
            // Handle positional destructuring like .Circle(radius)
            for (
              let fieldIndex = 0;
              fieldIndex <
              Math.min(destructuringParams.length, variant.fields.length);
              fieldIndex++
            ) {
              const destructuredVar = destructuringParams[fieldIndex]!;
              const variantElement = variant.fields[fieldIndex];

              if (destructuredVar.tag === ExprTag.Atom && variantElement) {
                const rawVarName = destructuredVar.token.value;

                // Skip if variable name is "_" (ignore pattern)
                if (rawVarName !== "_") {
                  const varName = sanitizeForCIdentifier(rawVarName);
                  // For unit type fields, generate a comment instead of a variable
                  // This allows the variable name to be "declared" without generating invalid C
                  if (isUnitType(variantElement.type)) {
                    context.emitter.emitLine(
                      `${indent}  // ${varName} is unit type (no value)`
                    );
                    // Register this as a unit variable so expression generation can handle it
                    // (Expression generation should skip generating references to unit variables)
                  } else {
                    const fieldName = sanitizeForCIdentifier(
                      variantElement.label
                    );
                    const fieldType = getTypeString(
                      variantElement.type,
                      context
                    );

                    // Generate variable declaration and assignment
                    const accessPrefix =
                      ptrOrRefType === "ref_semantics" || ptrOrRefType
                        ? "->"
                        : ".";
                    context.emitter.emitLine(
                      `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                    );

                    // Check if this variable needs to be stored in the state machine
                    const functionContext =
                      context as FunctionGenerationContext;
                    if (
                      (functionContext?.inAsyncStateMachine ||
                        functionContext?.inEffectStateMachine) &&
                      functionContext.stateMachineVariables
                    ) {
                      let varId: string | undefined;

                      // if (destructuredVar.$?.id) {
                      //   varId = destructuredVar.$.id;
                      // } else
                      if (destructuredVar.$?.env) {
                        const vars = getVariablesFromEnv(
                          destructuredVar.$.env,
                          rawVarName
                        );
                        if (vars.length > 0) {
                          varId = vars[vars.length - 1]!.id;
                        }
                      }

                      if (
                        varId &&
                        functionContext.stateMachineVariables.has(varId)
                      ) {
                        // This variable crosses an await boundary, store it in state machine
                        context.emitter.emitLine(
                          `${indent}  sm->${getStateMachineFieldName(varId, "local", functionContext.stateMachineFieldAliases)} = ${varName};`
                        );
                      }
                    }
                  }
                }
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
            `${indent}  ${getTypeString(matchValueType, context)} ${sanitizeForCIdentifier(renameExpr.token.value)} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (
          !isUnit &&
          tempVariableName &&
          bodyCode &&
          !isControlFlowCode(bodyCode)
        ) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Always emit break to exit the switch case
        // (nested break to exit loop is handled by generateAtom with insideMatch flag)
        context.emitter.emitLine(`${indent}  break;`);
        context.emitter.emitLine(`${indent}}`); // close case block scope
      }
    }
  }

  // Restore insideMatch flag
  context.insideMatch = savedInsideMatch;
  context.emitter.emitLine(`${indent}}`);

  // Generate deferred drop expressions for the match expression after the switch closes
  // This ensures owned variables (like the matched enum) are cleaned up
  if (expr.$?.deferredDropExpressions) {
    generateDeferredDropExpressions(expr, indent, context);
  }

  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
}

/**
 * Helper function to check if an expression is an or-pattern (using `|`)
 */
function isOrPattern(expr: Expr): boolean {
  if (!exprIsFunctionCall(expr)) return false;
  return exprIsFunctionCallOf(expr, "|", 2);
}

/**
 * Helper function to flatten an or-pattern into a list of individual patterns
 */
function flattenOrPattern(expr: Expr): Expr[] {
  if (!isOrPattern(expr)) {
    return [expr];
  }
  const fnCall = expr as FnCallExpr;
  const left = fnCall.args[0]!;
  const right = fnCall.args[1]!;
  return [...flattenOrPattern(left), ...flattenOrPattern(right)];
}

/**
 * Get a C literal value from a compile-time value
 */
function getCLiteralFromValue(value: Value | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (isNumberValue(value)) {
    return String(value.value);
  }
  if (isBooleanValue(value)) {
    return value.value ? "true" : "false";
  }
  return undefined;
}

/**
 * Generate a match expression for primitive types (integer, bool)
 * Uses C switch statement for efficient matching
 */
function generatePrimitiveMatchExpression(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext,
  matchedValueCode: string,
  matchValueType: Type,
  tempVariableName: string | undefined,
  isUnit: boolean
): string {
  // Set insideMatch flag so nested break statements use goto instead of break
  const savedInsideMatch = context.insideMatch;
  context.insideMatch = true;

  // Generate the switch statement
  context.emitter.emitLine(`${indent}switch (${matchedValueCode}) {`);

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // Skip non-executed cases (comptime branch elimination)
      if (!caseExpr.args[0]?.$?.caseExecuted) continue;

      const caseValue = caseExpr.args[0];
      const caseBody = caseExpr.args[1];

      if (!caseValue || !caseBody) continue;

      // Check for wildcard pattern "_"
      if (exprIsAtom(caseValue) && caseValue.token.value === "_") {
        // Generate default case
        context.emitter.emitLine(`${indent}default: {`);

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (
          !isUnit &&
          tempVariableName &&
          bodyCode &&
          !isControlFlowCode(bodyCode)
        ) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        context.emitter.emitLine(`${indent}  break;`);
        context.emitter.emitLine(`${indent}}`); // close case block scope
        continue;
      }

      // Get the pattern values from the or-pattern (or single pattern)
      const flattenedPatterns = flattenOrPattern(caseValue);

      // For or-patterns like (1 | 2 | 3), we use the primitivePatternValues from evaluator
      // if available, otherwise fall back to generating from the expressions
      const patternValues = caseValue.$?.primitivePatternValues;

      if (patternValues && patternValues.length > 0) {
        // Generate case labels for each pattern value
        for (const value of patternValues) {
          const cLiteral = getCLiteralFromValue(value);
          if (cLiteral !== undefined) {
            context.emitter.emitLine(`${indent}case ${cLiteral}:`);
          }
        }
      } else {
        // Fallback: try to get values from the flattened pattern expressions
        for (const patternExpr of flattenedPatterns) {
          const patternValue = patternExpr.$?.value;
          const cLiteral = getCLiteralFromValue(patternValue);
          if (cLiteral !== undefined) {
            context.emitter.emitLine(`${indent}case ${cLiteral}:`);
          }
        }
      }

      // Open block scope for the case body
      context.emitter.emitLine(`${indent}{`);

      // Generate the body of the case (only once for all the case labels)
      const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
      if (
        !isUnit &&
        tempVariableName &&
        bodyCode &&
        !isControlFlowCode(bodyCode)
      ) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else if (bodyCode) {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }

      context.emitter.emitLine(`${indent}  break;`);
      context.emitter.emitLine(`${indent}}`); // close case block scope
    }
  }

  // Restore insideMatch flag
  context.insideMatch = savedInsideMatch;
  context.emitter.emitLine(`${indent}}`);

  // Generate deferred drop expressions
  if (expr.$?.deferredDropExpressions) {
    generateDeferredDropExpressions(expr, indent, context);
  }

  return isUnit ? "" : (tempVariableName ?? "");
}
