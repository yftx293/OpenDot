# Cloudflare staging acceptance

Status: **Pending**, updated 2026-10-21. The 2026-10-19 managed-cloud
check had no configured staging identity. The later local Mac inspection found
an existing deployed Worker with a healthy endpoint, alongside the local Node
service exposed through its existing Tunnel. Health alone does not establish
staging Group lifecycle, update/rollback or measured cost acceptance. No new
staging/production resources or paid services were created by this follow-up.

The repaired [real-model Bot Team scenario](bot-team-live-acceptance.md) now has
two consecutive complete local Node Durable passes, eleven checks each and three
requests per Bot within the original six-request grant. Earlier failed runs are
retained in that account. Local/public Node and the existing deployed Worker
health endpoints return HTTP 200. None of this establishes real vendor inference
through the deployed Worker, staging lifecycle/update/rollback/cost acceptance,
or physical-device behavior. No Worker resources were changed by these repairs.

Local workerd/Miniflare exercises actual SQLite, PiHarness, object reconstruction,
Alarms, native Task checkpoints, original receipts and interruption faults. The
Goal Team test additionally runs compiled Node/HTTP/Scheduler and actual SIGKILL
with natural lease recovery. These are local infrastructure tests, not deployed
hibernation, deployment update, platform quota or billing evidence.

Before claiming real staging acceptance, use an authorized isolated account/
namespace and the existing [deployment instructions](cloudflare-deployment.md).
Retain original Session/DO/Conversation/Submission/Task identities and validate
planned/lost/duplicate/cancelled/old wakes, SQLite across reinitialization and
version updates, uncertain tool effects and incompatible rollback protection.
Record actual DO requests/duration, SQLite usage, Worker requests and provider
attempts/tokens/duration from that environment. No measured cloud cost is
available yet. Provider and physical-phone acceptance must be recorded separately.

Release gates for #34/#35/#30 remain open. Workerd or Chromium emulation passing
does not satisfy the real provider, deployed Cloudflare or physical-device gates.

## Image publication is a separate gate

Main `b9e933a` passes `validate`, `cloud-agent` and `cloud-authority` in CI run 39208773222. Its separate Docker Publish run 39208773220 fails both architectures
at **Log in to Docker Hub**; annotations report **Username and password required**,
and image promotion is skipped. This is a registry-credential publication blocker,
not a product CI failure. No image release success is claimed.
