import type { FnCallExpr } from "../../expr";
import type { CodeGenContext } from "../utils";
import { generateExpr } from "./expr";

/**
 * The `consume` function call,
 * generating a consume expression.
 *
 * consume() means "take ownership of this location without dropping the old value"
 * - Used for initializing fresh memory (malloc'd/calloc'd slots)
 * - Used when explicitly consuming a value without cleanup
 * - The old value at the location is NOT dropped (caller is responsible for ensuring it's safe)
 */
export function generateConsume(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const argExpr = expr.args[0]!;
  const argCode = generateExpr(argExpr, indent, context);

  // NOTE: consume() does NOT generate drop code for the old value
  // That's the whole point - we're consuming the location without cleanup
  // If the old value needs to be dropped, use regular assignment or explicit ___drop()

  return argCode;
}
