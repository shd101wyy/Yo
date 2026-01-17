import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  FuncCallExpr,
} from "../../expr";
import {
  isEnumType,
  isObjectType,
  isPtrType,
  isUnitType,
  Type,
  TypeTag,
} from "../../types";
import { isTempVariableName } from "../../utils";
import { isBooleanValue } from "../../value";
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
import { generateExpr } from "./generation";

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
export function generateCondExpression(
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
    // Strategy:
    // - If all conditions before a compile-time true are compile-time false, just generate the value directly
    // - Otherwise: First condition becomes `if (...) {}`, all subsequent become nested in a single `else { ... }`

    // First pass: check if we can optimize to direct value generation
    let firstNonFalseBranchIndex = -1;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        const condition = arg.args[0];
        if (condition) {
          const isFalse =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false;
          if (!isFalse) {
            firstNonFalseBranchIndex = i;
            break;
          }
        }
      }
    }

    // Check if the first non-false branch is a compile-time true
    let canOptimizeToDirect = false;
    if (firstNonFalseBranchIndex >= 0) {
      const firstArg = expr.args[firstNonFalseBranchIndex];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, "=>", 2)
      ) {
        const firstCondition = firstArg.args[0];
        if (
          firstCondition &&
          isBooleanValue(firstCondition.$?.value) &&
          firstCondition.$.value.value === true
        ) {
          canOptimizeToDirect = true;
        }
      }
    }

    // If we can optimize to direct generation, just generate the value expression
    if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
      const arg = expr.args[firstNonFalseBranchIndex];
      if (
        arg &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, "=>", 2)
      ) {
        const value = arg.args[1];
        if (value) {
          // Generate the value expression directly
          const valueCode = generateExpr(value, indent, context);

          // Check if we need to assign to temp variable
          if (tempVar && !isUnit) {
            if (
              valueCode &&
              valueCode !== "" &&
              !valueCode.startsWith("goto") &&
              valueCode !== "continue" &&
              valueCode !== "break" &&
              !valueCode.includes("return")
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
            // For goto, continue, break, return statements, emit them directly
            else if (
              valueCode &&
              (valueCode.startsWith("goto") ||
                valueCode === "continue" ||
                valueCode === "break" ||
                valueCode.includes("return"))
            ) {
              context.emitter.emitLine(`${indent}${valueCode};`);
            }
          }
        }
      }

      // For unit types, return empty string; for others, return temp variable
      return isUnit ? "" : (tempVar ?? "");
    }

    // Otherwise, generate full if-else chain
    let currentIndent = indent;
    let elseBlockDepth = 0; // Track how many else blocks we need to close at the end
    let hasEmittedBranch = false; // Track whether we've emitted any branch (not skipped)

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          // Skip compile-time false conditions
          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false
          ) {
            continue;
          }

          // For the first EMITTED branch, generate `if (...) {}` or just `{}`
          if (!hasEmittedBranch) {
            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              // Compile-time true as first condition - just use a block
              context.emitter.emitLine(`${currentIndent}{`);
            } else {
              // Regular condition
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
            hasEmittedBranch = true;
          } else {
            // For subsequent conditions, wrap in `else {` and increment depth
            context.emitter.emitLine(`${currentIndent}else {`);
            elseBlockDepth++;
            currentIndent += "  ";

            const isCompileTimeTrue =
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true;

            if (isCompileTimeTrue) {
              // Compile-time true - no condition needed, value goes directly in the else block
              // We'll close the else block at the end, not here
            } else {
              // Regular condition - generate if inside the else block
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
          }

          // Determine the indent for the value block
          const isCompileTimeTrue =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true;

          // For compile-time true in else block (not first branch), don't add extra indentation
          const valueIndent =
            hasEmittedBranch && isCompileTimeTrue
              ? currentIndent
              : currentIndent + "  ";

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // For begin blocks in conditionals, we need to generate the statements inline
            // like generateLoopBody but also capture the final expression result

            const beginArgs = value.args;

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const arg = beginArgs[j]!;
              const argCode = generateExpr(arg, valueIndent, context);
              // Skip temp variable references
              if (
                argCode &&
                arg.$ &&
                !isTempVariableName(arg.$.env.modulePath, argCode)
              ) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;
              // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
              if (finalExpr.$?.deferredDupExpressions) {
                generateDeferredDupExpressions(
                  finalExpr,
                  valueIndent,
                  context as FunctionGenerationContext
                );
              }
              const finalExprCode = generateExpr(
                finalExpr,
                valueIndent,
                context
              );

              if (finalExprCode) {
                // Check if this is a control flow statement
                if (
                  finalExprCode === "continue" ||
                  finalExprCode === "break" ||
                  finalExprCode.startsWith("goto") ||
                  (exprIsFunctionCall(finalExpr) &&
                    exprIsFunctionCallOf(finalExpr, BuiltinKeywords.return)) ||
                  finalExprCode.includes("return")
                ) {
                  // For control flow statements, emit them directly without assignment
                  context.emitter.emitLine(`${valueIndent}${finalExprCode};`);
                } else if (tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${finalExprCode};`
                  );
                }
              }
            }

            // Generate deferred drop expressions for the begin block
            if (value.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(value, valueIndent, context);
            }
          } else {
            // Generate deferred dup expressions for non-begin value expressions
            if (value.$?.deferredDupExpressions) {
              generateDeferredDupExpressions(
                value,
                valueIndent,
                context as FunctionGenerationContext
              );
            }
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, valueIndent, context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              valueCode.startsWith("goto") ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${valueIndent}${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              if (!isUnit) {
                context.emitter.emitLine(
                  `${valueIndent}${tempVar} = ${valueCode};`
                );
              }
            }
          }

          // Close the if/block for this condition
          // For compile-time true in an else block, we don't close anything here (the else block closes at the end)
          // For all other cases, close the if block or the initial block
          const needsClosing = !(hasEmittedBranch && isCompileTimeTrue);
          if (needsClosing) {
            context.emitter.emitLine(`${currentIndent}}`);
          }
        }
      }
    }

    // Close all the else blocks we opened
    for (let i = 0; i < elseBlockDepth; i++) {
      currentIndent = currentIndent.slice(0, -2); // Remove 2 spaces
      context.emitter.emitLine(`${currentIndent}}`);
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
export function generateMatchExpression(
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
  let ptrOrRefType: TypeTag.Ptr | "ref_semantics" | undefined = undefined;

  let enumType: Type;
  if (isPtrType(matchValueType)) {
    enumType = matchValueType.childType;
    ptrOrRefType = matchValueType.tag;
  } else if (isObjectType(matchValueType)) {
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
        const casePattern = caseExpr.args[0]!;
        const caseBody = caseExpr.args[1]!;

        if (exprIsFunctionCall(casePattern)) {
          // Pattern is a variant constructor: .None or .Some(x)
          const variantName = casePattern.func.token.value;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (!variant) {
            continue;
          }

          if (!variant.fields || variant.fields.length === 0) {
            // Null case
            nullCase = { caseBody };
          } else {
            // Pointer case
            pointerCase = { caseBody, variantName, casePattern };
          }
        } else if (exprIsAtom(casePattern) && casePattern.token.value === "_") {
          // Default case - treat as null case if nullCase not set, otherwise pointer case
          if (!nullCase) {
            nullCase = { caseBody };
          } else if (!pointerCase) {
            pointerCase = {
              caseBody,
              variantName:
                enumType.variants.find((v) => v.fields?.length)?.name || "",
              casePattern,
            };
          }
        }
      }
    }

    // Generate the optimized if/else structure
    context.emitter.emitLine(
      `${indent}if (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      // If the pointer case has a variable binding, assign it
      if (
        exprIsFunctionCall(pointerCase.casePattern) &&
        pointerCase.casePattern.args.length > 0
      ) {
        const bindingExpr = pointerCase.casePattern.args[0]!;
        if (exprIsAtom(bindingExpr)) {
          const bindingName = bindingExpr.token.value;
          const bindingType = enumType.variants.find(
            (v) => v.name === pointerCase.variantName
          )?.fields?.[0]?.type;
          if (bindingType) {
            const bindingTypeName = getTypeString(bindingType, context);
            context.emitter.emitLine(
              `${indent}  ${bindingTypeName} ${bindingName} = ${matchedValueCode};`
            );
          }
        }
      }

      const caseBodyCode = generateCaseBody(
        pointerCase.caseBody,
        indent + "  ",
        context
      );
      if (!isUnit && tempVariableName && caseBodyCode) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${caseBodyCode};`
        );
      } else if (caseBodyCode) {
        context.emitter.emitLine(`${indent}  ${caseBodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const caseBodyCode = generateCaseBody(
        nullCase.caseBody,
        indent + "  ",
        context
      );
      if (!isUnit && tempVariableName && caseBodyCode) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${caseBodyCode};`
        );
      } else if (caseBodyCode) {
        context.emitter.emitLine(`${indent}  ${caseBodyCode};`);
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
        const casePattern = caseExpr.args[0]!;
        const caseBody = caseExpr.args[1]!;

        if (exprIsFunctionCall(casePattern)) {
          const variantName = casePattern.func.token.value;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (!variant) {
            continue;
          }

          const caseTag = getEnumVariantCName(enumType, variantName, context);
          context.emitter.emitLine(`${indent}  case ${caseTag}: {`);

          const caseBodyCode = generateCaseBody(
            caseBody,
            indent + "    ",
            context
          );
          if (!isUnit && tempVariableName && caseBodyCode) {
            context.emitter.emitLine(
              `${indent}    ${tempVariableName} = ${caseBodyCode};`
            );
          } else if (caseBodyCode) {
            context.emitter.emitLine(`${indent}    ${caseBodyCode};`);
          }

          // Check if we need to break out of the loop instead of just the switch
          if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
            context.emitter.emitLine(
              `${indent}    goto ${context.currentLoopLabel};`
            );
          } else if (caseBody.$?.controlFlow === "continue") {
            context.emitter.emitLine(`${indent}    break;`);
            if (context.currentContinueLabel) {
              context.emitter.emitLine(
                `${indent}    goto ${context.currentContinueLabel};`
              );
            }
          } else {
            context.emitter.emitLine(`${indent}    break;`);
          }

          context.emitter.emitLine(`${indent}  }`);
        } else if (exprIsAtom(casePattern) && casePattern.token.value === "_") {
          // Default case
          context.emitter.emitLine(`${indent}  default: {`);
          const caseBodyCode = generateCaseBody(
            caseBody,
            indent + "    ",
            context
          );
          if (!isUnit && tempVariableName && caseBodyCode) {
            context.emitter.emitLine(
              `${indent}    ${tempVariableName} = ${caseBodyCode};`
            );
          } else if (caseBodyCode) {
            context.emitter.emitLine(`${indent}    ${caseBodyCode};`);
          }

          // Check if we need to break out of the loop instead of just the switch
          if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
            context.emitter.emitLine(
              `${indent}    goto ${context.currentLoopLabel};`
            );
          } else if (caseBody.$?.controlFlow === "continue") {
            context.emitter.emitLine(`${indent}    break;`);
            if (context.currentContinueLabel) {
              context.emitter.emitLine(
                `${indent}    goto ${context.currentContinueLabel};`
              );
            }
          } else {
            context.emitter.emitLine(`${indent}    break;`);
          }

          context.emitter.emitLine(`${indent}  }`);
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
      const casePattern = caseExpr.args[0]!;
      const caseBody = caseExpr.args[1]!;

      if (exprIsFunctionCall(casePattern)) {
        // Pattern is a variant constructor: .Ok(value) or .Err(err)
        const variantName = casePattern.func.token.value;
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (!variant) {
          continue;
        }

        const caseTag = getEnumVariantCName(enumType, variantName, context);
        context.emitter.emitLine(`${indent}  case ${caseTag}: {`);

        // Handle variable bindings for variant fields
        if (variant.fields && casePattern.args.length > 0) {
          // Generate bindings for each field
          variant.fields.forEach((field, fieldIndex) => {
            const bindingExpr = casePattern.args[fieldIndex];
            if (!bindingExpr || !exprIsAtom(bindingExpr)) {
              return;
            }

            const bindingName = bindingExpr.token.value;
            const bindingType = field.type;
            const bindingTypeName = getTypeString(bindingType, context);
            const fieldAccessCode = `${matchedValueCode}.${ptrOrRefType === "ref_semantics" || ptrOrRefType ? "->" : "."}data.${variantName}.${sanitizeForCIdentifier(field.label)}`;

            context.emitter.emitLine(
              `${indent}    ${bindingTypeName} ${bindingName} = ${fieldAccessCode};`
            );
          });
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (caseBody.$?.controlFlow === "continue") {
          context.emitter.emitLine(`${indent}  break;`);
          if (context.currentContinueLabel) {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentContinueLabel};`
            );
          }
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }

        context.emitter.emitLine(`${indent}  }`);
      } else if (exprIsAtom(casePattern) && casePattern.token.value === "_") {
        // Default case
        context.emitter.emitLine(`${indent}  default: {`);

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (caseBody.$?.controlFlow === "continue") {
          context.emitter.emitLine(`${indent}  break;`);
          if (context.currentContinueLabel) {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentContinueLabel};`
            );
          }
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);

  // Generate deferred drop expressions for the match expression after the switch closes
  // This ensures owned variables (like the matched enum) are cleaned up
  if (expr.$?.deferredDropExpressions) {
    generateDeferredDropExpressions(expr, indent, context);
  }

  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
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

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
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

    // Generate each statement except the last one
    for (let j = 0; j < beginArgs.length - 1; j++) {
      const arg = beginArgs[j]!;
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
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

    // Generate deferred drop expressions for the begin block
    if (bodyExpr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(bodyExpr, indent, context);
    }

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
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
export function generateWhileLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    // We need to re-evaluate the condition on each iteration
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const savedContinueLabel = context.currentContinueLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    const continueLabel = `continue_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;
    context.currentContinueLabel = continueLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}${continueLabel}:;`);
    const stepCode = generateStepExpression(stepExpr, context);
    context.emitter.emitLine(`${indent}  ${stepCode};`);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;
    context.currentContinueLabel = savedContinueLabel;

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}

export function generateDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate C code for all deferred dup expressions.
 * This is used to generate dup calls for expressions that need reference counting.
 * The dup expressions are created during evaluation and deferred to codegen to ensure
 * proper context (e.g., closure captures, state machine variables).
 */
export function generateDeferredDupExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      if (exprIsFunctionCall(dupExpr)) {
        const dupCode = generateExpr(dupExpr, indent, context);
        if (dupCode) {
          emitter.emitLine(`${indent}${dupCode};`);
        }
      }
    }
  }
}
