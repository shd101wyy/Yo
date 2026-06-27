import type { FnCallExpr } from "../../expr";
import { emitTraverseValue } from "../functions/generation";
import type { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * __yo_gc_collect - trigger garbage collection
 */
export function generateYoGcCollect(
  expr: FnCallExpr,
  _indent: string,
  _context: CodeGenContext
): string {
  if (expr.args.length !== 0) {
    return `// Error: __yo_gc_collect requires exactly 0 arguments`;
  }
  return `__yo_gc_collect()`;
}

/**
 * __yo_gc_trace_child(tracer, child) — the body of `GcTracer.visit`. Lowers to
 * the compositional per-value traverse (emitTraverseValue) of `child`, using
 * `tracer` (a `GcTracer`, i.e. the opaque `void(*)(void*)` collector callback
 * carried as a raw pointer) as the visit callback: a managed `child` registers
 * the edge, a value `child` recurses inline through its structure. Returns unit.
 */
export function generateYoGcTraceChild(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return `// Error: __yo_gc_trace_child requires exactly 2 arguments`;
  }
  const childExpr = expr.args[1]!;
  const childType = childExpr.$?.type;
  if (!childType) {
    return `// Error: __yo_gc_trace_child child missing type information`;
  }
  const tracerCode = generateExpr(expr.args[0]!, indent, context);
  const childCode = generateExpr(childExpr, indent, context);
  emitTraverseValue(childCode, childType, context, new Set<string>(), tracerCode);
  return `((void)0)`;
}
