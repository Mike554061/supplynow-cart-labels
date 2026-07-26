#!/usr/bin/env python3
"""
Refresh the Cart Labels pre-check watchlist from live reconciliation data.

The pre-check band on each label is driven by an embedded `const PRECHECK=[...]`
block in ../index.html. This script regenerates that block from a fresh export of
the RD_Order_History tab so the watchlist never goes stale.

USAGE:
  1. Export the recon book to CSV (the RD_Order_History tab). Either:
       - Google Drive UI:  Reconcile_by_Date -> File -> Download -> CSV, or
       - a Claude session:  Drive MCP download_file_content
         fileId=1ihHNewuBgFxJ1BkkG5YyR6021d846kY15o0KtQ61Fw0  exportMimeType=text/csv
  2. python3 tools/refresh_watchlist.py path/to/RD_Order_History.csv
  3. git commit -am "Refresh pre-check watchlist" && git push

It recomputes BOTH the per-account chronic-short items AND the systemic tags
(RD OUT = short across >=3 metros or >=2 accounts in a metro; SUB = >=3 misses at
this account; CHK = otherwise), then rewrites the PRECHECK block in index.html.
Self-contained: no other data files needed.
"""
import sys, os, re, csv, json
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "index.html")

STOP = set("LLC INC THE CO CORP USE THIS CARD RESTAURANT BAR GRILL GRILLE PUB REST AND OF "
           "ASSOC ASSOCIATION COMPANY LOUNGE CUISINE".split())
REAL_METROS = {"Pittsburgh", "Cleveland", "Dearborn", "Indianapolis", "Ypsilanti",
               "Troy", "Columbus", "Akron", "Wilkes-Barre"}

def money(s):
    try: return float(re.sub(r"[^0-9.\-]", "", str(s)) or 0)
    except ValueError: return 0.0

def num(s):
    try: return float(re.sub(r"[^0-9.\-]", "", str(s)) or 0)
    except ValueError: return 0.0

def is_junk_business(b):
    b = (b or "").strip()
    return (not b) or b[:1].isdigit() or b in (".", "")

def split_items(cell):
    """'Name UPC: 123; Other UPC: 456' -> [(name, upc), ...]"""
    out = []
    for part in str(cell or "").split(";"):
        part = part.strip()
        if not part: continue
        m = re.search(r"UPC:\s*(\d+)\s*$", part)
        upc = m.group(1) if m else ""
        name = re.sub(r"\s*UPC:\s*\d+\s*$", "", part).strip()
        if name: out.append((name.upper(), upc))
    return out

def matchkeys(name):
    words = [w for w in re.sub(r"[^A-Za-z0-9 ]", " ", name).upper().split()
             if w and w not in STOP]
    keys = set()
    if words:
        keys.add("".join(words[:2])); keys.add(words[0])
    return sorted(k for k in keys if len(k) >= 5)

def pretty(name):
    return re.sub(r"\s+", " ", name).strip().title()

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: refresh_watchlist.py RD_Order_History.csv")
    rows = list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8-sig")))
    recon = [r for r in rows if (r.get("Status") or "").strip() == "Reconciled"]

    # per-account rollups + item frequency; per-item metro/account spread for systemic tags
    acct = {}
    item_accounts = defaultdict(set)   # upc -> set(business)
    item_metros = defaultdict(set)     # upc -> set(metro)
    metro_item_accts = defaultdict(lambda: defaultdict(set))  # metro -> upc -> set(biz)

    for r in recon:
        biz = (r.get("Business") or "").strip()
        store = (r.get("Store") or "").strip()
        fill = num(r.get("Fill Rate %"))
        var = money(r.get("Variance $"))
        items = split_items(r.get("Unavailable Items"))
        if not is_junk_business(biz):
            a = acct.setdefault(biz, {"business": biz, "metro": store, "orders": 0,
                                      "fill_sum": 0.0, "short": 0.0, "items": defaultdict(lambda: [0, "", ""])})
            a["orders"] += 1; a["fill_sum"] += fill; a["short"] += var
            for nm, upc in items:
                cell = a["items"][upc or nm]
                cell[0] += 1; cell[1] = nm; cell[2] = upc
                item_accounts[upc or nm].add(biz)
                if store in REAL_METROS:
                    metro_item_accts[store][upc or nm].add(biz)
        for nm, upc in items:
            if store in REAL_METROS:
                item_metros[upc or nm].add(store)

    # systemic keys: short across >=3 metros OR >=2 accounts within a metro
    systemic = set(k for k, ms in item_metros.items() if len(ms) >= 3)
    for metro, items in metro_item_accts.items():
        for k, accts in items.items():
            if len(accts) >= 2: systemic.add(k)

    def tag(key, cnt):
        if key in systemic: return "RD OUT"
        return "SUB" if cnt >= 3 else "CHK"

    wl = []
    for a in acct.values():
        mk = matchkeys(a["business"])
        if not mk: continue
        top = sorted(a["items"].items(), key=lambda kv: -kv[1][0])[:5]
        if not top: continue
        wl.append({
            "match": mk,
            "acct": a["business"].replace(" ***USE THIS CARD***", ""),
            "metro": a["metro"],
            "fill": round(a["fill_sum"] / a["orders"], 1),
            "short": round(a["short"]),
            "orders": a["orders"],
            "items": [{"n": pretty(cell[1]), "t": tag(key, cell[0]), "x": cell[0]}
                      for key, cell in top],
        })
    wl.sort(key=lambda w: -w["short"])
    wl = [w for w in wl if w["short"] >= 300][:35]

    payload = json.dumps(wl, ensure_ascii=False, separators=(",", ":"))
    html = open(INDEX, encoding="utf-8").read()
    new = re.sub(r"const PRECHECK=\[.*?\];",
                 "const PRECHECK=" + payload + ";", html, count=1, flags=re.S)
    if new == html:
        sys.exit("ERROR: could not find `const PRECHECK=[...];` block to replace.")
    open(INDEX, "w", encoding="utf-8").write(new)
    print(f"Updated PRECHECK: {len(wl)} accounts, {len(systemic)} systemic SKUs. "
          f"Review, commit, and push index.html.")

if __name__ == "__main__":
    main()
