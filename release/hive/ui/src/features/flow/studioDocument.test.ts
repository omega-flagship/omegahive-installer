import {describe,it,expect} from 'vitest'
import {studioDocument,isStudioSender} from './studioDocument'
const channel='12345678-1234-1234-1234-123456789abc'
const assets={html:'<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>',script:'console.log("</script><script>bad</script>")',style:'/* </style> */'}
describe('isolated Flow document',()=>{
 it('embeds fixed assets with no direct network or form access',()=>{
  const d=studioDocument(assets,'https://hive.example.test',channel,channel)
  expect(d.html).toContain('connect-src &#39;none&#39;')
  expect(d.html).toContain('form-action &#39;none&#39;')
  expect(d.html).toContain('data-flow-channel="'+channel+'"')
  expect(d.html).not.toContain('src="./app.js"')
  expect(d.html).not.toContain('</script><script>bad')
  expect(d.html.match(/<\/script>/g)).toHaveLength(1)
 })
 it('rejects invalid bindings and unexpected asset formats',()=>{
  expect(()=>studioDocument(assets,'null',channel,channel)).toThrow()
  expect(()=>studioDocument(assets,'https://hive.example.test','<script>',channel)).toThrow()
  expect(()=>studioDocument({...assets,html:'bad'},'https://hive.example.test',channel,channel)).toThrow()
 })
 it('requires opaque origin, exact frame and current document channel',()=>{
  const source={} as Window,other={} as Window
  const event={origin:'null',source,data:{channel}}
  expect(isStudioSender(event,source,channel)).toBe(true)
  expect(isStudioSender({...event,origin:'https://hive.example.test'},source,channel)).toBe(false)
  expect(isStudioSender(event,other,channel)).toBe(false)
  expect(isStudioSender(event,source,'old')).toBe(false)
  expect(isStudioSender({...event,data:{}},source,channel)).toBe(false)
  expect(isStudioSender(event,null,channel)).toBe(false)
 })
})
