# B3 explicit-copy dry run over std: the sites (2026-10-22)

The output of `yo fix ./std --migrate explicit-copy --std-path ./std --dry-run` (the plan's N1 std command, no `--hot-path`), by the `fix/explicit-copy-migration-defects` tree binary (3cb59050d, the tool that merged as #1537), on develop `12ecc08a3`'s `std/` (identical to `6cd3495c5`'s). The run took 0:48 at 275 MB. It would insert 52 `.clone()` calls and leaves 162 sites as written, and 0 files failed to evaluate. Nothing was applied.

- Insertions by kind: field-store 22, binding 20, param 7, assign 2, return 1. By directory: `std/encoding` 13, `std/http` 10, `std/fs` 9, `std/url` 8, `std/cli` 6, `std/regex` 2, and one each in `std/testing`, `std/path.yo`, `std/glob.yo` and `std/crypto`.
- Listed sites by reason: source written afterwards 76; a raw pointer into the source taken 33 (into the copy 2); returned from a `&` parameter 29; copied in a generic body 12 (at more than one type 2); returned from a borrowed binding 5; returned from a `&mut` borrow 3.
- Listed sites by directory: `std/regex` 36, `std/encoding` 27, `std/url` 18, `std/http` 15, `std/cli` 15, `std/string` 11, `std/collections` 8, `std/prelude.yo` 6, `std/net` 6, `std/process` 5, `std/fs` 5, `std/fmt` 5, `std/path.yo` 2, and one each in `std/log.yo`, `std/io` and `std/error.yo`.

This is B3's input (`plans/VALUES_BY_DEFAULT.md`, B3; the plan's older "97 left as written, 88 of them written after" predates the raw-pointer and dying-temporary guards). The `src/` counterpart is `VBD_B1_EXPLICIT_COPY_LISTING_2026-10-22.md`. Positions move when the tree does, so re-run the dry run on the tip before editing from it.

```text
fix: std/cli/arg_parser.yo:127:57: `(self._subcommand)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:215:15: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:216:22: `description` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:228:33: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:229:40: `description` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:270:22: `long_name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:271:23: `short_name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:272:24: `description` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:297:22: `long_name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:298:23: `short_name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:299:24: `description` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:301:26: `default_value` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:320:22: `name` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:322:24: `description` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:562:50: param: `(def._long_name)` would become `def._long_name.clone()`
fix: std/cli/arg_parser.yo:571:61: param: `(def._long_name)` would become `def._long_name.clone()`
fix: std/cli/arg_parser.yo:614:45: `(self._name)` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/cli/arg_parser.yo:664:63: param: `(p_def._long_name)` would become `p_def._long_name.clone()`
fix: std/cli/arg_parser.yo:631:58: field-store: `current_arg` would become `current_arg.clone()`
fix: std/cli/arg_parser.yo:707:45: param: `(def._long_name)` would become `def._long_name.clone()`
fix: std/cli/arg_parser.yo:708:46: param: `(def._default_value)` would become `def._default_value.clone()`
fix: std/collections/array_list.yo:1938:31: `self` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/collections/array_list.yo:1948:32: `self` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/collections/array_list.yo:457:33: `((_ptr.add)(index).(*))` is copied at more than one type (a generic body); left as written
fix: std/collections/array_list.yo:1993:17: `other(i)` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/collections/hash_map.yo:674:30: `((((Self._data_ptr)(self).add)(index).(*)).value)` is copied at more than one type (a generic body); left as written
fix: std/collections/hash_map.yo:1278:33: `(((data_ptr.add)((self._index)).(*)).key)` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/collections/priority_queue.yo:184:36: `(self._data)` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/collections/priority_queue.yo:229:37: `(self._data)` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/crypto/hmac.yo:41:25: assign: `key` would become `key.clone()`
fix: std/encoding/csv.yo:114:12: `input` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/csv.yo:181:22: `record` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/csv.yo:234:12: `field` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/csv.yo:249:16: `field` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/csv.yo:270:15: `records(r)` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/encoding/html.yo:217:12: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/html.yo:221:12: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/html.yo:396:12: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/encoding/json.yo:199:24: field-store: `s` would become `s.clone()`
fix: std/encoding/json.yo:219:36: field-store: `keys(i)` would become `keys(i).clone()`
fix: std/encoding/json.yo:231:8: `token` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/json.yo:339:42: `k` is returned from a `&mut` borrow, so a caller may write through it; return a projection (`-> &mut T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/json.yo:360:42: `k` is returned from a `&mut` borrow, so a caller may write through it; return a projection (`-> &mut T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/json.yo:400:14: binding: `tokens(ti)` would become `tokens(ti).clone()`
fix: std/encoding/json.yo:561:16: `src` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/json.yo:1228:12: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/json.yo:1560:18: binding: `a_keys(i)` would become `a_keys(i).clone()`
fix: std/encoding/json.yo:1773:52: `self` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/json.yo:1774:76: `v` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/encoding/percent.yo:93:12: binding: `input` would become `input.clone()`
fix: std/encoding/percent.yo:115:12: binding: `input` would become `input.clone()`
fix: std/encoding/toml.yo:304:41: `k` is returned from a `&mut` borrow, so a caller may write through it; return a projection (`-> &mut T`) or spell the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:349:48: field-store: `s` would become `s.clone()`
fix: std/encoding/toml.yo:463:13: `src` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:624:25: `path` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:1291:54: return: `(dec.text)` would become `dec.text.clone()`
fix: std/encoding/toml.yo:1624:10: `keys(i)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:1632:21: param: `child_path` would become `child_path.clone()`
fix: std/encoding/toml.yo:1666:16: `keys(last)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:1875:10: `keys(i)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:1878:28: assign: `child_path` would become `child_path.clone()`
fix: std/encoding/toml.yo:1985:8: binding: `keys(last)` would become `keys(last).clone()`
fix: std/encoding/toml.yo:2071:21: `(p.cur_path)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2075:10: `keys(i)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2112:16: `keys(last)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2216:8: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2247:8: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2288:8: `key` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/encoding/toml.yo:2360:8: binding: `text` would become `text.clone()`
fix: std/encoding/toml.yo:2704:18: binding: `a_keys(i)` would become `a_keys(i).clone()`
fix: std/error.yo:223:20: `message` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/fmt/format.yo:121:34: `decimal` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/fmt/index.yo:48:16: `s` is copied and a raw pointer into the copy is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/fmt/spec.yo:97:23: `text` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/fmt/spec.yo:228:23: `body` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/fmt/to_string.yo:349:7: `self` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/fs/dir.yo:142:22: binding: `path_s` would become `path_s.clone()`
fix: std/fs/dir.yo:436:12: binding: `raw(i)` would become `raw(i).clone()`
fix: std/fs/dir.yo:469:18: field-store: `(r.name)` would become `r.name.clone()`
fix: std/fs/file.yo:205:21: `data` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/fs/walker.yo:156:17: `p` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/fs/walker.yo:208:25: field-store: `root_s` would become `root_s.clone()`
fix: std/fs/walker.yo:211:19: binding: `(item.path)` would become `item.path.clone()`
fix: std/fs/walker.yo:234:32: field-store: `(entry.name)` would become `entry.name.clone()`
fix: std/fs/walker.yo:254:28: field-store: `(entry.name)` would become `entry.name.clone()`
fix: std/fs/walker.yo:270:28: field-store: `(entry.name)` would become `entry.name.clone()`
fix: std/fs/walker.yo:284:19: `pending_links(j)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/fs/walker.yo:321:9: `pattern` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/fs/walker.yo:373:37: field-store: `(parts.rest)` would become `parts.rest.clone()`
fix: std/fs/watch.yo:118:14: `(w._waiters)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/glob.yo:237:21: field-store: `pattern` would become `pattern.clone()`
fix: std/http/client.yo:117:17: `body` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/client.yo:374:37: `key` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/http/client.yo:399:13: binding: `parts(i)` would become `parts(i).clone()`
fix: std/http/client.yo:529:49: field-store: `scheme` would become `scheme.clone()`
fix: std/http/client.yo:823:16: `location` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/http/client.yo:836:39: `(opts.body)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/http/http.yo:81:17: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:81:31: `value` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:121:24: field-store: `(h.value)` would become `h.value.clone()`
fix: std/http/http.yo:138:20: param: `(h.value)` would become `h.value.clone()`
fix: std/http/http.yo:224:34: `path` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:234:17: `body` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:250:17: `body` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:469:41: `status_text` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/http.yo:505:17: `body` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/http/http.yo:575:16: `raw` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/http/http.yo:593:18: binding: `lines(usize(0))` would become `lines(usize(0)).clone()`
fix: std/http/http.yo:639:14: binding: `lines(j)` would become `lines(j).clone()`
fix: std/http/http.yo:672:16: `raw` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/http/http.yo:690:19: binding: `lines(usize(0))` would become `lines(usize(0)).clone()`
fix: std/http/http.yo:702:48: field-store: `parts(usize(0))` would become `parts(usize(0)).clone()`
fix: std/http/http.yo:705:14: binding: `parts(usize(2))` would become `parts(usize(2)).clone()`
fix: std/http/http.yo:715:14: binding: `lines(j)` would become `lines(j).clone()`
fix: std/http/wire.yo:98:10: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/http/wire.yo:184:12: `value` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/io/bufio.yo:259:16: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/log.yo:247:12: `s` is copied and a raw pointer into the copy is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/net/addr.yo:74:14: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/net/addr.yo:154:14: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/net/addr.yo:795:12: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/net/dns.yo:78:120: `host` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/net/dns.yo:85:51: `host` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/net/unix.yo:124:5: `(self._path)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/path.yo:403:23: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/path.yo:421:23: `name` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/path.yo:665:21: binding: `(self._segments)` would become `self._segments.clone()`
fix: std/prelude.yo:9147:21: `value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/prelude.yo:8264:23: `value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/prelude.yo:8265:16: `or_value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/prelude.yo:9272:21: `value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/prelude.yo:9273:18: `or_value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/prelude.yo:8256:23: `value` is copied in a generic body, where `.clone()` would demand `Clone` of every instantiation; left as written
fix: std/process/command.yo:191:18: `program` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/process/command.yo:203:21: `a` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/process/command.yo:230:14: `key` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/process/command.yo:241:37: `dir` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/process/command.yo:772:16: `data` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/compiler.yo:390:43: `ranges` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/compiler.yo:558:15: `((self._program).instructions)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/flags.yo:93:14: binding: `flags_str` would become `flags_str.clone()`
fix: std/regex/index.yo:108:28: `pattern` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:123:5: `(self._pattern)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:158:10: `s` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:181:15: `((self._program).literal_prefix)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:231:14: `input` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:275:14: `input` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:332:14: `input` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:456:16: `(self._input)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/index.yo:540:16: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:566:18: `replacement` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:722:16: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:724:24: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:763:42: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:765:24: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:806:16: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:808:24: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:834:42: `input` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:836:24: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:892:20: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/index.yo:895:24: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:53:16: `value` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:56:16: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:57:17: `groups` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:58:22: `group_spans` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:65:5: `(self._value)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:94:5: `(self._input)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:105:34: `(self._value)` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/match.yo:109:48: `(self._groups)(actual_idx)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/regex/node.yo:189:16: `ranges` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/regex/parser.yo:94:17: `pattern` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/vm.yo:175:16: `input` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/vm.yo:343:65: `(thread.slots)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/vm.yo:542:13: `(self._seen)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/vm.yo:543:18: `(self._next_seen)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/regex/vm.yo:798:58: field-store: `(thread.slots)` would become `thread.slots.clone()`
fix: std/string/string.yo:279:17: `al` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/string/string.yo:290:20: `al` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/string/string.yo:743:61: `current_bytes` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string.yo:2286:27: `self` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string.yo:2290:27: `self` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string.yo:2294:27: `self` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string.yo:2325:33: `self` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string.yo:2574:27: `self` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/string_builder.yo:187:14: `(self._buf)` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/string/unicode.yo:2183:29: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/string/unicode.yo:2214:29: `input` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/testing/bench.yo:194:12: field-store: `name` would become `name.clone()`
fix: std/url/index.yo:545:5: `(self._scheme)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:556:5: `(self._host)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:576:5: `(self._path)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:586:5: `(self._query)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:592:5: `(self._fragment)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:606:5: `(self._userinfo)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:888:8: `s` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:622:24: `scheme` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/url/index.yo:855:18: `forbidden` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:654:50: field-store: `h` would become `h.clone()`
fix: std/url/index.yo:684:26: `path` is copied and its source is written afterwards, so the two may share a buffer on purpose; spell a borrow (`&mut`) or the copy (`.clone()`) by hand
fix: std/url/index.yo:703:47: field-store: `q` would become `q.clone()`
fix: std/url/index.yo:725:50: field-store: `f` would become `f.clone()`
fix: std/url/index.yo:750:50: field-store: `u` would become `u.clone()`
fix: std/url/index.yo:769:26: field-store: `h` would become `h.clone()`
fix: std/url/index.yo:785:16: `(self._scheme)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:808:52: `s` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:914:11: `s` is copied and a raw pointer into its source is taken, so the program may reach one buffer through both; move it with the pointer taken first, or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:986:12: binding: `segs(i)` would become `segs(i).clone()`
fix: std/url/index.yo:1033:16: `ref_path` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:1043:67: `h` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:1122:39: field-store: `q` would become `q.clone()`
fix: std/url/index.yo:1124:88: `(self._query)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:1162:19: `(self._path)` is returned from a `&` parameter, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:1189:41: `v` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
fix: std/url/index.yo:1196:15: binding: `parts(i)` would become `parts(i).clone()`
fix: would insert 52 `.clone()` call(s); 162 site(s) left as written (listed above); 0 file(s) did not evaluate
```
