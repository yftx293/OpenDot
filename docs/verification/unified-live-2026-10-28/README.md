# Unified real-model acceptance

Source `1ab498d` was built locally and exercised through isolated product HTTP
fixtures using the user-selected Magpie `opencode-go-3/beam-free` model. The
fixture provider received zero requests; no production conversations were used.

- `single.json`: three successive private turns, one assistant reply each,
  expected values 100, 120, 115, and a Host restart after the first turn.
- `group.json`: three relay-v1 rounds with three Dots, one response per Dot,
  expected values and prior-peer reading, preserved sessions and a Host restart.
  The participant and model call bounds were explicitly configured.

These are Node product API results, not Chrome/mobile presentation, unrestricted
group policies, container mount, Cloudflare, Kimi or vision-model evidence. The
Mac was locked during this attempt, so Chrome verification was not performed.
The complete regression suite was still running when these files were saved.

## Automated mobile browser regression

On `10c2cc5`, Chrome in headless Pixel 7 emulation passed 16 scenarios covering
creation, navigation, settings, group discussion, approvals and keyboard/layout
behavior. `mobile-synthetic-discussion.png` is a screenshot from the isolated
automated test with a synthetic model, not a real-model conversation or a
physical-device screenshot. A previous run reported a history-scroll failure;
the UI fix passed both its dedicated retry and the full 16-scenario rerun.

## Real-model mobile browser private chat

On `e36e9fb`, the optional `single-real-model.spec.ts` used headless Chrome at
390 × 844 with isolated data and the real Magpie `opencode-go-3/beam-free`
model. Three user-submitted turns showed the expected balances 100, 120, 115;
the latter two prompts supplied only the increment or decrement. The test waited
for each completed answer and observed zero synthetic-provider requests, page
errors, console errors or failed API responses. `single-round-1.png` through
`single-round-3.png` show those actual replies. An earlier run captured its
first screenshot too early; these files are from the corrected rerun. This is
automated browser evidence rather than physical phone or interactive Chrome.

## Real-model mobile browser group discussion

On `58f75a5`, the optional `group-real-model.spec.ts` used headless Chrome at
390 × 844 with isolated data and the actual Magpie `opencode-go-3/beam-free`
model. The user submitted three successive group messages in the page. Each
round produced three ordered Dot replies plus a coordinator summary, and every
reply contained the expected current value (100, 120, 115). The second and
third prompts did not supply their answers. No synthetic-provider requests,
browser page errors, console errors or failed API responses were observed.
`group-round-1.png` through `group-round-3.png` are the resulting real-model
screenshots. This does not replace an interactive browser or physical phone
acceptance, and it does not itself inspect each model input for peer context.
