/**
 * Whether the guided demo is under a modal now (GuideLayer hides and silences itself then). Probed on the demo's live
 * region (`.guide-live`), which is always mounted in the same body-level layer as its caption. Probing the caption itself
 * flip-flopped: under a modal it unmounts, the probe then reads "not under", it mounts again, modal containment makes it
 * inert, it unmounts…, an endless MutationObserver loop that froze the page (Surface D4 smoke, the Ask's sheet grip
 * pressed during a demo on a phone). underModal.test.ts plays that loop.
 */
import { askUnderModal } from '../ask/placement'

export const GUIDE_PROBE = '.guide-live'

export const guideUnderModal = (doc: Pick<Document, 'querySelector'>): boolean => askUnderModal(doc, doc.querySelector(GUIDE_PROBE))
