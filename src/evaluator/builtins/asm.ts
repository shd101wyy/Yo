import {
  type Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { formatErrorMessage } from "../../error";
import {
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { createTupleType } from "../../types/creators";
import type { Type, TypeField } from "../../types/definitions";
import {
  isBooleanType,
  isComptimeStringType,
  isFloatType,
  isIntegerType,
  isPtrType,
} from "../../types/guards";
import { VUnit } from "../../unit-value";
import {
  isComptimeStringValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";

// Register class names recognized in asm operands
const REGISTER_CLASSES = new Set([
  "reg",
  "reg_byte",
  "reg_abcd",
  "xmm_reg",
  "ymm_reg",
  "imm",
  "mem",
]);

/** Operand direction kinds recognized as sub-calls in asm(). */
const INPUT_OPERAND_KINDS = new Set(["in"]);
const OUTPUT_OPERAND_KINDS = new Set(["out", "lateout"]);
// `ref` is an alias for `inout`, kept around because the inout→ref rename
// (commit 746b4f60) updated the asm test sources but didn't update this
// recognition set. Either spelling is accepted by the operand parser.
const INOUT_OPERAND_KINDS = new Set(["inout", "inlateout", "ref"]);
// clobber/clobber_abi/asm_options are handled separately (not as operands)
const SPECIAL_OPERAND_KINDS = new Set(["const_val", "sym"]);

/** All operand/option call names recognized inside asm(). */
const ALL_ASM_SUBCALL_NAMES = new Set([
  ...INPUT_OPERAND_KINDS,
  ...OUTPUT_OPERAND_KINDS,
  ...INOUT_OPERAND_KINDS,
  ...SPECIAL_OPERAND_KINDS,
  "clobber",
  "clobber_abi",
  "asm_options",
]);

/** asm_options flag names */
const ASM_OPTION_FLAGS = new Set([
  "pure",
  "nomem",
  "readonly",
  "nostack",
  "preserves_flags",
  "att_syntax",
  "intel_syntax",
  "volatile",
  "noreturn",
]);

interface AsmOperand {
  kind: "in" | "out" | "inout" | "lateout" | "inlateout" | "const_val" | "sym";
  name: string | undefined;
  constraint: string | undefined;
  /** For in/inout/inlateout: the evaluated input expression */
  valueExpr: Expr | undefined;
  /** For out/lateout: the output type (return-value mode) */
  outputType: Type | undefined;
  /** For out/lateout: the target variable name (variable-target mode) */
  targetVarName: string | undefined;
  /** Whether this output is discarded (_) */
  discarded: boolean;
}

interface AsmOptions {
  noreturn: boolean;
}

/** Check whether a Yo type is valid for asm operands. */
function isValidAsmOperandType(type: Type): boolean {
  return (
    isIntegerType(type) ||
    isFloatType(type) ||
    isPtrType(type) ||
    isBooleanType(type)
  );
}

/**
 * Check whether an atom expression is a register class name (like `reg`, `imm`, `mem`).
 */
function isRegisterClassAtom(expr: Expr): boolean {
  return expr.tag === "Atom" && REGISTER_CLASSES.has(expr.token.value);
}

/**
 * Check whether an expression is a known asm sub-call (out, in, clobber, etc.).
 * This is used to stop template parsing before evaluating operand expressions.
 */
function isAsmSubcall(expr: Expr): boolean {
  if (!exprIsFunctionCall(expr)) return false;
  if (expr.func.tag !== "Atom") return false;
  return ALL_ASM_SUBCALL_NAMES.has(expr.func.token.value);
}

/**
 * Check whether an operand arg is a discard `_`.
 */
function isDiscardAtom(expr: Expr): boolean {
  return expr.tag === "Atom" && expr.token.value === "_";
}

/**
 * Evaluate a constraint argument. Can be:
 * - A register class atom (reg, imm, mem, etc.)
 * - A string literal for explicit register name ("rax", "eax", etc.)
 * - raw("constraint") for raw GCC constraint strings
 */
function evaluateConstraint(
  constraintExpr: Expr,
  env: Environment,
  context: EvaluatorContext
): string {
  // Register class atom (reg, imm, mem, etc.)
  if (
    constraintExpr.tag === "Atom" &&
    REGISTER_CLASSES.has(constraintExpr.token.value)
  ) {
    return constraintExpr.token.value;
  }

  // Evaluate the expression — might be a string literal for explicit register or raw()
  const evaluated = evaluateExpression({
    expr: constraintExpr,
    env,
    context: { ...context },
  });
  if (evaluated.$?.value && isComptimeStringValue(evaluated.$.value)) {
    return evaluated.$.value.value;
  }

  // raw("constraint") call
  if (exprIsFunctionCallOf(constraintExpr, "raw", 1)) {
    const fnCallExpr = constraintExpr as FnCallExpr;
    const rawArg = fnCallExpr.args[0]!;
    const evalRaw = evaluateExpression({
      expr: rawArg,
      env,
      context: { ...context },
    });
    if (evalRaw.$?.value && isComptimeStringValue(evalRaw.$.value)) {
      return `raw:${evalRaw.$.value.value}`;
    }
  }

  throw formatErrorMessage({
    token: constraintExpr.token,
    errorMessage: `Invalid asm constraint. Expected a register class (reg, imm, mem, ...), an explicit register name string, or raw("constraint").`,
  });
}

/**
 * Parse a single operand sub-call like in("name", reg, expr) or out(reg, u32).
 * The arguments within the operand call can be:
 *   - (name?, constraint, value_or_type) for named
 *   - (constraint, value_or_type) for positional
 * For const_val/sym:
 *   - (name?, value) or (value)
 */
function parseOperand(
  operandExpr: FnCallExpr,
  env: Environment,
  context: EvaluatorContext,
  kind: string
): AsmOperand {
  // Normalize the `ref` alias to `inout` so the downstream codegen
  // (which switches on `op.kind === "inout"` / "inlateout") sees the
  // canonical kind string. The rename in commit 746b4f60 surfaced
  // `ref` in user-facing positions but kept the internal enum tag as
  // "inout".
  if (kind === "ref") {
    kind = "inout";
  }
  const args = operandExpr.args;

  if (kind === "const_val" || kind === "sym") {
    return parseSpecialOperand(operandExpr, env, context, kind);
  }

  if (args.length < 1 || args.length > 3) {
    throw formatErrorMessage({
      token: operandExpr.token,
      errorMessage: `asm ${kind}() expects 1 to 3 arguments, got ${args.length}.`,
    });
  }

  let name: string | undefined;
  let constraintIdx: number;

  // Detect if first arg is a name (comptime_str that is NOT a register class)
  if (args.length >= 2) {
    const firstArg = args[0]!;
    // If it's a register class atom, skip name detection
    if (isRegisterClassAtom(firstArg)) {
      constraintIdx = 0;
    } else if (isDiscardAtom(firstArg)) {
      constraintIdx = 0;
    } else {
      // Try evaluating — might be a string literal (name or explicit register)
      const firstEval = evaluateExpression({
        expr: firstArg,
        env,
        context: { ...context },
      });
      if (firstEval.$?.value && isComptimeStringValue(firstEval.$.value)) {
        name = firstEval.$.value.value;
        constraintIdx = 1;
      } else {
        constraintIdx = 0;
      }
    }
  } else {
    constraintIdx = 0;
  }

  // For explicit register names (like "rax"), there's no separate constraint arg —
  // the name IS the constraint and the next arg is the value/type
  const hasConstraint = constraintIdx < args.length - 1;

  let constraint: string | undefined;
  let valueTypeIdx: number;

  if (hasConstraint) {
    constraint = evaluateConstraint(args[constraintIdx]!, env, context);
    valueTypeIdx = constraintIdx + 1;
  } else {
    // When used as in("rax", value) — the name IS the explicit register constraint
    if (name !== undefined) {
      constraint = name;
      // name stays as the operand name for template references
    }
    valueTypeIdx = constraintIdx;
  }

  const valueOrTypeExpr = args[valueTypeIdx];
  if (!valueOrTypeExpr) {
    throw formatErrorMessage({
      token: operandExpr.token,
      errorMessage: `asm ${kind}() is missing its value/type argument.`,
    });
  }

  // Determine if this is an input, output, or inout operand
  const isInputKind = INPUT_OPERAND_KINDS.has(kind);
  const isOutputKind = OUTPUT_OPERAND_KINDS.has(kind);

  // For output-only operands (out, lateout), the last arg can be:
  // 1. A type (return-value mode) — e.g., out(reg, u32)
  // 2. A variable (variable-target mode) — e.g., out(reg, x)
  // 3. _ (discard) — e.g., out(reg, _)
  if (isOutputKind) {
    if (isDiscardAtom(valueOrTypeExpr)) {
      return {
        kind: kind as AsmOperand["kind"],
        name,
        constraint,
        valueExpr: undefined,
        outputType: undefined,
        targetVarName: undefined,
        discarded: true,
      };
    }

    // For variable-target mode, the variable might be uninitialized.
    // Look up the variable directly to avoid "not initialized" errors.
    // Skip variables that hold type values (e.g., i32, u32) — those are return-value mode.
    if (valueOrTypeExpr.tag === "Atom") {
      const varName = valueOrTypeExpr.token.value;
      const variables = getVariablesFromEnv(env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        // If the variable holds a type value, it's return-value mode (e.g., out(reg, i32))
        if (variable.value && isTypeValue(variable.value[0])) {
          // Fall through to evaluation path below
        } else {
          const varType = variable.type;
          if (!isValidAsmOperandType(varType)) {
            throw formatErrorMessage({
              token: valueOrTypeExpr.token,
              errorMessage: `asm ${kind}() target variable '${varName}' has type that is not valid for inline assembly. Must be a primitive numeric, pointer, or bool type.`,
            });
          }
          // Evaluate the expression to annotate it for codegen.
          // If the variable is uninitialized, manually annotate instead of calling evaluateExpression.
          let evaluated: Expr;
          if (variable.initializedAtToken) {
            evaluated = evaluateExpression({
              expr: valueOrTypeExpr,
              env,
              context: { ...context },
            });
          } else {
            // Uninitialized variable — annotate manually so codegen can reference it
            evaluated = valueOrTypeExpr;
            evaluated.$ = {
              env,
              type: varType,
              value: undefined,
              pathCollection: [],
            };
          }
          return {
            kind: kind as AsmOperand["kind"],
            name,
            constraint,
            valueExpr: evaluated,
            outputType: varType,
            targetVarName: varName,
            discarded: false,
          };
        }
      }
      // Not a variable or is a type variable — fall through to evaluate as type expression
    }

    const evaluated = evaluateExpression({
      expr: valueOrTypeExpr,
      env,
      context: { ...context },
    });

    if (evaluated.$?.value && isTypeValue(evaluated.$.value)) {
      // Return-value mode: output type
      const outputType = evaluated.$.value.value;
      if (!isValidAsmOperandType(outputType)) {
        throw formatErrorMessage({
          token: valueOrTypeExpr.token,
          errorMessage: `asm ${kind}() output type must be a primitive numeric, pointer, or bool type.`,
        });
      }
      return {
        kind: kind as AsmOperand["kind"],
        name,
        constraint,
        valueExpr: undefined,
        outputType,
        targetVarName: undefined,
        discarded: false,
      };
    }

    throw formatErrorMessage({
      token: valueOrTypeExpr.token,
      errorMessage: `asm ${kind}() last argument must be a type, variable, or _ (discard).`,
    });
  }

  // For input and inout operands, evaluate the value expression
  const evaluated = evaluateExpression({
    expr: valueOrTypeExpr,
    env,
    context: { ...context },
  });

  if (!evaluated.$) {
    throw formatErrorMessage({
      token: valueOrTypeExpr.token,
      errorMessage: `Failed to evaluate asm ${kind}() value expression.`,
    });
  }

  const valueType = evaluated.$.type;
  if (!isValidAsmOperandType(valueType)) {
    throw formatErrorMessage({
      token: valueOrTypeExpr.token,
      errorMessage: `asm ${kind}() value type is not valid for inline assembly. Must be a primitive numeric, pointer, or bool type.`,
    });
  }

  if (isInputKind) {
    return {
      kind: kind as AsmOperand["kind"],
      name,
      constraint,
      valueExpr: evaluated,
      outputType: undefined,
      targetVarName: undefined,
      discarded: false,
    };
  }

  // inout / inlateout: value is both input and output
  return {
    kind: kind as AsmOperand["kind"],
    name,
    constraint,
    valueExpr: evaluated,
    outputType: valueType,
    targetVarName: undefined,
    discarded: false,
  };
}

function parseSpecialOperand(
  operandExpr: FnCallExpr,
  env: Environment,
  context: EvaluatorContext,
  kind: string
): AsmOperand {
  const args = operandExpr.args;
  if (args.length < 1 || args.length > 2) {
    throw formatErrorMessage({
      token: operandExpr.token,
      errorMessage: `asm ${kind}() expects 1 or 2 arguments, got ${args.length}.`,
    });
  }

  let name: string | undefined;
  let valueIdx = 0;

  // Check if first arg is a name
  if (args.length === 2) {
    const firstEval = evaluateExpression({
      expr: args[0]!,
      env,
      context: { ...context },
    });
    if (firstEval.$?.value && isComptimeStringValue(firstEval.$.value)) {
      name = firstEval.$.value.value;
      valueIdx = 1;
    }
  }

  const valueExpr = args[valueIdx]!;
  const evaluated = evaluateExpression({
    expr: valueExpr,
    env,
    context: { ...context },
  });

  return {
    kind: kind as AsmOperand["kind"],
    name,
    constraint: undefined,
    valueExpr: evaluated,
    outputType: undefined,
    targetVarName: undefined,
    discarded: false,
  };
}

function parseAsmOptions(
  optionExpr: FnCallExpr,
  _env: Environment,
  _context: EvaluatorContext
): AsmOptions {
  const options: AsmOptions = { noreturn: false };

  for (const arg of optionExpr.args) {
    if (arg.tag === "Atom") {
      const flag = arg.token.value;
      if (!ASM_OPTION_FLAGS.has(flag)) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Unknown asm_options flag: '${flag}'. Valid flags: ${[...ASM_OPTION_FLAGS].join(", ")}.`,
        });
      }
      if (flag === "noreturn") {
        options.noreturn = true;
      }
    } else {
      throw formatErrorMessage({
        token: optionExpr.token,
        errorMessage: `asm_options() arguments must be flag identifiers (e.g., pure, nomem, noreturn).`,
      });
    }
  }

  return options;
}

export function evaluateAsm({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Phase C privilege gate: asm is unsafe-by-construction and requires
  // `pragma(Pragma.AllowUnsafe);` at the top of the file. See
  // plans/MEMORY_SAFETY.md.
  if (!isImplicitlyUnsafeCapableFile(expr.token.modulePath)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'asm(...)' is not available in safe code.

Inline assembly can corrupt memory, violate calling conventions, and
break the type system. To use it, declare at the top of this file:

    pragma(Pragma.AllowUnsafe);`,
    });
  }
  // asm can only be called inside a function body or test block
  if (
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "function-body" &&
    context.isEvaluatingFunctionBodyOrAsyncBlock?.kind !== "test-block"
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `asm() can only be called inside a function body or test block.`,
    });
  }

  // Block CTFE — asm cannot be compile-time evaluated
  if (context.isAnalyzingCtfeCapability) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Cannot use "asm" during compile-time function evaluation analysis.`,
    });
  }

  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `asm() requires at least one argument (the assembly template string).`,
    });
  }

  // --- Parse template strings ---
  // Collect leading comptime_str args as the template (multi-string support)
  const templateParts: string[] = [];
  let argIdx = 0;

  while (argIdx < expr.args.length) {
    const arg = expr.args[argIdx]!;

    // Stop before operand sub-calls — do NOT evaluate them as expressions
    if (isAsmSubcall(arg)) break;

    const evaluated = evaluateExpression({
      expr: arg,
      env,
      context: { ...context },
    });

    if (evaluated.$?.value && isComptimeStringValue(evaluated.$.value)) {
      templateParts.push(evaluated.$.value.value);
      argIdx++;
    } else if (
      evaluated.$?.value &&
      isUnknownValue(evaluated.$.value) &&
      isComptimeStringType(evaluated.$.value.type)
    ) {
      // comptime_str but unknown value — still valid as template
      templateParts.push(""); // placeholder
      argIdx++;
    } else {
      break;
    }
  }

  if (templateParts.length === 0) {
    throw formatErrorMessage({
      token: expr.args[0]!.token,
      errorMessage: `First argument to asm() must be a compile-time string (the assembly template).`,
    });
  }

  // --- Parse operands and options ---
  const operands: AsmOperand[] = [];
  let options: AsmOptions = { noreturn: false };

  while (argIdx < expr.args.length) {
    const arg = expr.args[argIdx]!;

    if (!exprIsFunctionCall(arg)) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `asm() arguments after the template must be operand or option calls (in, out, inout, clobber, asm_options, etc.).`,
      });
    }

    const callName = arg.func.tag === "Atom" ? arg.func.token.value : undefined;

    if (!callName) {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `asm() operand must be a named call like in(...), out(...), etc.`,
      });
    }

    if (
      INPUT_OPERAND_KINDS.has(callName) ||
      OUTPUT_OPERAND_KINDS.has(callName) ||
      INOUT_OPERAND_KINDS.has(callName) ||
      SPECIAL_OPERAND_KINDS.has(callName)
    ) {
      operands.push(parseOperand(arg, env, context, callName));
    } else if (callName === "clobber" || callName === "clobber_abi") {
      // Clobbers are stored directly on the expr for codegen — validate args
      for (const clobberArg of arg.args) {
        // Allow bare atoms for common clobbers: memory, cc
        if (
          clobberArg.tag === "Atom" &&
          (clobberArg.token.value === "memory" ||
            clobberArg.token.value === "cc")
        ) {
          continue;
        }
        const evalClobber = evaluateExpression({
          expr: clobberArg,
          env,
          context: { ...context },
        });
        if (
          !evalClobber.$?.value ||
          !isComptimeStringValue(evalClobber.$.value)
        ) {
          if (
            !(
              clobberArg.tag === "Atom" && clobberArg.token.value === "memory"
            ) &&
            !(clobberArg.tag === "Atom" && clobberArg.token.value === "cc")
          ) {
            throw formatErrorMessage({
              token: clobberArg.token,
              errorMessage: `${callName}() arguments must be compile-time strings (e.g., "memory", "cc", "rax").`,
            });
          }
        }
      }
    } else if (callName === "asm_options") {
      options = parseAsmOptions(arg, env, context);
    } else {
      throw formatErrorMessage({
        token: arg.token,
        errorMessage: `Unknown asm() operand or option: '${callName}'. Expected: in, out, inout, lateout, inlateout, const_val, sym, clobber, clobber_abi, asm_options.`,
      });
    }

    argIdx++;
  }

  // --- Mark variable-target output variables as initialized ---
  // asm writes to these variables, so they should be considered initialized after the call
  let currentEnv = env;
  for (const op of operands) {
    if (op.targetVarName === undefined) continue;
    if (op.kind !== "out" && op.kind !== "lateout") continue;

    const variables = getVariablesFromEnv(currentEnv, op.targetVarName);
    if (variables.length > 0) {
      const variable = variables[variables.length - 1]!;
      if (!variable.initializedAtToken) {
        currentEnv = updateExistingVariable(currentEnv, variable, {
          ...variable,
          initializedAtToken: expr.token,
        });
      }
    }
  }
  env = currentEnv;

  // --- Infer return type ---
  // Collect output types from non-discarded, non-variable-target outputs
  const returnOutputTypes: Type[] = [];

  for (const op of operands) {
    if (op.discarded) continue;
    if (op.targetVarName !== undefined) continue; // variable-target, doesn't contribute to return
    if (op.kind === "const_val" || op.kind === "sym") continue;
    if (op.kind === "in") continue;

    // out, lateout, inout, inlateout — all have an output type
    if (op.outputType) {
      returnOutputTypes.push(op.outputType);
    }
  }

  let returnType: Type;
  if (options.noreturn) {
    // noreturn: use the enclosing function's return type (like panic)
    returnType =
      context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body"
        ? context.isEvaluatingFunctionBodyOrAsyncBlock.type.return.type
        : VUnit.type;
  } else if (returnOutputTypes.length === 0) {
    returnType = VUnit.type;
  } else if (returnOutputTypes.length === 1) {
    returnType = returnOutputTypes[0]!;
  } else {
    // Multiple outputs → tuple
    const tupleFields: TypeField[] = returnOutputTypes.map((type, i) => ({
      label: i.toString(),
      type,
      exprs: {
        expr: expr,
        labelExpr: undefined,
        typeExpr: undefined,
        defaultValueExpr: undefined,
        assignedValueExpr: undefined,
      },
    }));
    returnType = createTupleType(tupleFields);
  }

  // --- Validate template placeholders ---
  // (We do basic validation here; full validation could be done in codegen)
  const template = templateParts.join("\n");
  const placeholderRegex = /\{([^}:]+)(?::[^}]*)?\}/g;
  let match;
  const operandNames = new Set<string>();
  for (let i = 0; i < operands.length; i++) {
    if (operands[i]!.name) {
      if (operandNames.has(operands[i]!.name!)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Duplicate asm operand name: '${operands[i]!.name}'.`,
        });
      }
      operandNames.add(operands[i]!.name!);
    }
  }

  while ((match = placeholderRegex.exec(template)) !== null) {
    const ref = match[1]!;
    if (ref === "{" || ref === "}") continue; // escaped braces
    // Check if it's a positional reference
    const positionalIdx = parseInt(ref, 10);
    if (!isNaN(positionalIdx)) {
      if (positionalIdx < 0 || positionalIdx >= operands.length) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `asm template references positional operand {${positionalIdx}} but only ${operands.length} operands are defined.`,
        });
      }
    } else {
      // Named reference — check it exists
      if (!operandNames.has(ref)) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `asm template references undefined operand '{${ref}}'.`,
        });
      }
    }
  }

  expr.$ = {
    env,
    type: returnType,
    value: undefined, // asm is always a runtime expression
    pathCollection: [],
  };

  return expr;
}

export function evaluateGlobalAsm({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // Phase C privilege gate. See plans/MEMORY_SAFETY.md.
  if (!isImplicitlyUnsafeCapableFile(expr.token.modulePath)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `'global_asm(...)' is not available in safe code. Declare 'pragma(Pragma.AllowUnsafe);' at the top of the file to use inline assembly.`,
    });
  }
  if (expr.args.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `global_asm() requires at least one argument (the assembly string).`,
    });
  }

  // Evaluate template — must be comptime_str
  const templateExpr = expr.args[0]!;
  const evaluated = evaluateExpression({
    expr: templateExpr,
    env,
    context: { ...context },
  });

  if (
    !evaluated.$?.value ||
    (!isComptimeStringValue(evaluated.$.value) &&
      !(
        isUnknownValue(evaluated.$.value) &&
        isComptimeStringType(evaluated.$.value.type)
      ))
  ) {
    throw formatErrorMessage({
      token: templateExpr.token,
      errorMessage: `global_asm() argument must be a compile-time string.`,
    });
  }

  expr.$ = {
    env,
    type: VUnit.type,
    value: undefined,
    pathCollection: [],
  };

  return expr;
}
