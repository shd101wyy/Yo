#!/usr/bin/env python3
"""Test 7's summary (scripts/test7.sh): the gates' counts, the audit corpus by verdict and cluster, and the
numbers for the release notes' `[n]` slots (plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md §3.3).

Usage: python3 -I classify.py --out <test7 out dir> --repo <candidate tree> --sha <candidate sha>

Attribution of an accepted-and-dirty program, first match wins:
  1. scripts/test7/attribution.tsv: `<path glob relative to the corpus root>\t<row>\t<note>`;
  2. a reproducer `repros/<basename>[-suffix].yo` belongs to the audit row whose `Where` document has that
     basename (plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md §3);
  3. otherwise UNATTRIBUTED, which blocks until someone triages it (add a row to attribution.tsv, or file it).
A row blocks (S) when it is in clusters 1-8 of the audit's §9, or is A40/A43, or is an S1 row of the audit that
§9 does not list (A55-A57: VBD machinery); A41, A42, A44, B* and C* are listable known issues (§3.5).
Writes <out>/summary.txt and <out>/dirty.tsv; exit 0 when legs (a) and (b) pass. Python standard library only.
"""

import argparse
import collections
import fnmatch
import glob
import os
import re
import sys

CLUSTER = {}
for c, rows in {
    1: "A1 A2",
    2: "A6 A13 A20 A32 A33 A34 A47",
    3: "A3 A5 A10 A12 A14 A15 A17 A21 A22",
    4: "A11 A18 A19a A19b A25 A27",
    5: "A4 A7 A8 A24 A28 A29 A48",
    6: "A23 A30 A31",
    7: "A9 A35 A49 A50 A51 A52",
    8: "A16 A26 A36 A37 A38 A39 A45 A46 A53 A54",
    9: "A40 A41 A42 A43 A44",
}.items():
    for r in rows.split():
        CLUSTER[r] = c
# S1 rows of the audit's §3 that §9 does not place: VBD's own machinery, so they block like clusters 1-8.
UNPLACED_BLOCKING = {"A55", "A56", "A57"}
LISTABLE = {"A41", "A42", "A44"}


def row_class(row):
    """-> (cluster label, blocks?)"""
    if row in CLUSTER:
        c = CLUSTER[row]
        if c == 9:
            return ("9:" + row, row not in LISTABLE)
        return (str(c), True)
    if row in UNPLACED_BLOCKING:
        return ("unplaced-S1", True)
    if re.fullmatch(r"[BC]\d+", row):
        return ("listable-" + row[0], False)
    if row.startswith("none:"):
        return ("not-ownership", False)
    if row.startswith("new:"):
        return ("new", True)
    return ("unknown-row", True)


def audit_rows(repo):
    """row id -> document basename (from §3's Where column)."""
    path = os.path.join(repo, "plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md")
    rows = {}
    in3 = False
    for line in open(path, encoding="utf-8"):
        if line.startswith("## 3"):
            in3 = True
        elif line.startswith("## 4"):
            break
        if not in3:
            continue
        m = re.match(r"\| (A\d+[ab]?|B\d+|C\d+) \|", line)
        if not m:
            continue
        cells = line.rstrip("\n").split("|")
        where = cells[5] if len(cells) > 5 else ""
        doc = re.search(r"`issues/(?:fixed/|retired/)?([^`]+?)\.md`", where)
        if doc:
            rows[m.group(1)] = doc.group(1)
    return rows


def doc_state(repo, base):
    for sub, state in (("issues/fixed", "fixed"), ("issues/retired", "retired"), ("issues", "open")):
        p = os.path.join(repo, sub, base + ".md")
        if os.path.isfile(p):
            if state == "open":
                head = open(p, encoding="utf-8", errors="replace").read(3000)
                if re.search(r"WALLED", head):
                    return "open (walled)"
            return state
    return "no doc"


def expect_of(path):
    try:
        head = open(path, encoding="utf-8", errors="replace").read(600)
    except OSError:
        return None
    m = re.search(r"//\s*expect[^:\n]*:\s*(\S+)", head)
    if not m:
        return None
    t = m.group(1)
    if t.startswith("accept"):
        return "accept"
    c = re.match(r"E\d{4}", t)
    return c.group(0) if c else None


def gate_lines(out):
    g = os.path.join(out, "gates")
    res = {}

    def read(name):
        p = os.path.join(g, name)
        return open(p, encoding="utf-8", errors="replace").read() if os.path.isfile(p) else None

    def rc(name):
        t = read(name + ".rc")
        return t.strip() if t is not None else None

    sinks = read("ge-sinks.log")
    res["G-E sinks"] = (rc("ge-sinks"), (re.findall(r"origin sinks: .*", sinks or "") or ["not run"])[-1])
    ga = read("ga.log")
    m = re.search(r"origins corpus \(today\): (\d+) passed, (\d+) failed", ga or "")
    res["G-A"] = (rc("ga"), ("%s/%d" % (m.group(1), int(m.group(1)) + int(m.group(2)))) if m else "not run")
    gb = read("gb.log")
    m = re.search(r"origins unsound \(G-B\): (\d+) passed, (\d+) failed", gb or "")
    res["G-B"] = (rc("gb"), ("%s/%d" % (m.group(1), int(m.group(1)) + int(m.group(2)))) if m else "not run")
    tot = read("ge-totality.log")
    m = re.findall(r"origin totality: .*", tot or "")
    res["G-E totality"] = (rc("ge-totality"), m[-1] if m else "not run")
    fails = {}
    for name, log in (("G-A", ga), ("G-B", gb), ("G-E totality", tot), ("G-E sinks", sinks)):
        fails[name] = [l for l in (log or "").splitlines() if l.startswith("  FAIL")][:40]
    return res, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    a = ap.parse_args()
    out, repo = a.out, a.repo
    corpus = os.path.join(out, "corpus", "audit-corpus")

    attrib = []
    ap_path = os.path.join(repo, "scripts/test7/attribution.tsv")
    for line in open(ap_path, encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        parts = line.rstrip("\n").split("\t")
        attrib.append((parts[0], parts[1], parts[2] if len(parts) > 2 else ""))
    rows = audit_rows(repo)

    def attribute(rel):
        for pat, row, note in attrib:
            if fnmatch.fnmatchcase(rel, pat):
                return row, note
        if rel.startswith("repros/"):
            b = os.path.basename(rel)[:-3]
            best = None
            for r, base in rows.items():
                if b == base or b.startswith(base + "-"):
                    if best is None or len(base) > len(rows[best]):
                        best = r
            if best:
                return best, "reproducer of the row"
        return None, ""

    results = []
    for p in sorted(glob.glob(os.path.join(out, "results", "*.tsv"))):
        line = open(p, encoding="utf-8", errors="replace").read().rstrip("\n")
        parts = line.split("\t")
        if len(parts) >= 4:
            results.append(parts[:4])
    listed = os.path.join(out, "programs.list")
    total = sum(1 for l in open(listed) if l.strip()) if os.path.isfile(listed) else len(results)

    verdicts = collections.Counter(r[1] for r in results)
    codes = collections.Counter(r[2] for r in results if r[1] == "REJECTED")
    pos_rejected, neg_accepted, neg_other_code = [], [], []
    for rel, v, code, _ in results:
        e = expect_of(os.path.join(corpus, rel))
        if e == "accept" and v in ("REJECTED", "CHECK-CRASH"):
            pos_rejected.append((rel, code))
        elif e and e != "accept":
            if v not in ("REJECTED", "CHECK-CRASH", "EXCLUDED-UNSAFE"):
                neg_accepted.append((rel, v))
            elif v == "REJECTED" and code != e:
                neg_other_code.append((rel, e, code))

    dirty = []
    by_cluster = collections.Counter()
    blocking = 0
    for rel, v, kind, detail in results:
        if v != "DIRTY":
            continue
        row, note = attribute(rel)
        if row is None:
            label, blocks, state = "UNATTRIBUTED", True, "-"
        else:
            label, blocks = row_class(row)
            base = rows.get(row)
            state = doc_state(repo, base) if base else "-"
        by_cluster[label] += 1
        blocking += 1 if blocks else 0
        dirty.append((rel, kind, row or "-", label, "BLOCKS" if blocks else "listed", state, note, detail))

    gates, gate_fails = gate_lines(out)
    gates_ok = all(v[0] == "0" for v in gates.values())
    complete = len(results) == total
    corpus_ok = complete and blocking == 0
    safe = total - verdicts.get("EXCLUDED-UNSAFE", 0)
    accepted = sum(verdicts.get(k, 0) for k in ("CLEAN", "LEAK", "DIRTY", "COMPILE-FAIL", "RUN-FAIL", "TIMEOUT"))

    L = []
    L.append("TEST 7 on %s" % a.sha)
    L.append("")
    L.append("(a) gates (test.yml origins-corpus): %s" % ("PASS" if gates_ok else "FAIL"))
    for k in ("G-E sinks", "G-A", "G-B", "G-E totality"):
        rc, txt = gates[k]
        L.append("  %-13s rc=%s  %s" % (k, rc if rc is not None else "-", txt))
        for f in gate_fails.get(k, []):
            L.append("      " + f.strip()[:200])
    L.append("")
    L.append("(b) audit corpus: %d programs (%d run%s), %d in safe code" % (
        total, len(results), "" if complete else ", INCOMPLETE", safe))
    L.append("  excluded, Pragma.AllowUnsafe : %d" % verdicts.get("EXCLUDED-UNSAFE", 0))
    L.append("  rejected                     : %d  (%s)" % (
        verdicts.get("REJECTED", 0), ", ".join("%s %d" % kv for kv in codes.most_common())))
    L.append("  check crashed (no code)      : %d" % verdicts.get("CHECK-CRASH", 0))
    L.append("  accepted                     : %d" % accepted)
    for k in ("CLEAN", "LEAK", "DIRTY", "COMPILE-FAIL", "RUN-FAIL", "TIMEOUT"):
        L.append("    %-26s : %d" % (k.lower(), verdicts.get(k, 0)))
    L.append("  accepted-and-ASan-dirty by cluster: %s" % (
        ", ".join("%s %d" % kv for kv in sorted(by_cluster.items())) or "none"))
    L.append("  BLOCKING dirty (clusters 1-8, A40, A43, unplaced S1, unattributed): %d -> (b) %s" % (
        blocking, "PASS" if corpus_ok else "FAIL"))
    L.append("")
    L.append("  probe drift (the corpus is frozen; the language is not): positives rejected %d, negatives"
             " rejected with another code %d, negatives accepted %d" % (
                 len(pos_rejected), len(neg_other_code), len(neg_accepted)))
    if dirty:
        L.append("")
        L.append("  dirty programs (path | ASan kind | row | cluster | blocks | row doc | note):")
        for d in dirty:
            L.append("    %s | %s | %s | %s | %s | %s | %s" % d[:7])
    crashes = [r for r in results if r[1] in ("CHECK-CRASH", "COMPILE-FAIL", "TIMEOUT")]
    if crashes:
        L.append("")
        L.append("  loud failures (check crash, C compile failure, timeout) — B-class, listable, never (S):")
        for rel, v, c, d in crashes:
            L.append("    %s | %s | %s" % (rel, v, d[:120]))
    L.append("")
    L.append("Slots for §3.3: G-A %s, G-B %s, G-E (%s); the audit's probe corpus (%d programs) re-run with"
             " %d accepted programs that ASan reports dirty in clusters 1-8; G-D and the adversarial pass:"
             " see (c) and (d)." % (gates["G-A"][1], gates["G-B"][1], gates["G-E totality"][1], safe, blocking))
    L.append("TEST 7 legs (a)+(b): %s" % ("PASS" if gates_ok and corpus_ok else "FAIL"))

    text = "\n".join(L)
    print(text)
    with open(os.path.join(out, "summary.txt"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    with open(os.path.join(out, "dirty.tsv"), "w", encoding="utf-8") as f:
        f.write("# path\tasan kind\trow\tcluster\tblocks\trow doc\tnote\tsummary\n")
        for d in dirty:
            f.write("\t".join(d) + "\n")
    with open(os.path.join(out, "drift.tsv"), "w", encoding="utf-8") as f:
        for rel, code in pos_rejected:
            f.write("positive-rejected\t%s\t%s\n" % (rel, code))
        for rel, e, code in neg_other_code:
            f.write("negative-other-code\t%s\texpect %s, got %s\n" % (rel, e, code))
        for rel, v in neg_accepted:
            f.write("negative-accepted\t%s\t%s\n" % (rel, v))
    sys.exit(0 if gates_ok and corpus_ok else 1)


if __name__ == "__main__":
    main()
