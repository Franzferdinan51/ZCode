# ZCode-bundled SystemOne shim

This directory is the `systemone` Python package bundled with the ZCode
release so per-task model routing works with **zero manual setup**: on
startup ZCode probes `http://127.0.0.1:8765/healthz` and, when nothing
answers, starts this shim itself as a detached background process:

```
python3.11 -m systemone.shim --port 8765        # cwd: the ZCode release root
```

A shim already listening on :8765 (for example a manually managed one)
is used as-is and never duplicated. If the shim can't be started, ZCode
logs one line and continues **without routing** (fail-open) — a session is
never broken because the router is missing.

## Kill-switches / overrides (environment)

| Variable                | Effect                                                        |
|-------------------------|---------------------------------------------------------------|
| `ZCODE_SYSTEMONE=0`     | Disables shim auto-start AND all route lookups                |
| `ZCODE_SYSTEMONE_DIR`   | Override the `systemone` package dir (must contain shim.py)   |
| `ZCODE_SYSTEMONE_PYTHON`| Python executable used to run the shim                        |
| `ZCODE_SYSTEMONE_WAIT_MS`| Max ms to wait for healthz after spawning (default 30000)    |
| `ZCODE_SPEEDSTACK_PRUNE=0` | Disables route-driven MCP pruning only (routing still applies effort) |

## Logs

- Shim request log: `~/.zcode-local/logs/systemone-shim.log`
- Shim process output: `~/.zcode-local/logs/systemone-shim.out.log`

## What the shim needs

- Python 3.11+ with `torch`, `transformers`, `gliclass`, `numpy`
  (see `requirements.txt`). macOS ships with these via the release
  builder's interpreter; on a fresh machine: `pip install -r requirements.txt`.
- The GLiClass model `knowledgator/gliclass-edge-v3.0`, fetched from
  Hugging Face on first run and cached in `~/.cache/huggingface`
  (honors `HF_HOME` / `TRANSFORMERS_CACHE`). After the first download the
  shim starts offline.

## Windows notes

ZCode looks for `python3.11`, then `python3`, then `python` on `PATH`
(`ZCODE_SYSTEMONE_PYTHON` overrides). The interpreter must be able to
`import gliclass` — if it can't, ZCode logs one line and continues
without routing (fail-open). To enable routing on Windows:

```
py -3.11 -m pip install -r <release>\systemone\requirements.txt
```

then restart ZCode; the model downloads once on first shim start.
