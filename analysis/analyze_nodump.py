# -*- coding: utf-8 -*-
"""Feature analysis on the clean event plus holdout validation on the fourth window."""
import json, io, math, sys

sys.stdout.reconfigure(encoding="utf-8")

WINDOWS = ["w14.json", "w12.json", "w10.json", "w8.json"]
THRESH = 10.0  # Event: outside money reached >= 10% of the migration threshold in two hours.


def load(f):
    return [r for r in json.load(io.open(f, encoding="utf-8")) if not r.get("error")]


def ev(r):
    return 1 if r["outsideSharePct"] >= THRESH else 0


def buckets(r, depCount):
    d = r["devBuyPct"]
    dev = ("none" if d < 0.05 else "under 1%" if d < 1 else "1-6%" if d < 6 else "6-10%" if d < 10 else "over 10%")
    e = r.get("exempt")
    ex = "no data" if e is None else "none" if len(e) == 0 else "1-2" if len(e) <= 2 else "3 or more"
    t = r["creatorTaxBps"]
    tax = "zero" if t == 0 else "up to 3%" if t <= 300 else "over 3%"
    n = depCount.get(r["deployer"].lower(), 1)
    ser = "1 launch" if n == 1 else "2-4" if n <= 4 else "5 or more"
    return {
        "creator buy": dev,
        "socials": "yes" if r.get("hasSocials") else "no",
        "creator fee": tax,
        "fees to third party": "yes" if r.get("feeToThirdParty") else "no",
        "pair": "ETH" if r.get("isEthPair") else "stock",
        "tax-exempt wallets": ex,
        "serial deployer": ser,
        
    }


def depcounts(rows):
    c = {}
    for r in rows:
        k = r["deployer"].lower()
        c[k] = c.get(k, 0) + 1
    return c


ALPHA = 20
logit = lambda p: math.log(p / (1 - p))
sig = lambda z: 1 / (1 + math.exp(-z))
clamp = lambda p: min(max(p, 1e-4), 1 - 1e-4)


def fit(rows, depCount):
    base = sum(ev(r) for r in rows) / len(rows)
    feats = {}
    for r in rows:
        for f, b in buckets(r, depCount).items():
            g = feats.setdefault(f, {}).setdefault(b, [0, 0])
            g[0] += 1
            g[1] += ev(r)
    out = {}
    for f, gs in feats.items():
        out[f] = {}
        for b, (n, k) in gs.items():
            p = clamp((k + ALPHA * base) / (n + ALPHA))
            out[f][b] = {"n": n, "k": k, "raw": k / n, "w": logit(p) - logit(clamp(base))}
    return base, out


def predict(base, model, r, depCount):
    z = logit(clamp(base))
    for f, b in buckets(r, depCount).items():
        g = model.get(f, {}).get(b)
        if g:
            z += g["w"]
    return sig(z)


def auc(pairs):
    pos = [p for p, y in pairs if y == 1]
    neg = [p for p, y in pairs if y == 0]
    if not pos or not neg:
        return float("nan")
    wins = ties = 0
    for a in pos:
        for b in neg:
            if a > b: wins += 1
            elif a == b: ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


# ---------- combined feature summary ----------
allrows = []
for f in WINDOWS:
    allrows += load(f)
dc_all = depcounts(allrows)
base, model = fit(allrows, dc_all)

print(f"SAMPLE   {len(allrows)} launches across 4 separated windows")
print(f"EVENT    outside money >= {THRESH:.0f}% of the migration threshold in two hours")
print(f"BASE     {base*100:.1f}%  ({sum(ev(r) for r in allrows)} events)\n")

for f in ["creator buy", "serial deployer", "tax-exempt wallets",
          "socials", "creator fee", "fees to third party", "pair"]:
    gs = model.get(f)
    if not gs: continue
    print(f"  {f}")
    for b, g in sorted(gs.items(), key=lambda x: -x[1]["w"]):
        if b == "no data": continue
        lift = (g["raw"] / base) if base else 0
        print(f"    {b:<12} n={g['n']:>4}  event {g['raw']*100:>5.1f}%   x{lift:.2f}")
    print()

# ---------- honest holdout validation ----------
print("=" * 62)
print("HOLDOUT VALIDATION: train on three windows, test on the fourth\n")
for held in range(4):
    tr = []
    for i, f in enumerate(WINDOWS):
        if i != held:
            tr += load(f)
    te = load(WINDOWS[held])
    dc = depcounts(tr)
    b0, m = fit(tr, dc)
    dcte = depcounts(te)
    preds = [(predict(b0, m, r, dcte), ev(r)) for r in te]
    a = auc(preds)
    brier = sum((p - y) ** 2 for p, y in preds) / len(preds)
    bbase = sum((b0 - y) ** 2 for p, y in preds) / len(preds)
    print(f"  test {WINDOWS[held]:<9} n={len(te):>3}  AUC {a:.3f}   Brier {brier:.4f}  (constant {bbase:.4f})")
print()
print("AUC 0.50 = chance. 0.60 weak. 0.70 decent. 0.80 good.")
print("Brier below the constant baseline means the model adds value.")
