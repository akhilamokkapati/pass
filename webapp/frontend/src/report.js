// Builds a self-contained HTML session report and downloads it, so a clinician
// can save or share it (and print to PDF). No dependencies.

function sparkSvg(vals, color) {
  const v = vals.filter((x) => x != null)
  if (v.length < 2) return '<div style="color:#999">no data</div>'
  const min = Math.min(...v)
  const max = Math.max(...v)
  const r = max - min || 1
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * 320},${60 - ((y - min) / r) * 54 - 3}`).join(' ')
  return `<svg viewBox="0 0 320 60" width="320" height="60"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`
}

export function downloadReport(m) {
  const hist = m?.hist || []
  const kv = hist.map((h) => h.knee).filter((x) => x != null)
  const romMax = kv.length ? Math.max(...kv) : null
  const romMin = kv.length ? Math.min(...kv) : null
  const rom = romMax != null ? romMax - romMin : null
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const sym = total > 60 ? Math.round((m.loadL / total) * 100) : null
  const f = (v, d = 0) => (v == null ? '--' : (+v).toFixed(d))
  const now = new Date()

  const box = (val, lbl) => `<div class=box><div class=val>${val}</div><div class=lbl>${lbl}</div></div>`

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PASS session report</title>
<style>
 body{font:14px system-ui,Segoe UI,Roboto,sans-serif;max-width:740px;margin:28px auto;padding:0 20px;color:#14181f}
 h1{font-size:22px;margin:0} h2{font-size:14px;color:#5b6675;text-transform:uppercase;letter-spacing:1px;margin:26px 0 8px}
 .muted{color:#8a94a2;font-size:12px} .row{display:flex;gap:12px;flex-wrap:wrap}
 .box{border:1px solid #e3e7ec;border-radius:10px;padding:10px 14px;min-width:120px}
 .val{font-size:22px;font-weight:800} .lbl{color:#6b7480;font-size:12px;margin-top:2px}
 .btn{margin-top:12px;padding:8px 14px;border:1px solid #cfd6de;border-radius:8px;background:#f5f7f9;cursor:pointer;font-weight:600}
 @media print{.noprint{display:none}}
</style></head><body>
 <h1>PASS session report</h1>
 <div class=muted>Generated ${now.toLocaleString()}</div>
 <button class="btn noprint" onclick="window.print()">Save as PDF / print</button>
 <h2>Knee flexion</h2>
 <div class=row>${box(f(m?.kneeAngle, 1) + ' deg', 'current')}${box(f(rom, 0) + ' deg', 'ROM')}${box(f(romMax, 0) + ' deg', 'max flexion')}${box(m?.reps ?? 0, 'reps')}</div>
 <div style="margin-top:10px">${sparkSvg(kv, '#2b6fd6')}</div>
 <h2>Pelvis tilt</h2>
 <div class=row>${box(f(m?.hipTilt, 1) + ' deg', 'tilt from neutral')}</div>
 <div style="margin-top:10px">${sparkSvg(hist.map((h) => h.hip), '#c8890f')}</div>
 <h2>Foot loading and symmetry</h2>
 <div class=row>${box(f(m?.loadL, 0), 'left load')}${box(f(m?.loadR, 0), 'right load')}${box(sym == null ? '--' : sym + ' / ' + (100 - sym) + ' %', 'L / R split')}</div>
 <p class=muted>PASS, Patient Assessment Sensing System. Knee and pelvis angles from IMU quaternions (swing twist); foot loads from insole pressure in relative units. Validate against a goniometer and weighing scale before clinical use.</p>
</body></html>`

  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `PASS-report-${now.toISOString().slice(0, 10)}.html`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
