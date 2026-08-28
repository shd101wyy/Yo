# A SECOND `io.await` inside a `cond`/`match` branch never stores its result — the binding stays a null slot and using it SIGSEGVs

**Found**: 2026-08-28, implementing C33 (http timeouts/redirects). **Status**:
OPEN. **Pre-existing** — not introduced by C33; it is why **every plain-HTTP
request has always crashed** (the client's live tests only ever exercised
HTTPS and `parse_response` units).

## Symptom

`std/http/client.yo`'s `_fetch_once` (formerly the body of `fetch_with`) has,
inside the `true =>` (plain-http) arm of the transport `cond`, TWO sequential
awaits:

```rust
addrs  := e.io.await(lookup_host(host, e.io), e);   // await #1 in the arm
...
stream := e.io.await(TcpStream.connect(addr, e.io), e); // await #2 in the arm
e.io.await(stream.write_string(req_str, e.io), e);      // uses `stream`
```

A live plain-http fetch (`http://neverssl.com`, `http://example.com`, any)
SIGSEGVs (`EXC_BAD_ACCESS address=0x8` = `null->_fd`) inside `TcpStream.write`.
HTTPS works because its arm's later awaits (`write`, `close`) have UNUSED
results, so a dropped store never manifests.

## Root cause (measured in the emitted C)

The FIRST await's result is stored:

```c
sm->var_219090 = ((__yo_t32*)__yo_incr_rc(((...)sm->await_future_0)->result)); // addrs
```

The SECOND await's result is NOT — `grep 'sm->var_219416 ='` (the `stream`
slot) finds **nothing**. `var_219416` is declared (`__yo_t40* var_219416; //
stream`) and USED (`TcpStream.write((__yo_t40*)(sm->var_219416), …)`) but never
assigned, so it is the zero-initialised NULL that crashes.

The extraction for a cond-internal await is `_emit_prev_await_result_extraction`
(`src/codegen/async/state_machine.yo` ~2096): with `use_await_result_field`
true (the await is `is_inside_cond`), it stores into `sm->await_result_N` and
then copies to the target field only when `prev_await.base.target_variable_id`
is `.Some`:

```rust
if(use_await_result_field, {
  match(prev_await.base.target_variable_id,
    .Some(tvid) => em.emit_string_line(`sm->${field} = sm->await_result_${idx};`),
    .None => ());   // <-- the connect await point lands here
});
```

**For the SECOND cond-internal await, `target_variable_id` is `.None`.** The
first await's target (`addrs`) is recorded; the second's (`stream`) is lost.
The related per-branch field `CondBranch.await_target_variable_id`
(state_code_gen.yo, `_find_branch_await_target_variable_id`) has the same
single-value shape — it returns only the FIRST `:= await` target in the branch.

## Fix direction (attempted, incomplete)

The target must be recorded PER await depth, not once per branch/point. A
`collect_branch_await_targets` that walks the branch in lockstep with
`collect_branch_await_exprs` and returns the `:=` target for each await
(`.None` for a bare await) gives `targets.get(depth)`. Wiring it into the
DISPATCH extraction (state_machine.yo ~1922) was not sufficient: the second
await here is single-branch (only the http arm has it) and flows through
`_emit_prev_await_result_extraction` (the `is_inside_cond`/`await_result_N`
path), whose target comes from `prev_await.base.target_variable_id` — set during
suspension analysis (`src/evaluator/shared/suspension_analysis.yo`, the shared
cond-await-point `rep` construction ~585). The real fix threads the per-depth
target onto the await POINT there (or falls back to the per-depth branch lookup
at the extraction), and MUST run the full battery — this touches the async
state machine broadly.

## Reproducer

`http://neverssl.com` (plain http, 200, Content-Length) through `fetch`:
compiles rc=0, `--release` binary SIGSEGVs (rc=139). Minimal synthetic: any
`io.async` whose `cond` arm does `a := await(f); b := await(g); use(b)` where
`b`'s result is used.

## Impact / scope

- **Plain HTTP is entirely broken** in `std/http` (crashes on every request).
- HTTPS is unaffected (single connect await; later awaits' results unused).
- C33's redirect FOLLOWING works over https→https chains (verified:
  `https://httpbin.org/redirect/15` → `TooManyRedirects`); an http→https hop
  hits this crash.
- Blocks a general, correct multi-await-per-cond-arm pattern.
