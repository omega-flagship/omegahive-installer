import { useEffect, useRef, useState } from 'react'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { isFlowMessage } from './operations'
import { FlowAdoptions } from './Adoptions'
import { isStudioSender, studioDocument, type StudioDocument } from './studioDocument'

export default function FlowPage() {
  const frame = useRef<HTMLIFrameElement>(null)
  const client = useHive(s => s.client)
  const swarms = useHive(s => s.swarms)
  const url = client?.flowStudioUrl?.()
  const enabled = client?.mode === 'live' && client.flowRequest && url && new URL(url).origin === location.origin
  const [document, setDocument] = useState<StudioDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled || !url) return
    const abort = new AbortController()
    const asset = async (name: string) => {
      const response = await fetch(new URL(name, url), {credentials:'same-origin', redirect:'error', signal:abort.signal})
      if (!response.ok) throw new Error('Flow studio assets are unavailable')
      const value = await response.text()
      if (value.length > 600000) throw new Error('Flow studio asset is too large')
      return value
    }
    void Promise.all([asset('index.html'), asset('app.js'), asset('style.css')]).then(([html,script,style]) => {
      if (!abort.signal.aborted) setDocument(studioDocument({html,script,style}, location.origin, crypto.randomUUID(), crypto.randomUUID()))
    }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Flow studio failed to load') })
    return () => { abort.abort(); setDocument(null); setError(null) }
  }, [enabled, url])
  useEffect(() => {
    if (!enabled || !client || !document) return
    let disposed = false
    const receive = async (event: MessageEvent) => {
      if (!isStudioSender(event, frame.current?.contentWindow ?? null, document.channel)) return
      // An opaque origin cannot be a postMessage target. The exact WindowProxy
      // plus per-document channel binds replies; the child pins our origin.
      const reply = (value: object) => { if (!disposed) frame.current?.contentWindow?.postMessage({...value,channel:document.channel}, '*') }
      if (event.data?.type === 'omegaflow-ready') {
        try {
          const me = await client.me?.()
          reply({ type: 'omegaflow-context', context: { swarms: Object.values(swarms).map(s => ({id:s.id,name:s.name})), me } })
        } catch { reply({type:'omegaflow-context',context:{swarms:[],me:null}}) }
        return
      }
      if (!isFlowMessage(event.data)) return
      const {id, operation, params} = event.data
      try { reply({type:'omegaflow-response',id,result:await client.flowRequest!(operation,params)}) }
      catch (error) { reply({type:'omegaflow-response',id,error:error instanceof Error ? error.message : 'Flow request failed'}) }
    }
    window.addEventListener('message', receive)
    return () => { disposed = true; window.removeEventListener('message', receive) }
  }, [client, enabled, swarms, document])
  return <Page title="Flow" eyebrow="Build connected work" label="Flow">
    <FlowAdoptions />
    {enabled ? error ? <p role="alert" className="px-6 py-8 text-ink-3">{error}</p>
      : document ? <iframe key={document.channel} ref={frame} srcDoc={document.html} title="Flow studio" className="h-full min-h-[720px] w-full border-0" sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />
      : <p role="status" className="px-6 py-8 text-ink-3">Loading Flow studio…</p>
      : <p className="px-6 py-8 text-ink-3">Flow studio requires a live Hive connection. The local authoring preview remains available separately.</p>}
  </Page>
}
