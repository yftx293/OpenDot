# Network-isolated fixture evaluation, 2026-10-28

On a local Colima Docker daemon, the container runner built from committed Git
source and ran under `--network none --init --cap-drop ALL`, with no host bind
mounts and no inherited application credentials. The running container was
inspected: network mode `none`, zero binds, and not privileged. An independent
synthetic TCP probe verified that container loopback worked while an outbound
connection failed. Image construction downloaded locked dependencies before
the network-isolated evaluation started.

The first run failed one Group and one MCP test; `first.json` preserves its
result. The repeat also failed those cases (`repeat.json`). A direct MCP
reproduction showed that Node as PID 1 left orphaned child processes as zombies;
adding Docker's init process allowed the MCP test to pass. `init-only.json`
retains the remaining Group test failure. That test sent an interjection after
observing a request but did not hold the coordinator's response, making its
intended ordering nondeterministic. The fixture now holds the original request,
submits the interjection, then releases the response; the existing assertion
that the coordinator reads the interjection remains intact.

`final.json` records the complete successful run on `b2e3b1b`: 11 Group,
1 MCP, 3 memory-authority and 5 memory-client tests passed without skips.
An isolated targeted Group run and the corresponding PR #109 test also passed.
This is synthetic fixture regression, not a live provider, production Mem0,
real device, Cloud deployment, Langfuse dataset or judge calibration.
