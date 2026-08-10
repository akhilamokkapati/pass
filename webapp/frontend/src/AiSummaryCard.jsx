// Clinician-only: turns the persisted sensor/actuation history into a plain-
// language progress summary + exercise suggestions via a real Gemini API
// call (webapp/backend/ai_summary.py) - not a template, an actual LLM call,
// on Google's free tier specifically so this doesn't bill per click. Still a
// deliberate button click rather than something that fires automatically -
// no reason to burn free-tier rate limit on requests nobody asked for.

import { useState } from 'react'

export default function AiSummaryCard() {
  const [state, setState] = useState('idle')   // idle | loading | done | error
  const [text, setText] = useState('')

  const generate = () => {
    setState('loading')
    fetch('/api/ai/summary', { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) { setText(data.error); setState('error'); return }
        setText(data.summary || 'No summary returned.')
        setState('done')
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
      {state === 'done' && <div className="ai-summary-text">{text}</div>}
    </section>
  )
}
