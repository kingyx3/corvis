import { assertPermission, type ResearchStreamEvent } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import {
  ResearchCancelledError,
  ResearchProviderError,
  ResearchTimeoutError,
  researchService,
} from "@/lib/server/research";
import { logEvent } from "@/lib/server/telemetry";

function errorEvent(error: unknown): ResearchStreamEvent {
  if (error instanceof ResearchTimeoutError) return { type: "error", code: "research_timeout" };
  if (error instanceof ResearchCancelledError) return { type: "error", code: "research_cancelled" };
  if (error instanceof ResearchProviderError) return { type: "error", code: "research_provider_error" };
  return { type: "error", code: "research_failed" };
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const body = await request.json() as { question?: string };
    const question = body.question?.trim();
    if (!question || question.length > 4000) return json({ error: "invalid_question", correlationId: id }, { status: 400 });

    const encoder = new TextEncoder();
    const execution = new AbortController();
    const onRequestAbort = () => {
      if (!execution.signal.aborted) execution.abort();
    };
    if (request.signal.aborted) onRequestAbort();
    else request.signal.addEventListener("abort", onRequestAbort, { once: true });

    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: ResearchStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
            request.signal.removeEventListener("abort", onRequestAbort);
            if (!execution.signal.aborted) execution.abort();
          }
        };
        const close = () => {
          request.signal.removeEventListener("abort", onRequestAbort);
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* response reader already closed */ }
        };

        void researchService().answer(identity, question, {
          signal: execution.signal,
          onProgress: (phase) => emit({ type: "progress", phase }),
        }).then((data) => {
          emit({ type: "result", data });
          close();
        }).catch((error: unknown) => {
          const event = errorEvent(error);
          if (!(error instanceof ResearchCancelledError && request.signal.aborted)) emit(event);
          if (error instanceof ResearchProviderError) {
            logEvent("error", "research.stream_provider_error", { correlationId: id }, { provider: error.provider, status: error.status ?? null });
          } else if (error instanceof ResearchTimeoutError) {
            logEvent("warn", "research.stream_timeout", { correlationId: id });
          } else if (!(error instanceof ResearchCancelledError)) {
            logEvent("error", "research.stream_failed", { correlationId: id }, { errorName: error instanceof Error ? error.name : "unknown" });
          }
          close();
        });
      },
      cancel() {
        if (!execution.signal.aborted) execution.abort();
        request.signal.removeEventListener("abort", onRequestAbort);
        closed = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-correlation-id": id,
      },
    });
  } catch (error) { return apiError(error, id); }
}
