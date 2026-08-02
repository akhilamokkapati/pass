// Small shared UI bits.

export function StatusPill({ ok }) {
  return (
    <span className={`pill ${ok ? 'live' : 'down'}`}>
      <i className="pill-dot" />{ok ? 'Live' : 'Not connected'}
    </span>
  )
}
