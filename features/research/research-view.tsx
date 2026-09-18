"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icon";

export function ResearchView({ suggestions }: { suggestions: string[] }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("What changed in my portfolio this quarter?");
  const [loading, setLoading] = useState(false);
  const ask = (value: string) => {
    if (!value.trim()) return;
    setQuestion(value.trim());
    setInput("");
    setLoading(true);
    window.setTimeout(() => setLoading(false), 650);
  };

  return <div className="research-page">
    <section className="page-heading research-heading"><div><p className="eyebrow">AI RESEARCH</p><h1>Ask Corvis</h1><p className="lede">Answers combine deterministic fund data with permissioned source evidence.</p></div><div className="answer-mode"><span className="live-dot"/>Trusted data mode</div></section>
    <div className="research-layout">
      <div className="conversation-panel">
        <div className="user-question"><div className="avatar user-avatar">AM</div><div><span>You</span><p>{question}</p></div></div>
        <div className="assistant-answer"><div className="avatar corvis-avatar">C</div><div className="answer-body"><span>Corvis</span>{loading ? <div className="thinking"><i/><i/><i/></div> : <><p>Across your latest published and review-ready Q2 2026 snapshots, the most material movement is concentrated in operating performance and leverage.</p><div className="answer-callouts"><div><span className="callout-label">12 companies</span><strong>EBITDA increased</strong><p>Median LTM growth of 9.4%</p></div><div><span className="callout-label amber-text">4 companies</span><strong>Leverage increased</strong><p>By more than 0.5x</p></div><div><span className="callout-label">3 holdings</span><strong>Fair value moved &gt;10%</strong><p>Quarter over quarter</p></div></div><p><strong>ABC Corp</strong> was one of the strongest operating movers: LTM Adjusted EBITDA rose to <strong>$125m</strong> (+8.7%) while revenue increased 12.1%. Net debt / EBITDA increased from 3.9x to 4.2x.</p><div className="citation-row"><button>[1] Advent VIII · Q2 · p.18</button><button>[2] Advent VIII · Q2 · p.19</button><button>[3] Snapshot fps_adv8_2026q2_v2</button></div><p className="answer-footnote">Quantitative statements were computed from semantic measures. Narrative context was retrieved from entitled source documents.</p></>}</div></div>
        <div className="suggestion-wrap"><span>Try asking</span><div>{suggestions.filter((x) => x !== question).slice(0,3).map((suggestion) => <button key={suggestion} onClick={() => ask(suggestion)}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div></div>
        <form className="ask-box" onSubmit={(event) => { event.preventDefault(); ask(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a fund, company, metric, change or source document…" rows={2}/><div className="ask-footer"><span><Icon name="shield" size={14}/>Uses only data you can access</span><button disabled={!input.trim()}><Icon name="send" size={17}/></button></div></form>
      </div>
      <aside className="evidence-panel"><p className="eyebrow">EVIDENCE</p><h3>Sources used</h3><div className="evidence-card"><div className="evidence-head"><div className="file-tile pdf">PDF</div><div><strong>Advent International GPE VIII</strong><span>Q2 2026 · Quarterly report</span></div></div><div className="evidence-snippet"><span>Page 18</span><p>“Adjusted EBITDA” <mark>$125m</mark> · LTM Jun-26</p></div><button>Open source <Icon name="arrow" size={14}/></button></div><div className="evidence-card semantic"><div className="semantic-icon"><Icon name="database"/></div><div><strong>Fund-period snapshot</strong><span>fps_adv8_2026q2_v2</span></div><dl><dt>Status</dt><dd>Published</dd><dt>Facts</dt><dd>486</dd><dt>Formula</dt><dd>semantic-v4.2</dd></dl></div><div className="evidence-policy"><Icon name="shield"/><p>Source retrieval is permission-checked before search results are returned.</p></div></aside>
    </div>
  </div>;
}
