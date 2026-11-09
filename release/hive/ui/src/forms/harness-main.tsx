import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '../index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FormHarness } from './FormHarness'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FormHarness />
  </StrictMode>,
)
