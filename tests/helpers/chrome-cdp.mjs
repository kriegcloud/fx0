import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
export async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await sleep(150);}throw new Error('Timed out: '+label);}
export async function connectCdp(url, errors) {
  const socket = new WebSocket(url), pending = new Map(), contexts = new Map()
  let sequence = 0, iframeSession
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }))
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe') {
      iframeSession = message.params.sessionId
      call('Runtime.enable', {}, iframeSession).catch(error => errors.push(error.message))
    }
    if (message.method === 'Target.detachedFromTarget' && iframeSession === message.params.sessionId) iframeSession = undefined
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, { id: context.id, sessionId: message.sessionId })
    }
    if (message.method === 'Runtime.executionContextDestroyed' || message.method === 'Runtime.executionContextsCleared' || message.method === 'Target.detachedFromTarget') {
      for (const [frame, context] of contexts) {
        if (context.sessionId === (message.params?.sessionId ?? message.sessionId) &&
          (message.method !== 'Runtime.executionContextDestroyed' || context.id === message.params.executionContextId)) contexts.delete(frame)
      }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Chrome CDP closed')) }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome CDP connection timeout')) }, 8000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Chrome CDP connection failed')) }, { once: true })
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 12_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const evaluate = async (expression, depth = 0) => {
    let context
    if (depth === 2 && iframeSession) {
      context = await until(() => [...contexts.values()].find(c => c.sessionId === iframeSession), 'opaque iframe execution context')
    } else if (depth) {
      let { frameTree } = await call('Page.getFrameTree')
      for (let index = 0; index < depth; index++) frameTree = frameTree?.childFrames?.[0]
      assert.ok(frameTree, `Missing frame at depth ${depth}`)
      context = contexts.get(frameTree.frame.id)
      assert.ok(context, `Missing default execution context at depth ${depth}`)
    }
    const result = await call('Runtime.evaluate', { expression, ...(context ? { contextId: context.id } : {}), returnByValue: true, awaitPromise: true }, context?.sessionId)
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Runtime.enable'); await call('Page.enable')
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  return { call, evaluate, close: async () => { socket.close(); await Promise.race([closed, sleep(1000, undefined, { ref: false })]) } }
}
