"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchAnswer, ResearchProgressPhase } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";

function phaseLabel(phase: ResearchProgressPhase | null): string {
  if (phase === "planning") return "Planning a governed query…";
  if (phase === "retrieval") return "Retrieving entitled evidence…";
  if (phase === "generation") return "Explaining deterministic results…";
  return "Starting Ask Corvis…";
}

function researchError(error: unknown): string {
  if (!(error instanceof Error)) return "Unable to answer this question";
  if (error.name === "AbortError") return "Request cancelled.";
  if (error.message === "research_timeout") return "Ask Corvis timed out before a governed answer completed. Try a narrower question.";
  if (error.message === "research_cancelled") return "Request cancelled.";
  if (error.message === "research_provider_error") return "Ask Corvis could not reach a required research provider. Try again later.";
  if (error.message === "research_stream_ended_without_result") return "Ask Corvis ended before returning a complete governed answer.";
  return error.message;
}

export function ResearchView({ suggestions, canReadSources }: { suggestions: string[]; canReadSources: boolean }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [answer, setAnswer] = useState<ResearchAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<ResearchProgressPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // Only the most recent evidence request may update the panel; an earlier,
  // slower response (or one for a previous answer) is discarded.
  const evidenceRequestRef = useRef(0);
  const evidenceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const ask = async (value: string) => {
    const next = value.trim();
    if (!next || loading) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setQuestion(next);
    setInput("");
    setAnswer(null);
    evidenceRequestRef.current += 1;
    setEvidence(null);
    setEvidenceError(null);
    setEvidenceLoading(null);
    setLoading(true);
    setPhase(null);
    setError(null);
    try {
      const result = await workspacePort.researchStream(next, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "progress") setPhase(event.phase);
        if (event.type === "result") setAnswer(event.data);
      }, controller.signal);
      if (!controller.signal.aborted) setAnswer(result);
    } catch (e) {
      setAnswer(null);
      setError(controller.signal.aborted ? "Request cancelled." : researchError(e));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
        setPhase(null);
      }
    }
  };

  const cancel = () => controllerRef.current?.abort();

  // Evidence failures stay in the evidence panel: they must never replace
  // the governed answer the user is reading.
  const openEvidence = async (sourceReferenceId: string) => {
    if (!canReadSources) return;
    const requestId = ++evidenceRequestRef.current;
    setEvidenceLoading(sourceReferenceId);
    setEvidenceError(null);
    try {
      const opened = await workspacePort.sourceEvidence(sourceReferenceId);
      if (requestId !== evidenceRequestRef.current) return;
      setEvidence(opened);
    } catch (caught) {
      if (requestId !== evidenceRequestRef.current) return;
      setEvidence(null);
      setEvidenceError(caught instanceof Error ? caught.message : "Source evidence could not be opened");
    } finally {
      if (requestId === evidenceRequestRef.current) setEvidenceLoading(null);
    }
    evidenceRef.current?.scrollIntoView?.({ block: "nearest" });
  };
  const closeEvidence = () => { evidenceRequestRef.current += 1; setEvidence(null); setEvidenceError(null); setEvidenceLoading(null); };
  const citationLabel = (citation: ResearchAnswer["citations"][number], index: number) => `[${index + 1}] ${citation.label}${citation.page ? ` · p.${citation.page}` : ""}`;

  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI research</p><h1>Ask Corvis</h1><p className="lede">Answers combine deterministic fund data with permissioned source evidence.</p></div><div className="answer-mode"><span className="live-dot" aria-hidden="true"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar" aria-hidden="true">U</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer" aria-live="polite" aria-busy={loading}><div className="avatar corvis-avatar" aria-hidden="true">C</div><div className="answer-body"><span>Corvis</span>{loading ? <><div className="thinking" aria-hidden="true"><i/><i/><i/></div><p className="answer-footnote">{phaseLabel(phase)}</p></> : error ? <p role="alert">{error}</p> : answer ? <><p>{answer.answer}</p>{answer.uncertainty && <p className="answer-footnote">{answer.uncertainty}</p>}<div className="citation-row">{answer.citations.map((citation, index) => canReadSources ? <button key={citation.sourceReferenceId} disabled={evidenceLoading === citation.sourceReferenceId} onClick={() => void openEvidence(citation.sourceReferenceId)}>{citationLabel(citation, index)}</button> : <span key={citation.sourceReferenceId} className="citation-label">{citationLabel(citation, index)}</span>)}</div><p className="answer-footnote">Quantitative claims must resolve to semantic queries; source citations are entitlement-checked before retrieval.</p></> : <p>Ask a question to query your entitled Corvis data.</p>}</div></div>
        {suggestions.length > 0 && <div className="suggestion-wrap"><span id="suggestions-label">Try asking</span><div role="group" aria-labelledby="suggestions-label">{suggestions.filter((x) => x !== question).slice(0,3).map((suggestion) => <button key={suggestion} disabled={loading} onClick={() => void ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>}
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea aria-label="Ask Corvis a question" value={input} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(input); } }} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2} disabled={loading}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access<span className="ask-hint"> · Enter to send, Shift+Enter for a new line</span></span>{loading ? <button type="button" className="text-button" onClick={cancel}>Cancel</button> : <button type="submit" disabled={!input.trim()} aria-label="Send question"><Icon name="send" size={17}/></button>}</div></form>
      </div>
      <aside className={`evidence-panel${evidence || evidenceError ? " evidence-open" : ""}`} aria-live="polite" aria-label="Source evidence"><p className="eyebrow">Evidence</p><h3>Sources used</h3>
        <div ref={evidenceRef}>
          {evidence && <div className="evidence-policy"><Icon name="source"/><p><strong>Opened entitled evidence</strong><br/>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}{evidence.excerpt ? <><br/><br/>{evidence.excerpt}</> : null}</p><button className="text-button" onClick={closeEvidence}>Close</button></div>}
          {evidenceError && <div className="evidence-policy" role="alert"><Icon name="alert"/><p><strong>Source evidence unavailable</strong><br/>{evidenceError}</p><button className="text-button" onClick={closeEvidence}>Dismiss</button></div>}
        </div>
        {answer?.citations.length ? answer.citations.map((citation) => <div className="evidence-card" key={citation.sourceReferenceId}><div><strong>{citation.label}</strong><span>{citation.page ? `Page ${citation.page}` : "Source reference"}</span></div>{canReadSources ? <button disabled={evidenceLoading === citation.sourceReferenceId} onClick={() => void openEvidence(citation.sourceReferenceId)}>{evidenceLoading === citation.sourceReferenceId ? "Opening…" : "Open entitled source"} <Icon name="arrow" size={14}/></button> : <span>Source access not granted</span>}</div>) : <div className="evidence-policy"><Icon name="shield"/><p>No source evidence is shown until a permission-checked answer returns citations.</p></div>}
      </aside>
    </div>
  </div>;
}
