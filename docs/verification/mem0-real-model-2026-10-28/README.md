# Real Mem0 and model product acceptance, 2026-10-28

On source head `0977360`, the opt-in test
`tests/mem0-real-model-product-live.test.ts` passed against the user-authorized
hosted Mem0 project and the local Magpie `opencode-go-3/beam-free` provider.
It used an isolated owner, Dot and namespace with a synthetic fictional
preference, through an actual Coding Host and a fresh private session. A Mem0
add returned HTTP 200 (accepted, not proof of extraction); bounded subsequent
search found the synthetic fact. In the second session, an actual product Mem0
search returned HTTP 200. A local loopback relay recorded only booleans showing
the new question and the synthetic fact were present together in the real
model input; the model's conversation reply contained the fact. The synthetic
model endpoint received no calls.

The preceding independent test saw a timed-out add and the durable capture was
marked `uncertain`; it was not automatically retried. Another isolated test had
an accepted add and a direct search hit, but product recall timed out, so it
was not counted as a pass. The passing run uses a different synthetic fact and
namespace. These test memories may remain in the authorized Mem0 project;
this two-API integration does not delete them.

On source head `6554e1a`, the same test also passed for a Node Durable private
session with a different synthetic preference: the real service accepted an
add, the new session successfully searched, the local relay verified the fact
in real model input, and the real model replied with it.

On source head `a5c7252`, a separate actual group turn used the real model and
a configured real Mem0 key with recall and capture enabled for that group's
Dot. The group produced the requested public reply and the Host observer saw
no Mem0 search or add requests. This isolated group-only run did not seed a
private memory for that same group Dot, so it is not a seeded-canary proof. An
additional combined private/group test stopped with HTTP 400 because its test
used a group member ID rather than the required Dot profile ID; the fixture
was corrected before the subsequent run below.

On source head `a3aae43`, the corrected combined Node Durable test passed
against real Mem0 and Magpie `opencode-go-3/beam-free` (one test, 54.55 s).
It seeded a synthetic private fact for a Dot, verified it was searchable,
observed that a fresh private session sent it to the real model and received
the fact in its reply, then used that same Dot in a group with recall and
capture enabled. The public group turn completed with no Mem0 search or add
after the baseline, and the relay observed no synthetic private marker in the
group model input. The fixture model endpoint received no calls. An additional
synthetic memory may remain in the authorized project.

These checks do not establish Cloud behavior, automatic remote deletion,
general provider reliability, or that every accepted asynchronous add has
fully completed. No credentials, raw model
requests, namespace IDs or user data are included in this evidence.
