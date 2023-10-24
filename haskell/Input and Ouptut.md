> http://learnyouahaskell.com/input-and-output

## Hello, world!

```typescript
function main(): IO<()> {
  return putStrLn("Hello, world!");
}

assert(typeof(putStrLn) === "(string) => IO<()>");
```

```typescript
function main(): IO<()> {
  do {
    await putStrLn("Hello, world!");
    let name: string = await getLine();
    putStrLn("Hey " + name + ", you rock!");
  }
}

assert(typeof(getLine) === "() => IO<string>");
```

```typescript
function main(): IO<()> {
  do {
    let line = await getLine();
    if (line == "") {
      return ();
    } else {
      await putStrLn(reverseWords(line));
      return main();
    }
  }
}
```

## Randomness

```typescript

```
