import {
  Environment,
  getVariablesFromEnv,
  updateExistingVariable,
} from "../../env";
import { Token } from "../../token";

/**
 * Consume captured variables for closures.
 *
 * This function implements the move semantics for closures in the Yo language.
 * When a closure is created, it captures variables from outer scopes by move,
 * similar to Rust's FnOnce closures. This means the captured variables are
 * consumed and cannot be used again after the closure is created.
 *
 * @param capturedVariables - Map of variable names to their frame levels
 * @param env - The environment where the closure is being created
 * @param closureToken - The token representing the closure creation point
 * @returns Updated environment with captured variables marked as consumed
 */
export function consumeCapturedVariables({
  capturedVariables,
  env,
  closureToken,
}: {
  capturedVariables: Map<string, number>;
  env: Environment;
  closureToken: Token;
}): Environment {
  let updatedEnv = env;

  for (const [
    variableName,
    definedAtFrameLevel,
  ] of capturedVariables.entries()) {
    // Only consume variables from outer scopes (lower frame levels)
    if (definedAtFrameLevel < env.frames.length) {
      const variables = getVariablesFromEnv(updatedEnv, variableName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (!variable.consumedAtToken) {
          // Mark the variable as consumed at the closure creation point
          updatedEnv = updateExistingVariable(updatedEnv, variable, {
            ...variable,
            consumedAtToken: closureToken,
          });
        }
      }
    }
  }

  return updatedEnv;
}
