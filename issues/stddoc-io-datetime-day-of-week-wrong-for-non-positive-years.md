# `DateTime.day_of_week` is wrong for year 0 and returns garbage for negative years

**Found:** 2026-09-11, during the `std/` `///` documentation sweep (docs-only PR;
this is filed, not fixed).
**File:** `std/time/datetime.yo:302-331` (`day_of_week`), reachable through the
validating constructor `DateTime.new` (`:507`), whose `_validate` (`:465-483`)
checks month, day, hour, minute, second, nanosecond and offset but **never the
year**.

## Behaviour, verbatim

Reproducer: `issues/repros/stddoc-io-datetime-day-of-week-wrong-for-non-positive-years.yo`

```
$ yo compile issues/repros/stddoc-io-datetime-day-of-week-wrong-for-non-positive-years.yo \
    --std-path ./std --optimize 2 -o /tmp/dow && /tmp/dow
year 2026 Jan 1 dow=3 doy=1
year 1 Jan 1 dow=0 doy=1
year 0 Jan 1 dow=6 doy=1
year -1 Jan 1 dow=254 doy=1
year -4 Jan 1 dow=250 doy=1
```

`day_of_week` documents itself as `0 = Monday … 6 = Sunday` (ISO 8601), so:

| date | correct (proleptic Gregorian) | returned |
| --- | --- | --- |
| 2026-01-01 | 3 (Thursday) | 3 ✅ |
| 0001-01-01 | 0 (Monday) | 0 ✅ |
| 0000-01-01 | 5 (Saturday) | **6** ❌ |
| -0001-01-01 | 4 (Friday) | **254** ❌ |
| -0004-01-01 | 1 (Tuesday) | **250** ❌ |

Year 0 is a leap year under the proleptic Gregorian rule the module already
implements (`0 % 400 == 0`), so 0000-01-01 is 366 days before 0001-01-01,
which is a Monday: 366 mod 7 = 2, so 0000-01-01 is a Saturday, index 5.

254 and 250 are not weekdays at all — they are `u8` wraps of −2 and −6.

## Root cause

`day_of_week` is Sakamoto's algorithm, which assumes FLOOR division and a
non-negative year:

```rust
y := cond((i32(self.month) < i32(3)) => (self.year - i32(1)), true => self.year);
sum := (((((y + (y / i32(4))) - (y / i32(100))) + (y / i32(400))) + t(...)) + i32(self.day));
dow := (sum % i32(7));
u8(cond((dow == i32(0)) => i32(6), true => (dow - i32(1))))
```

Two separate defects, both from C's signed-integer semantics:

1. **`y / 4`, `y / 100`, `y / 400` truncate toward zero, not toward negative
   infinity.** For `y = -1` the leap-year corrections come out one step off,
   which is why year 0 (whose `y` becomes −1 for January and February) is
   already wrong by one day.
2. **C's `%` keeps the sign of the dividend**, so a negative `sum` yields a
   negative `dow`. The `dow == 0` remap only handles the Sunday case, so
   `dow - 1` stays negative and `u8(...)` of a negative `i32` wraps into the
   200s — an out-of-range value for a method whose contract is `0..=6`.

`day_of_year` is unaffected (it only sums month lengths and consults
`_is_leap_year`, which is sign-safe for the leap rule), and `to_unix` /
`from_unix` are unaffected (they use the era-based Howard Hinnant algorithm,
which is written to floor correctly for negative eras).

## Fix

Floor the divisions and normalise the remainder before the remap, e.g.

```rust
_fdiv :: (fn(a : i32, b : i32) -> i32)(
  cond((a >= i32(0)) => (a / b), true => (((a - b) + i32(1)) / b))
);
...
dow := (((sum % i32(7)) + i32(7)) % i32(7));
```

Alternatively derive the weekday from `to_unix()` (whose era arithmetic is
already correct for negative years) instead of running a second calendar
algorithm: `dow = ((days_since_epoch + 3) mod 7)` with a floored `mod`, since
1970-01-01 was a Thursday. That removes the duplicate algorithm rather than
repairing it, and is the shape I would pick.

Whether `_validate` should ALSO reject years below 1 is a separate design
question — the module supports negative years everywhere else (`to_unix`,
`from_unix`, `parse` of an RFC 3339 `YYYY` is four digits so it cannot express
one), so rejecting them in `new` would be a narrowing.

## Test to add with the fix

`tests/time/datetime.test.yo` — the five rows of the table above, asserting the
weekday of 0001-01-01, 0000-01-01 and −0001-01-01 against the proleptic
Gregorian answer, plus an assertion that `day_of_week() <= u8(6)` for every one
of them (which is what catches the `u8` wrap independently of the off-by-one).
