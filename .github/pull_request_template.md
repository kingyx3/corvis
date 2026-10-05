## Summary

<!-- What changes and why, in a few sentences. Link the issue or Confluence page if there is one. -->

## Changes

<!-- The notable changes, grouped by area. Call out anything that is a pure move so reviewers can skim it. -->

## Verification

- [ ] `npm run verify` passes locally (lint, typecheck, unit tests with coverage gates, build)
- [ ] New or changed behaviour has a test at the lowest useful layer; `npm run test:e2e` run if a user journey changed
- [ ] No existing SQL migration was edited (add a new numbered one instead)
- [ ] No secrets, customer data or confidential evidence in the diff, the description or the history
- [ ] Docs and `docs/README.md` index updated if a document was added or moved

<!-- Say what you could not run locally (container builds, Terraform, database acceptance, live providers). -->

## Rollout and risk

<!-- Config or environment-variable changes, migration order, rollback path, and anything operators must do before deploying. Write "none" if there is none. -->
