import type { DebuggerRun } from './debuggerSession'
export interface SourcePage { run_id:string;workspace_id:string;generation:number;tree_digest:string;path:string;file_digest:string;size_bytes:number;after:number;cursor:number;eof:boolean;encoding:string;data:string;source:string;runtime_file_bytes_verified:boolean;currency:string }
/** Assemble saved input, never the mutable target tree or current editor contents. */
export class RunSourceReader {
  cursor=0
  private pages: Uint8Array[]=[]
  private metadata: SourcePage|null=null
  constructor(readonly run: DebuggerRun) {}
  append(page:SourcePage) {
    if(page.run_id!==this.run.id||page.workspace_id!==this.run.workspace_id||page.generation!==this.run.generation||page.tree_digest!==this.run.tree_digest||page.source!=='run-saved-input'||page.runtime_file_bytes_verified!==false||page.encoding!=='base64'||!['current','historical'].includes(page.currency))throw new Error('Saved source identity does not match debugger run')
    if(!page.path||page.path.startsWith('/')||page.path.includes('\\')||page.path.split('/').some(x=>!x||x==='.'||x==='..')||!Number.isSafeInteger(page.size_bytes)||page.size_bytes<0||page.size_bytes>2097152||!/^[a-f0-9]{64}$/.test(page.file_digest)||page.after!==this.cursor||!Number.isSafeInteger(page.cursor))throw new Error('Invalid saved source metadata or cursor')
    if(this.metadata&&(page.path!==this.metadata.path||page.file_digest!==this.metadata.file_digest||page.size_bytes!==this.metadata.size_bytes))throw new Error('Saved source artifact changed')
    const bytes=Uint8Array.from(atob(page.data),c=>c.charCodeAt(0))
    if(bytes.length>16384||page.cursor!==this.cursor+bytes.length||page.cursor>page.size_bytes||page.eof!==(page.cursor===page.size_bytes)||(!page.eof&&!bytes.length))throw new Error('Invalid saved source byte page')
    this.metadata=page;this.pages.push(bytes);this.cursor=page.cursor
    return page.eof
  }
  async finish() {
    const m=this.metadata;if(!m||!m.eof)throw new Error('Saved source is incomplete')
    const bytes=new Uint8Array(this.cursor);let offset=0
    for(const page of this.pages){bytes.set(page,offset);offset+=page.length}
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('')
    if(digest!==m.file_digest)throw new Error('Saved source content hash differs')
    return {path:m.path,digest,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
  }
}
