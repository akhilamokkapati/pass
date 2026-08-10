// Exports the full session's time-series history as a CSV, for feeding
// external tools (e.g. a gait model) rather than reading the dashboard.
// Same source data as report.js's sparklines, just the raw rows instead of
// a rendered summary.

const f = (v, d = 2) => (v == null ? '' : (+v).toFixed(d))

export function downloadCSV(m) {
  const hist = m?.hist || []
  const t0 = hist.length ? hist[0].t : 0
  const header = 't_s,knee_left_deg,knee_right_deg,hip_tilt_deg,foot_load_left,foot_load_right'
  const rows = hist.map((h) =>
    [f(h.t - t0, 3), f(h.kneeL), f(h.kneeR), f(h.hip), f(h.loadL, 0), f(h.loadR, 0)].join(','))
  const csv = [header, ...rows].join('\n')

  const now = new Date()
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `RUNMO-session-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
