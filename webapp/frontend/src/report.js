// Builds the PASS session report as a real vector PDF (jsPDF) and downloads it
// in one click - no print dialog, crisp text and charts. Layout mirrors the
// on-screen cards: a row of stat boxes plus a sparkline per metric.

import { jsPDF } from 'jspdf'

const f = (v, d = 0) => (v == null ? '--' : (+v).toFixed(d))

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// A row of stat boxes starting at (x, y). Returns the y of the row's bottom.
function drawBoxes(doc, x, y, boxes) {
  const w = 118, h = 50, gap = 9
  boxes.forEach((b, i) => {
    const bx = x + i * (w + gap)
    doc.setDrawColor(227, 231, 236)
    doc.setLineWidth(1)
    doc.roundedRect(bx, y, w, h, 6, 6)
    doc.setTextColor(20, 24, 31)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.text(String(b.val), bx + 10, y + 24)
    doc.setTextColor(107, 116, 128)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text(String(b.lbl), bx + 10, y + 40)
  })
  return y + h
}

// A sparkline of vals in the given colour. Returns the y of its bottom.
function drawSpark(doc, x, y, vals, hex) {
  const v = vals.filter((n) => n != null)
  const w = 320, h = 55
  if (v.length < 2) {
    doc.setTextColor(150, 150, 150)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text('no data', x, y + 20)
    return y + 24
  }
  const min = Math.min(...v)
  const max = Math.max(...v)
  const r = (max - min) || 1
  const pts = v.map((val, i) => [
    x + (i / (v.length - 1)) * w,
    y + h - ((val - min) / r) * (h - 6) - 3,
  ])
  const [rr, gg, bb] = hexToRgb(hex)
  doc.setDrawColor(rr, gg, bb)
  doc.setLineWidth(1.5)
  for (let i = 1; i < pts.length; i++) {
    doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
  }
  return y + h
}

// A section heading (uppercase, muted). Returns the y of its baseline.
function drawHeading(doc, x, y, text) {
  doc.setTextColor(91, 102, 117)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.text(text.toUpperCase(), x, y)
  return y
}

export function downloadReport(m) {
  const hist = m?.hist || []
  const now = new Date()
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const M = 40                 // left margin
  const CONTENT_W = 515        // A4 width (595) minus both margins

  // Title
  doc.setTextColor(20, 24, 31)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('PASS session report', M, 56)
  doc.setTextColor(138, 148, 162)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text('Generated ' + now.toLocaleString(), M, 72)

  const kneeData = (key, angleKey, reps) => {
    const kv = hist.map((h) => h[key]).filter((x) => x != null)
    const romMax = kv.length ? Math.max(...kv) : null
    const romMin = kv.length ? Math.min(...kv) : null
    const rom = romMax != null ? romMax - romMin : null
    return {
      kv,
      boxes: [
        { val: f(m?.[angleKey], 1) + ' deg', lbl: 'current' },
        { val: f(rom, 0) + ' deg', lbl: 'ROM' },
        { val: f(romMax, 0) + ' deg', lbl: 'max flexion' },
        { val: reps ?? 0, lbl: 'reps' },
      ],
    }
  }
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const sym = total > 60 ? Math.round((m.loadL / total) * 100) : null
  const kneeL = kneeData('kneeL', 'kneeLAngle', m?.repsL)
  const kneeR = kneeData('kneeR', 'kneeRAngle', m?.repsR)

  let y = 104
  const section = (title, boxes, vals, color) => {
    y = drawHeading(doc, M, y, title) + 14
    y = drawBoxes(doc, M, y, boxes) + 16
    if (vals) y = drawSpark(doc, M, y, vals, color) + 26
    else y += 6
  }

  section('Left knee flexion', kneeL.boxes, kneeL.kv, '#2b6fd6')
  section('Right knee flexion', kneeR.boxes, kneeR.kv, '#f6774b')
  section('Pelvis tilt', [{ val: f(m?.hipTilt, 1) + ' deg', lbl: 'tilt from neutral' }],
    hist.map((h) => h.hip), '#c8890f')
  section('Foot loading and symmetry', [
    { val: f(m?.loadL, 0), lbl: 'left load' },
    { val: f(m?.loadR, 0), lbl: 'right load' },
    { val: sym == null ? '--' : sym + ' / ' + (100 - sym) + ' %', lbl: 'L / R split' },
  ], null)

  // Disclaimer footer
  doc.setTextColor(138, 148, 162)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const disc = 'PASS, Patient Assessment Sensing System. Knee and pelvis angles from IMU ' +
    'quaternions (swing twist); foot loads from insole pressure in relative units. ' +
    'Validate against a goniometer and weighing scale before clinical use.'
  doc.text(doc.splitTextToSize(disc, CONTENT_W), M, y + 6)

  // One-click download, no dialog.
  doc.save(`PASS-report-${now.toISOString().slice(0, 10)}.pdf`)
}
