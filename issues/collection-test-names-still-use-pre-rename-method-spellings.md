# 37 collection tests are named after methods that no longer exist (`add`, `has`, `set`, `min`/`max`, `iter_ptr`)

**Status:** OPEN
**Severity:** papercut — the assertions are correct and green; only the test
*names* are wrong, and they are the tree's index of collection coverage.
**Found:** 2026-09-04, during the std-API audit re-measurement of the
`collections/*` row, while looking for `insert` coverage in
`tests/collections/`.

The §5 API-rename sweep (`plans/STD_API_AUDIT.md:575-582`, DONE 2026-08-25)
renamed the map/set mutators and accessors and migrated every call site. It did
not touch the string literals in `test("...")`, so 37 tests across five files
still advertise methods that were deleted in that sweep. `--test-name-pattern`
matches against exactly those strings (`AGENTS.md` documents it as the way to run
one test), so grepping the suite for `insert` coverage finds nothing and grepping
for `add` finds tests for a method that does not exist.

## Reproducer

```
$ grep -n 'test("' tests/collections/hash_set.test.yo | head -6
5:test("HashSet.new creates empty set", {
10:test("HashSet.with_capacity creates set with specified capacity", {
16:test("HashSet.with_capacity rounds up to power of 2", {
22:test("HashSet.with_capacity with small capacity uses default", {
29:test("HashSet.add inserts new element", {
36:test("HashSet.add returns false for duplicate element", {

$ sed -n '29,34p' tests/collections/hash_set.test.yo
test("HashSet.add inserts new element", {
  set := HashSet(i32).new();
  result := set.insert(i32(42));
  assert(result.is_ok());
  assert(result.unwrap() == true);
  assert(set.len() == usize(1));
});

$ grep -n '^  add :\|^  has :\|^  set :\|^  min :\|^  max :\|^  iter_ptr :' std/collections/*.yo
$ echo $?
1
```

The name says `add`, the body calls `insert`, and `add` exists nowhere in
`std/collections/`. Expected: the name and the body agree.

## The full inventory

| file | lines | says | method actually called |
| --- | --- | --- | --- |
| `tests/collections/hash_set.test.yo` | 29, 36, 44, 51, 468 | `HashSet.add` | `insert` |
| `tests/collections/hash_set.test.yo` | 61, 66, 71, 75 | `HashSet.has` | `contains` |
| `tests/collections/hash_map.test.yo` | 30, 37, 47, 54, 258 | `HashMap.set` | `insert` |
| `tests/collections/hash_map.test.yo` | 100, 105, 110, 114 | `HashMap.has` | `contains_key` |
| `tests/collections/hash_map.test.yo` | 474, 484 | `HashMap iter_ptr` | `iter` |
| `tests/collections/btree_map.test.yo` | 11, 20, 30, 40, 47 | `BTreeMap.set` | `insert` |
| `tests/collections/btree_map.test.yo` | 111, 121, 131, 135, 139 | `BTreeMap.min` / `.max` | `first_entry` / `last_entry` |
| `tests/collections/linked_list.test.yo` | 399, 406, 412, 416, 423, 430 | `LinkedList.has` | `contains` |
| `tests/collections/array_list.test.yo` | 544 | `ArrayList.set` | index assignment `&(list(i)).* = v` |

37 names in five files. Nothing outside `tests/collections/` is affected — the
same grep over the rest of `tests/` finds no stale collection method name.

The `ArrayList.set` case (`array_list.test.yo:544`) is different in kind and
worth reading before renaming: `ArrayList` has never had a `set` method. The
body exercises the `Index` impl's pointer assignment,
`&(list(usize(1))).* = old_box`, and what it actually pins is that the
overwritten `Box` is dropped. Its name should say that, not name a method.

## Root cause

`plans/STD_API_AUDIT.md:575-582` records the renames:

- "Map/set `set`/`add` → `insert`"
- "`HashMap.iter_ptr` → `iter`"
- "`BTreeMap min/max` → `first_entry`/`last_entry` (returns a whole entry); sets
  keep `min`/`max` (return the element)"

and the sweep landed with the call sites migrated — every body in the table above
already calls the new name, which is why the suite is green and nothing flagged
the drift. A method rename has no mechanical relationship to a test's name
string, and there is no check that ties them together, so the names were simply
left behind.

`LinkedList.has` → `contains` is the same rename applied to a sequence type
(`.github/instructions/yo-design.instructions.md:522` fixes `contains` as the
membership spelling for sequences and sets, `contains_key` for maps).

## Fix

Rewrite the 37 name strings to the current spellings. They are pure string edits
inside `test("...")` and change no assertion:

- `HashSet.add …` → `HashSet.insert …`
- `HashSet.has …` → `HashSet.contains …`
- `HashMap.set …` → `HashMap.insert …`
- `HashMap.has …` → `HashMap.contains_key …`
- `HashMap iter_ptr …` → `HashMap iter …`
- `BTreeMap.set …` → `BTreeMap.insert …`
- `BTreeMap.min …` / `.max …` → `BTreeMap.first_entry …` / `.last_entry …`
  (including `:139` "min and max same for single entry" →
  "first_entry and last_entry same for single entry")
- `LinkedList.has …` → `LinkedList.contains …`
- `array_list.test.yo:544` "ArrayList.set with Box replaces and cleans up old
  value" → "ArrayList index assignment with Box replaces and drops the old
  value", which is what the body asserts.

Do the edits by hand or verify the count: a blind `sed` over `test("` risks
touching a name where the old word is legitimate prose. After the rename, the
sanity check is that

```
grep -c 'test("HashSet.insert' tests/collections/hash_set.test.yo
```

reports 5 and the corresponding greps for `add`/`has`/`set`/`min`/`max`/`iter_ptr`
report 0, and that the file count of `test(` in each file is unchanged.

Run `yo fmt` on the five files and re-run
`yo test ./tests/collections --parallel 1` to confirm the same number of tests
still pass.

## Regression test

There is no assertion to add — the fix is the rename. What prevents recurrence is
making the next rename sweep include its test names: add a line to
`.github/instructions/yo-design.instructions.md`'s rename table section saying
that a method rename must also rewrite the `test("<Type>.<method> …")` strings
that name it, since `--test-name-pattern` is the documented way to run one test.

## Scope check — what this does NOT break

The §9 export-coverage read (`plans/STD_API_AUDIT.md:868-877`) greps every
`export(...)` name across the whole of `tests/`, bodies included, so it is
unaffected: `insert`, `contains`, `contains_key`, `first_entry` and `last_entry`
all appear in the bodies and score as covered. The damage is confined to the
names themselves — `--test-name-pattern`, the failure messages the runner prints,
and any human reading the test list as an index of what is covered.
