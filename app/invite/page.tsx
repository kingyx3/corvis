"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Outcome = { status: "loading" | "accepted"; message: string } | { status: "error"; message: string; retry: () => void };

export default function InvitationPage() {
  const [outcome, setOutcome] = useState<Outcome>({ status: "loading", message: "Checking your invitation…" });

  useEffect(() => {
    const token = window.location.hash.slice(1) || window.sessionStorage.getItem("corvis:pending-invitation:v1") || "";
    const params = new URLSearchParams(window.location.search);
    const tenantId = params.get("tenantId") ?? "";
    const workspaceId = params.get("workspaceId") ?? "";
    // The bearer token is in the URL fragment, which browsers do not send to
    // servers or include in referrers. Remove it from visible history before
    // making the authenticated acceptance request.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (!token || !tenantId || !workspaceId) {
      queueMicrotask(() => setOutcome({ status: "error", message: "This invitation link is incomplete. Ask the organization administrator to issue a new one." }));
      return;
    }
    window.sessionStorage.setItem("corvis:pending-invitation:v1", token);
    let active = true;
    const accept = () => {
      setOutcome({ status: "loading", message: "Checking your invitation…" });
      void fetch("/api/v1/invitations/accept", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-corvis-tenant": tenantId, "x-corvis-workspace": workspaceId },
        body: JSON.stringify({ token }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { error?: string; data?: { tenantId?: string; workspaceId?: string } };
        if (!response.ok) throw new Error(payload.error ?? `invitation_accept_failed_${response.status}`);
        if (payload.data?.tenantId && payload.data.workspaceId) {
          window.localStorage.setItem("corvis:workspace-context:v1", JSON.stringify({ tenantId: payload.data.tenantId, workspaceId: payload.data.workspaceId }));
        }
        window.sessionStorage.removeItem("corvis:pending-invitation:v1");
        if (active) setOutcome({ status: "accepted", message: "Your invitation has been accepted. Your access is active." });
      }).catch((error: unknown) => {
        if (active) {
          const detail = error instanceof Error ? error.message : "This invitation could not be accepted.";
          setOutcome({ status: "error", message: `We couldn't accept the invitation yet (${detail}). Sign in with the invited email address, then try again. The invitation is saved in this browser tab.`, retry: accept });
        }
      });
    };
    accept();
    return () => { active = false; };
  }, []);

  return <main className="invite-shell"><section className="panel" aria-labelledby="invite-heading" aria-busy={outcome.status === "loading"}>
    <p className="eyebrow">Corvis workspace access</p>
    <h1 id="invite-heading">{outcome.status === "accepted" ? "Invitation accepted" : "Accept your invitation"}</h1>
    <p role={outcome.status === "error" ? "alert" : "status"} className={outcome.status === "error" ? "tone-danger" : ""}>{outcome.message}</p>
    {outcome.status === "error" && <button className="primary-button" type="button" onClick={outcome.retry}>Try again</button>}
    {outcome.status === "accepted" && <Link className="primary-button" href="/">Continue to Corvis</Link>}
  </section></main>;
}
