# `DateTime.day_of_week` is wrong for year 0 and returns garbage for negative years

**Status: FIXED 2026-09-14.** Verified red-then-green: the repro printed
`dow=6/254/250` before and `dow=5/4/0` after, and three new regression tests in
`tests/time/datetime.test.yo` fail against the pre-fix `std` and pass after.

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
| -0004-01-01 | **0 (Monday)** — see correction below | **250** ❌ |

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

---

## Correction to the table above (2026-09-14)

**The `-0004-01-01` row was wrong**, and is corrected in place above. It
claimed Tuesday (ISO 1); the answer is **Monday (ISO 0)**.

The row was wrong on its face before checking any calendar: it reads
"1 (Tuesday)", but this method's own contract — stated two paragraphs above it
— is `0 = Monday … 6 = Sunday`, under which `1` is Tuesday only if Monday is
`0`… which is what the row denies by pairing `1` with Tuesday. The name and
the number disagree with each other.

Two independent derivations give Monday:

1. **Days-from-civil.** `_days_from_civil(-4, 1, 1) = -720989`, and
   `(-720989 + 3) mod 7 = 0` under a floored modulus (1970-01-01 was a
   Thursday, ISO 3).
2. **By hand from a known anchor.** 0001-01-01 was a Monday. Years −4…0 span
   366 + 365 + 365 + 365 + 366 = **1827** days, and 1827 = 261 × 7 exactly, so
   the weekday is unchanged: Monday.

The other four rows are correct as written.

**Why this matters more than the arithmetic.** Had the fix been validated by
"make the code reproduce the doc's table", the result would have been a fix
that is still wrong for negative years *plus* a regression test pinning the
wrong answer — and it would have looked like disciplined red-then-green work,
because the test would have gone red before and green after. An expected-value
table shipped in the same document as the bug is not an independent oracle: it
was written by whoever misunderstood the behaviour. The regression test
therefore derives its expectations independently and says so in a comment, and
deliberately does **not** pin this row's original claim.

## Fix (applied)

`day_of_week` no longer runs a second calendar algorithm. The era-based
days-from-epoch computation that `to_unix` already had — correct for negative
years, and the one place the floor-vs-truncate problem is handled — is
extracted as `_days_from_civil(y, m, d)`, and both call it:

```rust
day_of_week : (fn(inout(self) : Self) -> u8)({
  days := _days_from_civil(i64(self.year), i64(self.month), i64(self.day));
  u8((((days + i64(3)) % i64(7)) + i64(7)) % i64(7))
}),
```

`+ 3` because 1970-01-01 was a Thursday (ISO 3); the `+ 7` before the second
`%` is what makes the result non-negative, since C's `%` keeps the sign of the
dividend and every pre-epoch date has a negative day count. This is the
"derive it from `to_unix`" option the original **Fix** section preferred, and
it is safe for the documented "weekday of the *local* date" semantics because
`to_unix` reads the civil fields as-if-UTC — the same local `y/m/d`
Sakamoto's algorithm was reading.

The module-level caveat and the method's "**Only valid for years 1 and
later**" note are removed, and `_validate`'s silence about the year is
documented as deliberate rather than as an oversight: negative years are
supported throughout, so rejecting them in `new` would be a narrowing.

### A trap for anyone porting this arithmetic

`era` is written `cond((y2 >= 0) => y2 / 400, true => (y2 - 399) / 400)`. The
second arm is a **workaround for C truncating toward zero**. Transcribing that
idiom into a language whose `/` already floors (Python's `//`, for one)
double-corrects, pushes `yoe` outside its `0..=399` range, and yields a
plausible-looking but wrong weekday. Both agents working on this hit it
independently while building a cross-check oracle. The cheap guard is to
assert `0 <= yoe <= 399` in the scratch derivation — it fails loudly on the
first negative year instead of returning a believable answer.

## Regression tests (added)

`tests/time/datetime.test.yo`, three of them, deliberately overlapping so no
single wrong assumption can make all three pass:

1. **the corrected table** — 2026, 1, 0, −1, −4, with expectations derived by
   the two routes above;
2. **an invariant sweep** — `day_of_week() <= 6` for every year in
   −500…500. This catches the `u8` wrap *independently of any per-date
   expectation*, which is the half that survives even if a table row is wrong,
   and it crosses the era boundary where a truncating divide misbehaves;
3. **a relative check needing no table at all** — consecutive days must step
   the weekday by exactly 1 (mod 7), walked across year 0's 29 February, so a
   wrong leap rule near the negative boundary shows up as a broken step.

All three fail against the pre-fix `std` (`Test failed with exit code 6`) and
pass after; the 19 pre-existing tests in the file are unaffected, as are
`tests/time/instant.test.yo` and `tests/time/duration.test.yo`. `to_unix` has
no other callers in `std/`, `src/` or `tests/`, so the extraction is contained.

Seed-gated check: `YO_STD=./std yo check std/time/datetime.yo` is clean under
the published v0.2.32 seed — the change is arithmetic only and needs no
compiler feature newer than the seed, so it is safe to land before a bump.
