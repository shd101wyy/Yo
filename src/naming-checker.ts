export function isUpperCamelCase(name: string): boolean {
  return name[0] === name[0].toUpperCase() && name.indexOf("_") < 0;
}

export function isSnakeCase(name: string): boolean {
  return !name.match(/[A-Z]/);
}
