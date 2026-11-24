# `__yo_panic(m.unwrap_or("..."))` in a value arm is rejected with a unify error between the message type and the arm's type

**Severity:** S3: a valid call is rejected with a message that names neither the cause nor the repair. Binding the message to a local first works, so std and the compiler can route around it.

- Filed: 2026-11-24 (lane akc-k2k3k6, re-verifying the retired syntax cheatsheet's "`__yo_panic` needs a plain message binding" note with a tree binary built from develop `34359627e`). The cheatsheet's error text ("Failed to evaluate panic message") is gone; the restriction is still there with a different, misleading message.

## Reproducer

```yo
f :: (fn(o : Option(i32), m : Option(&str)) -> i32)(
  match(o, .Some(v) => v, .None => __yo_panic(m.unwrap_or("dflt")))
);

main :: (fn() -> unit)({
  _ := f(Option(i32).Some(i32(1)), Option(&str).None);
});
export(main);
```

`yo check`:

```text
error[E0601]: Cannot unify incompatible types: "&str" and "i32"
2 |   match(o, .Some(v) => v, .None => __yo_panic(m.unwrap_or("dflt")))
```

Both of these check:

```yo ignore
.None => {
  msg := m.unwrap_or("dflt");
  __yo_panic(msg)
}
```

```yo ignore
.None => __yo_panic(m) // m : &str
```

## Root cause (suspected, not traced)

`__yo_panic` takes the enclosing context's expected type as its own result type. A method-call argument is evaluated with that expected type still in force, so `unwrap_or`'s `&str` result is unified against the arm's `i32`. An atom or a local carries its own type and never meets the expectation. The fix is to evaluate the message argument with no expected type (or the message's own `&str`), in the `__yo_panic` builtin's argument evaluation.

## Fix direction

Clear the expected type before evaluating `__yo_panic`'s argument. A test in `tests/` (a value arm whose `__yo_panic` message is a method call) fails before and passes after.
