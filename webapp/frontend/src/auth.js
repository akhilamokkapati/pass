// Demo-appropriate local auth: accounts and the current session live in the
// browser's localStorage, not a real backend. Good enough to make a login /
// create-account flow feel real for a project demo, but NOT secure - passwords
// are stored in plain text client-side, and logIn() below deliberately never
// rejects (any input gets you in) so a demo can't get stuck on a mistyped
// password. Do not reuse this pattern for anything handling real patient data.
const USERS_KEY = 'pass_users'
const SESSION_KEY = 'pass_session'

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {} } catch { return {} }
}
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
}

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null }
}

export function logOut() {
  localStorage.removeItem(SESSION_KEY)
}

// Compact "34 · Female · Right knee ACL recovery" line for anywhere the
// dashboard wants to show who it's currently personalized for. Empty string
// when nothing was collected (guests, or accounts made before this existed).
export function profileSummary(session) {
  if (!session) return ''
  const parts = []
  if (session.age) parts.push(`${session.age}`)
  if (session.gender && session.gender !== 'other') parts.push(session.gender[0].toUpperCase() + session.gender.slice(1))
  else if (session.gender === 'other') parts.push('Other')
  if (session.condition) parts.push(session.condition)
  return parts.join(' · ')
}

export function signUp({ name, email, password, role, age, gender, condition }) {
  name = (name || '').trim()
  const key = (email || '').trim().toLowerCase()
  if (!name || !key || !password) return { ok: false, error: 'Fill in all fields.' }
  if (role !== 'patient' && role !== 'clinician') return { ok: false, error: 'Pick a role.' }
  const users = loadUsers()
  if (users[key]) return { ok: false, error: 'An account with that email already exists.' }
  const profile = { age: age || null, gender: gender || null, condition: (condition || '').trim() || null }
  users[key] = { name, email: key, password, role, ...profile }
  saveUsers(users)
  const session = { name, email: key, role, ...profile }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return { ok: true, session }
}

// Guest shortcut: skips account creation entirely (not saved to USERS_KEY,
// so it never collides with a real account and leaves nothing behind after
// logout). Role has to be picked here since there's no existing account to
// read it from - this is the one place a role picker actually belongs.
export function guestLogin(role) {
  if (role !== 'patient' && role !== 'clinician') role = 'patient'
  const session = { name: 'Guest', email: 'guest', role, age: null, gender: null, condition: null }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return { ok: true, session }
}

export function logIn({ email, password }) {
  const key = (email || '').trim().toLowerCase()
  const users = loadUsers()
  const user = users[key]
  // Demo mode: never block here. A recognized email logs in as that account
  // (so you can still demo both roles by using the right email) - password is
  // not even checked. Anything else falls back to a patient session so the
  // button always works.
  const session = user
    ? { name: user.name, email: user.email, role: user.role, age: user.age || null, gender: user.gender || null, condition: user.condition || null }
    : { name: (email || '').trim() || 'Guest', email: key || 'guest', role: 'patient', age: null, gender: null, condition: null }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return { ok: true, session }
}
