import { useState } from 'react'
import { signUp, logIn } from './auth.js'

export default function LoginView({ onAuth }) {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('patient')
  const [error, setError] = useState('')

  const submit = (e) => {
    e.preventDefault()
    const result = mode === 'login'
      ? logIn({ email, password })
      : signUp({ name, email, password, role })
    if (!result.ok) { setError(result.error); return }
    setError('')
    onAuth(result.session)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo">PASS</span>
          <span className="tagline">Patient Assessment Sensing System</span>
        </div>

        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setError('') }}>
            Log in
          </button>
          <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => { setMode('signup'); setError('') }}>
            Create account
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === 'signup' && (
            <label className="auth-field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoComplete="name" />
            </label>
          )}
          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>

          {mode === 'signup' && (
            <div className="auth-field">
              <span>I am a</span>
              <div className="auth-role">
                <button type="button" className={role === 'patient' ? 'on' : ''} onClick={() => setRole('patient')}>Patient</button>
                <button type="button" className={role === 'clinician' ? 'on' : ''} onClick={() => setRole('clinician')}>Clinician</button>
              </div>
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn download auth-submit">
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        <div className="auth-note">
          Demo login - accounts are stored in this browser only, not a real server.
        </div>
      </div>
    </div>
  )
}
