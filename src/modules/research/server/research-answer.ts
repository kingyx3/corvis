import type { RequestIdentity, ResearchAnswer } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { researchService, type ResearchExecutionOptions } from "./research.ts";

/** The demo-mode answer: no retrieval or model is involved, but the phases and cancellation behave like the real service. */
async function demoAnswer(question: string, options: ResearchExecutionOptions): Promise<ResearchAnswer> {
  options.signal?.throwIfAborted();
  options.onProgress?.("planning");
  options.signal?.throwIfAborted();
  options.onProgress?.("retrieval");
  options.signal?.throwIfAborted();
  options.onProgress?.("generation");
  options.signal?.throwIfAborted();
  return { answer: `Demo-mode response for: ${question}.`, citations: [], semanticQueryIds: [], uncertainty: "Demo mode does not execute production semantic queries." };
}

/** Answers a research question: the permissioned research service, or the canned demo answer in demo mode. */
export async function answerResearchQuestion(identity: RequestIdentity, question: string, options: ResearchExecutionOptions = {}): Promise<ResearchAnswer> {
  if (getServerConfig().demoMode) return demoAnswer(question, options);
  return researchService().answer(identity, question, options);
}
