import type { FnCallExpr } from "../../expr";
import { isStrType } from "../../types/guards";
import { isComptimeStringValue } from "../../value";
import { type CodeGenContext, getTypeString } from "../utils";
import { generateExpr } from "./expr";

export function generatePanic(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;

  // panic() never returns, so we need to handle it specially
  // We need to generate the panic code and then provide a dummy value for the assignment
  const returnType = expr.$?.type;
  if (!returnType) {
    return `// Error: panic() missing type information`;
  }

  if (expr.args.length === 0) {
    // No message provided, just call abort()
    emitter.emitLine(`${indent}abort();`);
  } else if (expr.args.length === 1) {
    // Message provided, print to stderr then abort
    const messageArg = expr.args[0]!;

    // The message should be a compile-time string value
    if (messageArg.$?.value && isComptimeStringValue(messageArg.$.value)) {
      const message = messageArg.$.value.value;
      emitter.emitLine(
        `${indent}fprintf(stderr, "%s\\n", ${JSON.stringify(message)});`
      );
      emitter.emitLine(`${indent}abort();`);
    } else {
      // Runtime message - generate code to evaluate it
      const messageCode = generateExpr(messageArg, indent, context);
      const msgType = messageArg.$?.type;
      const msgIsStr = msgType && isStrType(msgType);
      if (msgIsStr) {
        // str is the builtin fat pointer: { const uint8_t* ptr; size_t len; }
        emitter.emitLine(
          `${indent}fprintf(stderr, "%.*s\\n", (int)${messageCode}.len, (const char*)${messageCode}.ptr);`
        );
      } else {
        emitter.emitLine(`${indent}fprintf(stderr, "%s\\n", ${messageCode});`);
      }
      emitter.emitLine(`${indent}abort();`);
    }
  } else {
    return `// Error: panic accepts 0 or 1 arguments, got ${expr.args.length}`;
  }

  // Since panic never returns, we need to provide a dummy value of the correct type
  // This code is unreachable but needed for C compilation
  const returnTypeStr = getTypeString(returnType, context);
  return `(*((${returnTypeStr}*)NULL))`; // This will never execute but has the right type
}
