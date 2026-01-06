import { createHash } from "crypto";
import { charIsOperator, Operators } from "./token";

let randomIdCounter = 0;
export function randomId() {
  return `id${randomIdCounter++}`;
}

export function generateModuleId(modulePath: string) {
  const hash = createHash("sha1").update(modulePath).digest("hex");
  return "yo" + hash.slice(0, 8);
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
  variableName: string,
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
  variableName: string,
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
