# Pi MCP implementation status

The implementation starts from `02848d6a60e1cde30f15f442abd43dc547dbc1b0`,
which depends on the unmerged #109 member-inbox work. Remote main at inspection
was `03c779b29c948973a3621ec73e7bdfc6cf76a570`. This is the first #103 slice,
not a report that #103, #101, #110 or #111 is complete.

The subsequent [approval and native Durable slice](mcp-approvals.md) records its
own implementation and remaining product integration separately.

## Dependency decision

`pi-mcp-adapter@7.0.0` was inspected from its npm release, upstream git SHA
`b41f334da85b7608f3ff9e64e41b675e2f5d51f0`, integrity
`sha512-/7g2R11VEZYmYgsstTKJ6kTIbluOLI/w72cVq0e9UAhquLLEFG7NUfdFfGyNZ18YhmiIU84iKioKuBH4YHTXdg==`.
Its host-managed export targets `host-managed.ts`; the package contains no
compiled host-managed JS export. Direct production-style import with Node
24.20.0 fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, before creating
a connection. A tsx-only success would not validate our compiled production
entry point. We have not claimed that bundling could never make it compatible.

This slice takes the fallback explicitly permitted by #103:
`@earendil-works/pi-mcp@1.3.0`. This is a standalone compiled client with no Pi
runtime peer dependencies. Its lockfile integrity is
`sha512-lbktLplmdGamM2t460Q0ziNEfpUEHDTVNf79g/AialJ3XZ+SHgNqa/OJXRR+fU+GV/l+gBhRPcyP8XkQlv8Avw==`.
There is one catalog/client implementation, shared by later Durable, Coding and
device adapters. No CLI, OAuth discovery, developer HOME scan or global
credential inheritance is enabled.

## Implemented boundary

- Existing managed MCP definitions gain an optional versioned `pi` policy.
  Its absence leaves legacy configurations unchanged. Saving a policy does
  **not** approve process startup, grant a session tools or enable a Runtime.
- Explicit original tool selection resolves into canonical registered names;
  collisions, missing names and schema/catalog changes are rejected. Session
  grants are intersected with this catalog, and the miniclaw wildcard grants no
  external tool.
- The connection checks a startup authorization callback before opening a
  transport and requires an explicit cwd/minimal environment. HTTP redirects,
  auth recovery and reconnect retries are disabled. Device execution requires
  the future shared device transport rather than a direct local shortcut.
- Dispatch validates the frozen intent, parameters and current catalog before
  a synchronous live-authority check and a host-ledger dispatch marker. A
  marker callback alone is not the durable ledger or an approval implementation.
  Post-dispatch errors are uncertain and cannot replay the same call on this
  instance. Tool errors retain their original result for later reconciliation.

## Remaining delivery

#103 still needs the common persistent approval/call ledger, native provenance
verification, lease/control fences, actual Durable and Coding tool adapters,
authenticated Coding IPC, cross-restart receipts, loader fallback checks and
the single versioned device channel. The existing artifact approval CHECK and
v89–v92 member tables have not been relaxed or overwritten by this slice.

#101 still needs Kimi readiness, exact target/observation scopes, image transport
and model capability checks, screen resource serialization and actual authorized
Mac acceptance. Member messaging does not authorize device control.

#110 still needs the opt-in Mem0 add/search service, owner-private audience guard,
frozen recall snapshots, completed-turn capture outbox and its two real Runtime
adaptations. Group root/question/reply/control and native admission ACK must
never trigger private memory operations.

#111 still needs the pinned OTel/Langfuse exporter and execution-point hooks,
separating capacity wait, provider dispatch/attempt, admission ACK and actual
consumption. Feedback and isolated evaluation remain separate slices.

Cloud and real vendor/device acceptance remain separately tracked; local fixture
success is not real model, real Mem0, Langfuse-project, Kimi or Cloud acceptance.

## Local validation of this slice

- Root TypeScript check and compiled backend build; personal-agent types pass.
- Six complete relevant Vitest files, 44 tests pass: contract, managed client,
  MCP owner isolation, stored-secret handling, runtime-secret boundary and
  effective MCP manifest. The managed-client suite includes actual child-process
  MCP and loopback HTTP, not a model or vendor service.
- `node scripts/test-mcp-production.mjs` passes under Node 24.20.0 using compiled
  `dist` imports: one actual stdio call, zero duplicate dispatches, child closed.
  Its identities are isolated fixture identities, not native Runtime proof.
- Formatting passes and the documentation check passes for 107 repository
  Markdown files. Native compilation is not replaced by tsx execution.

The first added device-close test incorrectly destructured the SDK transport
pair, then counted recursive idempotent close calls instead of close events.
Both test errors were fixed against the SDK implementation; the final test
asserts one actual close event after a late transport arrives. Earlier failures
are not reported as passing runs. The artifact-only scratch dependency tree was
moved out of the repository before the final documentation check.

A follow-up concurrency test found that duplicate identities also need checking
after the asynchronous catalog re-list. That final pre-dispatch check is now in
place. The complete managed-client suite passes 16 tests, including two
simultaneous calls sharing one identity and exactly one actual stdio effect.
The persistent approval ledger remains required for cross-process/restart
protection; this fix does not replace it.
