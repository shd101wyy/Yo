import type { FnCallExpr } from "../../expr";
import { isPtrType } from "../../types/guards";
import { emitTraverseValue } from "../functions/generation";
import type { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

/**
 * __yo_gc_collect - trigger garbage collection
 */
export function generateYoGcCollect(
  expr: FnCallExpr,
  _indent: string,
  _context: CodeGenContext
): string {
  if (expr.args.length !== 0) {
    return codegenFatal(`__yo_gc_collect requires exactly 0 arguments`);
  }
  return `__yo_gc_collect()`;
}

/**
 * __yo_gc_trace_child(tracer, slot) — the body of `GcTracer.visit`. `slot` is a
 * pointer to where the child lives; lowers to the compositional per-value traverse
 * (emitTraverseValue) over `*slot`, read RAW (no dup/drop, so the collector's RC
 * trial-decrement is not perturbed), using `tracer` (the opaque `void(*)(void*)`
 * collector callback carried as a raw pointer) as the visit callback: a managed
 * `*slot` registers the edge, a value `*slot` recurses inline. Returns unit.
 */
export function generateYoGcTraceChild(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return codegenFatal(`__yo_gc_trace_child requires exactly 2 arguments`);
  }
  const slotExpr = expr.args[1]!;
  const slotType = slotExpr.$?.type;
  if (!slotType || !isPtrType(slotType)) {
    return codegenFatal(`__yo_gc_trace_child slot must be a pointer`);
  }
  const tracerCode = generateExpr(expr.args[0]!, indent, context);
  const slotCode = generateExpr(slotExpr, indent, context);
  // `slot` points at the child; read `*slot` as a raw C lvalue — no dup, no drop.
  emitTraverseValue(
    `(*(${slotCode}))`,
    slotType.childType,
    context,
    new Set<string>(),
    tracerCode
  );
  return `((void)0)`;
}
