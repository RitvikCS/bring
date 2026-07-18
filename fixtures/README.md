# Integration fixtures (Phase 1G)

Three deliberately tiny devcontainer projects used by
`test/integration/lifecycle.test.ts` — they exist so Bring's real lifecycle
can be exercised through the actual Dev Containers CLI and Docker:

- `minimal/` — single-container project on `debian:bookworm-slim`
  (P1-44: fast up/shell/down/remove).
- `compose/` — an app plus sidecar through Docker Compose (P1-45 lifecycle;
  Phase 2 relationship inventory and cleanup coverage).
- `failing/` — a `postCreateCommand` that always fails
  (P1-46: concise error classification and the captured log).
- `lineage/` — two tiny Dockerfiles used to prove a labelled base image is
  classified as an ancestor of, rather than unattached from, a running derived
  Dev Container image.

The integration tests copy each fixture to a temporary directory before
running, so nothing here is ever registered in your real Bring state and
container labels never point into the repository.

Run them (needs Docker and the `devcontainer` CLI on PATH):

```sh
npm run test:integration
```

They are skipped in the normal `npm test` run — `BRING_INTEGRATION=1`
enables them.
