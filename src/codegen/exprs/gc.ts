import type { FnCallExpr } from "../../expr";
import type { CodeGenContext } from "../utils";

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
