/**
 * Keep it safe (M1): "Download my mind's memory" and "Restore from file", with a preview of what a restore would change
 * before anything is written, and a gentle nudge when there is memory not yet saved to a file. All of it stays on this
 * machine: the file goes to the person's own disk and back; nothing is sent to the hive.
 */
import { useId, useRef, useState } from 'react'
import { askMemory, forgetsOf, FILE_PROBLEM_WORDS, planEmpty, planWords, useAskMemory, type ForgetAllToken, type MemoryFile, type RestorePlan } from '../../lib/askMemory'
import { askConfirmBound, bindEpoch } from '../../lib/identityEpoch'
import { Button } from '../../ui/primitives'
import { dismissNudge, download, fileName, markSaved, memoryMark, needsSaving } from './durability'
import { folderLink, saveViaPicker, StaleWrite, useFolder, type SavePicker } from './folder'

/** The browser's save picker (Chromium): with it the page knows the file was written, so it may say "Saved". */
const savePicker = (): SavePicker | null => {
  const w = typeof window !== 'undefined' ? (window as unknown as { showSaveFilePicker?: SavePicker }) : null
  return typeof w?.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : null
}

type Pending = { file: MemoryFile; plan: RestorePlan; token: ForgetAllToken; name: string; fromFolder: boolean }

export function MemoryDurability({ compact = false }: { compact?: boolean }) {
  const mem = useAskMemory()
  const folder = useFolder()
  const [say, setSay] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [, bump] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  if (!mem.owner) return null
  const owner = mem.owner
  const nudge = needsSaving(owner, mem)

  const save = async () => {
    const binding = bindEpoch()
    setBusy(true)
    setSay(null)
    const out = await askMemory.exportFile()
    if (!binding.current()) return
    if (!out) {
      setBusy(false)
      return setSay({ tone: 'warn', text: 'This browser’s memory could not be read just now, so no file was made.' })
    }
    // the mark is what the FILE holds (entries, forget markers and watermark), not what the page shows now
    const mark = memoryMark({ beliefs: out.file.entries.flatMap((e) => (e.type === 'belief' ? [e] : [])), talks: out.file.entries.flatMap((e) => (e.type === 'talk' ? [e] : [])), forgets: forgetsOf(out.file.tombstones, out.file.forgot_all_at) })
    const pick = savePicker()
    if (pick) {
      // r2: the browser's save picker: once the write closes, the browser has accepted the file, so it is "Saved"
      try {
        // r2.1: the picker may stay open across an identity change: every stage is checked, a stale write is aborted
        const name = await saveViaPicker(pick, fileName(Date.now()), out.text, () => binding.current())
        binding.commit(() => {
          setBusy(false)
          markSaved(owner, mark)
          setSay({ tone: 'ok', text: `Saved as “${name}”. Keep it somewhere safe; restoring it here brings this memory back.` })
        })
      } catch (e) {
        binding.commit(() => {
          setBusy(false)
          if ((e as { name?: string })?.name !== 'AbortError' && !(e instanceof StaleWrite)) setSay({ tone: 'warn', text: 'The file could not be saved there. Nothing changed here.' })
        })
      }
      return
    }
    binding.commit(() => {
      setBusy(false)
      download(fileName(Date.now()), out.text)
      markSaved(owner, mark)
      // the page cannot see the download finish: it says only what it knows (Platform relay, r1.1)
      setSay({ tone: 'ok', text: 'Handed to your browser to download. Check it arrived, and keep the file somewhere safe; restoring it here brings this memory back.' })
    })
  }

  const choose = async (f: File | undefined) => {
    if (input.current) input.current.value = ''
    if (!f) return
    const binding = bindEpoch()
    let raw: string
    try {
      raw = await f.text()
    } catch {
      binding.commit(() => setSay({ tone: 'warn', text: FILE_PROBLEM_WORDS.unreadable }))
      return
    }
    if (!binding.current()) return
    await preview(raw, f.name)
  }

  /** M2: "Restore from your folder": the folder's file, through the same preview and merge. */
  const fromFolder = async () => {
    const binding = bindEpoch()
    if (folder.permission !== 'granted' && !(await folderLink.allow())) {
      binding.commit(() => setSay({ tone: 'warn', text: 'This browser was not allowed to read your folder, so nothing was restored.' }))
      return
    }
    const raw = await folderLink.read()
    if (!binding.current()) return
    if (raw === null) return setSay({ tone: 'warn', text: 'There is no saved memory in your folder yet. Nothing was restored.' })
    await preview(raw, `${folder.linked ?? 'your folder'}`, true)
  }

  /** r2.1: the person's explicit decision to write this browser's memory over the folder's copy (behind a confirm). */
  const replaceFolder = async () => {
    const binding = bindEpoch()
    const ok = await askConfirmBound(`Replace the memory saved in “${folder.linked}” with this browser’s? Anything only the folder’s copy holds will no longer be in that folder.`, 'Replace the folder’s copy', { danger: true, binding })
    if (!ok) return
    const done = await folderLink.replaceFolderCopy()
    binding.commit(() => setSay(done ? { tone: 'ok', text: `“${folder.linked}” now holds this browser’s memory.` } : { tone: 'warn', text: 'The folder could not be written just now. Nothing changed there.' }))
  }

  const preview = async (raw: string, name: string, fromFolder = false) => {
    const binding = bindEpoch()
    setSay(null)
    setPending(null)
    setBusy(true)
    const read = await askMemory.previewRestore(raw)
    binding.commit(() => {
      setBusy(false)
      if (!read) return setSay({ tone: 'warn', text: 'You are signed in as someone else now, so nothing was restored.' })
      if (!read.ok) return setSay({ tone: 'warn', text: FILE_PROBLEM_WORDS[read.problem] })
      if (planEmpty(read.plan)) return setSay({ tone: 'ok', text: `Nothing to change: ${planWords(read.plan).join('; ') || 'the file holds nothing new'}.` })
      setPending({ file: read.file, plan: read.plan, token: read.token, name, fromFolder })
    })
  }

  const apply = async () => {
    if (!pending) return
    const binding = bindEpoch()
    setBusy(true)
    const done = await askMemory.restore(pending.file, pending.token)
    // a consented restore from the folder: compare again, and lift the protection only if nothing there is missing here
    if (done && pending.fromFolder) await folderLink.restored()
    binding.commit(() => {
      setBusy(false)
      setPending(null)
      setSay(done ? { tone: 'ok', text: `Restored. ${planWords(done).join('; ')}.` } : { tone: 'warn', text: 'Nothing was restored: the memory changed hands or could not be written. Choose the file again to try once more.' })
    })
  }

  return (
    <div className={compact ? 'mt-3' : 'mt-4 rounded-xl border border-line px-3 py-3'} data-mind-durability="" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="text-[12px] font-semibold text-ink-3">
        Keep it safe
      </h3>
      <p className="mt-0.5 text-[12.5px] text-ink-3">Clearing this browser’s data clears this memory too. Save it to a file on your computer, and restore it from there.</p>
      <p className="mt-0.5 text-[12px] text-ink-4" data-mind-forget-scope="">Forget everything clears what’s remembered; your “Use my swarm talk in answers” choice stays as you set it. Clearing this browser’s data clears both.</p>
      {nudge && !pending && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line-2 bg-tint/[0.04] px-3 py-2 text-[12.5px] text-ink-2" role="status" data-mind-nudge="">
          <span className="min-w-0 flex-1">Some of what your mind remembers isn’t saved to a file yet.</span>
          <Button variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={() => (dismissNudge(owner, mem), bump((n) => n + 1))}>
            Not now
          </Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="subtle" className="min-h-9 px-3 text-[12.5px]" disabled={busy || !mem.ready} onClick={() => void save()} data-mind-download="">
          Download my mind’s memory
        </Button>
        <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" disabled={busy || !mem.ready} onClick={() => input.current?.click()} data-mind-restore="">
          Restore from file
        </Button>
        <input ref={input} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-label="Choose a saved memory file" onChange={(e) => void choose(e.target.files?.[0])} data-mind-file="" />
      </div>
      {folder.supported && (
        <div className="mt-3 rounded-lg border border-line px-3 py-2.5 text-[12.5px] text-ink-2" data-mind-folder={folder.linked ? folder.permission ?? 'linked' : 'none'}>
          {folder.linked ? (
            <>
              <p className="min-w-0">
                {folder.guarded ? (
                  <>Linked to your folder “{folder.linked}”. Nothing is written there until you choose below.</>
                ) : (
                  <>
                    Kept in your folder “{folder.linked}”
                    {folder.wroteAt ? `, last written ${new Date(folder.wroteAt).toLocaleTimeString()}` : ''}. It is written again after each change.
                  </>
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {folder.permission !== 'granted' && (
                  <Button variant="subtle" className="min-h-8 px-3 text-[12px]" disabled={busy} onClick={() => void folderLink.allow()} data-mind-folder-allow="">
                    Allow saving to “{folder.linked}”
                  </Button>
                )}
                {folder.guarded && (
                  <span className="w-full text-[12.5px] text-ink" data-mind-folder-guarded={folder.guarded}>
                    {folder.guarded === 'newer'
                      ? 'Your folder holds memory this browser doesn’t, so nothing is written over it. Restore from it, or replace it with this browser’s.'
                      : 'Your folder holds a file this page can’t read as your memory, so nothing is written over it.'}
                  </span>
                )}
                {mem.ready && (folder.guarded === 'newer' || (!mem.beliefs.length && !mem.talks.length)) && (
                  <Button variant="subtle" className="min-h-8 px-3 text-[12px]" disabled={busy} onClick={() => void fromFolder()} data-mind-folder-restore="">
                    Restore from your folder
                  </Button>
                )}
                {folder.guarded && (
                  <Button variant="ghost" className="min-h-8 px-3 text-[12px]" disabled={busy} onClick={() => void replaceFolder()} data-mind-folder-replace="">
                    Replace the folder’s copy with this browser’s
                  </Button>
                )}
                <Button variant="ghost" className="min-h-8 px-3 text-[12px]" disabled={busy} onClick={() => void folderLink.unlink()} data-mind-folder-unlink="">
                  Stop keeping it there
                </Button>
              </div>
              {folder.error && (
                <p className="mt-1.5 text-warn" role="alert">
                  {folder.error}
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">Or keep a copy in a folder on this computer, written again after each change.</span>
              <Button variant="subtle" className="min-h-8 px-3 text-[12px]" disabled={busy || !mem.ready} onClick={() => void folderLink.link()} data-mind-folder-link="">
                Choose a folder
              </Button>
            </div>
          )}
        </div>
      )}
      {pending && (
        <div className="mt-3 rounded-lg border border-line-2 bg-tint/[0.04] p-3" role="group" aria-label="What restoring would change" data-mind-preview="">
          <p className="text-[13px] text-ink">Restoring “{pending.name}” (saved {new Date(pending.file.exported_at).toLocaleDateString()}) would:</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-2">
            {planWords(pending.plan).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-ink-3">Your newer notes stay; the file’s newer notes replace your older ones. What you forgot stays forgotten.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" className="min-h-9 px-3 text-[12.5px]" disabled={busy} onClick={() => void apply()} data-mind-restore-go="">
              Restore
            </Button>
            <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {say && (
        <p className={`mt-2 text-[12.5px] ${say.tone === 'warn' ? 'text-warn' : 'text-ink-2'}`} role={say.tone === 'warn' ? 'alert' : 'status'} data-mind-say={say.tone}>
          {say.text}
        </p>
      )}
    </div>
  )
}
