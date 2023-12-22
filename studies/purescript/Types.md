> https://github.com/purescript/documentation/blob/master/language/Types.md

## Records

```typescript
type Person = {
  name: String;
};

// =

type PersonRows = (name: String);
type Person = Record(PersonRows);


const x: Person = {
  name: "John",
  age: 42,
};
```

where `Record` is a **type constructor** that takes a tuple of rows and returns a record type.

### Extending Records

```typescript
type PersonWithAge = Record((age: Number) | PersonRows);
```

## Tagged Unions

```typescript

```
