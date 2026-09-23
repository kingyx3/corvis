"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchAnswer, ResearchProgressPhase } from "@/core/enterprise";
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

export function ResearchView({ suggestions }: { suggestions: string[] }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [answer, setAnswer] = useState<ResearchAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<ResearchProgressPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Leaving the view must not leave a research stream (and its server-side
  // work) running in the background.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const ask = async (value: string) => {
    const next = value.trim();
    if (!next || loading) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setQuestion(next);
    setInput("");
    setAnswer(null);
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

  const cancel = () => {
    controllerRef.current?.abort();
  };

  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI RESEARCH</p><h1>Ask Corvis</h1><p className="lede">Answers combine deterministic fund data with permissioned source evidence.</p></div><div className="answer-mode"><span className="live-dot"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar">U</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer"><div className="avatar corvis-avatar">C</div><div className="answer-body"><span>Corvis</span>{loading ? <><div className="thinking"><i/><i/><i/></div><p className="answer-footnote">{phaseLabel(phase)}</p></> : error ? <p>{error}</p> : answer ? <><p>{answer.answer}</p>{answer.uncertainty && <p className="answer-footnote">{answer.uncertainty}</p>}<div className="citation-row">{answer.citations.map((citation, index) => <button key={citation.sourceReferenceId}>[{index + 1}] {citation.label}{citation.page ? ` · p.${citation.page}` : ""}</button>)}</div><p className="answer-footnote">Quantitative claims must resolve to semantic queries; source citations are entitlement-checked before retrieval.</p></> : <p>Ask a question to query your entitled Corvis data.</p>}</div></div>
        <div className="suggestion-wrap"><span>Try asking</span><div>{suggestions.filter((x) => x !== question).slice(0,3).map((suggestion) => <button key={suggestion} disabled={loading} onClick={() => void ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2} disabled={loading}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access</span>{loading ? <button type="button" className="text-button" onClick={cancel}>Cancel</button> : <button disabled={!input.trim()} aria-label="Send question"><Icon name="send" size={17}/></button>}</div></form>
      </div>
      <aside className="evidence-panel"><p className="eyebrow">EVIDENCE</p><h3>Sources used</h3>{answer?.citations.length ? answer.citations.map((citation) => <div className="evidence-card" key={citation.sourceReferenceId}><div><strong>{citation.label}</strong><span>{citation.page ? `Page ${citation.page}` : "Source reference"}</span></div><button>Open entitled source <Icon name="arrow" size={14}/></button></div>) : <div className="evidence-policy"><Icon name="shield"/><p>No source evidence is shown until a permission-checked answer returns citations.</p></div>}</aside>
    </div>
  </div>;
}
