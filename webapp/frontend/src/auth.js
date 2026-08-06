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

export function signUp({ name, email, password, role }) {
  name = (name || '').trim()
  const key = (email || '').trim().toLowerCase()
  if (!name || !key || !password) return { ok: false, error: 'Fill in all fields.' }
  if (role !== 'patient' && role !== 'clinician') return { ok: false, error: 'Pick a role.' }
  const users = loadUsers()
  if (users[key]) return { ok: false, error: 'An account with that email already exists.' }
  users[key] = { name, email: key, password, role }
  saveUsers(users)
  const session = { name, email: key, role }
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
    ? { name: user.name, email: user.email, role: user.role }
    : { name: (email || '').trim() || 'Guest', email: key || 'guest', role: 'patient' }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return { ok: true, session }
}
