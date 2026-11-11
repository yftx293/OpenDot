# Proactive workflows

## Implemented GitHub event path

An opt-in GitHub subscription routes selected repository events into the existing
managed Goal path. It adds no scheduler, execution worker, identity system or
general remote-write tool.

```text
GitHub JSON webhook
  → bounded body + HMAC-SHA256 verification
  → exact repository / event filter
  → persistent delivery and semantic-event deduplication
  → subscription state, cooldown and lifetime Goal budget
  → one SQLite transaction: Goal + Session + Scheduler TaskRun + event receipt
  → existing Scheduler claim / frozen context / Pi Durable
  → workspace evidence + explicit private-artifact approval
  → verified Goal outcome + existing owned workspace delivery outbox
```

The implemented events are completed `workflow_run` failures (`failure`,
`timed_out`, `action_required`, `startup_failure`) and selected `pull_request`
transitions (`opened`, `reopened`, `synchronize`, `closed`, `ready_for_review`).
Other events, successful CI and repository mismatches receive an ignored receipt.
PR numbers, native IDs, head SHA, action/state and timestamps are normalized;
arbitrary comments, descriptions, titles, URLs and the full payload are not
inserted into model context or retained in the receipt. Selected event metadata
is still explicitly identified as untrusted task data.

Each admitted event creates an independent Goal with its own immutable runtime,
frozen objective, completion criteria and run budget. The subscription limits
the number of admitted Goals over its lifetime; each Goal independently retains
the existing duration and model-generation budgets. The UI uses one run per Goal
and a five-minute subscription cooldown. API callers may explicitly configure
1–10 runs per Goal, 1–100 Goals, and a 0–86400 second cooldown.

## Deployment and use

Enable `MINICLAW_PERSONAL_GOALS=true`, `MINICLAW_DURABLE_RUNTIME=true` and
`MINICLAW_GITHUB_GOALS=true` in a configured self-hosted instance. All flags remain
off by default. Configure an existing supported model Provider and an owned Host
workspace. Only a currently active administrator can create or receive execution
for that workspace; another administrator cannot use it.

Provision a random, private **local** signing secret of at least 32 bytes in a
deployment environment variable named `MINICLAW_GITHUB_WEBHOOK_<NAME>`. It must be
the actual HMAC key available to the server, not an outbound proxy credential
placeholder. Configure the same secret in GitHub's repository Webhook settings.
Never place it in a URL, source file, API creation payload or log. The registry
stores only the variable name; administrators see configured names, never values.
Changing the key invalidates old signatures without replaying acknowledged events.

The deployment must also explicitly grant that reference to its account and
workspace in the non-secret `MINICLAW_GITHUB_WEBHOOK_GRANTS` JSON array:

```json
[
  {
    "owner_user_id": "<actual account ID>",
    "workspace_jid": "web:<actual workspace ID>",
    "secret_variable": "MINICLAW_GITHUB_WEBHOOK_PROJECT"
  }
]
```

Use actual IDs from the existing account/workspace APIs. A variable name by itself
grants no capability. Missing, malformed or mismatched declarations fail closed;
another administrator cannot enumerate or use these signing references. Removing
a grant fences intake, existing Goal execution and pending delivery after restart
with the changed deployment configuration. Owners can still cancel their routines.
The grants variable itself cannot be used as a signing key.

Open **个人委托 → GitHub 例行任务**, select the owned Host workspace, repository,
objective, completion condition, lifetime Goal budget and configured key name.
Configure GitHub's JSON Webhook to POST to the displayed subscription path under
the existing service address, preserving any reverse-proxy subpath. Subscribe to
**Workflow runs** and **Pull requests**. This change does not create a public
listener, change Tailscale or register a remote Webhook automatically.

An incoming CI failure can create a bounded review Goal, read evidence already
present in the authorized workspace, and propose a review artifact. The user opens
its ordinary Session on either browser, reviews/approves the exact artifact, and
observes the verified result and workspace delivery receipt. Natural-language
completion still requires human confirmation; `artifact_contains:TEXT` is checked
against the actual artifact.

This workflow does **not** download GitHub logs, clone repositories, create repair
PRs or claim remote inspection automatically. Remote reads/writes need separately
authorized capabilities. Delivery uses the existing owned Session and workspace;
external IM delivery is not added by this subscription API.

## HTTP control surface

Management uses existing Cookie authentication and exact ownership:

| Method/path under `/api/github-goals` | Behavior                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /availability`                   | Authenticated feature status; administrator sees configured signing-variable names |
| `GET /`                               | Current owner's subscriptions                                                      |
| `POST /`                              | Strict configuration plus `Idempotency-Key`; immutable creation identity           |
| `GET /:id`                            | Subscription and latest 100 event receipts                                         |
| `PATCH /:id`                          | `{expected_revision, state: active/paused/cancelled}`                              |
| `POST /:id/events`                    | External signed JSON intake; Cookie does not grant access                          |

Creation fields are `workspace_jid`, `repository` (`owner/repo`),
`secret_variable`, `objective`, `completion_criteria`, `events`
(`workflow_failure` / `pull_request`), `max_goals`, `runs_per_goal`,
`cooldown_seconds`. Defaults for the last three are 10 / 1 / 300. Configuration
is immutable; create a new subscription for a changed filter, budget or target.

Event requests require `X-GitHub-Delivery` UUID, `X-GitHub-Event`, JSON content type
and `X-Hub-Signature-256`. Exact received bytes are verified before JSON parsing
with a constant-time digest comparison. Bodies over 256 KiB are rejected.
HTTP 202 returns the persisted receipt, including `state`, `reason`, nullable
`goal_id` and `run_id`. Same-delivery retries return the original receipt; a changed
body or event header under that ID returns 409. A native semantic-event key also
suppresses duplicate events with a new delivery ID. No raw body is retained.

Cooldown, budget, paused/cancelled and duplicate events are permanently receipted
as suppressed. Resuming does not replay events suppressed during pause. No Goal,
run or notification is created for ignored/suppressed events. At 10,000 receipts
per subscription, intake fails closed; deduplication records are never deleted
to reopen replay. A new subscription needs explicit configuration and a new
endpoint. A provisioning failure rolls back all admission writes and returns a
retryable error. After commit the existing Scheduler owns the persisted run even
if the response is lost or the process exits.

Pause affects **new events**, leaving existing Goals available for control.
Cancel is terminal: it fences new events, cancels active associated Goals/runs,
revokes pending approvals and stops their local Harness owners. Completed Goal
results remain, while not-yet-dispatched notifications are suppressed even if a
worker already claimed the outbox item. Already delivered results cannot be
withdrawn. Repeated cancel safely retries process stopping. Normal Goal controls
remain available separately.

## Recovery and evidence

Subscription, event receipt, Goal, Session and initial Scheduler occurrence commit
in one product SQLite transaction. Execution recovery uses the original
run/submission/checkpoint. Turning the Durable creation flag off preserves
existing execution and duplicate receipt acknowledgement; new qualifying events
cannot provision a new Durable Goal.

`tests/github-goals.test.ts` covers actual temporary SQLite and authenticated Hono
routes: HMAC failure, cross-owner access, Host revocation, filters, both deduplication
keys, reopen/retry, admission rollback, cooldown/budgets, pause/cancel, approval
revocation, late completion fencing, notification suppression and private v74
backup. It calls no model.

`web/tests/e2e/product-session-continuity.spec.ts` also drives production-page
registration, signed intake, both browser contexts, an actual backend SIGKILL at
approval wait, stable identities after restart, exact artifact approval, one
charged run and delivery. Its HTTP model is simulated and its disposable lease
clock explicitly advanced. See [evaluation.md](evaluation.md) for executed results.

Pending: live GitHub delivery to a deployed endpoint, real configured-model
acceptance, external IM delivery, automated GitHub inspection/repair and automatic
memory updates. Explicit user-confirmed promotion of completed-Goal evidence to
[Personal Memory](personal-memory.md) is implemented. Cron and once tasks retain the existing Scheduler API; this
increment implements one external event workflow.
