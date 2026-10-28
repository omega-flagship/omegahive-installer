import { Component, createElement, lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { escapeAndSay } from './escapeSay'
import { useExperienceNotices } from '../shell/experienceStage'
import { useRoute } from '../lib/router'
import { EXPERIENCES, experienceById, type ExperienceDef } from './registry'
import { OmegaMenu } from './OmegaMenu'

/**
 * If an experience throws (while rendering or while its code loads), the person is returned to the Classic hive
 * immediately and locally; saving that choice happens afterwards and cannot hold them in a broken experience (Review R1).
 */
class Guard extends Component<{ children: ReactNode; onFail: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    this.props.onFail(e)
  }
  render() {
    return this.state.failed ? <Stage>Returning to the Classic hive…</Stage> : this.props.children
  }
}

/** The bare stage while an experience loads or hands back: its chrome's surface and ink, never the classic void. */
function Stage({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="xc-ink-2 fixed inset-0 grid place-items-center text-[13px]" style={{ background: 'var(--xc-texture), var(--xc-surface)', fontFamily: 'var(--xc-font)' }}>
      {children}
    </div>
  )
}

/** One lazy component per experience, made once at module load (never during render). A failed load is replaced so the next visit retries. */
const lazyFor = (e: ExperienceDef) => lazy(e.load!)
const LAZY = new Map<string, ComponentType>(EXPERIENCES.filter((e) => e.load).map((e) => [e.id, lazyFor(e)]))

export function ExperienceHost({ id }: { id: string }) {
  const def = experienceById(id)
  const Comp = LAZY.get(def.id)
  const route = useRoute()
  // in front (no classic page or sheet over it): notices keep clear of the experience's chrome (request Q)
  useExperienceNotices(!!Comp && route.name === 'hive')
  if (!Comp) return null
  return (
    <>
      <Guard
        key={def.id}
        onFail={(e) => {
          if (def.load) LAZY.set(def.id, lazyFor(def)) // a failed lazy load is retried next time, not cached as broken
          void escapeAndSay(`${def.name} hit a problem; you are back in the Classic hive`, { body: e instanceof Error ? e.message : undefined, when: 'always' })
        }}
      >
        <Suspense fallback={<Stage>Opening {def.name}…</Stage>}>
          {createElement(Comp)}
        </Suspense>
      </Guard>
      <EscapeHatch name={def.name} id={def.id} />
    </>
  )
}

/** The experience's Ω: the shared menu plus the way back to the Classic hive. Outside the Guard, so it survives a crash. */
function EscapeHatch({ name, id }: { name: string; id: string }) {
  const toClassic = () =>
    void escapeAndSay('Back to the Classic hive', { when: 'local' })
  return <OmegaMenu heading={`You are in ${name}`} context={id} footer={[{ label: 'Back to the Classic hive', run: toClassic }]} />
}
