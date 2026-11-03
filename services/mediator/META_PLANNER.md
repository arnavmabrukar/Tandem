# Meta plan generation

Project owners can open **Plans**, enter a goal, and click **Generate with Meta**.
The result opens in the existing plan editor. Review/edit and Save draft, then use
plan approval: **Approve and create tasks** keeps per-task contract review, while
**Approve and run** approves the contracts too and starts delegation. Generation
alone never saves a plan, assigns work, creates tasks, or approves a contract. Saved drafts use the
existing human-authored draft flow; provider provenance is not persisted yet.

Add these to the root `.env.local` for local development and to the Render
backend environment for hosting. Never put the API key in Vercel or VITE_*.

```dotenv
# Secret from your Meta Model API account; replace this placeholder privately.
MODEL_API_KEY=your-meta-api-key
# Optional; this is the default model selected for this integration.
TANDEM_META_MODEL=muse-spark-1.3-contributor
```

Paste the bare key with no quotes. Surrounding whitespace is ignored; a key that
still contains quotes, spaces, or non-ASCII characters produces 503.

Backend logs record why generation failed, without any prompt, model output, or
credential: Meta's HTTP status and error code, a timeout or connection error, or
which plan fields failed validation. Search them for `Meta` or `MODEL_API_KEY`.

Restart the backend after changing configuration. No new migration is needed.
Deploy both frontend and backend before using the hosted UI.

The request sends only the submitted goal and project name, repository name,
and description (capped at 10,000 characters). It does not inspect repository
files, send message history, or call agent tools. Contributor-mode content may
be used for training; choose `muse-spark-1.3` for Standard mode if desired.
`store=false` controls API response storage, not Contributor training policy.

Implementation uses the existing httpx dependency and Meta's Responses API at
https://api.meta.ai/v1/responses. It requests a complete, non-streaming response
with the supplied model, medium reasoning, temperature/top_p 1, and a 32,000
output-token limit. Complete output is validated with PlanProposal, including
path rules, unique task keys, and dependency-cycle rejection. Incomplete or
malformed output produces 502; missing configuration produces 503.

Owner authorization is checked before the provider call and again afterward.
No database locks are held during inference. Network timeout is 120 seconds
(10 seconds to connect), frontend timeout 135 seconds. There are no automatic
retries: trying again makes another billable request. A lost response does not
save a hidden plan. Review and save use the existing version/idempotency rules.
Long-running generation may exceed hosting proxy limits; background jobs,
streaming progress, persisted generation provenance, and cross-worker request
quotas are follow-up work.

Validation: mocked provider/HTTP unit tests, frontend client tests, and production
build. Live provider credentials and hosted end-to-end generation still need
verification. Enter a small goal, generate, inspect all tasks, save, and confirm
no live tasks exist until a human approves the saved plan.

References:
- https://dev.meta.ai/docs/protocols/responses
- https://dev.meta.ai/docs/models
