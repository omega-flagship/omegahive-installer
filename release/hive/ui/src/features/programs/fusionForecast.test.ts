import { expect, it, vi } from 'vitest'
import type { Me, HiveClient } from '../../api/client'
import { ForecastComposer, forecastDraft, type ForecastIntent } from './fusionForecast'
const me: Me = {principal:'user:u_fixture',kind:'sso',role:'member',expires_at:null,person:{id:'u_fixture',email:null,name:'Invented reader'}}
const draft=()=>({market:'invented-market',probability_yes:'0.7',text:'Invented explanation'})
const result=(key='k1')=>({status:'done' as const,receipt:{id:'receipt:invented',state:'committed' as const,at:'2026-10-04T00:00:00Z'},detail:{mode:'synthetic',idempotency_key:key,result:{forecast_id:'forecast:invented'}}})
function setup(saved: ForecastIntent|null=null) {
 const journal={read:()=>saved,write:vi.fn((v:ForecastIntent)=>{saved=v}),clear:vi.fn(()=>{saved=null})}
 const client={me:vi.fn(async()=>me),programAct:vi.fn<HiveClient['programAct']>().mockResolvedValue(result())}
 // these cases are about the transport and journal; the §9d confirm is covered below with needs → true
 const c=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k1',()=>false)
 return {c,client,journal}
}
it('reviews a snapshot and sends only frozen fields with a stable top-level key',async()=>{
 const {c,client,journal}=setup(),d=draft()
 await c.submit(d,async message=>{expect(message).toContain(me.principal);expect(message).toContain('does not trade');d.text='Changed after review';return true})
 expect(client.programAct).toHaveBeenCalledWith('omegafusion',{swarm_id:'s_fixture',action:'human-forecast',items:[],params:draft(),idempotency_key:'k1'})
 expect(journal.write.mock.invocationCallOrder[0]).toBeLessThan(client.programAct.mock.invocationCallOrder[0])
 expect(journal.write.mock.calls[0][0]).toEqual({version:1,principal:me.principal,swarm:'s_fixture',key:'k1'})
 expect(c.state.phase).toBe('committed');expect(journal.clear).toHaveBeenCalled()
})
it('cancel and invalid probabilities never send or persist an effect',async()=>{
 const {c,client,journal}=setup();await c.submit(draft(),async()=>false)
 expect(client.programAct).not.toHaveBeenCalled();expect(journal.write).not.toHaveBeenCalled()
 for(const p of ['NaN','Infinity','-0.1','1.1','1e-1','']) expect(()=>forecastDraft({...draft(),probability_yes:p})).toThrow()
 expect(()=>forecastDraft({...draft(),principal:'user:other'} as ReturnType<typeof draft>)).toThrow()
})
it('changed identity during review refuses before persistence and submit',async()=>{
 const {c,client,journal}=setup();client.me.mockResolvedValueOnce(me).mockResolvedValueOnce({...me,principal:'user:u_other',person:{...me.person!,id:'u_other'}})
 await expect(c.submit(draft(),async()=>true)).rejects.toThrow('changed')
 expect(journal.write).not.toHaveBeenCalled();expect(client.programAct).not.toHaveBeenCalled()
})
it('storage failure refuses before the first effect',async()=>{
 const {c,client,journal}=setup();journal.write.mockImplementation(()=>{throw new Error('quota')})
 await expect(c.submit(draft(),async()=>true)).rejects.toThrow('quota');expect(client.programAct).not.toHaveBeenCalled()
})
it('lost response persists recovery metadata and never resends the forecast',async()=>{
 const {c,client}=setup();client.programAct.mockRejectedValueOnce(new Error('lost'))
 await c.submit(draft(),async()=>true);expect(c.state.phase).toBe('unknown')
 await expect(c.submit(draft(),async()=>true)).rejects.toThrow('Recover')
 client.programAct.mockResolvedValueOnce(result());await c.reconcile()
 expect(client.programAct.mock.calls.map(call=>call[1].action)).toEqual(['human-forecast','human-reconcile'])
 expect(client.programAct.mock.calls[1][1].params).toEqual({receipt_key:'k1'});expect(c.state.phase).toBe('committed')
})
it('restored pending intent performs no action until explicit recovery',async()=>{
 const {c,client}=setup({version:1,principal:me.principal,swarm:'s_fixture',key:'k1'})
 expect(c.state.phase).toBe('unknown');expect(client.programAct).not.toHaveBeenCalled()
 await c.reconcile();expect(client.programAct.mock.calls[0][1].action).toBe('human-reconcile')
 expect(()=>setup({version:1,principal:'user:other',swarm:'s_fixture',key:'k1'})).toThrow('match')
})
it('refused recovery retains the pending key instead of declaring an absent commitment',async()=>{
 const {c,client,journal}=setup({version:1,principal:me.principal,swarm:'s_fixture',key:'k1'})
 client.programAct.mockResolvedValueOnce({status:'refused'});await c.reconcile()
 expect(c.state.phase).toBe('unknown');expect(c.state.intent?.key).toBe('k1');expect(journal.clear).not.toHaveBeenCalled()
})
it('unknown or mismatched committed receipt stays uncertain without resend',async()=>{
 const {c,client,journal}=setup();client.programAct.mockResolvedValueOnce(result('foreign'))
 await c.submit(draft(),async()=>true);expect(c.state.phase).toBe('unknown');expect(journal.clear).not.toHaveBeenCalled()
 client.programAct.mockResolvedValueOnce({...result(),status:'started',receipt:{...result().receipt,state:'unknown'}} as unknown as ReturnType<typeof result>)
 await c.reconcile();expect(c.state.phase).toBe('unknown');expect(client.programAct).toHaveBeenCalledTimes(2)
})

it('a pending intent created by another view during review is preserved',async()=>{
 const {c,client,journal}=setup()
 await expect(c.submit(draft(),async()=>{journal.write({version:1,principal:me.principal,swarm:'s_fixture',key:'another-intent'});return true})).rejects.toThrow('Recover')
 expect(c.state.intent?.key).toBe('another-intent');expect(client.programAct).not.toHaveBeenCalled()
})

it('an older recovery cannot clear a newer pending intent',async()=>{
 const {c,client,journal}=setup({version:1,principal:me.principal,swarm:'s_fixture',key:'k1'})
 journal.write({version:1,principal:me.principal,swarm:'s_fixture',key:'newer'})
 await expect(c.reconcile()).rejects.toThrow('changed');expect(client.programAct).not.toHaveBeenCalled();expect(journal.clear).not.toHaveBeenCalled()
})
it('§9d: a confirm action mints only after the person confirmed, sends the token at the top level, never resends it',async()=>{
 let saved: ForecastIntent|null=null
 const journal={read:()=>saved,write:vi.fn((v:ForecastIntent)=>{saved=v}),clear:vi.fn(()=>{saved=null})}
 const client={me:vi.fn(async()=>me),programAct:vi.fn<HiveClient['programAct']>().mockResolvedValue(result()),confirmAct:vi.fn<NonNullable<HiveClient['confirmAct']>>().mockResolvedValue({confirm_token:'hct_invented',expires_at:'2026-10-05T00:00:00.000Z',expires_in:120})}
 const c=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k1',()=>true)
 await c.submit(draft(),async()=>{expect(client.confirmAct).not.toHaveBeenCalled();return false})
 expect(client.confirmAct).not.toHaveBeenCalled();expect(client.programAct).not.toHaveBeenCalled()
 await c.submit(draft(),async()=>true)
 expect(client.confirmAct).toHaveBeenCalledTimes(1)
 expect(client.confirmAct.mock.calls[0][2]).toBe('human-forecast')
 expect(client.confirmAct.mock.calls[0][3]).toEqual({items:[],params:draft(),base_revision:null})
 expect(client.programAct.mock.calls[0][1]).toEqual({swarm_id:'s_fixture',action:'human-forecast',items:[],params:draft(),idempotency_key:'k1',confirm_token:'hct_invented'})
 expect(c.state.phase).toBe('committed')
 // a lost answer: unknown, never resent; recovery asks the person, then mints a NEW token
 const c2=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k2',()=>true)
 client.programAct.mockRejectedValueOnce(new Error('lost'))
 await c2.submit(draft(),async()=>true);expect(c2.state.phase).toBe('unknown')
 expect(client.programAct).toHaveBeenCalledTimes(2)
 await expect(c2.reconcile()).rejects.toThrow('confirmation')
 const asked=vi.fn(async()=>true);client.programAct.mockResolvedValueOnce(result('k2'))
 await c2.reconcile(asked);expect(asked).toHaveBeenCalledTimes(1)
 expect(client.confirmAct).toHaveBeenCalledTimes(3)
 expect(client.programAct.mock.calls[2][1].action).toBe('human-reconcile')
})
it('§9d: a refused confirm is a refusal (nothing sent), never an unknown delivery',async()=>{
 const {ApiError}=await import('../../api/client')
 let saved: ForecastIntent|null=null
 const journal={read:()=>saved,write:vi.fn((v:ForecastIntent)=>{saved=v}),clear:vi.fn(()=>{saved=null})}
 const client={me:vi.fn(async()=>me),programAct:vi.fn<HiveClient['programAct']>().mockRejectedValue(new ApiError(403,'confirm_invalid','raw hive text')),confirmAct:vi.fn<NonNullable<HiveClient['confirmAct']>>().mockResolvedValue({confirm_token:'hct_x',expires_at:'',expires_in:120})}
 const c=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k1',()=>true)
 await c.submit(draft(),async()=>true)
 expect(c.state).toEqual({phase:'refused',message:'This needs your confirmation again.'})
})
it('review B1: the composer’s identity (alive) is checked before the journal, the mint and the act; a change before the act sends nothing and leaves nothing to recover',async()=>{
 const {ApiError}=await import('../../api/client')
 let saved: ForecastIntent|null=null
 const journal={read:()=>saved,write:vi.fn((v:ForecastIntent)=>{saved=v}),clear:vi.fn(()=>{saved=null})}
 let alive=false
 const client={me:vi.fn(async()=>me),programAct:vi.fn<HiveClient['programAct']>().mockResolvedValue(result()),confirmAct:vi.fn<NonNullable<HiveClient['confirmAct']>>(async()=>{alive=false;return {confirm_token:'hct_x',expires_at:'',expires_in:120}})}
 const c=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k1',()=>true,()=>alive)
 // already changed when the person confirms: nothing persisted, nothing minted
 await expect(c.submit(draft(),async()=>true)).rejects.toThrow('was not sent')
 expect(journal.write).not.toHaveBeenCalled();expect(client.confirmAct).not.toHaveBeenCalled()
 // changes while the token is minted: the token is discarded, no act, the journal entry is cleared
 alive=true
 await expect(c.submit(draft(),async()=>true)).rejects.toThrow('was not sent')
 expect(client.confirmAct).toHaveBeenCalledTimes(1);expect(client.programAct).not.toHaveBeenCalled()
 expect(saved).toBeNull();expect(c.state.phase).toBe('draft')
 // changes while the act is out: it may have gone, so the intent stays recoverable (unknown), never re-sent
 client.confirmAct.mockImplementation(async()=>({confirm_token:'hct_y',expires_at:'',expires_in:120}))
 client.programAct.mockImplementationOnce(async()=>{alive=false;throw new ApiError(0,'network','lost')})
 alive=true
 await c.submit(draft(),async()=>true)
 expect(c.state.phase).toBe('unknown');expect(saved).not.toBeNull()
 expect(client.programAct).toHaveBeenCalledTimes(1)   // no recovery check once the identity moved
})
it('review B2 (a): a lost answer to a completed forecast is recovered by the host’s check with the same token, not asked again',async()=>{
 const {ApiError}=await import('../../api/client')
 let saved: ForecastIntent|null=null
 const journal={read:()=>saved,write:vi.fn((v:ForecastIntent)=>{saved=v}),clear:vi.fn(()=>{saved=null})}
 const client={me:vi.fn(async()=>me),programAct:vi.fn<HiveClient['programAct']>().mockRejectedValueOnce(new ApiError(0,'network','lost')).mockResolvedValueOnce(result()),confirmAct:vi.fn<NonNullable<HiveClient['confirmAct']>>().mockResolvedValue({confirm_token:'hct_z',expires_at:'',expires_in:120})}
 const c=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k1',()=>true)
 await c.submit(draft(),async()=>true)
 expect(c.state.phase).toBe('committed')
 expect(client.confirmAct).toHaveBeenCalledTimes(1)
 expect(client.programAct.mock.calls[1][1].confirm_token).toBe('hct_z')
 // (b) a failed intent (the check refused): unknown, recover by receipt key; nothing is re-sent from here
 client.programAct.mockRejectedValueOnce(new ApiError(500,'program_error','boom')).mockRejectedValueOnce(new ApiError(403,'confirm_invalid','x'))
 const c2=new ForecastComposer(client,me.principal,'s_fixture',journal,()=> 'k2',()=>true)
 await c2.submit(draft(),async()=>true)
 expect(c2.state.phase).toBe('unknown');expect(client.programAct).toHaveBeenCalledTimes(4);expect(client.confirmAct).toHaveBeenCalledTimes(2)
})
