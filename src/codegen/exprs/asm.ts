import {
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  type Expr,
  type FnCallExpr,
} from "../../expr";
import { isTargetWasm } from "../../target";
import { isUnitType } from "../../types/guards";
import { isComptimeStringValue, isTypeValue } from "../../value";
import { type CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./expr";

// Register class names mapped to GCC constraint letters per architecture
const REGISTER_CLASS_TO_GCC: Record<string, Record<string, string>> = {
  reg: { x86_64: "r", aarch64: "r", x86: "r", arm: "r" },
  reg_byte: { x86_64: "q", x86: "q" },
  reg_abcd: { x86_64: "Q", x86: "Q" },
  xmm_reg: { x86_64: "x", aarch64: "w" },
  ymm_reg: { x86_64: "x" },
  imm: { x86_64: "i", aarch64: "i", x86: "i", arm: "i" },
  mem: { x86_64: "m", aarch64: "m", x86: "m", arm: "m" },
};

// Explicit register name to GCC constraint mapping (common x86_64 registers)
const EXPLICIT_REGISTER_CONSTRAINTS: Record<string, string> = {
  rax: "a",
  eax: "a",
  ax: "a",
  al: "a",
  rbx: "b",
  ebx: "b",
  bx: "b",
  bl: "b",
  rcx: "c",
  ecx: "c",
  cx: "c",
  cl: "c",
  rdx: "d",
  edx: "d",
  dx: "d",
  dl: "d",
  rsi: "S",
  esi: "S",
  si: "S",
  rdi: "D",
  edi: "D",
  di: "D",
};

// Register template modifier mapping: Yo modifier -> GCC modifier character
const TEMPLATE_MODIFIERS: Record<string, string> = {
  e: "k", // 32-bit (eax)
  x: "w", // 16-bit (ax)
  l: "b", // 8-bit low (al)
  h: "h", // 8-bit high (ah)
  w: "w", // aarch64 32-bit (w0)
};

interface ParsedOperand {
  kind: "in" | "out" | "inout" | "lateout" | "inlateout" | "const_val" | "sym";
  name: string | undefined;
  constraint: string;
  cExpr: string;
  cType: string;
  isDiscarded: boolean;
  isVariableTarget: boolean;
}

/**
 * Resolve a constraint to a GCC constraint letter.
 */
function resolveConstraint(
  constraint: string | undefined,
  arch: string
): string {
  if (!constraint) return "r"; // default to general-purpose register

  // Raw constraint passthrough
  if (constraint.startsWith("raw:")) {
    return constraint.slice(4);
  }

  // Explicit register name
  const explicitReg = EXPLICIT_REGISTER_CONSTRAINTS[constraint];
  if (explicitReg) return explicitReg;

  // Register class
  const classMap = REGISTER_CLASS_TO_GCC[constraint];
  if (classMap) {
    return classMap[arch] ?? classMap["x86_64"] ?? "r";
  }

  // Assume it's a raw GCC constraint string
  return constraint;
}

/**
 * Transform Yo asm template placeholders to GCC operand references.
 * {name} -> %[name]
 * {N} -> %N
 * {name:mod} -> %<gccMod>[name]
 * {{ -> {
 * }} -> }
 */
function transformTemplate(
  template: string,
  _operandNames: Map<string, number>
): string {
  let result = "";
  let i = 0;

  while (i < template.length) {
    if (template[i] === "{") {
      if (i + 1 < template.length && template[i + 1] === "{") {
        result += "{";
        i += 2;
        continue;
      }
      // Find closing }
      const closeIdx = template.indexOf("}", i + 1);
      if (closeIdx === -1) {
        result += template[i];
        i++;
        continue;
      }
      const inner = template.slice(i + 1, closeIdx);
      const colonIdx = inner.indexOf(":");

      let ref: string;
      let modifier: string | undefined;
      if (colonIdx >= 0) {
        ref = inner.slice(0, colonIdx);
        modifier = inner.slice(colonIdx + 1);
      } else {
        ref = inner;
      }

      const gccMod = modifier
        ? (TEMPLATE_MODIFIERS[modifier] ?? modifier)
        : undefined;
      const positionalIdx = parseInt(ref, 10);

      if (!isNaN(positionalIdx)) {
        // Positional: {0} -> %0 or {0:e} -> %k0
        if (gccMod) {
          result += `%${gccMod}${positionalIdx}`;
        } else {
          result += `%${positionalIdx}`;
        }
      } else {
        // Named: {name} -> %[name] or {name:e} -> %k[name]
        if (gccMod) {
          result += `%${gccMod}[${ref}]`;
        } else {
          result += `%[${ref}]`;
        }
      }
      i = closeIdx + 1;
    } else if (
      template[i] === "}" &&
      i + 1 < template.length &&
      template[i + 1] === "}"
    ) {
      result += "}";
      i += 2;
    } else {
      result += template[i];
      i++;
    }
  }

  return result;
}

/**
 * Parse an operand sub-call from the asm() arguments during codegen.
 */
function parseOperandForCodegen(
  operandExpr: FnCallExpr,
  indent: string,
  context: CodeGenContext,
  kind: string
): ParsedOperand {
  const args = operandExpr.args;
  const arch = context.targetInfo.arch;

  if (kind === "const_val") {
    let name: string | undefined;
    let valueIdx = 0;
    if (
      args.length === 2 &&
      args[0]!.$?.value &&
      isComptimeStringValue(args[0]!.$.value)
    ) {
      name = args[0]!.$.value.value;
      valueIdx = 1;
    }
    const valueCode = generateExpr(args[valueIdx]!, indent, context);
    return {
      kind: "const_val",
      name,
      constraint: "",
      cExpr: valueCode,
      cType: "",
      isDiscarded: false,
      isVariableTarget: false,
    };
  }

  if (kind === "sym") {
    let name: string | undefined;
    let valueIdx = 0;
    if (
      args.length === 2 &&
      args[0]!.$?.value &&
      isComptimeStringValue(args[0]!.$.value)
    ) {
      name = args[0]!.$.value.value;
      valueIdx = 1;
    }
    const valueCode = generateExpr(args[valueIdx]!, indent, context);
    return {
      kind: "sym",
      name,
      constraint: "i",
      cExpr: valueCode,
      cType: "",
      isDiscarded: false,
      isVariableTarget: false,
    };
  }

  // Parse: (name?, constraint, value_or_type)
  let name: string | undefined;
  let constraintIdx = 0;

  // Detect name — first arg is a comptime_str that is not a register class
  if (args.length >= 2) {
    const firstArg = args[0]!;
    if (
      firstArg.$?.value &&
      isComptimeStringValue(firstArg.$.value) &&
      !(firstArg.tag === "Atom" && isRegisterClass(firstArg.token.value))
    ) {
      name = firstArg.$.value.value;
      constraintIdx = 1;
    }
  }

  const hasConstraintArg = constraintIdx < args.length - 1;
  let constraintRaw: string | undefined;
  let valueTypeIdx: number;

  if (hasConstraintArg) {
    constraintRaw = extractConstraintString(
      args[constraintIdx]!,
      indent,
      context
    );
    valueTypeIdx = constraintIdx + 1;
  } else {
    // Name IS the constraint (explicit register)
    if (name !== undefined) {
      constraintRaw = name;
    }
    valueTypeIdx = constraintIdx;
  }

  const constraint = resolveConstraint(constraintRaw, arch);
  const valueOrTypeExpr = args[valueTypeIdx]!;

  // Check for discard
  if (valueOrTypeExpr.tag === "Atom" && valueOrTypeExpr.token.value === "_") {
    return {
      kind: kind as ParsedOperand["kind"],
      name,
      constraint,
      cExpr: "",
      cType: "int32_t",
      isDiscarded: true,
      isVariableTarget: false,
    };
  }

  // Check if it's a type (return-value output mode)
  if (valueOrTypeExpr.$?.value && isTypeValue(valueOrTypeExpr.$.value)) {
    const outputType = valueOrTypeExpr.$.value.value;
    const cType = getTypeString(outputType, context);
    return {
      kind: kind as ParsedOperand["kind"],
      name,
      constraint,
      cExpr: "",
      cType,
      isDiscarded: false,
      isVariableTarget: false,
    };
  }

  // It's a value expression (input, inout, or variable-target output)
  const cExpr = generateExpr(valueOrTypeExpr, indent, context);
  const cType = getTypeString(valueOrTypeExpr.$?.type, context);

  // Check if this is a variable-target output (out/lateout with a variable)
  const isOutputKind = kind === "out" || kind === "lateout";
  const isVariableTarget = isOutputKind && valueOrTypeExpr.tag === "Atom";

  return {
    kind: kind as ParsedOperand["kind"],
    name,
    constraint,
    cExpr,
    cType,
    isDiscarded: false,
    isVariableTarget,
  };
}

function isRegisterClass(name: string): boolean {
  return [
    "reg",
    "reg_byte",
    "reg_abcd",
    "xmm_reg",
    "ymm_reg",
    "imm",
    "mem",
  ].includes(name);
}

function extractConstraintString(
  expr: Expr,
  _indent: string,
  _context: CodeGenContext
): string {
  if (expr.tag === "Atom" && isRegisterClass(expr.token.value)) {
    return expr.token.value;
  }
  if (expr.$?.value && isComptimeStringValue(expr.$.value)) {
    return expr.$.value.value;
  }
  // raw("constraint")
  if (exprIsFunctionCallOf(expr, "raw", 1)) {
    const fnCall = expr as FnCallExpr;
    if (
      fnCall.args[0]!.$?.value &&
      isComptimeStringValue(fnCall.args[0]!.$.value)
    ) {
      return `raw:${fnCall.args[0]!.$.value.value}`;
    }
  }
  return "r"; // fallback
}

/**
 * Parse clobber arguments from a clobber() or clobber_abi() call.
 */
function parseClobbers(
  clobberExpr: FnCallExpr,
  context: CodeGenContext
): string[] {
  const clobbers: string[] = [];
  const kind =
    clobberExpr.func.tag === "Atom" ? clobberExpr.func.token.value : "clobber";

  if (kind === "clobber_abi") {
    // clobber_abi("C") → expand to all caller-saved registers for the ABI
    const arch = context.targetInfo.arch;
    if (arch === "x86_64") {
      clobbers.push(
        "rax",
        "rcx",
        "rdx",
        "rsi",
        "rdi",
        "r8",
        "r9",
        "r10",
        "r11",
        "xmm0",
        "xmm1",
        "xmm2",
        "xmm3",
        "xmm4",
        "xmm5",
        "xmm6",
        "xmm7",
        "xmm8",
        "xmm9",
        "xmm10",
        "xmm11",
        "xmm12",
        "xmm13",
        "xmm14",
        "xmm15",
        "cc",
        "memory"
      );
    } else if (arch === "aarch64") {
      for (let i = 0; i <= 18; i++) clobbers.push(`x${i}`);
      clobbers.push("x30");
      for (let i = 0; i <= 31; i++) clobbers.push(`v${i}`);
      clobbers.push("cc", "memory");
    }
    return clobbers;
  }

  // Regular clobber() — collect string args
  for (const arg of clobberExpr.args) {
    if (arg.$?.value && isComptimeStringValue(arg.$.value)) {
      clobbers.push(arg.$.value.value);
    } else if (arg.tag === "Atom") {
      // Allow bare identifiers for common clobbers: memory, cc
      clobbers.push(arg.token.value);
    }
  }

  return clobbers;
}

/**
 * Parse asm_options() flags.
 */
function parseAsmOptionsForCodegen(optExpr: FnCallExpr): {
  isVolatile: boolean;
  intelSyntax: boolean;
  noreturn: boolean;
  pure: boolean;
} {
  const result = {
    isVolatile: true,
    intelSyntax: false,
    noreturn: false,
    pure: false,
  };

  for (const arg of optExpr.args) {
    if (arg.tag !== "Atom") continue;
    switch (arg.token.value) {
      case "pure":
        result.pure = true;
        result.isVolatile = false;
        break;
      case "intel_syntax":
        result.intelSyntax = true;
        break;
      case "noreturn":
        result.noreturn = true;
        break;
      case "volatile":
        result.isVolatile = true;
        break;
    }
  }

  return result;
}

let _asmTempCounter = 0;

/**
 * Generate C code for an asm() expression.
 */
export function generateAsm(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;
  const returnType = expr.$?.type;

  if (!returnType) {
    return `/* Error: asm() missing type information */`;
  }

  // Check target compatibility
  if (isTargetWasm(context.targetInfo)) {
    emitter.emitLine(
      `${indent}/* Error: inline assembly is not supported on WebAssembly */`
    );
    emitter.emitLine(`${indent}abort();`);
    return `(*((${getTypeString(returnType, context)}*)NULL))`;
  }

  // --- Parse arguments ---
  // Collect template strings
  const templateParts: string[] = [];
  let argIdx = 0;

  while (argIdx < expr.args.length) {
    const arg = expr.args[argIdx]!;
    if (exprIsFunctionCall(arg)) break;
    if (arg.$?.value && isComptimeStringValue(arg.$.value)) {
      templateParts.push(arg.$.value.value);
      argIdx++;
    } else {
      break;
    }
  }

  const rawTemplate = templateParts.join("\n");

  // Parse operands, clobbers, options
  const operands: ParsedOperand[] = [];
  const allClobbers: string[] = [];
  let asmOpts = {
    isVolatile: true,
    intelSyntax: false,
    noreturn: false,
    pure: false,
  };

  while (argIdx < expr.args.length) {
    const arg = expr.args[argIdx]!;
    if (!exprIsFunctionCall(arg)) {
      argIdx++;
      continue;
    }

    const callName = arg.func.tag === "Atom" ? arg.func.token.value : undefined;
    if (!callName) {
      argIdx++;
      continue;
    }

    if (
      [
        "in",
        "out",
        "inout",
        "lateout",
        "inlateout",
        "ref",
        "const_val",
        "sym",
      ].includes(callName)
    ) {
      // `ref` is a user-facing alias for `inout` (see evaluator/builtins/asm.ts).
      // Normalize here so the downstream kind switches see the canonical tag.
      const kind = callName === "ref" ? "inout" : callName;
      operands.push(parseOperandForCodegen(arg, indent, context, kind));
    } else if (callName === "clobber" || callName === "clobber_abi") {
      allClobbers.push(...parseClobbers(arg, context));
    } else if (callName === "asm_options") {
      asmOpts = parseAsmOptionsForCodegen(arg);
    }

    argIdx++;
  }

  // --- Build operand name map for template transformation ---
  const operandNameMap = new Map<string, number>();
  for (let i = 0; i < operands.length; i++) {
    if (operands[i]!.name) {
      operandNameMap.set(operands[i]!.name!, i);
    }
  }

  // --- Handle const_val: substitute directly into template ---
  let processedTemplate = rawTemplate;
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i]!;
    if (op.kind !== "const_val") continue;

    // Replace {name} or {N} with the constant value (bare, no prefix)
    if (op.name) {
      processedTemplate = processedTemplate.replace(
        new RegExp(`\\{${op.name}(?::[^}]*)?\\}`, "g"),
        op.cExpr
      );
    }
    processedTemplate = processedTemplate.replace(
      new RegExp(`\\{${i}(?::[^}]*)?\\}`, "g"),
      op.cExpr
    );
  }

  // Transform Yo template to GCC template
  const gccTemplate = transformTemplate(processedTemplate, operandNameMap);

  // --- Generate temporary variables for outputs ---
  const outputTemps: { varName: string; cType: string; operandIdx: number }[] =
    [];
  const inoutTemps: {
    varName: string;
    cType: string;
    initExpr: string;
    operandIdx: number;
  }[] = [];
  const discardTemps: { varName: string; cType: string; operandIdx: number }[] =
    [];

  for (let i = 0; i < operands.length; i++) {
    const op = operands[i]!;

    if (op.isDiscarded) {
      const varName = `__asm_discard_${_asmTempCounter++}`;
      discardTemps.push({ varName, cType: op.cType, operandIdx: i });
      emitter.emitLine(`${indent}${op.cType} ${varName};`);
    } else if (op.kind === "out" || op.kind === "lateout") {
      if (op.isVariableTarget) {
        // Variable-target: no temporary needed, write directly to the variable
      } else if (op.cType) {
        const varName = `__asm_out_${_asmTempCounter++}`;
        outputTemps.push({ varName, cType: op.cType, operandIdx: i });
        emitter.emitLine(`${indent}${op.cType} ${varName};`);
      }
    } else if (op.kind === "inout" || op.kind === "inlateout") {
      const varName = `__asm_inout_${_asmTempCounter++}`;
      inoutTemps.push({
        varName,
        cType: op.cType,
        initExpr: op.cExpr,
        operandIdx: i,
      });
      emitter.emitLine(`${indent}${op.cType} ${varName} = ${op.cExpr};`);
    }
  }

  // --- Build GCC asm statement ---
  const volatileStr = asmOpts.isVolatile ? " __volatile__" : "";

  // When intel_syntax is requested, don't wrap with .intel_syntax/.att_syntax
  // directives — GCC/clang operand substitution produces AT&T-style register
  // names (e.g., %eax) regardless of inline directives. Instead, we set a
  // context flag so the C compiler is invoked with -masm=intel.
  const finalTemplate = gccTemplate;
  if (asmOpts.intelSyntax) {
    context.needsIntelAsmSyntax = true;
  }

  // Escape for C string
  const escapedTemplate = JSON.stringify(finalTemplate);

  // Build output operand list
  const outputParts: string[] = [];
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i]!;
    if (op.kind === "in" || op.kind === "const_val" || op.kind === "sym")
      continue;

    let prefix: string;
    if (op.kind === "out" || op.kind === "lateout") {
      prefix = op.kind === "lateout" ? "=&" : "=";
    } else {
      // inout, inlateout
      prefix = op.kind === "inlateout" ? "+&" : "+";
    }

    const gccConstraint = `${prefix}${op.constraint}`;
    const nameLabel = op.name ? `[${op.name}] ` : "";

    let targetVar: string;
    if (op.isDiscarded) {
      const disc = discardTemps.find((d) => d.operandIdx === i);
      targetVar = disc!.varName;
    } else if (op.isVariableTarget) {
      targetVar = op.cExpr;
    } else if (op.kind === "out" || op.kind === "lateout") {
      const outTemp = outputTemps.find((o) => o.operandIdx === i);
      targetVar = outTemp!.varName;
    } else {
      const ioTemp = inoutTemps.find((io) => io.operandIdx === i);
      targetVar = ioTemp!.varName;
    }

    outputParts.push(`${nameLabel}"${gccConstraint}" (${targetVar})`);
  }

  // Build input operand list
  const inputParts: string[] = [];
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i]!;
    if (op.kind !== "in" && op.kind !== "sym") continue;

    const gccConstraint = op.constraint;
    const nameLabel = op.name ? `[${op.name}] ` : "";
    inputParts.push(`${nameLabel}"${gccConstraint}" (${op.cExpr})`);
  }

  // Build clobber list
  const clobberParts = allClobbers.map((c) => `"${c}"`);

  // Emit the __asm__ statement
  const outputStr = outputParts.join(", ");
  const inputStr = inputParts.join(", ");
  const clobberStr = clobberParts.join(", ");

  emitter.emitLine(`${indent}__asm__${volatileStr} (`);
  emitter.emitLine(`${indent}    ${escapedTemplate}`);
  emitter.emitLine(`${indent}    : ${outputStr}`);
  emitter.emitLine(`${indent}    : ${inputStr}`);
  emitter.emitLine(`${indent}    : ${clobberStr}`);
  emitter.emitLine(`${indent});`);

  // Handle noreturn
  if (asmOpts.noreturn) {
    emitter.emitLine(`${indent}__builtin_unreachable();`);
    const returnTypeStr = getTypeString(returnType, context);
    return `(*((${returnTypeStr}*)NULL))`;
  }

  // --- Return expression ---
  if (isUnitType(returnType)) {
    return ""; // void, no return value
  }

  // Collect return-value output expressions
  const returnExprs: string[] = [];
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i]!;
    if (op.isDiscarded || op.isVariableTarget) continue;
    if (op.kind === "in" || op.kind === "const_val" || op.kind === "sym")
      continue;

    if (op.kind === "out" || op.kind === "lateout") {
      const outTemp = outputTemps.find((o) => o.operandIdx === i);
      if (outTemp) returnExprs.push(outTemp.varName);
    } else {
      // inout, inlateout
      const ioTemp = inoutTemps.find((io) => io.operandIdx === i);
      if (ioTemp) returnExprs.push(ioTemp.varName);
    }
  }

  if (returnExprs.length === 1) {
    return returnExprs[0]!;
  }

  if (returnExprs.length > 1) {
    // Return a tuple
    const tupleTypeStr = getTypeString(returnType, context);
    const fields = returnExprs.map((e, i) => `._${i} = ${e}`).join(", ");
    return `((${tupleTypeStr}){ ${fields} })`;
  }

  return ""; // shouldn't happen, but fallback
}

/**
 * Generate C code for global_asm() — top-level assembly emitted in the declaration section.
 */
export function generateGlobalAsm(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (isTargetWasm(context.targetInfo)) {
    return `/* global_asm skipped: not supported on this target */`;
  }

  const templateExpr = expr.args[0]!;
  if (templateExpr.$?.value && isComptimeStringValue(templateExpr.$.value)) {
    const template = templateExpr.$.value.value;
    context.emitter.emitDeclarationLine(
      `__asm__(${JSON.stringify(template)});`
    );
  }

  return ""; // global_asm is a statement, no return value
}
