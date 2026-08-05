// Demo-appropriate local auth: accounts and the current session live in the
// browser's localStorage, not a real backend. Good enough to make a login /
// create-account flow feel real for a project demo (accounts persist across
// reloads, wrong passwords are rejected), but NOT secure - passwords are
// stored in plain text client-side. Do not reuse this pattern for anything
// handling real patient data.
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
  if (!user || user.password !== password) return { ok: false, error: 'Incorrect email or password.' }
  const session = { name: user.name, email: user.email, role: user.role }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return { ok: true, session }
}
