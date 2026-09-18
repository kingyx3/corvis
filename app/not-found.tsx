export default function NotFound() {
  return (
    <main className="content">
      <section className="page-heading">
        <div>
          <p className="eyebrow">NOT FOUND</p>
          <h1>This Corvis resource isn’t available.</h1>
          <p className="lede">It may have moved, been removed, or be outside your workspace permissions.</p>
        </div>
        <a className="primary-button" href="/">Return to workspace</a>
      </section>
    </main>
  );
}
