// https://rust-lang.github.io/api-guidelines/naming.html
/**
 * Check if the name is in UpperCamelCase
 * @param name
 * @returns
 */
export function isUpperCamelCase(name: string): boolean {
  if (!name) {
    throw new Error("Name cannot be empty");
  }
  name = name.replace(/^_*/, "");
  name = name.replace(/_*$/, "");
  return name[0]! === name[0]!.toUpperCase() && name.indexOf("_") < 0;
}

/**
 * Check if the name is in lowerCamelCase
 * @param name
 * @returns
 */
export function isLowerCamelCase(name: string): boolean {
  if (!name) {
    throw new Error("Name cannot be empty");
  }

  name = name.replace(/^_*/, "");
  name = name.replace(/_*$/, "");
  return name[0]! === name[0]!.toLowerCase() && name.indexOf("_") < 0;
}

/**
 * Check if the name is in snake_case
 * @param name
 * @returns
 */
export function isSnakeCase(name: string): boolean {
  return !name.match(/[A-Z]/);
}

/**
 * Check if the name is in SCREAMING_SNAKE_CASE
 * @param name
 * @returns
 */
export function isScreamingSnakeCase(name: string): boolean {
  return name === name.toUpperCase();
}
