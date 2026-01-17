import { Environment, getVariablesFromEnv } from "../../env";

/**
 * Check if a variable is captured by the closure or is a local variable.
 * A variable is captured if the latest variable with that name exists at a frame level
 * that is <= the closure capture frame level.
 * Variables at higher frame levels (more recent scopes) are local variables.
 */
export function checkVariableIsClosureCaptured(
  variableName: string,
  env: Environment,
  closureCaptureFrameLevel: number
): boolean {
  // Get all variables with this name, ordered from oldest to newest
  const variables = getVariablesFromEnv(env, variableName);

  if (variables.length === 0) {
    // Variable not found in environment - assume it's not captured
    return false;
  }

  // Get the latest (most recent) variable with this name
  const latestVariable = variables[variables.length - 1]!;

  // Check if it's from a captured frame level
  return latestVariable.frameLevel <= closureCaptureFrameLevel;
}
