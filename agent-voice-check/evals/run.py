#!/usr/bin/env python3
"""Score voicecheck against real agent prose.

`corpus.jsonl` holds sentences pulled from BB pi sessions, read by hand against
the `agent-voice` skill and labeled 1 (violates the standard) or 0 (clean,
including sentences the tool wrongly flags). The predictions are the tool's own
two layers, so this measures what an agent actually gets: a sentence is reported
only when a phrase pattern matches it and the decision gate scores it at or
above the threshold.

    ./run.py                # sweep thresholds, report the best
    ./run.py --threshold 0.5
    ./run.py --json

The sweep is the point. The shipped threshold is a guess until a labeled corpus
says which value separates the two classes with the fewest mistakes.
"""

from __future__ import annotations

import json
import os
import sys
import time
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.realpath(__file__))
TOOL = os.path.join(os.path.dirname(HERE), "voicecheck")
vc = SourceFileLoader("voicecheck_tool", TOOL).load_module()

SWEEP = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7)
CHUNK = 20


def score_corpus(rows, key):
    scored = []
    for start in range(0, len(rows), CHUNK):
        chunk = rows[start : start + CHUNK]
        items = [
            {"offset": i, "line": i + 1, "sentence": row["sentence"], "matched": ["corpus"]}
            for i, row in enumerate(chunk)
        ]
        answers, _ = vc.ask(items, vc.DEFAULT_MODEL, key, timeout=90)
        for index, row in enumerate(chunk):
            gate = answers.get(f"g{index}") or {}
            family = (answers.get(f"f{index}") or {}).get("choice") or "none"
            candidate = any(
                __import__("re").search(pattern, row["sentence"])
                for _, _, pattern in vc.PATTERNS
            )
            scored.append(
                {
                    **row,
                    "candidate": candidate,
                    "score": (gate.get("probabilities") or {}).get("problem", 0.0),
                    "family": family,
                }
            )
    return scored


def confusion(scored, threshold):
    tp = fp = fn = tn = 0
    wrong = []
    for row in scored:
        predicted = bool(row["candidate"]) and row["score"] >= threshold
        actual = bool(row["label"])
        if predicted and actual:
            tp += 1
        elif predicted:
            fp += 1
            wrong.append(("false positive", row))
        elif actual:
            fn += 1
            wrong.append(("miss", row))
        else:
            tn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": threshold,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": precision, "recall": recall, "f1": f1,
        "accuracy": (tp + tn) / len(scored) if scored else 0.0,
    }, wrong


def main(argv):
    as_json = "--json" in argv
    threshold = None
    if "--threshold" in argv:
        threshold = float(argv[argv.index("--threshold") + 1])
    path = os.path.join(HERE, "corpus.jsonl")
    if "--corpus" in argv:
        path = argv[argv.index("--corpus") + 1]
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    key = os.environ.get("AI_GATEWAY_API_KEY", "").strip()
    if not key:
        print("run.py: needs AI_GATEWAY_API_KEY", file=sys.stderr)
        return 2

    started = time.monotonic()
    scored = score_corpus(rows, key)
    elapsed = int((time.monotonic() - started) * 1000)

    results = [confusion(scored, t)[0] for t in ([threshold] if threshold else SWEEP)]
    best = max(results, key=lambda r: (r["f1"], r["precision"]))["threshold"]
    positives = [r for r in scored if r["label"]]
    negatives = [r for r in scored if not r["label"]]
    candidate_recall = sum(1 for r in positives if r["candidate"]) / len(positives) if positives else 0
    mean_pos = sum(r["score"] for r in positives) / len(positives) if positives else 0
    mean_neg = sum(r["score"] for r in negatives) / len(negatives) if negatives else 0

    if as_json:
        print(json.dumps({
            "sweep": results,
            "best": best,
            "sentences": len(scored),
            "positives": len(positives),
            "negatives": len(negatives),
            "prefilterRecall": round(candidate_recall, 3),
            "meanScorePositives": round(mean_pos, 3),
            "meanScoreNegatives": round(mean_neg, 3),
            "elapsedMs": elapsed,
            "model": vc.DEFAULT_MODEL,
        }, indent=2))
        return 0

    print(f"{len(scored)} sentences: {len(positives)} violations, {len(negatives)} clean")
    print(f"phrase pass reaches {candidate_recall:.0%} of the violations; gate mean score "
          f"{mean_pos:.2f} on violations and {mean_neg:.2f} on clean ({elapsed} ms)\n")
    print("A first pass wants recall, so read the curve at a low threshold and")
    print("check that the shortlist stays trustworthy as you go down it.\n")
    print(f"{'thr':>5} {'prec':>6} {'rec':>6} {'F1':>6} {'acc':>6}   tp fp fn tn")
    for result in results:
        mark = " <-" if result["threshold"] == best else ""
        print(f"{result['threshold']:5.2f} {result['precision']:6.2f} {result['recall']:6.2f} "
              f"{result['f1']:6.2f} {result['accuracy']:6.2f}  {result['tp']:3} {result['fp']:2} "
              f"{result['fn']:2} {result['tn']:2}{mark}")

    ranked = sorted(scored, key=lambda r: -(r["score"] * max(
        (vc.PRIORS.get(name, 0.5) for name in (r["matched"] or ["none"])), default=0.5)))
    total_positives = sum(1 for r in ranked if r["label"])
    print("\nshortlist, ranked by score x phrase reliability:")
    for k in (5, 8, 12, 16):
        if k > len(ranked):
            break
        top = ranked[:k]
        hits = sum(1 for r in top if r["label"])
        print(f"  top {k:2}: {hits:2} of {total_positives} violations, precision {hits / k:.2f}")

    chosen = [r for r in results if r["threshold"] == (threshold if threshold else best)][0]
    _, wrong = confusion(scored, chosen["threshold"])
    if wrong:
        print(f"\nmistakes at {chosen['threshold']:.2f}:")
        for kind, row in wrong:
            print(f"  {kind:14} score={row['score']:.2f} match={row['candidate']}  {row['sentence'][:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
