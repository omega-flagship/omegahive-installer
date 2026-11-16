import {describe,it,expect} from 'vitest'
import {isFlowMessage} from './operations'
import {parse,href} from '../../lib/router'

describe('Flow bridge',()=>{
  it('allows only bounded fixed operations, never arbitrary URLs',()=>{
    expect(isFlowMessage({type:'omegaflow-request',id:'templates',operation:'templates',params:{}})).toBe(true)
    expect(isFlowMessage({type:'omegaflow-request',id:'1',operation:'validate',params:{body:{}}})).toBe(true)
    expect(isFlowMessage({type:'omegaflow-request',id:'1',operation:'fetch',params:{url:'https://example.test'}})).toBe(false)
    expect(isFlowMessage({type:'omegaflow-request',id:'1',operation:'publish',params:[]})).toBe(false)
    expect(isFlowMessage({type:'omegaflow-request',id:'1',operation:'publish',params:{body:'x'.repeat(300001)}})).toBe(false)
  })
  it('round trips the native Flow navigation route',()=>{
    expect(parse(href({name:'flow'}))).toEqual({name:'flow'})
  })
})
