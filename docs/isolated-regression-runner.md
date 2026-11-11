# Fixture regression runner (work in progress)

`scripts/evaluation/run-isolated-regression.mjs` prepares an isolated copy of
committed Git HEAD, an empty home and scratch directory, and an environment
without inherited provider, Cloud, Mem0, proxy or device credentials. It runs a
fixed, versioned set of existing Group, MCP and Mem0 fixtures sequentially and
writes a new mode-0600 JSON report with the Git revision, dataset digest,
coverage and per-suite results. The source tree and existing report are not
overwritten. Installed dependency directories are linked read-only by convention;
install the matching lockfile dependencies first.

Run only when validation is authorized:

```sh
node scripts/evaluation/run-isolated-regression.mjs /absolute/path/to/new-report.json
```

The Group and MCP cases use a synthetic loopback model; memory cases use local
fixtures. This is a regression baseline, not a dataset experiment, real model,
judge calibration, actual Mem0 or Cloud acceptance. The runner does not enforce
an operating-system network sandbox; that isolation remains a prerequisite
before executing untrusted or production-backed eval scenarios. This new runner
has not yet been executed or validated.

## Network-isolated container runner

`scripts/evaluation/run-container-regression.mjs` builds a separate image from
committed Git HEAD, then runs the same fixture categories in a disposable
unprivileged container with `--network none`, a child-reaping init process,
no host mounts, dropped Linux capabilities and no inherited application credentials. A local Unix-socket
Docker context is required; remote Docker daemons are rejected before source is
sent. The build step downloads the locked dependencies and is not itself an
isolation boundary; the subsequent evaluation is offline. Loopback fixture
servers remain available inside the container's private network namespace.

```sh
node scripts/evaluation/run-container-regression.mjs /absolute/path/to/new-report.json
```

The report identifies the snapshot, fixture set and per-suite results. It is
not real-model, production Mem0, live device, Cloud or judge acceptance, and
it does not constitute a live Langfuse dataset experiment. Build or execution
failure does not produce a passing report.
