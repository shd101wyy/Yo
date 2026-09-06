# std API stabilization — raw findings by module group (2026-09-06)

Companion to `plans/STD_API_STABILIZATION.md` (the decisions and the ranked list). Every item here was verified by reading the implementation; file:line references are as of develop `e27f253eb`. Known/filed issues were excluded by the auditors and are not repeated.

---

## collections + imm — verified file:line

## P0
1. imm/vec.yo RC leaks: _copy_elems (87-100) dups; push grow (144-149) frees old buffer without dropping; concat grow (236-247) same; pop unique path (189-193) leaves slot outside Dispose loop (56-63). Deque._grow (deque.yo:60-72) and ArrayList.pop (array_list.yo:250) do it right. Tests i32/no-grow only (tests/imm_vec.test.yo:266).
2. imm/vec.yo drops uninitialized memory: bare `p.* = v` into fresh malloc in map (292), filter (304), reverse (281), dedup (408), zip_with (425) → consume(...).
3. HashMap/HashSet tombstones never reclaimed: remove writes CTRL_DELETED (hash_map.yo:429, hash_set.yo:385); _needs_resize tests live size only (hash_map 254-259, hash_set 246); _find_bucket stops only at EMPTY (204-234) → O(capacity) probes under churn. Track tombstones; rehash in place.
4. Deque._grow unchecked new_cap*sizeof(T) + doubling wrap (deque.yo:50-52); imm/vec._raw_alloc same (vec.yo:79) — C35 residual.
5. imm to_list/from_list not inverses: Set.to_list -> List(T) (set.yo:154) vs from_list(ArrayList) (158); sorted_set 63/180, list 208, vec 430; three names for one conversion (from_list / from_entries map.yo:972 sorted_map.yo:627 / FromIterator) → FromIterator on every imm type + to_array_list.

## P1
6. Zero IntoIterator/Iterator on any imm collection (7 hits all in std/collections) — cannot for/map/collect imm Vec/List/Map/Set/SortedMap/SortedSet; Map.keys() -> List(K) un-iterable.
7. Trait matrix: ArrayList Eq/Clone/Default/ToString/Index/IntoIter/FromIter (no Ord/Hash); HashMap Clone/Index/IntoIter only; HashSet IntoIter/FromIter only; BTreeMap Index/IntoIter; Deque Index/IntoIter/FromIter; LinkedList Index/IntoIter; PriorityQueue IntoIter; OrderedMap NOTHING (no IntoIter); imm types Eq (+Index Vec/List); ImmString Eq/Ord/Hash/ToString. Default on 1/9; ToString 1/9; Hash/Ord none.
8. ArrayList missing: first, last, insert(idx,v), swap, swap_remove, truncate, resize(n,v), fill(v), dedup, split_off, append, chunks, windows, starts_with/ends_with, concat/join, sort_by_key, binary_search_by, iter().rev(). Non-Rust: index_of (position), ensure_total_capacity (reserve — TOTAL vs Rust's ADDITIONAL: footgun), slice_copy. sort is heapsort = UNSTABLE (array_list.yo:936, _heapsort_by 853) under Rust's stable name → sort_unstable + stable sort.
9. ArrayList.retain O(n²) with alloc per removal (1160-1173: drain per reject, drain allocs Self :352).
10. HashMap: get_or_insert/_with/update_with double-probe (488-521); update_with non-Rust; missing entry API proper, remove_entry, get_key_value, retain, extend, FromIterator (D3.4 compiler-blocked — recheck), values_mut, into_keys/values, drain, reserve, capacity() method.
11. Deque missing front/back (!), with_capacity, clear, contains, capacity, truncate, rotate_*, insert/remove, make_contiguous, extend, drain.
12. BTreeMap.insert -> unit (btree_map.yo:77; old value dropped :82) — D2 violation; no contains_key; missing clear/entry/range/pop_first/pop_last/retain/append/extend/FromIterator/Default; :86 discards push Result → :87 len()-1 underflow.
13. PriorityQueue is a MIN-heap (priority_queue.yo:41/69) vs Rust BinaryHeap MAX → flip + Reverse(T) or rename MinHeap; missing with_capacity/clear/into_sorted_vec/into_vec/from(list) O(n) heapify/extend/FromIterator/peek_mut/drain/Clone/Default; push discards Result (:49) then len()-1; iter takes inout(self) (:187) unlike others.
14. LinkedList.remove -> Result (linked_list.yo:264) vs ArrayList.remove -> T/panic (array_list.yo:434) — D1 one-op-two-styles; no DoubleEndedIterator despite prev pointers; missing append/split_off/traits/FromIterator; Index on O(n) (482).
15. OrderedMap.remove rebuilds _order (ordered_map.yo:97-124) O(n); missing swap_remove/shift_remove/get_index/get_index_of/insert_full/Index/IntoIterator/retain/sort_keys/pop/Eq/Clone/Default.
16. imm Map/SortedMap/Set/SortedSet remove -> Self discards presence/value (map.yo:905, sorted_map.yo:565, set.yo:53, sorted_set.yo:51); insert -> Self drops old value → return (Self, Option(V)) like PopResult (vec.yo:66).
17. imm/Vec documented persistent but is flat COW: push on shared copies n (vec.yo:156-168), set (129-137), pop (195-201); doc vec.yo:1,34-36 → fix doc or implement RRB; dedup (369) O(n²) and removes ALL dups (Rust dedup = consecutive; this is `unique`).
18. Public internals: HashMap ctrl/data/capacity/size/k0/k1 (hash_map.yo:52-62), HashSet (hash_set.yo:49-58), LinkedList head/tail/length (linked_list.yo:24-27) — D2 bans pub size.

## P2
19. Doc coverage (std/imm 100%): priority_queue.yo 7/7 (29,33,37,41,48,69,187); deque.yo 9 (33,37,41,84,95,109,124,142,277); btree_map.yo 9 (34,38,42,68,77,98,199,228,257); array_list.yo 5 (30,39,112,1088,1097; from_array doc orphaned 69-74); ordered_map 3; hash_map keys:721 values:769; hash_set iter:821; linked_list iter:471.
20. HashSet = 498 byte-identical lines of HashMap (of 929) → HashSet(T) := HashMap(T, unit) (unit is ZST now); imm/set vs imm/sorted_set only 74 lines differ → one generic set algebra over a map trait.
21. ArrayListError.EmptyList never constructed (array_list.yo:14); IndexOutOfBounds only from slice (457-461), start>end payload misleading.
22. push -> Result coin flip: ArrayList.push Result (182) but ensure_total_capacity panics (551), with_capacity panics (135), HashMap.new/with_capacity panic (130/177) vs insert Result (337), Deque.push_back unit+unwrap (52); EVERY internal caller discards the Result (array_list 86/118/1093/1101/1116/1180/1014, btree_map 86, priority_queue 49, ordered_map 87, hash_map! macro) → push -> unit (abort) + try_push -> Result. D1 decision needed once.
23. iter() means two things: ArrayList.iter yields VALUES (762), OrderedMap.iter MapEntry values (259); others yield pointers (D2 says iter = pointers).
24. ImmString.replace first-only (imm/string.yo:463); replace_all O(n·k) re-concat (478).
25. btree_map.yo:184, priority_queue.yo:172 read ArrayList._ptr directly (use ptr()).
26. imm/List drops recursively (list.yo:25-34 ListNode, no iterative Dispose) → stack overflow on long lists; LinkedList has iterative clear (linked_list.yo:328).
27. hash_map.yo:195/232 says "quadratic probing", code is linear; :344-349 stream-of-consciousness comment; ordered_map.yo:10-11 doc uses `set`; imm/vec.new mallocs 4 for empty (vec.yo:103); imm/List lacks any/all/find/index_of that imm/Vec has; set_len/fill_with_byte/resize_with_byte/extend_from_ptr unsafe-but-unmarked on ArrayList.

---

## text + encoding (string/fmt/encoding/json/toml/csv/regex/url/path/glob) — verified file:line

## P0
1. html_decode O(n²): result rebuilt via template per char (html.yo:145 fn; hot :162; +12 sites) → StringBuilder.
2. glob `*` exponential backtracking + per-byte recursion (glob.yo:5, `*` arm 22-88) → two-pointer greedy matcher.
3. fmt.Writer.to_string aliases live buffer: String.from_bytes stores ArrayList BY REF (string.yo:77; array_list.yo:18 ref struct), writer never resets (writer.yo:187) → copy+reset or consuming into_string.
4. base64_decode accepts len%4==1, unchecked trailing bits, any number of '=' (base64.yo:79-108, :110); EncodingError lacks InvalidLength/InvalidLastSymbol (error.yo:19).
5. Path.strip_prefix has node `relative` semantics under Rust's name (path.yo:561) → rename relative_to, add real strip_prefix -> Option(Self) (starts_with :402).
6. html entity tables lazy-init via unsynchronised globals (html.yo:21-31) → Once/atomic.

## P1
7. D1 violations (effects for pure transforms): Url.parse(s, exn) url/index.yo:150; json_parse/_bytes/_string json.yo:791,782,804 (json_parse_result :1337 is correct — two styles in one file); base64_decode/_url base64.yo:110,114; hex_decode hex.yo:~57; utf16_to_utf8 utf16.yo:~60; toml_parse Result(_, String) toml.yo:147.
8. JsonError.Other(String) as primary error (json.yo:1038-1335); ToString drops UnexpectedChar payload (:47) → TypeMismatch(expected, found), Trailing, line/col.
9. String.parse_* return Option (string.yo 2226 bool, 2438 f64, 2521 i32, 2536 i64, 2542 u32, 2557 u64, 2456/2497 radix) → FromStr trait + s.parse(T) -> Result(T, ParseError); overflow vs garbage indistinguishable (_radix_magnitude :2405).
10. String.replace replaces FIRST (string.yo:1606), replace_all (:1643) — Rust replace = all → swap; add replacen.
11. No next_back on StringChars (:1753)/StringCharIndices (:1821)/StringBytes (:1789)/StringLines (:2010) → chars().rev() impossible (D4 said iterator-only).
12. String.lines() keeps trailing \r (string.yo:2010-2058); byte-at-a-time copy anti-pattern.
13. rune classification ASCII-only under Unicode names: is_whitespace:27, is_alphabetic:35, is_uppercase:39, is_lowercase:43, to_lowercase:47, to_uppercase:54 (rune.yo) → rename is_ascii_*/to_ascii_*, add Unicode via unicode.yo (to_upper/lower_code_point :2225); missing is_alphanumeric/is_numeric/is_control/to_digit/from_digit/len_utf8/encode_utf8/MAX.
14. Trait coverage: rune only Eq/Ord/Send (rune.yo:83-103) — no Hash/ToString/Clone/Default; JsonValue none of Eq/Clone/ToString/Default; TomlValue none; Url only ToString (url/index.yo:500); Regex/GlobPattern/StringBuilder/Writer none; Path has all but Default.
15. Url missing: join (http hand-rolls redirects, C33), query_pairs, path_segments, username/password (raw userinfo :467), port_or_known_default, domain, set_* setters, from/to_file_path, has_authority, dot-segment normalisation; host_port/origin non-Rust names (449-499).
16. JsonValue.Object: parallel ArrayLists, O(n) get (:91)/Index (:169); no insert/object()/remove/is_*/as_i64/as_u64 (as_number f64 only)/pointer (RFC 6901); at(index) = serde get(index).
17. TOML ~1/3: TomlValue Str/Int/Bool/Table only (toml.yo:15-24); no floats/arrays/datetimes/inline tables/[[x]]/dotted keys/multiline/literal strings/escapes ("a\"b" mis-parses :113)/inline comments (:181)/serializer; has_key:52→contains_key, table_len:80→len/is_empty, insert:56 no old value.
18. Regex JS-shaped: exec=find/captures, test=is_match, match_all dup of find_iter, search re-runs match, RegexMatch.value=as_str, group=get, named_group=name, group_count=len, source=as_str; new(pattern, flags) :56 vs compile(pattern) :98 inverted vs Rust; JS flags g/y; no x; missing splitn/replacen/shortest_match/capture_names/find_at/captures_len (regex/index.yo:56-812, match.yo:32-108).
19. fmt.Alignment required by exported FormatSpec.pad (index.yo:20) but not re-exported (writer.yo:21).
20. Two builders, three vocabularies: StringBuilder(write_*), fmt.Writer(write_* chainable + numerics), String(push_*) → one builder + trait.
21. fmt.Writer byte-at-a-time appends (writer.yo:41,48,64); write_padded pads by BYTES (:145) vs FormatSpec by runes (spec.yo:71).
22. StringBuilder.to_string copies byte-at-a-time (119-141) and CONSUMES (non-consuming name) → into_string + non-consuming ToString; clear:144 reallocates.
23. EncodingError thin: utf16 throws InvalidChar(u8(0)) for unpaired surrogate (utf16.yo ~72,80,92), no offset → InvalidChar(byte, index), UnpairedSurrogate(index, unit), InvalidLength(len).
24. GlobPattern.new doesn't compile/validate (glob.yo:191); `[a-z]` ranges NOT implemented (133-150: literal compare); no filesystem globbing, MatchOptions, matches_path.

## P2
25. String missing: splitn, rsplit, rsplitn, split_terminator, split_whitespace, split_at, trim_matches/_start_matches/_end_matches, replacen, matches/match_indices, eq_ignore_ascii_case, is_ascii, insert/insert_str, remove, truncate, pop, capacity, shrink_to_fit, retain. Non-Rust names: index_of=find (:1537), last_index_of=rfind (:1542), at=chars().nth (:268), byte_at, substring, concat, to_cstr.
26. trim ASCII-only (string.yo:1001 _is_whitespace_byte) under "like JS trim" doc → trim_ascii or Unicode.
27. base64 _decode_char 64-entry linear scan per char (base64.yo:66-78); no hex_encode_upper.
28. Module-prefix stutter: base64_encode, hex_decode, json_parse, csv_parse, toml_parse, html_decode, glob_match (D2 blesses encode/decode, parse/stringify); csv_write→stringify; json_stringify_pretty→stringify_pretty.
29. No std/encoding barrel; string/index.yo omits unicode.yo.
30. csv whole-string codec: no headers/StringRecord/streaming/flexible/quote_style/comment; csv_parse_strict mandatory opts asymmetric; mid-field quote errors (crate default lenient); CsvOptions.default:72 undocumented.
31. JSON Number f64 only (json.yo:71) → Int(i64)/UInt(u64) arms.
32. percent_decode non-InvalidUtf8 StringError → TruncatedEscape(0) fabricated (percent.yo ~135); no encode sets (PATH/QUERY/FRAGMENT/USERINFO).
33. Path: push (807) no pop; no set_extension/set_file_name/display/has_root/is_empty/Default; components (518) ArrayList(String) no Component enum; ancestors (821) eager.
34. Doc coverage: url/index.yo 10/10 undocumented (150,449-484 use //); glob.yo 3/3 (180,191,194); json.yo 30/47; regex/index.yo 14/22; string.yo 32/96 (Pattern impls 1339-1496); regex/match.yo 6/10; path.yo 4 (732,756,807,821); csv default:72.
35. Byte/char inconsistencies: writer.write_padded bytes vs FormatSpec runes; html_decode rune table vs html_encode bytes (html.yo:92 vs :319); glob ? and [...] match one byte (glob.yo:103,114) undocumented.

---

## io/fs/net/http/process/time (agent report, 2026-09-06) — verified file:line

## P0
1. Result(_, String) in exported APIs (D1 BANNED): env.yo:166 cwd, :266 current_exe, :414 chdir (io-path → should throw IoExn); http/http.yo:231 parse_response, :313 parse_request → HttpParseError enum + HttpError.Malformed(HttpParseError).
2. IpAddr.parse_v4 (net/addr.yo:37-88): "..." → 0.0.0.0 (no digits-in-octet flag); octet accumulation overflows u32 unchecked ("4294967297.0.0.0" → 1.0.0.0). Tests don't cover.
3. UdpSocket.bind echoes bind arg (udp.yo:87) — ephemeral port reports 0; TCP got the C2 fix (tcp.yo:168-181), UDP didn't. Test asserts only loopback.
4. UdpSocket.send requires connect which doesn't exist (udp.yo:119-126) → dead API. Add connect(self, addr, io).
5. http/server.yo has no `## Stability` marker (fs/watch.yo:28 does) → frozen prematurely.
6. One malformed request kills HttpServer.serve (server.yo:86-113): read_http_message throws propagate out of serve loop (remote DoS). Per-connection handler answering 400/413.
7. Child.kill returns raw i32 errno (process/command.yo:635) → should throw IoExn; add no-arg kill()=SIGKILL.
8. DateTime.now() returns UTC labelled local (datetime.yo:117-119) → resolve offset or delete.

## P1
9. UdpSocket.recv_from returns raw sockaddr buffer (udp.yo:112); _sockaddr_to_socket_addr private in tcp.yo:58; _make_sockaddr duplicated tcp.yo:36/udp.yo:34 → shared net/_sockaddr.yo; return struct(n, from : SocketAddr).
10. SocketAddr/IpAddr: ToString only — no Eq/Hash/Ord/Clone (addr.yo:142-175, 202-221). V6 holds Array(u16,8) (Array Hash exists post-#434).
11. No parse_v6, no IpAddr.parse, no SocketAddr.parse; IpAddr lacks any_v6/octets/segments/is_unspecified/is_multicast/is_private → Result(_, AddrParseError).
12. Child has no Reader/Writer pipe handles (command.yo:573-633): write_stdin/read_*_to_end only; wrap fds like File.from_fd (file.yo:198); _drain_fd (command.yo:430) = read_to_end reimplemented.
13. No Seek trait (File.seek inherent file.yo:207; SeekFrom in fs/types.yo); Stdout/Stderr have only raw write (stdio.yo:70,86) — add write_string/write_bytes (BufWriter has them bufio.yo:235,250); Reader.read_exact not a trait default (BufReader inherent bufio.yo:137).
14. Watcher (fs/watch.yo:322-421) has close() but no Dispose — the only handle type without; _queue unbounded (line 326).
15. IpAddr.parse_v4 uses effect style + NetError.Other(String) for a pure parse (D1 row 2) → Result(IpAddr, AddrParseError); NetError.DNSFailed(msg) payload is the hostname (dns.yo:229), EAI code discarded.
16. HTTP: status bare i32 (http_status_text 13 codes http.yo:133-149); headers ArrayList(HttpHeader), no remove/get_all; body String (http.yo:156) — parse_response reassembles body via string concat (http.yo:290-300) so binary bodies broken client-side (parse_request fixed at :313); Connection: close forced (client.yo:171, server.yo:95); only first DNS answer tried (client.yo:191).
17. Metadata timestamps bare i64 secs (metadata.yo:55,59,70); no SystemTime/UNIX_EPOCH in std/time.
18. fs gaps: OpenOptions (OpenMode 5 combos fs/types.yo:172), read_dir materializes whole ArrayList (dir.yo:352), Metadata.file_type(), created(), File.try_clone.
19. Command gaps: Child.try_wait, env_remove, envs, get_program/get_args; Child.pid → id; Output.stdout_string helper.
20. Tcp gaps: TcpStream.local_addr (peer_addr is the connect ARG not getpeername, tcp.yo:374), connect_timeout, set_*_timeout, set_nonblocking, ttl, TcpListener.incoming; bind ignores SO_REUSEADDR setsockopt result (tcp.yo:147); UnixStream.pair, UnixListener.incoming.

## P2
21. Naming: get_header (http.yo:91,166) vs builder header(); set_header APPENDS (http.yo:83; set_host twice → 2 Host lines); Metadata.size→len; modified_time→modified; env.get/set/remove vs var/set_var/remove_var (env.set returns bool env.yo:57); fs.append_file; dns.resolve; Child.pid→id.
22. Underscore names exported: fs/types.yo:208 (_open_mode_to_flags,_open_mode_needs_perm), :251 (_seek_from_to_whence — no consumer, delete).
23. Duration: from_secs/millis/nanos(i64) accept negatives (duration.yo:24,28,40) breaking Ord (line 176) and to_string; missing Mul/Div by int, checked_*/saturating_*, from_mins/hours, MAX; to_string "5s 0ns".
24. Instant: add/sub named only (instant.yo:267,277), no operators, no Hash/ToString; DateTime no Hash.
25. DateTime no format()/strftime; parse RFC3339 only (no RFC2822/HTTP-date).
26. IpAddr.V6.to_string never emits :: (addr.yo:155-169) — RFC 5952.
27. fs.copy reads whole file (file.yo:464-472); io/copy streams (io/index.yo:121).
28. Blocking syscalls in io.async bodies: chmod file.yo:450, realpath :549, readlink dir.yo:257, mkdtemp/mkstemp temp.yo:61,154.
29. File.read/write truncate size to u32 (file.yo:119,130,145,162; sys/file.yo:37,42).
30. Doc coverage (// not ///): metadata.yo 13, duration.yo 13, temp.yo 11, datetime.yo 7, dir.yo 6 (_str variants), fs/types.yo 4, walker.yo 4, http/wire.yo 4, instant.yo 3, command.yo env_clear misattributed (162-171).

---

## core (prelude traits, Option/Result, error, hash, rand, crypto, log, bench) — verified file:line

## P0
1. Rng.range(x,x)/next_below(0) SIGFPE: rand.yo:68 `((0 - bound) % bound)`; range (77-80) high<low → wrapped garbage; doc :75-76 claims panic. Fix: assert bound != 0, assert high > low, span in u64. No empty-range test (tests/rand.test.yo:32-56).
2. std/log globals raced: log.yo:81-84 globals; set_level/set_output/set_timestamps (89-101) no lock; enabled (108-110) no lock; log_lazy (168-172) checks outside mutex; only _emit (:126) locks; module doc 14-20 promises a single mutex. Fix: atomics or take _log_mutex in setters/getters.

## P1
3. derive_rules degrade silently on non-struct/enum: Eq → always true (prelude.yo:7034); Ord → all equal (7400-7403); Hash → feeds nothing (7219); Clone → shallow self (7139); ToString → type name (fmt/to_string.yo:490-499). derive(Default) does it right (7428-7431 comptime_assert). Fix: copy the assert into all four.
4. No checked_/wrapping_/saturating_/overflowing_ arithmetic anywhere (zero grep hits); also missing abs/pow/signum/clamp/min/max/leading_zeros/trailing_zeros/count_ones/rotate/is_power_of_two/next_power_of_two/abs_diff. Present: MIN/MAX (prelude 1194…4120), From/Into widening (8391-8403).
5. Floats have no methods: impl(f64) only Default/Send/Acyclic/Comptime/Runtime/From(f32) (prelude 796, 3638-3641, 8390); no MIN/MAX/EPSILON/INFINITY/NAN, sqrt/abs/floor/ceil/round/is_nan; only libc/math (no std module imports it). f64 has NaN-total cmp (3523-3528).
6. Numeric parsing returns Option (string.yo:2517-2557: parse_i32/i64/u32/u64/_radix/parse_f64) — D1 says Result(T, TypedError). Fix: ParseIntError{Empty,InvalidDigit,PosOverflow,NegOverflow}/ParseFloatError; keep Option spellings deprecated.
7. Error trait: source `?= .None` (error.yo:10-13) overridden by NOTHING in tree; downcast is an undocumented builtin (tests/error.test.yo:9,17,33), not exported/documented in std/error; no is(T), no chain(), no wrap/context. Fix: is(err,T), ErrorChain iterator, Context(msg, source) type, document downcast.
8. No derive(Error); derive(ToString) is Debug-shaped (structural, fmt/to_string.yo:503) so 10 std error enums hand-write to_string + impl Error(): crypto/random.yo:30-42, net/errors.yo, encoding/{csv,json,error}.yo, regex/error.yo, url/index.yo, sys/errors.yo, http/http.yo ×4. Fix: Debug trait split OR derive_rule(Error) with per-variant format strings (thiserror).
9. bench: no black_box (zero hits); no auto-calibration; iterations==0 → min=i64.MAX/max=0 (bench.yo:73-74,95-98); _i64_to_string/_u64_to_string reimplement ToString (37-48).
10. log: closed LogOutput enum(Stderr,Stdout) (log.yo:76), fwrite (112-121); no Sink trait, no env init (YO_LOG).
11. rand: only Rng exported (rand.yo:100); no thread_rng/random(); range i64-only (:77), not Range type; no f64 range/fill_bytes/bool; shuffle/choice hard-wired to ArrayList (82,93).
12. Default on only 16 types: 13 primitives (prelude 784-796), Option (6796), String (string.yo:2577), ArrayList (array_list.yo:992). Missing: unit, rune, str, Box, tuples, Array, HashMap, HashSet, BTreeMap, Duration, Path, StringBuilder, ImmString, hashers.

## P2
13. log.get_level (log.yo:93) → level().
14. log.Level includes Off as loggable (log.yo:39; enabled :108-110); no Ord (private _level_value 40-50); Eq hand-written via __yo_op_eq (67-73) — derive exists.
15. HashMap default keys 0,0 (hash.yo:24-25) — deterministic by design (fixpoint byte-identity); add RandomState/with_random_keys() + doc sentence.
16. Digest trait no one-shot digest()/digest_hex()/reset (digest.yo:14-29); hmac spells the 3-call chain 4× (hmac.yo:26,36,38).
17. Fnv1aHasher no reset (SipHasher13 has, hash.yo:65-72); neither Default.
18. Option/Result: complete except Option.xor/is_none_or/get_or_insert(_with)/insert/unzip, Result.is_ok_and/is_err_and. zip returns IterPair (Yo-ism, consistent). No `?` operator (D1: effects are the path).
19. Doc coverage: log.yo 15/25 undocumented (trace…error, *_target, *_lazy 178-194); crypto/random.yo 6/7 (62,131,139,149,158,188); sha256.yo 3/3 (151,270,274); sha1 2; sha512 2; md5 2; digest.yo trait itself (14); hash.yo DEFAULT_KEY_1:25.

---

## concurrency/async/memory — verified file:line

## P0
1. Send NOT enforced at spawn boundaries: validate_capture_trait_requirements is a no-op (src/evaluator/utils/closure.yo:125-132, doc :8); only validate_where_constraints_for_call (calls/helper.yo:4322-4400) enforces markers and only on concrete where(). Thread.spawn/spawn(pool) declare Impl(Fn(io) -> unit, Send) (thread.yo:40,45,57,211) but a closure capturing non-atomic ref struct / Io / JoinHandle compiles → racing non-atomic RC. tests/thread_safety.test.yo:28-40 only asserts Type.impls. Fix: implement for marker traits (trait_checking.yo:204-232 has the derivation) + comptime_expect_error negatives.
2. spawn(pool) holds pool mutex across __yo_worker_spawn (thread.yo:218-221); runtime inline fallback (codegen/parallelism/runtime.yo:463-468) runs task on submitter → nested spawn self-deadlocks on non-recursive mutex. join_all same shape (156-165).
3. Thread.join re-callable → double pthread_join UB (thread.yo:61-64; __yo_thread_join guards only zero handle runtime.yo:172-181); spawn creates joinable never detached (141-167); Thread has no Dispose → un-joined thread leaks. Fix: own(self)/zero handle + Dispose detaching.

## P1
4. Thread.spawn carries no result though D7 blocker fixed 2026-08-28 (thread.yo:11-25 doc says use Channel) → Thread(T).spawn -> Thread(T), join() -> T.
5. sync/channel never auto-closes: single fused handle (channel.yo:33-48), recv blocks until _closed (108-116), close manual (181-187) → Sender/Receiver split with producer count; at minimum loud doc.
6. Async parks on 1ms timers: yield awaits IO_timer.sleep(1) unconditionally (async/index.yo:45-49); async/channel send/recv 1ms tick (channel.yo:65,95); async/mutex.lock (mutex.yo:53) → waker/ready-queue primitive (__yo_async_wake); yield = pure poll_step.
7. async/mutex.with_lock doc claims awaits inside body allowed (mutex.yo:59-61) but body is sync Fn(inout(v) : T) -> R; zero tests for with_lock (tests/async/mutex.test.yo:27-57 only lock/unlock).
8. Once.call holds raw lock across f() (once.yo:58-64,70-80) citing blocker issues/fixed/generic-r-callback-with-unit-closure-emits-void-star-temp.md — FIXED (C20 2026-08-26) → rewrite via Mutex.with_lock.
9. Raw lock surface public from safe code: Mutex._raw_lock/_raw_unlock/_raw_handle_ptr (mutex.yo:85-93); __YO_THREAD_SYNC_TYPE in export (:107); Phase P privacy never landed (issues/thread-safety-phase-p-never-landed-but-plan-says-complete.md).
10. Missing: thread::scope, Thread current(), available_parallelism (get_hardware_threads), Mutex.try_lock (sync), Condvar wait_timeout/wait_while (cond.yo only wait/signal/broadcast), mpsc recv_timeout/iter/unbounded, RwLock try_read/try_write (only with_read/with_write), LazyLock, AtomicPtr/compare_exchange_weak/fetch_update (atomic.yo:1223-1237), Semaphore permit guard/with_permit, interval, spawn_blocking, select (race returns usize index). WaitGroup.add clamps negative (waitgroup.yo:56-60) vs Go panic.
11. timeout -> Option(T) conflates timed-out/aborted/Some(None) (async/index.yo:128) → Result(T, Elapsed); consumes handle unlike race/any.
12. race/any manual contract "await every handle" (index.yo:64-68, 87-90); JoinHandle bare struct(__future : *(T)) no Dispose (prelude.yo:10498-10503) → losers leak → Dispose aborting non-terminal task.
13. No ## Stability on async/index, async/channel, async/mutex, sync/barrier, sync/semaphore (only spec/*, fs/watch have it).
14. Docs: sync/atomic.yo all 11 types + ~130 methods no /// (:145,:1004,:1110…); cond.yo new/wait/signal/broadcast (30-41) none; mutex.yo new (69), with_lock (72) undocumented; once.yo new/call/is_done (49,55,85) use //; waitgroup.yo 43,51,67,71,79 use // and pragma at :2 splits the //! block. Widen issues/collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md.
15. tests/sync/mutex.test.yo has ZERO concurrent tests (0 Thread.spawn) vs rwlock 19, once 16, semaphore 12, waitgroup 19, barrier 8.

## P2
16. RwLock reader-preferring, writer starvation undocumented (rwlock.yo:160-167; comment 188-205 silent).
17. async/channel.recv O(n) (_buf.remove(0) channel.yo:100,124) → head index/ring like sync/channel._head.
18. try_recv conflates Empty/Disconnected (async/channel.yo:121-129, sync/channel.yo:160-177) → TryRecvError{Empty, Disconnected}.
19. Layout/layout_of decorative (allocator.yo:10-23, export 144-150; only consumer tests/allocator.test.yo:61); no alloc(layout)/dealloc(ptr, layout).
20. Naming: MemoryOrder (Rust Ordering); get_hardware_threads; Box is RC (= Rust Rc) (prelude.yo:8023-8032); MemoryOrder.Consume (atomic.yo:112) — Rust omits; MemoryOrder.to_c_order public (:114) leaks C type.
21. thread docs never mention inline fallback (runtime.yo:152-165) → rendezvous deadlock.
22. ThreadPool.join_all reads worker count outside lock (thread.yo:152 vs lock :156).
23. std/gc.yo 13 lines, no Stability, no heap size/pause/resume, no doc on when collection runs.

