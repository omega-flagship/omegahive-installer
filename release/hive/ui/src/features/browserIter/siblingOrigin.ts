const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')

/** Dot112903: configurable sibling; iter.localhost is a Mac test default, never a public-host guess. */
export function iterSiblingOrigin(pageHref: string, configured?: string): string | null {
  try {
    const page = new URL(pageHref)
    if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) return null
    if (!configured?.trim()) {
      if (!loopback(page.hostname)) return null
      return `${page.protocol}//iter.localhost${page.port ? `:${page.port}` : ''}` === page.origin ? null
        : `${page.protocol}//iter.localhost${page.port ? `:${page.port}` : ''}`
    }
    const sibling = new URL(configured.trim())
    if (!['http:', 'https:'].includes(sibling.protocol) || sibling.username || sibling.password || sibling.pathname !== '/' || sibling.search || sibling.hash || sibling.origin === page.origin) return null
    if (sibling.protocol !== 'https:' && !(loopback(page.hostname) && loopback(sibling.hostname))) return null
    return sibling.origin
  } catch { return null }
}
