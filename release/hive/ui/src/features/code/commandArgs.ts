/** Match native Python shlex.split(posix=True, comments=False). Returns direct argv, without expansion. */
export function commandArgs(command: string): string[] {
  if (command.length > 16384 || command.includes('\0')) throw new Error('Command exceeds 16384 characters or contains a null byte')
  const args: string[] = []
  let word = '', started = false, quote: "'" | '"' | null = null
  const push = () => { if (started) { args.push(word); word = ''; started = false } }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
    } else if (ch === '\\') {
      if (++i === command.length) throw new Error('Command ends with an unfinished escape')
      const next = command[i]
      word += quote === '"' && next !== '"' && next !== '\\' ? '\\' + next : next
      started = true
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch; started = true
    } else if (' \t\r\n'.includes(ch)) push()
    else { word += ch; started = true }
  }
  if (quote) throw new Error('Command has an unclosed quote')
  push()
  if (!args.length || !args[0]) throw new Error('Enter an executable and its arguments')
  if (args.length > 100) throw new Error('Command exceeds 100 arguments')
  return args
}

export const liveRunStatus = (status: string) => ['prepared', 'starting', 'running', 'cancel_requested'].includes(status)
