import { useEffect, useState } from 'react'
import { GatewayClient, EVENT_CONNECTION_STATE, type ConnectionState } from './protocol/client.ts'

const client = new GatewayClient(import.meta.env.GATEWAY_URL)

function App() {
  const [state, setState] = useState<ConnectionState>('disconnected')
  const [log, setLog] = useState<string[]>([])

  const push = (msg: string) => setLog((prev) => [...prev, `${new Date().toISOString().slice(11, 23)} ${msg}`])

  useEffect(() => {
    const unsub = client.on(EVENT_CONNECTION_STATE, (s) => {
      setState(s as ConnectionState)
      push(`state → ${s as string}`)
    })

    push('calling connect()…')
    client
      .connect()
      .then(() => {
        push('connect() resolved ✅')
        return client.call('agents.list')
      })
      .then((agents) => {
        const list = Array.isArray(agents)
          ? agents
          : (agents as { agents?: { id: string }[] })?.agents ?? []
        push(`agents.list ✅ → ${list.map((a: { id: string }) => a.id).join(', ')}`)
      })
      .catch((err: Error) => push(`ERROR ❌ ${err.message}`))

    return () => {
      unsub()
      client.disconnect()
    }
  }, [])

  return (
    <div style={{ fontFamily: 'monospace', padding: 16 }}>
      <h2>OpenClaw PWA — GatewayClient test</h2>
      <p>State: <strong>{state}</strong></p>
      <pre style={{ background: '#111', color: '#0f0', padding: 12, minHeight: 120 }}>
        {log.join('\n')}
      </pre>
    </div>
  )
}

export default App
