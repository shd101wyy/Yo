# An associated type declared `: ?Sized` makes `Self.Target` not a type

**Severity:** S3. A trait whose associated type opts out of the implicit `Sized` bound cannot name that type in a
method signature; the error is the internal "Expected a type" form and the spelling has no workaround except
`: Type` (which admits an unsized type today).

Found 2026-11-15 by the VERDICTS-63 probes (p4, first run). Seed `yo` 0.2.77 and develop (`yo-dt6`) both fail.

## Reproducer

`issues/repros/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.yo`:

```yo
Peek :: trait(
  Target : ?Sized,
  peek : (fn(self : &Self) -> &Self.Target)
);
export(Peek);

main :: (fn() -> unit)({});
export(main);
```

```text
error: Expected a type for function return type, got:
(Self.Target)
  --> issues/repros/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.yo:5:36
  |
5 |   peek : (fn(self : &Self) -> &Self.Target)
  |                                    ^
```

(The probe's first run hit the same text on the prelude's `Deref`: `derive on "AllocatorVTable": the derive rule
failed: Expected a type for function return type, got: (Self.Target)`.)

## Expected

`Self.Target` is a type in a signature whether the associated type is declared `Type` or `?Sized`. VERDICTS-63 keeps
`Deref.Target : Type` for Generation A; decision 49's "`Deref.Target : ?Sized`" waits on this fix.

Fix: not started (v0.2.79).
