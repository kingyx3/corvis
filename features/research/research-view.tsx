"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchAnswer, ResearchPin, ResearchProgressPhase } from "@/core/enterprise";
import type { SourceEvidence } from "@/core/workspace";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";
import { PageHeading } from "@/components/ui/page-heading";

type ConversationTurn = {
  id: string;
  question: string;
  /** When this answer was generated (or, for a reopened pin, originally generated). */
  askedAt: string;
  loading: boolean;
  phase: ResearchProgressPhase | null;
  answer: ResearchAnswer | null;
  error: string | null;
  /** Set once this turn's answer is saved for later reference (#182 D7). */
  pinId?: string;
  pinBusy?: boolean;
  /** True when this turn was reopened from a saved answer rather than freshly asked. */
  reopened?: boolean;
};

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

function formatAsOf(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ResearchView({ suggestions, canReadSources, onOpenReviewObservation }: { suggestions: string[]; canReadSources: boolean; onOpenReviewObservation?: (observationId: string) => void }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([{
    id: "preview",
    question: "What changed in my portfolio this quarter?",
    askedAt: new Date().toISOString(),
    loading: false,
    phase: null,
    answer: null,
    error: null,
  }]);
  const [focusedTurnId, setFocusedTurnId] = useState("preview");
  const [pending, setPending] = useState(false);
  const [pins, setPins] = useState<ResearchPin[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinsLoading, setPinsLoading] = useState(true);
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // Only the most recent evidence request may update the panel; an earlier,
  // slower response (or one for a previous answer) is discarded.
  const evidenceRequestRef = useRef(0);
  const evidenceRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // D8: a scrollable conversation history — always reveal the latest turn.
  const lastTurnLoading = turns.at(-1)?.loading ?? false;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, lastTurnLoading]);

  const loadPins = () => {
    void workspacePort.listResearchPins()
      .then((data) => { setPins(data); setPinsError(null); })
      .catch((reason: unknown) => setPinsError(reason instanceof Error ? reason.message : "Saved answers are temporarily unavailable"))
      .finally(() => setPinsLoading(false));
  };
  useEffect(() => { loadPins(); }, []);

  const updateTurn = (id: string, patch: Partial<ConversationTurn> | ((turn: ConversationTurn) => Partial<ConversationTurn>)) => {
    setTurns((current) => current.map((turn) => turn.id === id ? { ...turn, ...(typeof patch === "function" ? patch(turn) : patch) } : turn));
  };

  const ask = async (value: string) => {
    const next = value.trim();
    if (!next || pending) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = crypto.randomUUID();
    const askedAt = new Date().toISOString();
    setInput("");
    setPending(true);
    setTurns((current) => [...current, { id, question: next, askedAt, loading: true, phase: null, answer: null, error: null }]);
    setFocusedTurnId(id);
    try {
      const result = await workspacePort.researchStream(next, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "progress") updateTurn(id, { phase: event.phase });
        if (event.type === "result") updateTurn(id, { answer: event.data });
      }, controller.signal);
      if (!controller.signal.aborted) updateTurn(id, { answer: result });
    } catch (e) {
      updateTurn(id, { answer: null, error: controller.signal.aborted ? "Request cancelled." : researchError(e) });
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPending(false);
        updateTurn(id, { loading: false, phase: null });
      }
    }
  };

  const cancel = () => controllerRef.current?.abort();

  const pinTurn = async (turn: ConversationTurn) => {
    if (!turn.answer || turn.pinBusy) return;
    updateTurn(turn.id, { pinBusy: true });
    try {
      const pin = await workspacePort.pinResearchAnswer({ question: turn.question, answer: turn.answer, askedAt: turn.askedAt });
      updateTurn(turn.id, { pinId: pin.pinId, pinBusy: false });
      setPins((current) => [pin, ...current.filter((item) => item.pinId !== pin.pinId)]);
    } catch (reason) {
      updateTurn(turn.id, { pinBusy: false });
      setPinsError(reason instanceof Error ? reason.message : "Could not save this answer");
    }
  };

  const unpin = async (pinId: string) => {
    try {
      await workspacePort.unpinResearchAnswer(pinId);
      setPins((current) => current.filter((pin) => pin.pinId !== pinId));
      setTurns((current) => current.map((turn) => turn.pinId === pinId ? { ...turn, pinId: undefined } : turn));
    } catch (reason) {
      setPinsError(reason instanceof Error ? reason.message : "Could not remove this saved answer");
    }
  };

  // D7: reopening a saved answer always redisplays the stored payload — it
  // never re-asks the question against current data.
  const reopenPin = (pin: ResearchPin) => {
    const id = crypto.randomUUID();
    setTurns((current) => [...current, { id, question: pin.question, askedAt: pin.askedAt, loading: false, phase: null, answer: pin.answer, error: null, pinId: pin.pinId, reopened: true }]);
    setFocusedTurnId(id);
    setPinsOpen(false);
  };

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

  const focusedTurn = turns.find((turn) => turn.id === focusedTurnId) ?? turns.at(-1) ?? null;
  const lastQuestion = turns.at(-1)?.question ?? "";

  return <div className="research-page">
    <PageHeading className="research-heading" eyebrow="AI research" title="Ask Corvis" description="Answers combine deterministic fund data with permissioned source evidence." actions={<><button type="button" className="secondary-button" aria-expanded={pinsOpen} onClick={() => setPinsOpen((open) => !open)}><Icon name="clock" size={14}/>Saved answers{pins.length > 0 ? ` (${pins.length})` : ""}</button><div className="answer-mode"><span className="live-dot" aria-hidden="true"/>Trusted data mode</div></>}/>

    {pinsOpen && <section className="panel saved-answers-panel" aria-label="Saved Ask Corvis answers">
      <div className="saved-answers-header"><h3>Saved answers</h3><button type="button" className="text-button" onClick={() => setPinsOpen(false)}>Close</button></div>
      {pinsError && <p role="alert" className="saved-answers-error">{pinsError}</p>}
      {pinsLoading && <p className="answer-footnote" aria-busy="true">Loading saved answers…</p>}
      {!pinsLoading && !pins.length && <p className="answer-footnote">No saved answers yet. Save an answer from the conversation to reopen it later, exactly as it was asked.</p>}
      {!pinsLoading && pins.length > 0 && <ul className="saved-answers-list">{pins.map((pin) => <li key={pin.pinId}><div><strong>{pin.question}</strong><span>As of {formatAsOf(pin.askedAt)} · saved {formatAsOf(pin.pinnedAt)}</span></div><div className="saved-answers-item-actions"><button type="button" className="secondary-button" onClick={() => reopenPin(pin)}>Reopen</button><button type="button" className="text-button" onClick={() => void unpin(pin.pinId)}>Remove</button></div></li>)}</ul>}
    </section>}

    <div className="research-layout">
      <div className="conversation-panel">
        <div className="conversation-scroll" ref={scrollRef}>
          {turns.map((turn) => <div className="conversation-turn" key={turn.id}>
            <div className="user-question"><div className="avatar user-avatar" aria-hidden="true">U</div><div><span>You</span><p>{turn.question}</p></div></div>
            <div className="assistant-answer" aria-live="polite" aria-busy={turn.loading}><div className="avatar corvis-avatar" aria-hidden="true">C</div><div className="answer-body">
              <span>Corvis{turn.reopened && <span className="saved-answer-badge" role="status">Reopened saved answer · as of {formatAsOf(turn.askedAt)}</span>}</span>
              {turn.loading ? <><div className="thinking" aria-hidden="true"><i/><i/><i/></div><p className="answer-footnote">{phaseLabel(turn.phase)}</p></> : turn.error ? <p role="alert">{turn.error}</p> : turn.answer ? <>
                <p>{turn.answer.answer}</p>
                {turn.answer.uncertainty && <p className="answer-footnote">{turn.answer.uncertainty}</p>}
                {turn.answer.citations.some((citation) => citation.hasOpenReconciliation) && <p className="answer-footnote" role="status"><Icon name="alert" size={14}/>This answer cites a source with an open reconciliation exception — the value may change once resolved.</p>}
                <div className="citation-row">{turn.answer.citations.map((citation, index) => canReadSources ? <button key={citation.sourceReferenceId} disabled={evidenceLoading === citation.sourceReferenceId} onClick={() => { setFocusedTurnId(turn.id); void openEvidence(citation.sourceReferenceId); }}>{citationLabel(citation, index)}</button> : <span key={citation.sourceReferenceId} className="citation-label">{citationLabel(citation, index)}</span>)}</div>
                <div className="turn-actions">
                  {turn.answer.citations.length > 0 && <button type="button" className="text-button" onClick={() => setFocusedTurnId(turn.id)}>{focusedTurnId === turn.id ? "Showing sources" : "Show sources"}</button>}
                  {turn.pinId ? <button type="button" className="text-button" disabled={turn.pinBusy} onClick={() => void unpin(turn.pinId!)}><Icon name="check" size={13}/>Saved · remove</button> : <button type="button" className="text-button" disabled={turn.pinBusy} onClick={() => void pinTurn(turn)}>{turn.pinBusy ? "Saving…" : "Save this answer"}</button>}
                </div>
                <p className="answer-footnote">Quantitative claims must resolve to semantic queries; source citations are entitlement-checked before retrieval.</p>
              </> : <p>Ask a question to query your entitled Corvis data.</p>}
            </div></div>
          </div>)}
        </div>
        {suggestions.length > 0 && <div className="suggestion-wrap"><span id="suggestions-label">Try asking</span><div role="group" aria-labelledby="suggestions-label">{suggestions.filter((x) => x !== lastQuestion).slice(0,3).map((suggestion) => <button key={suggestion} disabled={pending} onClick={() => void ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>}
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea aria-label="Ask Corvis a question" value={input} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(input); } }} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2} disabled={pending}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access<span className="ask-hint"> · Enter to send, Shift+Enter for a new line</span></span>{pending ? <button type="button" className="text-button" onClick={cancel}>Cancel</button> : <button type="submit" disabled={!input.trim()} aria-label="Send question"><Icon name="send" size={17}/></button>}</div></form>
      </div>
      <aside className={`evidence-panel${evidence || evidenceError ? " evidence-open" : ""}`} aria-live="polite" aria-label="Source evidence"><p className="eyebrow">Evidence</p><h3>Sources used</h3>
        <div ref={evidenceRef}>
          {evidence && <div className="evidence-policy"><Icon name="source"/><p><strong>Opened entitled evidence</strong><br/>{`Document ${evidence.documentId}${evidence.page ? ` · page ${evidence.page}` : ""}${evidence.sheetName ? ` · ${evidence.sheetName}` : ""}${evidence.cellRange ? ` · ${evidence.cellRange}` : ""}`}{evidence.excerpt ? <><br/><br/>{evidence.excerpt}</> : null}</p><button className="text-button" onClick={closeEvidence}>Close</button></div>}
          {evidenceError && <div className="evidence-policy" role="alert"><Icon name="alert"/><p><strong>Source evidence unavailable</strong><br/>{evidenceError}</p><button className="text-button" onClick={closeEvidence}>Dismiss</button></div>}
        </div>
        {focusedTurn?.answer?.citations.length ? focusedTurn.answer.citations.map((citation) => <div className="evidence-card" key={citation.sourceReferenceId}><div><strong>{citation.label}</strong><span>{citation.page ? `Page ${citation.page}` : "Source reference"}</span>{citation.hasOpenReconciliation && <span className="status-pill status-review"><span className="status-dot"/>Open reconciliation</span>}</div>{canReadSources ? <button disabled={evidenceLoading === citation.sourceReferenceId} onClick={() => void openEvidence(citation.sourceReferenceId)}>{evidenceLoading === citation.sourceReferenceId ? "Opening…" : "Open entitled source"} <Icon name="arrow" size={14}/></button> : <span>Source access not granted</span>}{citation.observationId && onOpenReviewObservation && <button onClick={() => onOpenReviewObservation(citation.observationId!)}>View reviewed observation <Icon name="arrow" size={14}/></button>}</div>) : <div className="evidence-policy"><Icon name="shield"/><p>No source evidence is shown until a permission-checked answer returns citations.</p></div>}
      </aside>
    </div>
  </div>;
}
