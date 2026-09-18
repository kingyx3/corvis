"use client";

import { useState } from "react";
import type { ResearchAnswer, ResearchCitation } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";

export function ResearchView({
  suggestions,
  onAsk,
  onOpenCitation,
}: {
  suggestions: string[];
  onAsk: (question: string) => Promise<ResearchAnswer>;
  onOpenCitation: (citation: ResearchCitation) => void;
}) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [answer, setAnswer] = useState<ResearchAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (value: string) => {
    const next = value.trim();
    if (!next || loading) return;
    setQuestion(next);
    setInput("");
    setLoading(true);
    setError(null);
    try { setAnswer(await onAsk(next)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Research request failed"); }
    finally { setLoading(false); }
  };

  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI RESEARCH</p><h1>Ask Corvis</h1><p className="lede">Quantitative answers use governed semantic measures; narrative answers use permission-checked source evidence.</p></div><div className="answer-mode"><span className="live-dot"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar">You</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer"><div className="avatar corvis-avatar">C</div><div className="answer-body"><span>Corvis</span>
          {loading ? <div className="thinking" aria-label="Corvis is researching"><i/><i/><i/></div> : error ? <div className="answer-error"><Icon name="alert"/><p>{error}</p></div> : answer ? <>
            <p>{answer.answer}</p>
            {answer.citations.length > 0 && <div className="citation-row">{answer.citations.map((citation, index) => <button key={`${citation.type}-${citation.id}`} onClick={() => onOpenCitation(citation)}>[{index + 1}] {citation.label}</button>)}</div>}
            <p className="answer-footnote">All returned evidence passed tenant and source-access authorization before retrieval. Document text is treated as untrusted evidence, never as executable instruction.</p>
          </> : <p>Ask a question about a fund, portfolio company, metric, change, snapshot or source document. Corvis will use only data you are entitled to access.</p>}
        </div></div>
        <div className="suggestion-wrap"><span>Try asking</span><div>{suggestions.filter((item) => item !== question).slice(0, 4).map((suggestion) => <button key={suggestion} disabled={loading} onClick={() => void ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2} maxLength={4000}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Permission checked before retrieval</span><button disabled={!input.trim() || loading} aria-label="Ask Corvis"><Icon name="send" size={17}/></button></div></form>
      </div>
      <aside className="evidence-panel"><p className="eyebrow">EVIDENCE</p><h3>Sources used</h3>
        {!answer?.citations.length ? <div className="evidence-policy"><Icon name="shield"/><p>Evidence will appear here after a sourced answer.</p></div> : answer.citations.map((citation) => <div className="evidence-card" key={`${citation.type}-${citation.id}`}>
          <div className="evidence-head"><div className={`file-tile ${citation.type === "source" ? "pdf" : ""}`}>{citation.type === "source" ? "SRC" : "DATA"}</div><div><strong>{citation.label}</strong><span>{citation.type === "source" ? `Source reference${citation.pageNumber ? ` · p.${citation.pageNumber}` : ""}` : "Governed snapshot"}</span></div></div>
          <button onClick={() => onOpenCitation(citation)}>Open evidence <Icon name="arrow" size={14}/></button>
        </div>)}
        <div className="evidence-policy"><Icon name="shield"/><p>Search filters tenant and source-document rights before results are returned.</p></div>
      </aside>
    </div>
  </div>;
}
