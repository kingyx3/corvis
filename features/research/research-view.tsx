"use client";

import { useState } from "react";
import type { ResearchAnswer } from "@/core/enterprise";
import { workspacePort } from "@/runtime/workspace-services";
import { Icon } from "@/components/ui/icon";

export function ResearchView({ suggestions }: { suggestions: string[] }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [answer, setAnswer] = useState<ResearchAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (value: string) => {
    const next = value.trim();
    if (!next || loading) return;
    setQuestion(next); setInput(""); setLoading(true); setError(null);
    try { setAnswer(await workspacePort.research(next)); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to answer this question"); setAnswer(null); }
    finally { setLoading(false); }
  };

  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI RESEARCH</p><h1>Ask Corvis</h1><p className="lede">Answers combine deterministic fund data with permissioned source evidence.</p></div><div className="answer-mode"><span className="live-dot"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar">U</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer"><div className="avatar corvis-avatar">C</div><div className="answer-body"><span>Corvis</span>{loading ? <div className="thinking"><i/><i/><i/></div> : error ? <p>{error}</p> : answer ? <><p>{answer.answer}</p>{answer.uncertainty && <p className="answer-footnote">{answer.uncertainty}</p>}<div className="citation-row">{answer.citations.map((citation, index) => <button key={citation.sourceReferenceId}>[{index + 1}] {citation.label}{citation.page ? ` · p.${citation.page}` : ""}</button>)}</div><p className="answer-footnote">Quantitative claims must resolve to semantic queries; source citations are entitlement-checked before retrieval.</p></> : <p>Ask a question to query your entitled Corvis data.</p>}</div></div>
        <div className="suggestion-wrap"><span>Try asking</span><div>{suggestions.filter((x) => x !== question).slice(0,3).map((suggestion) => <button key={suggestion} onClick={() => void ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access</span><button disabled={!input.trim() || loading}><Icon name="send" size={17}/></button></div></form>
      </div>
      <aside className="evidence-panel"><p className="eyebrow">EVIDENCE</p><h3>Sources used</h3>{answer?.citations.length ? answer.citations.map((citation) => <div className="evidence-card" key={citation.sourceReferenceId}><div><strong>{citation.label}</strong><span>{citation.page ? `Page ${citation.page}` : "Source reference"}</span></div><button>Open entitled source <Icon name="arrow" size={14}/></button></div>) : <div className="evidence-policy"><Icon name="shield"/><p>No source evidence is shown until a permission-checked answer returns citations.</p></div>}</aside>
    </div>
  </div>;
}
