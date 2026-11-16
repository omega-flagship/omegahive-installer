// Purpose: hand a file the page made to the browser's own download, so it lands where the person keeps downloads and
// nothing leaves this machine.

/** Save `blob` as `name` through the browser's download. The address is released once the browser has taken it. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
