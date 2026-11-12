import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.js'

const input = { turnId: 'turn-test', index: 2, model: 'test-model', messageCount: 1 }
const fakeResult = {
  turnId: input.turnId,
  index: input.index,
  answer: 'test model result',
  toolUses: [],
  stopReason: 'end_turn',
  usage: null,
}

function handlers() {
  const registered = {}
  const on = (event, matcher, hook) => {
    if (typeof matcher === 'function') hook = matcher
    registered[event] = hook
    return { catch(handler) { registered[`${event}:catch`] = handler; return this } }
  }
  register(on)
  return registered
}

function startTurnStep(handler, usage, answer, event = input) {
  let calls = 0
  let resolveAsked
  const asked = new Promise(resolve => { resolveAsked = resolve })
  const $ = {
    session: { usage: async () => usage },
    ui: { ask: async (question, options) => { resolveAsked({ question, options }); return answer() } },
  }
  let received
  const next = async function* (passed) { calls += 1; received = passed; return fakeResult }
  next.called = false
  const done = (async () => {
    const stream = handler($, event, next)
    while (true) {
      const part = await stream.next()
      if (part.done) return { calls, received, result: part.value }
    }
  })()
  return { done, asked }
}

async function runModelApi(handler, usage, answer, called = false) {
  let calls = 0
  const $ = {
    session: { usage: async () => usage },
    ui: { ask: async (question, options) => { $.askArgs = { question, options }; return answer() } },
  }
  const next = async () => { calls += 1; return { value: 'test result' } }
  next.called = called
  const result = await handler($, {}, next)
  return { calls, result, askArgs: $.askArgs }
}

const limits = (fiveHour, sevenDay, fiveReset, sevenReset) => ({
  rateLimits: [
    ...(fiveHour === undefined ? [] : [{ kind: 'five_hour', percentUsed: fiveHour, ...(fiveReset ? { resetsAt: fiveReset } : {}) }]),
    ...(sevenDay === undefined ? [] : [{ kind: 'seven_day', percentUsed: sevenDay, ...(sevenReset ? { resetsAt: sevenReset } : {}) }]),
  ],
})

test('allows a subagent request below both limits', async () => {
  const event = { ...input, agentId: 'agent-123' }
  const run = startTurnStep(handlers()['turn.step'], limits(99, 40), () => 'Stop', event)
  const { calls, received, result } = await run.done
  expect(calls).toBe(1)
  expect(received.agentId).toBe('agent-123')
  expect(result.answer).toBe('test model result')
})

test('stops independently at either limit and shows reset time and possible paid usage', async () => {
  for (const usage of [limits(100, 40, '2026-10-29T12:00:00.000Z'), limits(40, 100, undefined, '2026-11-04T10:00:00.000Z')]) {
    const run = startTurnStep(handlers()['turn.step'], usage, () => 'Stop')
    const [{ question, options }, { calls, result }] = await Promise.all([run.asked, run.done])
    expect(calls).toBe(0)
    expect(result.usage).toBe(null)
    expect(question).toContain('may use paid usage credits')
    expect(question).toContain('resets 2026-')
    expect(options[0]).toBe('Stop')
  }
})

test('treats a missing window, empty usage, NaN, or negative percentage as unknown', async () => {
  const invalidUsage = [limits(40), { rateLimits: [] }, limits(Number.NaN, 12), limits(-1, 12)]
  for (const usage of invalidUsage) {
    const run = startTurnStep(handlers()['turn.step'], usage, () => 'Stop')
    const [{ question, options }, { calls, result }] = await Promise.all([run.asked, run.done])
    expect(calls).toBe(0)
    expect(result.usage).toBe(null)
    expect(question).toContain('may use paid usage credits')
    expect(options[0]).toBe('Stop')
  }
})

test('usage read failure and UI rejection deny by default', async () => {
  const run = startTurnStep(handlers()['turn.step'], Promise.reject(new Error('unavailable')), () => Promise.reject(new Error('headless')))
  const { calls, result } = await run.done
  expect(calls).toBe(0)
  expect(result.usage).toBe(null)
})

test('an approval applies to one request only', async () => {
  const hook = handlers()['turn.step']
  const first = startTurnStep(hook, limits(100, 100), () => 'Allow this request')
  const firstResult = await first.done
  const second = startTurnStep(hook, limits(100, 100), () => 'Stop')
  const secondResult = await second.done
  expect(firstResult.calls).toBe(1)
  expect(secondResult.calls).toBe(0)
})

test('concurrent approvals stay bound to their own blocked request', async () => {
  const hook = handlers()['turn.step']
  const decisions = []
  const first = startTurnStep(hook, limits(100, 30), () => new Promise(resolve => decisions.push({ id: 'five', resolve })), { ...input, turnId: 'five' })
  const second = startTurnStep(hook, limits(30, 100), () => new Promise(resolve => decisions.push({ id: 'seven', resolve })), { ...input, turnId: 'seven' })
  const questions = await Promise.all([first.asked, second.asked])
  expect(questions[0].options[0]).toBe('Stop')
  expect(questions[1].options[0]).toBe('Stop')
  decisions.find(item => item.id === 'seven').resolve('Allow this request')
  decisions.find(item => item.id === 'five').resolve('Stop')
  const [a, b] = await Promise.all([first.done, second.done])
  expect(a.calls).toBe(0)
  expect(b.calls).toBe(1)
  expect(a.received).toBe(undefined)
  expect(b.received).toBeDefined()
})

test('all three mod model APIs require the request-scoped approval', async () => {
  const registered = handlers()
  for (const event of ['model.complete', 'model.fork', 'model.classify']) {
    const stopped = await runModelApi(registered[event], limits(20, 100), () => 'Stop')
    expect(stopped.calls).toBe(0)
    expect(stopped.result.deny).toContain('seven-day usage is at or above 100%')
    expect(stopped.askArgs.options[0]).toBe('Stop')
    const allowed = await runModelApi(registered[event], limits(20, 100), () => 'Allow this request')
    expect(allowed.calls).toBe(1)
  }
})

test('API hook failure never redispatches the downstream call', async () => {
  const hooks = handlers()
  let calls = 0
  const next = async () => { calls += 1; throw new Error('downstream failed') }
  next.called = true
  const result = await hooks['model.complete:catch']({}, {}, next)
  expect(result.deny).toContain('guard failed')
  expect(calls).toBe(0)

  const turnStepCatch = hooks['turn.step:catch']({}, input, next)
  const returned = await turnStepCatch.next()
  expect(returned.value.usage).toBe(null)
  expect(calls).toBe(0)
})

test('Claude Code accepts a stopped turn.step without dispatching downstream', async ($, on) => {
  on('session.usage', () => ({ value: limits(100, 35) }) as never)
  on('turn.start', () => ({ turnId: input.turnId }) as never)
  let downstreamCalls = 0
  on('turn.step', async function* () {
    downstreamCalls += 1
    throw new Error('downstream model dispatch must not run')
  })
  await $.turn.start({ text: 'guard integration', turnId: input.turnId } as never)
  const stream = $.turn.step(input as never)
  let result
  while (true) {
    const part = await stream.next()
    if (part.done) { result = part.value; break }
  }
  expect(downstreamCalls).toBe(0)
  expect(result.answer).toContain('usage-credit-guard')
  expect(result.usage).toBe(null)
})

test('session start shows current known usage persistently and continues lifecycle', async () => {
  const hooks = handlers()
  let status
  let continued = false
  const $ = {
    session: { usage: async () => limits(42, 18) },
    ui: { status: text => { status = text } },
  }
  await hooks['session.start']($, {}, async () => { continued = true; return { ok: true } })
  expect(status).toBe('Guard active · 5h: 42% · weekly: 18% · context: ? tokens')
  expect(continued).toBe(true)
})

test('status preserves a below-threshold decimal without claiming approval is required', async () => {
  const hooks = handlers()
  let status
  const $ = {
    session: { usage: async () => limits(99.9, 18) },
    ui: { status: text => { status = text } },
  }
  await hooks['session.start']($, {}, async () => ({}))
  expect(status).toBe('Guard active · 5h: 99.9% · weekly: 18% · context: ? tokens')
})

test('session start shows unknown usage and approval requirement when usage fails', async () => {
  const hooks = handlers()
  let status
  const $ = {
    session: { usage: async () => { throw new Error('unavailable') } },
    ui: { status: text => { status = text } },
  }
  await hooks['session.start']($, {}, async () => ({}))
  expect(status).toBe('Guard active · 5h: ? · weekly: ? · context: ? tokens · approval required')
})

test('session measure updates status and display errors do not block lifecycle', async () => {
  const hooks = handlers()
  const shown = []
  const $ = { ui: { status: text => shown.push(text) } }
  let continued = false
  await hooks['session.measure']($, { rateLimits: limits(100, 30).rateLimits }, async () => { continued = true; return {} })
  expect(shown[0]).toBe('Guard active · 5h: 100% · weekly: 30% · context: ? tokens · approval required')
  expect(continued).toBe(true)

  const failingUi = { ui: { status: () => Promise.reject(new Error('display unavailable')) } }
  await hooks['session.measure'](failingUi, { rateLimits: limits(55, 67).rateLimits }, async () => ({ ok: true }))
  expect(true).toBe(true)
})

function observeUsage(hooks, usage) {
  return hooks['session.measure'](
    { ui: { status: () => {} } },
    { rateLimits: usage.rateLimits },
    async () => ({}),
  )
}

test('an observed five-hour reset allows one refresh request without approving credits', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  let approvals = 0
  const decide = () => { approvals += 1; return 'Stop' }
  const first = await startTurnStep(hooks['turn.step'], limits(undefined, 45), decide).done
  expect(first.calls).toBe(1)
  expect(approvals).toBe(0)
  const second = await startTurnStep(hooks['turn.step'], limits(undefined, 45), decide).done
  expect(second.calls).toBe(0)
  expect(approvals).toBe(1)
})

test('a five-hour reset still blocks an exhausted weekly limit', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 100, expired))
  const run = startTurnStep(hooks['turn.step'], limits(undefined, 100), () => 'Stop')
  const [{ question }, result] = await Promise.all([run.asked, run.done])
  expect(result.calls).toBe(0)
  expect(question).toContain('seven-day usage is at or above 100%')
})

test('missing usage before reset or without an observed reset stays blocked', async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  for (const reset of [undefined, future, 'not-a-date']) {
    const hooks = handlers()
    await observeUsage(hooks, limits(50, 45, reset))
    const result = await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done
    expect(result.calls).toBe(0)
  }
})

test('reset evidence never treats empty snapshots or malformed present readings as zero', async () => {
  const expired = new Date(Date.now() - 60_000).toISOString()
  for (const usage of [{ rateLimits: [] }, limits(Number.NaN, 45), limits(-1, 45)]) {
    const hooks = handlers()
    await observeUsage(hooks, limits(100, 45, expired))
    const result = await startTurnStep(hooks['turn.step'], usage, () => 'Stop').done
    expect(result.calls).toBe(0)
  }
})

test('status labels an observed reset and recovers when a fresh zero reading arrives', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 3_600_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  const shown = []
  const $ = { ui: { status: text => shown.push(text) } }
  await hooks['session.measure']($, { rateLimits: limits(undefined, 45).rateLimits }, async () => ({}))
  expect(shown[0]).toBe('Guard active · 5h: reset · weekly: 45% · context: ? tokens')
  await observeUsage(hooks, limits(0, 45, future))
  const result = await startTurnStep(hooks['turn.step'], limits(0, 45, future), () => { throw new Error('must not ask') }).done
  expect(result.calls).toBe(1)
  const missing = await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done
  expect(missing.calls).toBe(0)
})

test('all model API gates share the observed-reset refresh allowance', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  const usage = limits(undefined, 45)
  const first = await runModelApi(hooks['model.complete'], usage, () => { throw new Error('must not ask') })
  expect(first.calls).toBe(1)
  for (const event of ['model.fork', 'model.classify']) {
    const result = await runModelApi(hooks[event], usage, () => 'Stop')
    expect(result.calls).toBe(0)
  }
})


test('concurrent requests cannot both use the same reset refresh', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  let approvals = 0
  const decide = () => { approvals += 1; return 'Stop' }
  const a = startTurnStep(hooks['turn.step'], limits(undefined, 45), decide)
  const b = startTurnStep(hooks['turn.step'], limits(undefined, 45), decide)
  const results = await Promise.all([a.done, b.done])
  expect(results[0].calls + results[1].calls).toBe(1)
  expect(approvals).toBe(1)
})

test('reset evidence is discarded when the session ends', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  await hooks['session.end']({}, { reason: 'logout' }, async () => ({}))
  const result = await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done
  expect(result.calls).toBe(0)
})

test('engine allows an observed-reset refresh through the guarded stream', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  const expired = new Date(Date.now() - 60_000).toISOString()
  on('session.usage', () => ({ value: limits(undefined, 45) }) as never)
  on('turn.start', () => ({ turnId: input.turnId }) as never)
  let downstream = 0
  on('turn.step', async function* () { downstream += 1; return fakeResult })
  await $.session.measure({ context: {}, rateLimits: limits(100, 45, expired).rateLimits, changed: ['rateLimits'] } as never)
  await $.turn.start({ text: 'reset integration', turnId: input.turnId } as never)
  const stream = $.turn.step(input as never)
  let result
  while (true) {
    const part = await stream.next()
    if (part.done) { result = part.value; break }
  }
  expect(downstream).toBe(1)
  expect(result.answer).toBe('test model result')
})


test('stale older reset timestamps cannot reopen a consumed refresh', async () => {
  const hooks = handlers()
  const older = new Date(Date.now() - 120_000).toISOString()
  const newer = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, newer))
  expect((await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done).calls).toBe(1)
  await observeUsage(hooks, limits(50, 45, older))
  expect((await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done).calls).toBe(0)
})

test('malformed readings cannot erase the record of a consumed reset', async () => {
  const hooks = handlers()
  const expired = new Date(Date.now() - 60_000).toISOString()
  await observeUsage(hooks, limits(100, 45, expired))
  expect((await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done).calls).toBe(1)
  await observeUsage(hooks, limits(Number.NaN, 45, expired))
  await observeUsage(hooks, limits(50, 45, expired))
  expect((await startTurnStep(hooks['turn.step'], limits(undefined, 45), () => 'Stop').done).calls).toBe(0)
})

test('an older healthy snapshot cannot replace a newer exhausted window', async () => {
  const hooks = handlers()
  const older = new Date(Date.now() - 60_000).toISOString()
  const newer = new Date(Date.now() + 3_600_000).toISOString()
  await observeUsage(hooks, limits(100, 45, newer))
  expect((await startTurnStep(hooks['turn.step'], limits(0, 45, older), () => 'Stop').done).calls).toBe(0)
})

test('an observed weekly reset refreshes only when the five-hour window is healthy', async () => {
  const expired = new Date(Date.now() - 60_000).toISOString()
  const hooks = handlers()
  await observeUsage(hooks, limits(20, 100, undefined, expired))
  expect((await startTurnStep(hooks['turn.step'], limits(20), () => 'Stop').done).calls).toBe(1)
  const exhausted = handlers()
  await observeUsage(exhausted, limits(100, 100, undefined, expired))
  expect((await startTurnStep(exhausted['turn.step'], limits(100), () => 'Stop').done).calls).toBe(0)
})

test('startup displays the reported context token count without deriving it from percent', async () => {
  const hooks = handlers()
  let status
  const $ = {
    session: { usage: async () => ({ ...limits(42, 18), context: { tokens: 12345, window: 200000, percent: 6 } }) },
    ui: { status: text => { status = text } },
  }
  await hooks['session.start']($, {}, async () => ({}))
  expect(status).toBe('Guard active · 5h: 42% · weekly: 18% · context: 12,345 tokens')
})

test('context measurements replace the count and clear unavailable or invalid readings', async () => {
  const hooks = handlers()
  let status
  let continued = 0
  const $ = { ui: { status: text => { status = text } } }
  for (const [tokens, expected] of [
    [123456, '123,456'], [1200, '1,200'], [0, '0'],
    [undefined, '?'], [NaN, '?'], [Infinity, '?'], [-1, '?'], ['123', '?'], [1.5, '?'],
  ]) {
    await hooks['session.measure']($, {
      rateLimits: limits(42, 18).rateLimits, context: { tokens, window: 200000 }, changed: ['context'],
    }, async () => { continued += 1; return {} })
    expect(status).toBe(`Guard active · 5h: 42% · weekly: 18% · context: ${expected} tokens`)
  }
  expect(continued).toBe(9)
})
