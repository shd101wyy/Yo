#!/usr/bin/env python3
"""Strict-framing LSP handshake gate: prove a `yo` binary can talk to a REAL client.

Spawns `<yo> lsp`, drives one editor-shaped session (initialize, initialized,
didOpen -> publishDiagnostics, shutdown, exit) and parses EVERY outgoing frame
with a strict base-protocol reader: the header block must be terminated by
exactly `\\r\\n\\r\\n`, `Content-Length` must parse, and the body must be
exactly that many bytes of JSON.

Why strict: `yo lsp` on Windows used to emit `\\r\\r\\n\\r\\n`-terminated
headers (libc text-mode newline translation on top of the explicit CRLF —
issues/fixed/lsp-windows-text-mode-framing-breaks-every-client.md). vscode-jsonrpc's
header state machine scans for exactly CR LF CR LF and never terminates on
that byte run, so no LSP client could even complete `initialize`. A tolerant
reader (readline + strip) cannot catch this class of bug; this parser can:
on a broken stream the terminator never appears, the read times out, and the
gate fails.

Usage:
    scripts/lsp-strict-handshake.py [path-to-yo]     # default: `yo` on PATH

Exit 0 = every frame strictly framed and the session completed; exit 1 = the
binary is not usable by a conforming LSP client (message on stderr).

No third-party dependencies; runs on Linux, macOS and Windows.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

TIMEOUT_S = 240.0  # first analysis pays the prelude evaluation — the same budget the lsp cli-cases allow

PROC = [None]


def die(msg):
    sys.stderr.write(f"lsp-strict-handshake: FAIL: {msg}\n")
    if PROC[0] is not None:
        PROC[0].kill()
    sys.exit(1)


class StrictReader:
    """Reads LSP frames with a conforming base-protocol parser.

    Bytes are scanned for the exact header terminator b"\\r\\n\\r\\n"; anything
    else (e.g. b"\\r\\r\\n") never terminates a header block — which is the
    point. A daemon thread does the blocking reads (portable across Windows
    pipes and POSIX); the main thread assembles frames and enforces the
    timeout, so a stream that never frames reads as a failure, not a hang.
    """

    def __init__(self, stream):
        self.buf = b""
        self.chunks = queue.Queue()
        self.eof = threading.Event()

        def pump():
            fd = stream.fileno()
            while True:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if chunk == b"":
                    self.eof.set()
                    return
                self.chunks.put(chunk)

        threading.Thread(target=pump, daemon=True).start()

    def _fill(self, deadline):
        try:
            self.buf += self.chunks.get(timeout=max(0.05, deadline - time.time()))
            return True
        except queue.Empty:
            return False

    def read_frame(self, timeout=TIMEOUT_S):
        deadline = time.time() + timeout
        while True:
            i = self.buf.find(b"\r\n\r\n")
            if i >= 0:
                header_bytes = self.buf[: i + 4]
                break
            if self.eof.is_set() or not self._fill(deadline):
                preview = self.buf[:120].decode("utf-8", "replace").replace("\r", "\\r").replace("\n", "\\n")
                die(
                    "no \\r\\n\\r\\n header terminator seen "
                    f"(buffer so far: {preview!r}) — the stream is not strictly "
                    "framed (Windows text-mode stdout does exactly this)"
                )
        lines = header_bytes.split(b"\r\n")
        length = None
        for line in lines:
            if not line:
                continue
            name, sep, value = line.partition(b":")
            # Header names match WITHOUT stripping leading whitespace: a
            # stray byte before a header line (an inter-frame \n, a doubled
            # terminator) corrupts that line and must FAIL the gate, not be
            # stripped into a pass — vscode-jsonrpc splits on \r\n and
            # exact-matches the name, so it would reject the stream. Only
            # spaces/tabs around the VALUE are tolerated, like the spec's
            # `Content-Length: 123` spelling.
            if sep and name.rstrip() == b"Content-Length" and name == name.lstrip(b" \t"):
                try:
                    length = int(value.strip(b" \t"))
                except ValueError:
                    die(f"Content-Length {value!r} does not parse")
        if length is None:
            die(f"no Content-Length header in {header_bytes!r}")
        self.buf = self.buf[len(header_bytes):]
        while len(self.buf) < length:
            if not self._fill(deadline):
                die(f"EOF inside frame body (have {len(self.buf)} of {length} bytes)")
        body, self.buf = self.buf[:length], self.buf[length:]
        return json.loads(body)


def main():
    yo = sys.argv[1] if len(sys.argv) > 1 else "yo"
    if os.name == "nt" and yo.lower().endswith(".cmd"):
        die("pass the yo.exe path, not the .cmd shim (its pipe plumbing is not inheritable)")
    proc = subprocess.Popen(
        [yo, "lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    PROC[0] = proc

    def send(msg):
        body = json.dumps(msg).encode("utf-8")
        proc.stdin.write(b"Content-Length: %d\r\n\r\n%s" % (len(body), body))
        proc.stdin.flush()

    reader = StrictReader(proc.stdout)

    def await_reply(expect_id, what):
        # Wait for the REPLY with the expected id, skipping anything the
        # server emits first (notifications, other replies) — assuming the
        # very next frame is the reply made the gate brittle against any
        # future window/logMessage.
        deadline = time.time() + TIMEOUT_S
        while True:
            frame = reader.read_frame(timeout=max(1.0, deadline - time.time()))
            if frame.get("id") == expect_id:
                if "result" in frame:
                    return frame
                die(f"{what} was not answered with a result: {frame!r}")

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"capabilities": {}, "processId": None, "rootUri": None}})
    await_reply(1, "initialize")
    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
    send({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {"textDocument": {"uri": "file:///virtual/handshake.yo", "languageId": "yo", "version": 1,
                                    "text": "main :: (fn() -> unit)({ undefined_probe(); });\nexport(main);\n"}},
    })
    published = False
    deadline = time.time() + TIMEOUT_S
    while not published:
        note = reader.read_frame(timeout=max(1.0, deadline - time.time()))
        if note.get("method") == "textDocument/publishDiagnostics":
            published = True
    send({"jsonrpc": "2.0", "id": 2, "method": "shutdown"})
    await_reply(2, "shutdown")
    send({"jsonrpc": "2.0", "method": "exit"})
    try:
        rc = proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        die("server did not exit within 30s of the exit notification")
    if rc != 0:
        die(f"server exited {rc} after a clean shutdown (expected 0)")
    print("lsp-strict-handshake: PASS — every frame strictly \\r\\n\\r\\n framed, full session completed")


if __name__ == "__main__":
    main()
