/**
 * Embedded Python stdio bridge that serves the SystemOne route-choice
 * protocol from a local Laya checkpoint (`pip install laya`).
 *
 * Kept as source text (not a .py file) so packaged apps always have it:
 * the sidecar writes it to a temp file once and spawns
 * `python3 <file>`. Protocol is NDJSON over stdio:
 *
 *   stdin  {"state": "...", "questions": [{"id": "route", "type": "choice",
 *           "instructions": "...", "criteria": [{"id": "A", "description": "..."}]}]}
 *   stdout {"answers": [{"choice": "B", "probabilities": {"A": .., "B": ..},
 *           "confidence": 0.9}]}
 *   stdout {"error": "..."}            on per-request failures
 *   stdout {"ready": true}              once, after the model loads
 *
 * Model selection via env: ZCODE_LAYA_MODEL (default
 * "convaiinnovations/laya"), ZCODE_LAYA_SUBFOLDER (default "multilingual").
 * Weights download from HuggingFace on first run, then stay cached.
 */

export const LAYA_BRIDGE_SOURCE = `import json
import os
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()


def main():
    try:
        import laya
    except ImportError as exc:
        emit({"fatal": "laya is not installed (pip install laya): %s" % exc})
        return 1
    model = os.environ.get("ZCODE_LAYA_MODEL", "convaiinnovations/laya")
    subfolder = os.environ.get("ZCODE_LAYA_SUBFOLDER", "multilingual")
    try:
        agent = laya.Agent(model, subfolder=subfolder)
    except Exception as exc:
        emit({"fatal": "laya checkpoint load failed: %s" % str(exc)[:500]})
        return 1
    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            questions = {}
            order = []
            for index, q in enumerate(req.get("questions", [])):
                qid = q.get("id") or ("q%d" % index)
                order.append(qid)
                questions[qid] = {
                    "type": q.get("type", "choice"),
                    "instructions": q.get("instructions", ""),
                    "criteria": {
                        c["id"]: c.get("description", "")
                        for c in q.get("criteria", [])
                    },
                }
            result = agent.predict(req.get("state", ""), questions)
            answers = []
            for qid in order:
                item = result["answers"][qid]
                answers.append(
                    {
                        "choice": item["choice"],
                        "probabilities": item["probabilities"],
                        "confidence": item["confidence"],
                    }
                )
            emit({"answers": answers})
        except Exception as exc:
            emit({"error": str(exc)[:500]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
