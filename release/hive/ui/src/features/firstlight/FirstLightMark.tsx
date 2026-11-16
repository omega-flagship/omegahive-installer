import { LivingMark } from '../../brand/LivingMark'

/** First Light's identity: the living Omega in plain glass with a universe inside; never a listening/readiness indicator. */
export function FirstLightMark({ className = '' }: { className?: string }) {
  return <LivingMark look="cosmos" className={`aspect-[288/264] ${className}`} />
}
