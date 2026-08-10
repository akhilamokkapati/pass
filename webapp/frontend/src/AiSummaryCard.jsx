// Clinician-only: turns the persisted sensor/actuation history into a plain-
// language progress summary + exercise suggestions via a real Gemini API call
// (webapp/backend/ai_summary.py) - not a template, an actual LLM call, on
// Google's free tier. It loads on open and then refreshes itself, but the
// backend gates the actual API call to at most once per refresh window and
// only when new data has arrived (and shares one cached result across all
// viewers), so this stays well within the free-tier quota. The button forces
// an immediate refresh.

import { useState, useEffect } from 'react'

// How often the browser asks the backend for a possibly-updated summary. This
// is cheap (the backend serves its cache and only calls Gemini when its own
// refresh window has elapsed AND the data changed), so it can be much finer
// than the backend's refresh window without costing extra API calls.
const POLL_MS = 10 * 60 * 1000

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

function formatUpdated(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function AiSummaryCard({ onSummary }) {
  const [state, setState] = useState('loading')  // loading | refreshing | done | error
  const [text, setText] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)

  // `force` true = the manual button (regenerate now); false = a background
  // poll or the initial load, where the backend usually just returns its cache.
  const load = (force) => {
    setState((prev) => (prev === 'done' ? 'refreshing' : 'loading'))
    fetch('/api/ai/summary' + (force ? '?force=true' : ''), { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) { failSoft(data.error); return }
        const summary = data.summary || 'No summary returned.'
        setText(summary)
        setUpdatedAt(data.generatedAt || null)
        setState('done')
        // Hand the latest summary up so the PDF report can include it.
        onSummary?.(summary)
      })
      .catch(() => failSoft("Couldn't reach the server - try again."))
  }

  // On failure keep any summary already on screen (a background poll that hits
  // an error shouldn't wipe a good summary); only surface the error on the
  // very first load when there's nothing to show. Uses functional updates so
  // it's correct even from the stale-closure poll callback.
  const failSoft = (msg) => {
    setState((prev) => (prev === 'refreshing' ? 'done' : 'error'))
    setText((prev) => prev || msg)
  }

  // Load on open, then poll for refreshes. The backend decides when to actually
  // call Gemini, so polling costs nothing extra.
  useEffect(() => {
    load(false)
    const id = setInterval(() => load(false), POLL_MS)
    return () => clearInterval(id)
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const updated = formatUpdated(updatedAt)

  return (
    <section className="card accent-balance ai-summary-card">
      <div className="card-head">
        <h3>AI progress summary</h3>
        <button className="btn download" onClick={() => load(true)}
          disabled={state === 'loading' || state === 'refreshing'}>
          {state === 'loading' || state === 'refreshing' ? 'Generating…' : 'Generate AI summary'}
        </button>
      </div>
      {state === 'loading' && <div className="cue">Reading recent history and asking Gemini…</div>}
      {state === 'error' && <div className="cal-msg">{text}</div>}
      {(state === 'done' || state === 'refreshing') && (
        <>
          <div className="ai-summary-text">{renderMarkdown(text)}</div>
          <div className="cue ai-updated">
            {state === 'refreshing'
              ? 'Checking for updates…'
              : `Updated ${updated || 'just now'} · refreshes automatically`}
          </div>
        </>
      )}
    </section>
  )
}
