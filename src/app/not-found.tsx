import Link from "next/link";

export default function NotFound() {
  return (
    <main className="state-page">
      <section className="state-card">
        <span className="brand-mark" aria-hidden="true">C</span>
        <p className="eyebrow">404 · Not found</p>
        <h1>This Corvis resource isn’t available.</h1>
        <p className="lede">It may have moved, been removed, or be outside your workspace permissions.</p>
        <div className="state-actions">
          <Link className="primary-button" href="/">Return to workspace</Link>
        </div>
      </section>
    </main>
  );
}
