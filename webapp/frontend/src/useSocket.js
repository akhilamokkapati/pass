import { useEffect, useRef, useState } from 'react'

// Connects to the backend WebSocket (same origin, so it works through the
// cloudflared tunnel over wss). Auto-reconnects if the link drops.
export function useSocket() {
  const [snap, setSnap] = useState(null)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)

  useEffect(() => {
    let stopped = false
    let retry

    const connect = () => {
      if (stopped) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => { setConnected(true); ws.send('hi') }
      ws.onmessage = (e) => {
        try { setSnap(JSON.parse(e.data)) } catch { /* ignore */ }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!stopped) retry = setTimeout(connect, 1000)
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => { stopped = true; clearTimeout(retry); wsRef.current?.close() }
  }, [])

  return { snap, connected }
}
