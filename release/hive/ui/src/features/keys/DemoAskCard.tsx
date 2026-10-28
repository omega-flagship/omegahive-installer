/**
 * Demo mode only (the in-browser simulator with invented people; Surface demo D2): what to try in the Ask, and the
 * simulated hive's memory switch, so memory on, off and learning can each be seen. Never shown on a real hive.
 */
import type { AskCapabilities } from '../../api/ask'
import { useAskMemory } from '../../lib/askMemory'
import { useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { startShowreel } from '../showreel/hook'
import { Button, Segmented } from '../../ui/primitives'
import { DEMO_TRIES } from './demoTries'

/** The sim's own switch for its Ask (SimClient.askSimFlags); live clients have none. */
interface DemoClient {
  mode: 'sim'
  demo: true
  askSimFlags(flags: AskCapabilities): void
}
const isDemo = (c: unknown): c is DemoClient => {
  const x = c as Partial<DemoClient> | null
  return !!x && x.mode === 'sim' && x.demo === true && typeof x.askSimFlags === 'function'
}

export function DemoAskCard() {
  const client = useHive((s) => s.client)
  const mem = useAskMemory()
  if (!isDemo(client)) return null
  const on = mem.capabilities ? mem.capabilities.memory : true
  const setMemory = (v: 'on' | 'off') => {
    client.askSimFlags({ conductor: true, memory: v === 'on' })
    void useAskStore.getState().loadSettings()
  }
  return (
    <section aria-labelledby="demo-ask-h" className="rounded-2xl border border-warn/30 bg-warn/[0.04] p-4" data-demo-ask="">
      <h2 id="demo-ask-h" className="eyebrow">
        Demo · simulated hive
      </h2>
      <p className="mt-1 text-[13px] text-ink-2">Everyone here is invented, and nothing leaves this browser.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {/* the showreel (features/showreel): the demo plays the hive by itself; loaded only here, in demo mode */}
        <Button type="button" variant="primary" icon="play" onClick={() => void startShowreel()} data-demo-showreel="">
          Watch it run
        </Button>
        <span className="text-[12.5px] text-ink-3">It moves the page by itself. Click, scroll, touch or type on the page, or move the mouse a good way across it, and you take over (Tab, Shift and the like, and the showreel’s own buttons, do not). Typing in the Ask pauses it so you can ask “why?”.</span>
      </div>
      <p className="mt-3 text-[13px] text-ink-2">Or try these in the Ask (press / to start typing):</p>
      <ul className="mt-3 space-y-2">
        {DEMO_TRIES.map((t) => (
          <li key={t.say} className="text-[13px]">
            <span className="font-medium text-ink">“{t.say}”</span>
            <span className="block text-[12px] text-ink-3">{t.shows}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] text-ink-3">This simulated hive’s Ask memory</span>
        <Segmented label="Simulated hive memory" value={on ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={setMemory} dense />
      </div>
    </section>
  )
}
