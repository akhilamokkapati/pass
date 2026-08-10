// Builds the PASS session report as a real vector PDF (jsPDF) and downloads it
// in one click - no print dialog, crisp text and charts. Each metric is a card
// with a colour-accented heading, a row of stat tiles, and an area sparkline.

import { jsPDF } from 'jspdf'

const f = (v, d = 0) => (v == null ? '--' : (+v).toFixed(d))

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lighten([r, g, b], t) {
  return [Math.round(r + (255 - r) * t), Math.round(g + (255 - g) * t), Math.round(b + (255 - b) * t)]
}

// Split a markdown line into plain / bold runs on **...**.
function parseRuns(line) {
  return line.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '').map((p) =>
    p.startsWith('**') && p.endsWith('**') ? { text: p.slice(2, -2), bold: true } : { text: p, bold: false })
}

// Draw wrapped rich text (mixed bold/normal runs) starting at baseline y.
// Returns the baseline y of the last line drawn.
function drawRich(doc, x, y, maxW, runs, size, lineH, color, forceBold) {
  doc.setFontSize(size)
  doc.setTextColor(color[0], color[1], color[2])
  let cx = x
  runs.forEach((run) => {
    doc.setFont('helvetica', (run.bold || forceBold) ? 'bold' : 'normal')
    run.text.split(/(\s+)/).forEach((w) => {
      if (w === '') return
      const ww = doc.getTextWidth(w)
      if (w.trim() === '') { cx += ww; return }        // whitespace token
      if (cx + ww > x + maxW && cx > x) { y += lineH; cx = x }
      doc.text(w, cx, y)
      cx += ww
    })
  })
  return y
}

// Card background panel.
function drawCardBg(doc, x, y, w, h) {
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(230, 235, 241)
  doc.setLineWidth(1)
  doc.roundedRect(x, y, w, h, 10, 10, 'FD')
}

// Colour dot + section title. `baseY` is the text baseline.
function drawCardHeading(doc, x, baseY, text, hex) {
  const [r, g, b] = hexToRgb(hex)
  doc.setFillColor(r, g, b)
  doc.circle(x + 3, baseY - 3, 3, 'F')
  doc.setTextColor(30, 36, 46)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(text, x + 13, baseY)
}

// A row of stat tiles. Returns the tile height.
function drawTiles(doc, x, y, w, tiles) {
  const n = tiles.length
  const gap = 10
  const tw = (w - (n - 1) * gap) / n
  const th = 48
  tiles.forEach((t, i) => {
    const tx = x + i * (tw + gap)
    doc.setFillColor(255, 255, 255)
    doc.setDrawColor(228, 233, 239)
    doc.setLineWidth(1)
    doc.roundedRect(tx, y, tw, th, 7, 7, 'FD')
    const num = String(t.num)
    doc.setTextColor(24, 28, 36)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.text(num, tx + 11, y + 23)
    if (t.unit && num !== '--') {
      const nw = doc.getTextWidth(num)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(140, 146, 156)
      doc.text(t.unit, tx + 11 + nw + 3, y + 23)
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(120, 127, 138)
    doc.text(String(t.lbl), tx + 11, y + 39)
  })
  return th
}

// Area sparkline in the given colour, framed by a faint baseline.
function drawChart(doc, x, y, w, h, vals, hex) {
  const v = vals.filter((n) => n != null)
  const [rr, gg, bb] = hexToRgb(hex)

  if (v.length < 2) {
    doc.setDrawColor(230, 234, 239)
    doc.setLineWidth(0.75)
    doc.line(x, y + h, x + w, y + h)
    doc.setTextColor(150, 156, 166)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text('no data yet', x, y + h / 2)
    return
  }

  const min = Math.min(...v)
  const max = Math.max(...v)
  const r = (max - min) || 1
  const pts = v.map((val, i) => [
    x + (i / (v.length - 1)) * w,
    y + h - ((val - min) / r) * (h - 8) - 4,
  ])

  // Area fill (light tint of the line colour).
  const segs = [[pts[0][0] - x, pts[0][1] - (y + h)]]
  for (let i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]])
  const last = pts[pts.length - 1]
  segs.push([(x + w) - last[0], (y + h) - last[1]])
  doc.setFillColor(...lighten([rr, gg, bb], 0.86))
  doc.lines(segs, x, y + h, [1, 1], 'F', true)

  // Baseline.
  doc.setDrawColor(230, 234, 239)
  doc.setLineWidth(0.75)
  doc.line(x, y + h, x + w, y + h)

  // Top line.
  doc.setDrawColor(rr, gg, bb)
  doc.setLineWidth(1.6)
  doc.setLineJoin('round')
  doc.setLineCap('round')
  for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])

  // Min / max labels, right-aligned.
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(140, 146, 156)
  doc.text(String(Math.round(max)), x + w, y + 8, { align: 'right' })
  doc.text(String(Math.round(min)), x + w, y + h - 2, { align: 'right' })
}

// Draws the whole report and returns the jsPDF doc (kept separate from the
// download so it can be rendered/inspected without a browser save dialog).
export function buildReportDoc(m, summary) {
  const hist = m?.hist || []
  const now = new Date()
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const PAGE_W = 595
  const PAGE_H = 842
  const M = 40
  const W = PAGE_W - 2 * M
  const BOTTOM = PAGE_H - 40

  // Top accent stripe + header.
  doc.setFillColor(43, 111, 214)
  doc.rect(0, 0, PAGE_W, 6, 'F')
  doc.setTextColor(24, 28, 36)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.text('PASS session report', M, 62)
  doc.setTextColor(140, 146, 156)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text('Patient Assessment Sensing System', M, 78)
  doc.text('Generated ' + now.toLocaleString(), PAGE_W - M, 62, { align: 'right' })
  doc.setDrawColor(230, 235, 241)
  doc.setLineWidth(1)
  doc.line(M, 92, PAGE_W - M, 92)

  let y = 108
  // Start a fresh page when the next block wouldn't fit.
  const ensureSpace = (need) => {
    if (y + need > BOTTOM) { doc.addPage(); y = 54 }
  }

  // AI progress summary (only if the clinician generated one on screen).
  if (summary && summary.trim()) {
    doc.setFillColor(43, 111, 214)
    doc.circle(M + 3, y - 3, 3, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(24, 28, 36)
    doc.text('AI progress summary', M + 13, y)
    y += 16

    const lines = summary.replace(/\r/g, '').split('\n')
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      if (line.trim() === '') { y += 5; continue }

      if (/^-{3,}$/.test(line.trim())) {                       // --- divider
        ensureSpace(16)
        doc.setDrawColor(230, 235, 241)
        doc.setLineWidth(1)
        doc.line(M, y, PAGE_W - M, y)
        y += 12
        continue
      }
      const h = line.match(/^#{1,6}\s+(.*)$/)                  // ### heading
      if (h) {
        ensureSpace(26)
        y += 8
        y = drawRich(doc, M, y, W, parseRuns(h[1]), 11, 15, [30, 36, 46], true) + 6
        continue
      }
      const n = line.match(/^(\d+)\.\s+(.*)$/)                 // 1. list item
      if (n) {
        ensureSpace(20)
        y += 4
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(10)
        doc.setTextColor(30, 36, 46)
        doc.text(n[1] + '.', M, y)
        y = drawRich(doc, M + 18, y, W - 18, parseRuns(n[2]), 10, 14, [55, 62, 74]) + 13
        continue
      }
      const b = line.match(/^\s*[*-]\s+(.*)$/)                 // * / - bullet
      if (b) {
        ensureSpace(18)
        y += 2
        doc.setFillColor(120, 127, 138)
        doc.circle(M + 6, y - 3, 1.3, 'F')
        y = drawRich(doc, M + 16, y, W - 16, parseRuns(b[1]), 10, 14, [70, 77, 88]) + 13
        continue
      }
      ensureSpace(18)                                          // paragraph
      y += 2
      y = drawRich(doc, M, y, W, parseRuns(line), 10, 14, [55, 62, 74]) + 13
    }

    // Divider before the metric cards.
    y += 6
    ensureSpace(30)
    doc.setDrawColor(230, 235, 241)
    doc.setLineWidth(1)
    doc.line(M, y, PAGE_W - M, y)
    y += 22
  }

  const kneeData = (key, angleKey, reps) => {
    const kv = hist.map((h) => h[key]).filter((x) => x != null)
    const romMax = kv.length ? Math.max(...kv) : null
    const romMin = kv.length ? Math.min(...kv) : null
    const rom = romMax != null ? romMax - romMin : null
    return {
      kv,
      tiles: [
        { num: f(m?.[angleKey], 1), unit: 'deg', lbl: 'current' },
        { num: f(rom, 0), unit: 'deg', lbl: 'ROM' },
        { num: f(romMax, 0), unit: 'deg', lbl: 'max flexion' },
        { num: reps ?? 0, unit: '', lbl: 'reps' },
      ],
    }
  }
  const total = (m?.loadL || 0) + (m?.loadR || 0)
  const sym = total > 60 ? Math.round((m.loadL / total) * 100) : null
  const kneeL = kneeData('kneeL', 'kneeLAngle', m?.repsL)
  const kneeR = kneeData('kneeR', 'kneeRAngle', m?.repsR)

  const card = (title, hex, tiles, vals) => {
    const hasChart = vals !== null && vals !== undefined
    const cardH = hasChart ? 162 : 94
    ensureSpace(cardH + 16)
    drawCardBg(doc, M, y, W, cardH)
    drawCardHeading(doc, M + 14, y + 24, title, hex)
    const tilesTop = y + 36
    drawTiles(doc, M + 14, tilesTop, W - 28, tiles)
    if (hasChart) drawChart(doc, M + 14, tilesTop + 48 + 16, W - 28, 50, vals, hex)
    y += cardH + 14
  }

  card('Left knee flexion', '#2b6fd6', kneeL.tiles, kneeL.kv)
  card('Right knee flexion', '#f6774b', kneeR.tiles, kneeR.kv)
  card('Pelvis tilt', '#c8890f',
    [{ num: f(m?.hipTilt, 1), unit: 'deg', lbl: 'tilt from neutral' }],
    hist.map((h) => h.hip))
  card('Foot loading and symmetry', '#2e9e6b', [
    { num: f(m?.loadL, 0), unit: '', lbl: 'left load' },
    { num: f(m?.loadR, 0), unit: '', lbl: 'right load' },
    { num: sym == null ? '--' : sym + ' / ' + (100 - sym), unit: '%', lbl: 'L / R split' },
  ], null)

  // Footer rule + disclaimer.
  ensureSpace(50)
  doc.setDrawColor(230, 235, 241)
  doc.setLineWidth(1)
  doc.line(M, y, PAGE_W - M, y)
  doc.setTextColor(150, 156, 166)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const disc = 'PASS, Patient Assessment Sensing System. Knee and pelvis angles from IMU ' +
    'quaternions (swing twist); foot loads from insole pressure in relative units. ' +
    'Validate against a goniometer and weighing scale before clinical use.'
  doc.text(doc.splitTextToSize(disc, W), M, y + 16)

  return doc
}

// One-click download, no dialog.
export function downloadReport(m, summary) {
  const doc = buildReportDoc(m, summary)
  doc.save(`PASS-report-${new Date().toISOString().slice(0, 10)}.pdf`)
}
