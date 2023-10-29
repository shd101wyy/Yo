## Variable Scope

```typescript
{
  // s is not valid here, it’s not yet declared
  let s = "hello"; // s is valid from this point forward

  // do stuff with s
} // this scope is now over, and s is no longer valid
```

## Memory and Allocation

```typescript
{
  let s1: string = "Hello, world";
  let s2 = s1;

  console.log("${s1}, world!"); // error, as move occurs
}
```
