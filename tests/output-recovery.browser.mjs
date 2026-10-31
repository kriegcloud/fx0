import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {until, connectCdp} from './helpers/chrome-cdp.mjs'
// Run against an already built checkout; its existing services and data are untouched.
const root=process.env.FX0_TEST_APP_ROOT || join(import.meta.dirname,'..')
const dir=await mkdtemp(join(tmpdir(),'fx0-recovery-'))
const evidence=dir
const errors=[],requests=[]
let app,chrome,cdp,appLog='',chromeLog='',phase=0
const initial='<!doctype html><html><head><title>Recovery fixture</title></head><body><h1>Saved preview</h1><main id="panels"></main></body></html>'
const chunk=(delta,finish_reason=null)=>`data: ${JSON.stringify({id:'fx0-fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`
const tool=(name,args)=>chunk({tool_calls:[{index:0,id:'call_'+phase,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls')
const proxy=createServer(async(req,res)=>{
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'kimi-k3.1-pro'},{id:'gpt-6.1-sol'}]}))}
 const chunks=[];for await(const x of req)chunks.push(x)
 const body=JSON.parse(Buffer.concat(chunks));requests.push({model:body.model,max_tokens:body.max_tokens,stream:body.stream})
 phase++
 res.writeHead(200,{'content-type':'text/event-stream'})
 let output
 if(phase===1) output=tool('publish_design',{html:initial})
 else if(phase===3) output=chunk({tool_calls:[{index:0,id:'cutoff',type:'function',function:{name:'edit_design',arguments:'{"edits":[{"old_string":"Saved preview","new_string":"'}}]})+chunk({},'length')
 else if(phase===4) output=tool('edit_design',{edits:[{old_string:'Saved preview',new_string:'Recovered preview'}]})
 else if(phase===5||phase===6) output=tool('edit_design',{edits:[{old_string:'</main>',new_string:`<section><h2>Panel ${phase}</h2><p>${'Synthetic fixture. '.repeat(400)}</p></section></main>`}]})
 else output=chunk({content:'Synthetic design published.'},'stop')
 res.end(output+'data: [DONE]\n\n')
})
await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
const proxyUrl=`http://127.0.0.1:${proxy.address().port}/v1`
const portProbe=createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r))
const base=`http://127.0.0.1:${port}`
try{
 app=spawn(process.execPath,['scripts/local-dev.mjs','--production'],{cwd:root,env:{...process.env,FX0_LOCAL_PORT:String(port),FX0_LOCAL_DATA_DIR:join(dir,'app'),FX0_PROXY_BASE_URL:proxyUrl,FX0_PROXY_API_KEY:'synthetic-fixture-key',FX0_WORKSTATION_TOOLS:'0',FX0_REFERENCE_ROOTS:'[]'},stdio:['ignore','pipe','pipe']})
 for(const stream of [app.stdout,app.stderr])stream.on('data',x=>appLog+=x)
 await until(async()=>{assert.equal(app.exitCode,null,appLog);return fetch(base).then(r=>r.ok).catch(()=>false)},'fixture application')
 chrome=spawn(process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',['--headless=new','--no-first-run','--no-default-browser-check','--no-proxy-server','--disable-background-networking','--disable-component-update','--disable-sync','--remote-debugging-port=0',`--user-data-dir=${join(dir,'chrome')}`,'about:blank'],{stdio:['ignore','ignore','pipe']})
 chrome.stderr.on('data',x=>chromeLog+=x)
 const debugPort=await until(async()=>{assert.equal(chrome.exitCode,null,chromeLog);return readFile(join(dir,'chrome','DevToolsActivePort'),'utf8').then(s=>s.split('\n')[0]).catch(()=>null)},'Chrome')
 const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
 cdp=await connectCdp(targets.find(x=>x.type==='page').webSocketDebuggerUrl,errors)
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await cdp.call('Page.navigate',{url:base})
 await until(()=>cdp.evaluate('!!document.querySelector("textarea")'),'composer')
 await cdp.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('gpt-6.1-sol')).click()`)
 await until(()=>cdp.evaluate(`[...document.querySelectorAll('button')].some(x=>x.textContent.includes('Kimi K3.1 Pro'))`),'model selector')
 await cdp.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Kimi K3.1 Pro')).click()`)
 const submit=async text=>{
   await cdp.evaluate(`(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));t.focus()})()`)
   await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
   await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 }
 await submit('Synthetic acceptance fixture: publish the initial design.')
 const session=await until(()=>cdp.evaluate('new URL(location.href).searchParams.get("s")'),'session')
 const idle=()=>fetch(`${base}/api/session?session=${session}`).then(r=>r.json()).then(j=>j.summary&&!j.summary.busy)
 await until(async()=>phase>=2&&await idle(),'first turn')
 const first=await(await fetch(`${base}/api/artifact?session=${session}`)).text();assert.match(first,/Saved preview/)
 await submit('FX0_TRUNCATE: synthetic interrupted edit fixture.')
 await until(()=>cdp.evaluate('document.body.innerText.includes("Continue in smaller steps")'),'recovery action')
 await until(async()=>phase===3&&await idle(),'truncated turn')
 assert.equal(await(await fetch(`${base}/api/artifact?session=${session}`)).text(),first,'failed call preserves previous artifact')
 await cdp.call('Page.reload',{ignoreCache:true})
 await until(()=>cdp.evaluate('document.body?.innerText.includes("The model reached its response limit")').catch(()=>false),'persisted error message')
 await cdp.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Continue in smaller steps').click()`)
 await until(async()=>phase>=7&&await idle(),'recovery completion')
 const final=await(await fetch(`${base}/api/artifact?session=${session}`)).text();assert.match(final,/Recovered preview/);assert.ok(final.length>12*1024)
 await until(async()=>{try{return (await cdp.evaluate('document.body.innerText',2)).includes('Recovered preview')}catch{return false}},'rendered recovered preview')
 assert.ok(!await cdp.evaluate(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Continue in smaller steps')`),'recovery action disappears after new work')
 assert.ok(requests.every(x=>x.model==='kimi-k3.1-pro'&&x.max_tokens===65536&&x.stream===true))
 await writeFile(join(evidence,'recovery-ui.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
 assert.deepEqual(errors,[], 'no browser errors')
 const result={result:'PASS',evidence,session,requests,artifactBytes:Buffer.byteLength(final),preservedOnTruncation:true,reloadedRecovery:true,rendered:true,errors}
 await writeFile(join(evidence,'recovery-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){
 await writeFile(join(evidence,'failure.png'),Buffer.from((await cdp.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log('Failure state',JSON.stringify({phase,requests,errors,body:await cdp?.evaluate('document.body.innerText'),url:await cdp?.evaluate('location.href')}));throw error;
}finally{
 await cdp?.close();chrome?.kill('SIGTERM');app?.kill('SIGTERM');await new Promise(r=>proxy.close(r));await writeFile(join(evidence,'fixture-server.log'),appLog)
}
