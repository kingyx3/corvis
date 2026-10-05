# In-app help and support (F9)

Every workspace user can reach help from the **Help** button in the top bar, from the command palette (`⌘K` / `Ctrl+K`, type "Help") and, on phones, from the **Workspace** tab of the bottom navigation (**Help and support**). The Help menu lists:

| Entry | What it does |
| --- | --- |
| Contact support | Opens an email draft (or the configured help-desk page) with the support context filled in. |
| Documentation | Opens the product documentation in a new tab. |
| Service status | Opens the service status page in a new tab. |
| Release notes | Opens the release notes in a new tab. |

The same **Contact support** entry point (`buildSupportRequest` in `src/modules/support/domain/support.ts`) is used by the error states: `src/app/error.tsx`, `src/app/global-error.tsx` (which renders its own document and has no CSS, so it only borrows the helper), the per-view error fallback (`src/shared/ui/view-error-boundary.tsx`), the "module unavailable" and "workspace degraded" notices in `src/app/page.tsx`, and source connections that need support. Where an error digest exists it is passed as the **Error reference**.

## What a support request contains

Only identifiers, from a fixed allow-list. Nothing else is read, and a value that is not a well-formed token is dropped, never truncated:

| Line | Source |
| --- | --- |
| Workspace ID, Organization ID | The identity the shell loaded (`src/modules/support/domain/support-scope.ts`), else the stored workspace selection (`src/shared/lib/workspace-context.ts`). |
| Current view | The view in the URL hash (`#/documents`), else the route path. Never a query string. |
| Latest request ID | The `correlationId` of the most recent `/api/v1` response (`src/shared/lib/request-correlation.ts`), the same id that appears in server logs. |
| Error reference | The Next.js error digest of the failure on screen, when there is one. |

**No financial data or documents are attached automatically.** Fund, document and metric names and values, user input and free text are never part of the context. The Help menu shows the exact lines under "Included when you contact support" before anything is sent, and the email body tells the user not to paste financial data. The allow-list and the "smuggled field" case are covered by `src/modules/support/domain/support.test.ts`.

The latest request ID is recorded by the HTTP adapters (`src/modules/workspace/adapters/http-workspace.ts`, `src/modules/delivery/adapters/http-delivery.ts`) and by `apiResponseError`. Requests that components make with a bare `fetch` do not update it. In demo mode there are no HTTP responses, so no request ID is shown.

## Configuration

Set at build time (they are `NEXT_PUBLIC_*`, so Next.js inlines them into the browser bundle; see `.env.example`, and pass them as `--build-arg` to the `Dockerfile`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL` | `support@corvis.example` | Mailbox "Contact support" writes to. |
| `NEXT_PUBLIC_CORVIS_SUPPORT_URL` | unset | Optional help-desk page. When set (https), "Contact support" opens it in a new tab with the context as query parameters (`workspace_id`, `organization_id`, `view`, `error_reference`, `request_id`, `subject`) instead of composing an email. |
| `NEXT_PUBLIC_CORVIS_DOCS_URL` | `https://docs.corvis.example/` | Product documentation. |
| `NEXT_PUBLIC_CORVIS_STATUS_URL` | `https://status.corvis.example/` | Service status page. |
| `NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL` | `https://docs.corvis.example/release-notes` | Release notes. |

URLs must be absolute `https:` URLs without embedded credentials; the email must be a plain address. An invalid value is ignored and the default is used (`resolveSupportConfig`), so a typo cannot create a `javascript:` link or an email with injected headers.

The defaults use the reserved `.example` domain on purpose: they never resolve, so an unconfigured deployment cannot send users or support mail to a host the project does not own. **Every real deployment must set the variables.** Because the values are inlined at build time, a promoted build-once image carries the values it was built with.

There is no Terraform or GitHub Environment wiring for these variables: browser-visible build configuration is passed as Docker build arguments, as `NEXT_PUBLIC_CORVIS_API_BASE` already is.

## Testing

- `src/modules/support/domain/support.test.ts`, `src/modules/support/domain/support-scope.test.ts` and `src/shared/lib/request-correlation.test.ts` cover the pure helpers at 100% (the changed-code coverage gate applies to every `domain/` and `src/shared/lib/` file).
- `e2e/help-support.spec.ts` covers the Help menu, the pre-filled context, the palette commands, the phone route and a view error. The Help menu is also a surface in `e2e/support/surfaces.ts`, so it runs through the axe matrix in both themes.
- `e2e/non-demo-smoke.spec.ts` checks, against the real HTTP adapter, that Contact support quotes the correlation id of a failed API call.
