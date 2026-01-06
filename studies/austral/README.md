# austral language

- https://github.com/austral/austral/
  - [Tutorial](https://austral-lang.org/tutorial/)
  - [Spec](https://austral-lang.org/spec/spec.html)
  - [Linear Types](https://austral-lang.org/tutorial/linear-types)

## Linear Types

https://austral-lang.org/tutorial/linear-types

```typescript
type File!;

function openFile(path: String): File!;

function writeString(file: File!, content: String): File!;

function closeFile(file: File!): Unit;
```
