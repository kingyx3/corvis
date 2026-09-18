export function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase().replaceAll(" ", "-");
  return <span className={`status-pill status-${key}`}><span className="status-dot" />{status}</span>;
}
