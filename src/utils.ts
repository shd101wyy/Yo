import { createHash } from "crypto";
import { charIsOperator, Operators } from "./token";

/**
 * Generate a module id based on the module path
 * @param modulePath
 * @returns
 */
export function generateModuleId(modulePath: string) {
  const hash = createHash("sha1").update(modulePath).digest("hex");
  return "yo" + hash.slice(0, 8);
}

/**
 * key: modulePath
 * value: counter
 */
const moduleIdCounters = new Map<string, number>();

/**
 * Generate a random id for the module
 * @param modulePath
 * @returns
 */
export function randomId(modulePath: string) {
  let counter = moduleIdCounters.get(modulePath);
  if (counter === undefined) {
    counter = 0;
  }
  moduleIdCounters.set(modulePath, counter + 1);
  return `${generateModuleId(modulePath)}_id_${counter}`;
}

export function resetModuleIdCounter(modulePath: string) {
  moduleIdCounters.delete(modulePath);
}

let tempVariableNameCount = 1;
function generateTempVariableNamePrefix(modulePath: string): string {
  return `_${generateModuleId(modulePath)}_temp_`;
}
export function generateNewTempVariableName(modulePath: string): string {
  return `${generateTempVariableNamePrefix(modulePath)}${tempVariableNameCount++}`;
}
export function isTempVariableName(
  modulePath: string,
  variableName: string
): boolean {
  return variableName.startsWith(generateTempVariableNamePrefix(modulePath));
}

const IdMap = new Map<string, number>();
/**
 * Return the first 10 characters of SHA1 of modulePath + variableName
 * @param modulePath
 * @param variableName
 * @returns
 */
export function generateVarialeId(
  modulePath: string,
  variableName: string
): string {
  let sanitizedVariableName = "";
  for (let i = 0; i < variableName.length; i++) {
    if (charIsOperator(variableName[i]!)) {
      const index = Operators.indexOf(variableName[i]!);
      sanitizedVariableName += `${index}`;
    } else {
      sanitizedVariableName += variableName[i];
    }
  }

  const id = generateModuleId(modulePath) + "_" + sanitizedVariableName;
  let count = IdMap.get(id);
  if (count === undefined) {
    count = 0;
  } else {
    count++;
  }
  IdMap.set(id, count);
  return id + (count == 0 ? "" : `_${count}`);
}

export function hashString(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

/**
 * Clear all module-related counters and caches
 * Call this between test runs to prevent memory accumulation
 */
export function clearAllModuleCounters(): void {
  moduleIdCounters.clear();
  IdMap.clear();
  tempVariableNameCount = 1;
}
