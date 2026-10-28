import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Redis } from '@upstash/redis'

const url = process.env.KV_REST_API_URL
const token = process.env.KV_REST_API_TOKEN
if (!url || !token) {
  throw new Error('journal integration test requires KV_REST_API_URL and KV_REST_API_TOKEN')
}

const prefix = `fx0:test:${randomUUID()}`
assert.notEqual(prefix, 'fx0:v1')
process.env.FX0_REDIS_PREFIX = prefix

// The credential store seals with SESSION_SECRET; a test-only one when unset.
process.env.SESSION_SECRET ??= 'journal-integration-test-secret-0123456789'
const journal = await import('../lib/journal.ts')
const credentials = await import('../lib/turn-credential.ts')
const drafts = await import('../lib/draft-store.ts')
const redis = new Redis({ url, token })
const key = (sessionId, part) => `${prefix}:session:${sessionId}:${part}`

async function clearTestPrefix() {
  assert.match(prefix, /^fx0:test:[0-9a-f-]+$/)
  let cursor = 0
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: `${prefix}:*`, count: 100 })
    if (keys.length > 0) await redis.del(...keys)
    cursor = Number(nextCursor)
  } while (cursor !== 0)
}

const STATIC_DESIGN = '<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><h1>Hello</h1></body></html>'

test('journal Redis integration uses isolated durable session state', async (t) => {
  try {
    await t.test('drafts cross readers, replay complete prefixes, and fence old attempts and terminal turns', async () => {
      const id='draft-reconnect'
      await journal.updateSession(id,{})
      assert.equal(await drafts.reserveDraft(id,'req-a',1),0)
      const revision=await drafts.beginDraft(id,'attempt-a','call',1,0,'req-a')
      assert.ok(revision>0)
      assert.equal(await drafts.appendDraft(id,'attempt-a',0,'<body>😀'),true)
      const first=await drafts.readDraft(id)
      assert.equal(first.item.delta,'<body>😀')
      const streamModule=new URL('../lib/event-stream.ts',import.meta.url).href
      const remoteReader=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
        import {registerHooks} from 'node:module';
        registerHooks({resolve(s,c,next){if(c.parentURL?.includes('/lib/')&&s.startsWith('.')&&!s.endsWith('.ts'))return next(s+'.ts',c);return next(s,c)}});
        const {createSessionEventStream}=await import(${JSON.stringify(streamModule)});
        const reader=createSessionEventStream(${JSON.stringify(id)}).getReader();
        const {value}=await reader.read();
        await reader.cancel();
        console.log(JSON.stringify(JSON.parse(value.split('data: ')[1])));
      `],{encoding:'utf8',timeout:10000})
      assert.equal(JSON.parse(remoteReader).delta,'<body>😀','an SSE reader in another process receives the draft without an EventEmitter')
      assert.equal(await drafts.readDraft(id,first.cursor),null)
      assert.equal(await drafts.appendDraft(id,'attempt-a',8,'hello'),true)
      const next=await drafts.readDraft(id,first.cursor)
      assert.equal(next.item.draftOffset,8)
      assert.equal(next.item.delta,'hello')
      assert.equal((await drafts.readDraft(id)).item.delta,'<body>😀hello','another reader/reconnect gets the prefix')
      await drafts.reserveDraft(id,'req-b',1)
      assert.equal(await drafts.appendDraft(id,'attempt-a',13,'late'),false)
      assert.equal(await drafts.beginDraft(id,'late-attempt-a','call',1,0,'req-a'),0)
      const retry=await drafts.beginDraft(id,'attempt-b','call',1,0,'req-b')
      assert.ok(retry>revision)
      await drafts.appendDraft(id,'attempt-b',0,'new')
      await journal.projectEvents(id,0,1,[{type:'done',turnId:1,id:1}])
      assert.equal((await drafts.readDraft(id)).item.draftClosed,true)
      assert.equal(await drafts.appendDraft(id,'attempt-b',3,'late'),false)
      assert.equal(await drafts.reserveDraft(id,'req-late',1),null)
      assert.equal(await drafts.reserveDraft(id,'req-next',2),0)
      assert.ok(await drafts.beginDraft(id,'attempt-next','call2',2,0,'req-next'))
      await drafts.appendDraft(id,'attempt-next',0,'next')
      await journal.projectEvents(id,1,2,[{type:'done',turnId:1,id:1}])
      assert.equal((await drafts.readDraft(id)).item.delta,'next','an old terminal does not clear a newer turn')
      await journal.publishDesignArtifact(id,STATIC_DESIGN,2)
      assert.equal((await drafts.readDraft(id)).item.draftClosed,true)
      assert.equal(await drafts.appendDraft(id,'attempt-next',4,'late'),false)
      assert.equal(await drafts.beginDraft(id,'late','call2',2,0,'req-next'),0,'publishing fences late begins at the old artifact revision')
      const token=randomUUID()
      assert.equal(await journal.claimSessionCleanup(id,token),'claimed')
      assert.equal(await journal.finishSessionCleanup(id,token,null),true)
      assert.equal(await drafts.readDraft(id),null)
      assert.equal(await drafts.reserveDraft(id,'deleted',3),null)
    })
    await t.test('compact checkpoints resume an appended tail and are removed with the journal', async () => {
      const id = 'compact-checkpoint'
      await journal.submitPrompt(id, { author: 'test', text: 'Start' })
      await journal.appendEvent(id, { type: 'turn_start', id: 1, turnId: 1 })
      for (let i = 0; i < 20; i++) await journal.appendEvent(id, { type: 'text', turnId: 1, delta: 'x' })
      const initial = await journal.readTranscript(id)
      assert.equal(initial.transcript.entries.at(-1).text, 'x'.repeat(20))
      assert.equal(initial.transcript.entries.length, 2)
      assert.equal(initial.transcript.lastSeq, 22)
      assert.equal((await redis.get(key(id, 'transcript'))).lastSeq, 22)
      await journal.appendEvent(id, { type: 'text', turnId: 1, delta: 'tail' })
      const resumed = await journal.readTranscript(id)
      await journal.appendEvent(id, { type: 'done', id: 1, turnId: 1 })
      const newer = await journal.readTranscript(id)
      assert.equal(newer.transcript.lastSeq, 24)
      await journal.publishTranscriptSnapshot(id, resumed.transcript)
      assert.equal(resumed.transcript.entries.at(-1).text, 'x'.repeat(20) + 'tail')
      assert.equal(resumed.transcript.lastSeq, 23)
      assert.equal((await redis.get(key(id, 'transcript'))).lastSeq, 24, 'a late older writer cannot roll the checkpoint back')
      const reads = await Promise.all(Array.from({ length: 8 }, () => journal.readTranscript(id)))
      assert.ok(reads.every((value) => value.transcript.lastSeq === 24))
      assert.equal((await redis.get(key(id, 'transcript'))).lastSeq, 24)
      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(id, token), 'claimed')
      assert.equal(await journal.finishSessionCleanup(id, token, null), true)
      assert.equal(await redis.exists(key(id, 'transcript')), 0)
      await journal.publishTranscriptSnapshot(id, newer.transcript)
      await journal.readTranscript(id)
      assert.equal(await redis.exists(key(id, 'transcript')), 0, 'late readers cannot recreate a deleted checkpoint')
    })
    await t.test('new sessions start at artifact revision zero', async () => {
      const sessionId = 'new-default'
      await journal.updateSession(sessionId, { preferredModel: null })
      assert.deepEqual(await journal.readSessionView(sessionId), { artifactRevision: 0 })
      const stored = await journal.readSession(sessionId)
      assert.equal(stored?.id, sessionId)
    })

    await t.test('a first prompt applies draft settings atomically; later prompts never override them', async () => {
      const sessionId = 'first-prompt-settings'
      await journal.submitPrompt(sessionId, { author: 'test', text: 'Design a page' },
        { preferredModel: 'test/picked', preferredEffort: 'high', preferredFast: true })
      let stored = await journal.readSession(sessionId)
      assert.equal(stored?.preferredModel, 'test/picked')
      assert.equal(stored?.preferredEffort, 'high')
      assert.equal(stored?.preferredFast, true)
      await journal.submitPrompt(sessionId, { author: 'test', text: 'Again' }, { preferredModel: 'test/other', preferredFast: false })
      stored = await journal.readSession(sessionId)
      assert.equal(stored?.preferredModel, 'test/picked')
      assert.equal(stored?.preferredFast, true)
    })

    await t.test('a design.md applies only with the prompt that creates the chat and is deleted with it', async () => {
      const sessionId = 'first-prompt-design-md'
      // Valid JSON on purpose: the stored text must not come back as a parsed value.
      const text = '{"colors":{"primary":"#0071e3"}}'
      const first = await journal.submitPrompt(sessionId, { author: 'test', text: 'Design a page' },
        { designMd: { name: 'Apple', source: 'getdesign:apple', text } })
      assert.deepEqual(first.event.designMd, { name: 'Apple', source: 'getdesign:apple' })
      assert.equal(first.idle, true, 'a new chat is idle')
      let stored = await journal.readSession(sessionId)
      assert.equal(stored?.designMd?.name, 'Apple')
      assert.equal(stored?.designMd?.bytes, Buffer.byteLength(text))
      assert.match(stored?.designMd?.sha ?? '', /^[0-9a-f]{64}$/)
      assert.equal(await journal.readDesignMd(sessionId), text)

      const second = await journal.submitPrompt(sessionId, { author: 'test', text: 'Again' },
        { designMd: { name: 'Stripe', source: 'getdesign:stripe', text: '# Stripe' } })
      assert.equal(second.event.designMd, undefined)
      assert.equal(second.idle, false, 'the first message has not started a turn yet')
      stored = await journal.readSession(sessionId)
      assert.equal(stored?.designMd?.name, 'Apple')
      assert.equal(await journal.readDesignMd(sessionId), text)
      const replayed = await journal.readEvents(sessionId)
      assert.deepEqual(replayed.filter((event) => event.type === 'user').map((event) => event.designMd?.name), ['Apple', undefined])

      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(sessionId, token), 'claimed')
      assert.equal(await journal.finishSessionCleanup(sessionId, token, null), true)
      assert.equal(await redis.exists(key(sessionId, 'design-md')), 0)
      assert.equal(await journal.readDesignMd(sessionId), null)
    })

    await t.test('a prompt is journaled for the transcript and never queued', async () => {
      const sessionId = 'no-queue'
      const submitted = await journal.submitPrompt(sessionId, { author: 'test', text: 'Start fast' })
      assert.equal(submitted.event.type, 'user')
      assert.equal(await redis.exists(key(sessionId, 'prompts')), 0)
    })

    await t.test('projection lands each libfx line once: a second projector at a stale cursor loses', async () => {
      const sessionId = 'projection'
      await journal.updateSession(sessionId, {})
      const first = await journal.projectEvents(sessionId, 0, 3, [
        { type: 'turn_start', id: 1, turnId: 1, at: 1 },
        { type: 'text', delta: 'Hello', turnId: 1, at: 2 },
      ])
      assert.deepEqual(first.map((item) => [item.type, item.seq]), [['turn_start', 1], ['text', 2]])
      assert.equal(await journal.projectEvents(sessionId, 0, 2, [{ type: 'text', delta: 'again', turnId: 1, at: 3 }]), null)
      // Lines that map to no item still move the cursor.
      assert.deepEqual(await journal.projectEvents(sessionId, 3, 4, []), [])
      const second = await journal.projectEvents(sessionId, 4, 5, [{ type: 'done', id: 1, turnId: 1, at: 4 }])
      assert.equal(second[0].seq, 3)
      assert.equal(await journal.projectedCursor(sessionId), 5)
      assert.deepEqual((await journal.readEvents(sessionId)).map((item) => item.type), ['turn_start', 'text', 'done'])
    })

    await t.test('a chat keeps the first libfx session bound to it, and fetch finds the chat from it', async () => {
      const sessionId = 'libfx-binding'
      await journal.updateSession(sessionId, {})
      assert.equal(await journal.bindLibfxSession(sessionId, 'wrun_first'), 'wrun_first')
      assert.equal(await journal.bindLibfxSession(sessionId, 'wrun_second'), 'wrun_first')
      assert.equal((await journal.readSession(sessionId)).libfxSessionId, 'wrun_first')
      assert.equal(await journal.chatOfLibfxSession('wrun_first'), sessionId)
      assert.equal(await journal.chatOfLibfxSession('wrun_second'), null)
    })

    await t.test('a question takes one answer, only while it is open', async () => {
      const sessionId = 'question'
      await journal.updateSession(sessionId, {})
      await journal.setActiveQuestion(sessionId, { turnId: 1, qid: 4 })
      assert.equal(await journal.answerActiveQuestion(sessionId, 3, { a: 'x' }), false)
      assert.equal(await journal.answerActiveQuestion(sessionId, 4, { a: 'yes' }), true)
      assert.equal(await journal.answerActiveQuestion(sessionId, 4, { a: 'no' }), false)
      assert.equal(await journal.takeAnswer(sessionId, 5), null)
      assert.deepEqual(await journal.takeAnswer(sessionId, 4), { a: 'yes' })
      assert.equal(await journal.takeAnswer(sessionId, 4), null)
      assert.equal(await journal.clearActiveQuestion(sessionId, 4), false)
    })

    await t.test('a turn end clears only its own turn', async () => {
      const sessionId = 'active-turn'
      const start = { id: 2, startedAt: 1, billingTeamId: 'team_a', prompt: 'p' }
      const [item] = await journal.projectEvents(sessionId, 0, 1, [{ type: 'turn_start', id: 2, turnId: 2, at: 1 }], { 2: start })
      await journal.projectEvents(sessionId, 1, 2, [{ type: 'done', id: 1, turnId: 1, at: 2 }])
      assert.deepEqual(await journal.getActiveTurn(sessionId), { ...start, startSeq: item.seq })
      await journal.projectEvents(sessionId, 2, 3, [{ type: 'done', id: 2, turnId: 2, at: 3 }])
      assert.equal(await journal.getActiveTurn(sessionId), null)
    })

    await t.test('asset reservations enforce both caps atomically across concurrent requests', async () => {
      const id = 'asset-caps'
      const user = 'asset-caps-user'
      const admitted = await Promise.all(Array.from({ length: 10 }, () => journal.reserveDesignAssets(id, user, 6)))
      assert.equal(admitted.filter((result) => result === 'ok').length, 8)
      assert.equal(admitted.filter((result) => result === 'chat').length, 2)
      assert.equal(await redis.get(key(id, 'asset-count')), 48)
      assert.equal(await journal.reserveDesignAssets('asset-caps-other', user, 50), 'ok')
      assert.equal(await journal.reserveDesignAssets('asset-caps-third', user, 3), 'daily')
      assert.equal(await redis.exists(key('asset-caps-third', 'asset-count')), 0)
    })

    await t.test('asset reservations and manifest commits are fenced throughout and after deletion', async () => {
      const id = 'asset-deletion'
      const user = 'asset-deletion-user'
      const asset = { handle: 'AbCdEfGhIjKlMnOpQrStUvWx', mimeType: 'image/png', bytes: 5 }
      await journal.updateSession(id, {})
      assert.equal(await journal.reserveDesignAssets(id, user, 1), 'ok')
      await journal.recordDesignAssets(id, [asset])
      assert.equal((await journal.readDesignAssets(id)).size, 1)
      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(id, token), 'claimed')
      await assert.rejects(journal.reserveDesignAssets(id, user, 1), journal.SessionCleanupError)
      await assert.rejects(journal.recordDesignAssets(id, [asset]), journal.SessionCleanupError)
      assert.equal(await redis.get(key(id, 'asset-count')), 1)
      assert.equal(await journal.finishSessionCleanup(id, token, null), true)
      await assert.rejects(journal.reserveDesignAssets(id, user, 1), journal.SessionCleanupError)
      await assert.rejects(journal.recordDesignAssets(id, [asset]), journal.SessionCleanupError)
      assert.equal(await redis.exists(key(id, 'asset-count'), key(id, 'assets')), 0)
    })

    await t.test('cleanup completion refunds its original UTC day exactly once and preserves unrelated assets', async () => {
      const id = 'asset-cleanup'
      const user = 'asset-cleanup-user'
      const yesterday = Date.UTC(2026, 0, 1, 23, 59)
      const today = yesterday + 120_000
      const a = { handle: 'AbCdEfGhIjKlMnOpQrStUvWx', mimeType: 'image/png', bytes: 5 }
      const b = { ...a, handle: 'ZbCdEfGhIjKlMnOpQrStUvWx' }
      assert.equal(await journal.reserveDesignAssets(id, user, 1, yesterday), 'ok')
      assert.equal(await journal.reserveDesignAssets(id, user, 1, today), 'ok')
      await journal.recordDesignAssets(id, [a, b])
      const job = { sessionId: id, userId: user, handles: [a.handle], reservedAt: yesterday }
      await journal.queueDesignAssetCleanup(job)
      assert.deepEqual(await journal.pendingDesignAssetCleanups(), [job])
      await Promise.all([journal.finishDesignAssetCleanup(job), journal.finishDesignAssetCleanup(job)])
      // A delayed enqueue whose response was lost cannot reintroduce the job.
      await journal.queueDesignAssetCleanup(job)
      await journal.finishDesignAssetCleanup(job)
      assert.equal(await redis.get(`${prefix}:user:${user}:assets:2026-01-01`), 0)
      assert.equal(await redis.get(`${prefix}:user:${user}:assets:2026-01-02`), 1)
      assert.equal(await redis.get(key(id, 'asset-count')), 1)
      assert.deepEqual([...await journal.readDesignAssets(id)], [[b.handle, { mimeType: 'image/png', bytes: 5 }]])
      assert.deepEqual(await journal.pendingDesignAssetCleanups(), [])
    })

    await t.test('rollback completion is idempotent when no retry enqueue was acknowledged', async () => {
      const id = 'asset-cleanup-unqueued'
      const user = 'asset-cleanup-unqueued-user'
      const reservedAt = Date.now()
      await journal.reserveDesignAssets(id, user, 2, reservedAt)
      const job = { sessionId: id, userId: user, handles: ['AbCdEfGhIjKlMnOpQrStUvWx'], reservedAt }
      await journal.finishDesignAssetCleanup(job)
      await journal.queueDesignAssetCleanup(job)
      await journal.finishDesignAssetCleanup(job)
      assert.equal(await redis.get(key(id, 'asset-count')), 1)
      assert.deepEqual(await journal.pendingDesignAssetCleanups(), [])
    })

    await t.test('pending asset rollback survives chat deletion without recreating deleted keys', async () => {
      const id = 'asset-cleanup-deleted'
      const user = 'asset-cleanup-deleted-user'
      const reservedAt = Date.now()
      await journal.updateSession(id, {})
      await journal.reserveDesignAssets(id, user, 1, reservedAt)
      const job = { sessionId: id, userId: user, handles: ['AbCdEfGhIjKlMnOpQrStUvWx'], reservedAt }
      await journal.queueDesignAssetCleanup(job)
      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(id, token), 'claimed')
      assert.equal(await journal.finishSessionCleanup(id, token, null), true)
      assert.deepEqual(await journal.pendingDesignAssetCleanups(), [job])
      await journal.finishDesignAssetCleanup(job)
      assert.equal(await redis.exists(key(id, 'asset-count'), key(id, 'assets')), 0)
      assert.equal(await redis.get(`${prefix}:user:${user}:assets:${new Date(reservedAt).toISOString().slice(0, 10)}`), 0)
      assert.deepEqual(await journal.pendingDesignAssetCleanups(), [])
    })

    await t.test('deletion waits for a running turn, then removes everything but the tombstone', async () => {
      const id = 'delete-race'
      await journal.updateSession(id, { preferredEffort: null })
      await journal.appendEvent(id, { type: 'status', text: 'before deletion' })
      await journal.bindLibfxSession(id, 'wrun_deleted')
      await journal.projectEvents(id, 0, 1, [{ type: 'turn_start', id: 1, turnId: 1, at: 1 }], { 1: { id: 1, startedAt: 1, billingTeamId: null, prompt: '' } })
      assert.equal(await journal.claimSessionCleanup(id, randomUUID()), 'busy')
      await journal.projectEvents(id, 1, 2, [{ type: 'done', id: 1, turnId: 1, at: 2 }])
      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(id, token), 'claimed')
      await journal.releaseSessionCleanup(id, token)
      assert.notEqual(await journal.readSession(id), null)
      const retry = randomUUID()
      assert.equal(await journal.claimSessionCleanup(id, retry), 'claimed')
      assert.equal(await journal.finishSessionCleanup(id, retry, 'wrun_deleted'), true)
      const leftover = []
      let cursor = 0
      do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: key(id, '*'), count: 100 })
        leftover.push(...keys)
        cursor = Number(nextCursor)
      } while (cursor !== 0)
      assert.deepEqual(leftover, [key(id, 'deleting')], 'deletion leaves only the tombstone')
      assert.equal(await journal.chatOfLibfxSession('wrun_deleted'), null)
      await assert.rejects(journal.appendEvent(id, { type: 'status', text: 'late' }), /deleted/)
      assert.equal(await journal.projectEvents(id, 0, 1, [{ type: 'status', text: 'late', at: 1 }]), null)
      await assert.rejects(journal.bindLibfxSession(id, 'wrun_late'), /deleted/)
      assert.equal(await journal.readSession(id), null)
    })

    await t.test('artifact publish is deletion-fenced, duplicate-safe, and names the turn that published it', async () => {
      const sessionId = 'artifact'
      await journal.updateSession(sessionId, { preferredFast: null })
      const first = await journal.publishDesignArtifact(sessionId, STATIC_DESIGN, 5)
      assert.equal(first.ok, true)
      assert.equal(first.changed, true)
      assert.equal(first.revision, 1)
      assert.equal(first.event?.type, 'artifact')
      assert.equal(first.event?.artifactRevision, 1)
      assert.equal(first.event?.turnId, 5)
      assert.equal((await journal.readSession(sessionId)).artifactTurn, 5)

      const duplicate = await journal.publishDesignArtifact(sessionId, STATIC_DESIGN, 6)
      assert.deepEqual(duplicate, { ok: true, revision: 1, changed: false, event: undefined })
      assert.equal((await journal.readSessionView(sessionId)).artifactRevision, 1)
      const artifactEvents = (await journal.readEvents(sessionId)).filter((event) => event.type === 'artifact')
      assert.equal(artifactEvents.length, 1)

      const token = randomUUID()
      assert.equal(await journal.claimSessionCleanup(sessionId, token), 'claimed')
      assert.equal(await journal.finishSessionCleanup(sessionId, token, null), true)
      assert.deepEqual(await journal.publishDesignArtifact(sessionId, STATIC_DESIGN.replace('Hello', 'Late'), 7), {
        ok: false, reason: 'fenced', error: 'the chat was deleted before publishing',
      })
    })
    await t.test('a capture is acknowledged, answered once, and fails fast when no tab takes it', async () => {
      const sessionId = randomUUID()
      const shot = { images: [{ mimeType: 'image/webp', data: 'AAAA' }, { mimeType: 'image/webp', data: 'BBBB' }], width: 1280, height: 1600 }
      const replies = key(sessionId, 'capture-replies')

      // Acknowledged, then answered with a photo: the call wakes as the photo arrives.
      await journal.openCapture(sessionId, 'c1')
      const started = Date.now()
      const waiting = journal.awaitCapture(sessionId, 'c1', AbortSignal.timeout(15_000))
      assert.equal(await journal.acknowledgeCapture(sessionId, 'c0'), false, 'another capture id is refused')
      assert.equal(await journal.acknowledgeCapture(sessionId, 'c1'), true)
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(await journal.answerCapture(sessionId, 'c1', { kind: 'shot', shot }), true)
      assert.deepEqual(await waiting, { kind: 'shot', shot })
      assert.ok(Date.now() - started < 2_500, `woke ${Date.now() - started} ms after waiting began, the photo came at 500 ms`)
      assert.equal(await journal.answerCapture(sessionId, 'c1', { kind: 'failed', reason: 'too-large' }), false, 'an answer is accepted once')
      assert.equal(await journal.acknowledgeCapture(sessionId, 'c1'), false, 'a replayed request finds its capture closed')

      // A tab's failure ends the wait with its reason.
      await journal.openCapture(sessionId, 'c2')
      assert.equal(await journal.acknowledgeCapture(sessionId, 'c2'), true)
      assert.equal(await journal.answerCapture(sessionId, 'c2', { kind: 'failed', reason: 'too-large' }), true)
      assert.deepEqual(await journal.awaitCapture(sessionId, 'c2', AbortSignal.timeout(5_000)), { kind: 'failed', reason: 'too-large' })

      // No tab acknowledges: the call gives up after the ack window, not the whole wait.
      await journal.openCapture(sessionId, 'c3')
      const silent = Date.now()
      assert.deepEqual(await journal.awaitCapture(sessionId, 'c3', AbortSignal.timeout(15_000), 1_000), { kind: 'unanswered' })
      assert.ok(Date.now() - silent < 3_000, `gave up after ${Date.now() - silent} ms`)
      assert.equal(await journal.answerCapture(sessionId, 'c3', { kind: 'shot', shot }), false, 'a late photo is refused')

      // Cancelled: the capture is withdrawn.
      await journal.openCapture(sessionId, 'c4')
      const cancel = new AbortController()
      setTimeout(() => cancel.abort(), 300)
      assert.deepEqual(await journal.awaitCapture(sessionId, 'c4', cancel.signal), { kind: 'cancelled' })
      assert.equal(await journal.acknowledgeCapture(sessionId, 'c4'), false, 'a cancelled wait withdraws its capture')
      assert.equal(await redis.exists(key(sessionId, 'capture'), replies), 0, 'nothing is left behind')
    })

    await t.test('a screenshot call records its preview wait under its call id, for its tool_end', async () => {
      const sessionId = randomUUID()
      await journal.recordPreviewWait(sessionId, 'call_a', 515.4)
      await journal.recordPreviewWait(sessionId, 'call_b', 0)
      assert.deepEqual([...await journal.readPreviewWaits(sessionId, ['call_a', 'call_b', 'call_missing'])], [['call_a', 515]])
      assert.deepEqual([...await journal.readPreviewWaits(sessionId, [])], [])
      assert.ok(await redis.pttl(key(sessionId, 'preview-waits')) > 0, 'the waits expire with the chat idle')
    })

    await t.test('a chat credential is sealed, expires with its token, and sign-out drops only its own login', async () => {
      const session = (loginId, accessToken) => ({
        userId: 'user-a', loginId, loginAt: 1, email: 'a@example.com', accessToken, teamId: 'team_a',
        expiresAt: Date.now() + 120_000, isLoggedIn: true, refreshToken: 'refresh-never-stored',
      })
      await credentials.saveTurnCredential('cred-laptop', session('login-laptop', 'access-laptop-secret'), 1)
      await credentials.saveTurnCredential('cred-phone', session('login-phone', 'access-phone-secret'), 1)
      const raw = await redis.get(`${prefix}:credential:cred-laptop`)
      assert.equal(typeof raw, 'string')
      assert.ok(!raw.includes('access-laptop-secret') && !raw.includes('refresh-never-stored'), 'sealed, never plaintext')
      const ttl = await redis.ttl(`${prefix}:credential:cred-laptop`)
      assert.ok(ttl > 0 && ttl <= 120, `expires with the token (ttl ${ttl})`)
      const read = await credentials.readTurnCredential('cred-laptop')
      assert.deepEqual(read, { userId: 'user-a', loginId: 'login-laptop', accessToken: 'access-laptop-secret', teamId: 'team_a', expiresAt: read.expiresAt })
      assert.equal('refreshToken' in read, false)

      const secret = process.env.SESSION_SECRET
      process.env.SESSION_SECRET = 'another-secret-another-secret-0123456789'
      assert.equal(await credentials.readTurnCredential('cred-laptop'), null, 'another secret cannot unseal it')
      process.env.SESSION_SECRET = secret

      assert.deepEqual(await credentials.dropLoginCredentials('login-laptop'), [{ chatId: 'cred-laptop', turns: 1, latest: 'deleted' }])
      assert.equal(await credentials.readTurnCredential('cred-laptop'), null)
      assert.equal((await credentials.readExecutionFunding('cred-laptop', 1)).ok, false)
      assert.equal(await redis.hlen(`${prefix}:paid-funding:cred-laptop`), 1, 'sign-out keeps the paid funding record')
      assert.equal((await credentials.readTurnCredential('cred-phone'))?.accessToken, 'access-phone-secret')
      await assert.rejects(credentials.saveTurnCredential('cred-expired', { ...session('login-x', 'x'), expiresAt: Date.now() - 1 }, 1), /Sign in again/)
      assert.equal(await credentials.readTurnCredential('cred-expired'), null, 'an expired token is never stored')
    })
  } finally {
    await clearTestPrefix()
  }
})
