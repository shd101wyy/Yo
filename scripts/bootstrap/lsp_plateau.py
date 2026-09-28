"""The LSP plateau gate: does `yo lsp` stop growing once every module is cached?

plans/EVALUATOR_MEMORY_REDUCTION.md Phase 1 step 3,
issues/lsp-memory-grows-per-open-edit-close-round.md. Drives one `yo lsp`
process over stdio. Per round, for every document:
- `didOpen`, then wait for its `publishDiagnostics`;
- `didChange` (append a comment line), then wait;
- `didClose`, then wait.

After each round it prints the server's resident set and high-water mark
from /proc (Linux) or `ps` (macOS):

  round <n> rss_kb=<VmRSS> hwm_kb=<VmHWM> secs=<round wall>

A plateau means rounds 2..N stay flat; growth per round is the leak.

Measure a STAGE-2 binary (`<stage-1> compile src/main.yo --optimize 2
--allocator mimalloc -o yo-s2`), which is what releases ship. A seed-built
`yo build` binary runs the seed's codegen and can show leaks the tree has
already fixed (~100 MB a round under v0.2.45, 2026-09-28).

Usage:
  python3 scripts/bootstrap/lsp_plateau.py <yo binary> <rounds> <file.yo> [<file.yo> ...]
  (defaults to 10 std files when none are given; run from the repo root)
"""
import json, os, subprocess, sys, time

yo, rounds = sys.argv[1], int(sys.argv[2])
files = [os.path.abspath(f) for f in sys.argv[3:]] or [os.path.abspath(p) for p in [
    "std/collections/array_list.yo", "std/collections/hash_map.yo", "std/string/string.yo",
    "std/fmt/to_string.yo", "std/path.yo", "std/fs/file.yo", "std/error.yo",
    "std/collections/hash_set.yo", "std/encoding/json.yo", "std/async/channel.yo"]]
proc = subprocess.Popen([yo, "lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
_next_id = [0]

def send(obj):
    body = json.dumps(obj).encode()
    proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    proc.stdin.flush()

def recv():
    length = None
    while True:
        line = proc.stdout.readline()
        if not line:
            raise SystemExit("yo lsp exited")
        line = line.strip()
        if not line:
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":")[1])
    return json.loads(proc.stdout.read(length))

def request(method, params):
    _next_id[0] += 1
    rid = _next_id[0]
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    while True:
        m = recv()
        if m.get("id") == rid and "method" not in m:
            return m

def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})

def wait_diagnostics(uri):
    while True:
        m = recv()
        if m.get("method") == "textDocument/publishDiagnostics" and m["params"]["uri"] == uri:
            return

def mem_kb():
    try:
        st = open("/proc/%d/status" % proc.pid).read()
        get = lambda k: int(next(l for l in st.splitlines() if l.startswith(k)).split()[1])
        return get("VmRSS:"), get("VmHWM:")
    except OSError:
        rss = int(subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)], capture_output=True, text=True).stdout)
        return rss, rss

request("initialize", {"processId": os.getpid(), "rootUri": "file://" + os.getcwd(), "capabilities": {}})
notify("initialized", {})
for r in range(1, rounds + 1):
    t0 = time.time()
    for f in files:
        uri = "file://" + f
        text = open(f).read()
        notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": "yo", "version": 1, "text": text}})
        wait_diagnostics(uri)
        notify("textDocument/didChange", {"textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": text + "\n// edit\n"}]})
        wait_diagnostics(uri)
        notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        wait_diagnostics(uri)
    rss, hwm = mem_kb()
    print("round %d rss_kb=%d hwm_kb=%d secs=%.1f" % (r, rss, hwm, time.time() - t0), flush=True)
request("shutdown", None)
notify("exit", None)
proc.wait(timeout=30)
