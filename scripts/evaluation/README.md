# Isolated fixture evaluation

The local and container runners use `cases.mjs` as the versioned fixture manifest.
Each case reports success only if Vitest exited successfully, at least one test
passed, and every named critical assertion appeared exactly once with `passed`
status. A missing, skipped, duplicated, failed or unparseable critical result is
failure. Other skips remain visible in the result; they are not counted as passes.

Report format v2 hashes the manifest and the declared fixture files. This digest
does not include every transitive dependency or model configuration: use the
recorded Git revision and lockfiles for the complete code identity. The host
runner refuses to use a manifest that differs from its committed snapshot.
The container runner computes its digest inside the archived build and runs with
Docker network disabled; the local runner does not enforce a network sandbox.
Both use synthetic fixtures and do not validate live models, Mem0, devices,
Langfuse or deployed Cloudflare.

The local runner builds the archived backend and Agent Runner before executing
cases. If either build fails, no fixture is reported as a pass. Coding IPC and crash
recovery cases use synthetic data and do not replace real-provider acceptance.
