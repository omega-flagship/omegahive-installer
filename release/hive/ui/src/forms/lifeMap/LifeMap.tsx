import { Component, lazy, Suspense, type ReactNode } from 'react'
import Classic from './Classic'
import Still from './Still'
import { useAtlas, type Atlas } from './useAtlas'
import { nativeGrammar, type LifeMapProps } from './types'
import './lifemap.css'

/**
 * Atlas, the luminous body map: the app form for the Atlas program. One state (useAtlas) shared by three grammars:
 *  - classic: the legacy body map in the hive's dark glass (WebGL atmosphere + SVG plate);
 *  - still:   a biography on calm paper;
 *  - cosmos:  a planet of self (r3f + bloom), loaded on first use.
 * Other grammars open in classic. Owner sees their graph; anyone else sees an empty Atlas and may explore the sample.
 */

const Cosmos = lazy(() => import('./Cosmos'))

class GlBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.warn('atlas cosmos unavailable; opening classic', e)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Body({ atlas, grammar }: { atlas: Atlas; grammar: 'classic' | 'still' | 'cosmos' }) {
  if (grammar === 'still') return <Still atlas={atlas} />
  if (grammar === 'cosmos')
    return (
      <GlBoundary fallback={<Classic atlas={atlas} />}>
        <Suspense fallback={<div className="lm lm-loading" aria-busy="true" />}>
          <Cosmos atlas={atlas} />
        </Suspense>
      </GlBoundary>
    )
  return <Classic atlas={atlas} />
}

export default function LifeMap(props: LifeMapProps) {
  const atlas = useAtlas(props)
  return <Body atlas={atlas} grammar={nativeGrammar(props.grammar)} />
}
