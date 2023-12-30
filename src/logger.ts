export function debug(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production" && process.env.DEBUG) {
    console.log(...args);
  }
}
