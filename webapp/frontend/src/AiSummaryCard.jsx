// Clinician-only: turns the persisted sensor/actuation history into a plain-
// language progress summary + exercise suggestions via a real Gemini API
// call (webapp/backend/ai_summary.py) - not a template, an actual LLM call,
// on Google's free tier specifically so this doesn't bill per click. Still a
// deliberate button click rather than something that fires automatically -
// no reason to burn free-tier rate limit on requests nobody asked for.

import { useState } from 'react'

// Gemini replies in markdown (### headings, **bold**, --- dividers, numbered
// lists). We render just that small subset ourselves rather than pull in a
// full markdown dependency - keeps the bundle lean and avoids an npm install.

// Split a line into plain + bold runs on **...** and render each run.
function renderInline(line, keyBase) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyBase}-${i}`}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

function renderMarkdown(text) {
  const lines = text.split('\n')
  const out = []

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const key = `md-${i}`

    if (line.trim() === '') return                         // collapse blank lines
    if (/^-{3,}$/.test(line.trim())) {                      // --- divider
      out.push(<hr key={key} className="ai-hr" />)
      return
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/)          // ### heading
    if (heading) {
      out.push(<h4 key={key} className="ai-h">{renderInline(heading[1], key)}</h4>)
      return
    }
    const numbered = line.match(/^(\d+)\.\s+(.*)$/)        // 1. list item
    if (numbered) {
      out.push(
        <p key={key} className="ai-li">
          <span className="ai-li-num">{numbered[1]}.</span>{' '}
          {renderInline(numbered[2], key)}
        </p>
      )
      return
    }
    const bullet = line.match(/^\s*[*-]\s+(.*)$/)          // * or - sub-bullet
    if (bullet) {
      out.push(
        <p key={key} className="ai-bullet">
          <span className="ai-bullet-dot">•</span>{' '}
          {renderInline(bullet[1], key)}
        </p>
      )
      return
    }
    out.push(<p key={key} className="ai-p">{renderInline(line, key)}</p>)
  })

  return out
}

export default function AiSummaryCard({ onSummary }) {
  const [state, setState] = useState('idle')   // idle | loading | done | error
  const [text, setText] = useState('')

  const generate = () => {
    setState('loading')
    fetch('/api/ai/summary', { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) { setText(data.error); setState('error'); return }
        const summary = data.summary || 'No summary returned.'
        setText(summary)
        setState('done')
        // Hand the generated summary up so the PDF report can include it.
        onSummary?.(summary)
      })
      .catch(() => { setText("Couldn't reach the server - try again."); setState('error') })
  }

  return (
    <section className="card accent-balance ai-summary-card">
      <div className="card-head">
        <h3>AI progress summary</h3>
        <button className="btn download" onClick={generate} disabled={state === 'loading'}>
          {state === 'loading' ? 'Generating…' : 'Generate AI summary'}
        </button>
      </div>
      {state === 'idle' && (
        <div className="cue">
          Summarizes recent sensor and actuation-session history into plain language, with a
          few exercise suggestions for next time. Click to generate - each click is a real
          API call, not cached or automatic.
        </div>
      )}
      {state === 'loading' && <div className="cue">Reading recent history and asking Gemini…</div>}
      {state === 'error' && <div className="cal-msg">{text}</div>}
      {state === 'done' && <div className="ai-summary-text">{renderMarkdown(text)}</div>}
    </section>
  )
}
