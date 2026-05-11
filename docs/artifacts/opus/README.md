# Legacy Opus Artifacts

These files were copied from Jogi's old `tests/opus/out/` sandbox before that sandbox was removed.

Keep these as trend data only. They are not part of the standalone classifier runtime.

Useful files:

- `groundtruth-from-sweep.json`: saved comparison of the old full sweep against `CLASSIFICATION.md`.
- `sweep.json`: old saved sweep output used by `groundtruth-from-sweep.json`.
- `param-sweep/20260507213054/`: first parameter sweep after generation config support.
- `param-sweep/20260507213642/`: prompt sweep.
- `param-sweep/20260507231216/`: latest dominant-document prompt plus definition tuning sweep.

Some JSON fields, especially `outPath`, still point at the historical Jogi sandbox path. Treat those paths as provenance, not live file locations.
