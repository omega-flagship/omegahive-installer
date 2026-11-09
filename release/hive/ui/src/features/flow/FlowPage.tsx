import { useEffect, useMemo, useRef, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { has } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { isFlowMessage } from './operations'
import { FlowAdoptions } from './Adoptions'
import { isStudioSender, studioDocument, type StudioDocument } from './studioDocument'
import { flowScreen } from './data'

/**
 * The Flow studio itself: the Flow page's content, and Create's Flow bench (Flow is a bench kind of Create). What shows
 * (adopted revisions, loading, no live connection, a failed load, the studio) is atoms (flow.metta) that MeTTa composes
 * for the look being worn; this component loads the studio, talks to it, and offers it and the adoptions as islands.
 */
export function FlowStudio() {
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
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const canAdopt = has(client, 'flowList') && has(client, 'flowRevision')
  const { plan, data } = useMemo(() => {
    const { data, facts } = flowScreen({ enabled: !!enabled, ready: document !== null, error }, canAdopt)
    return { plan: compose('flow', facts), data }
  }, [enabled, document, error, canAdopt, compose])
  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2 md:px-6">
      <Screen plan={plan} className="min-h-0 flex-1" host={{
        data,
        islands: {
          'flow-adoptions': <FlowAdoptions />,
          'flow-studio': document ? <iframe key={document.channel} ref={frame} srcDoc={document.html} title="Flow studio" className="h-full min-h-[720px] w-full rounded-xl border-0" sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" /> : null,
        },
      }} />
    </div>
  )
}

export default function FlowPage() {
  return <Page title="Flow" eyebrow="Build connected work" label="Flow"><FlowStudio /></Page>
}
