const STOPPED = 'Request stopped by usage-credit-guard.'

function stopped(e, reason = 'Approval was not granted') {
  return {
    turnId: e.turnId,
    index: e.index,
    answer: `${STOPPED} ${reason}.`,
    toolUses: [],
    stopReason: null,
    usage: null,
  }
}

function usageWindows(rateLimits, observedResets) {
  const kinds = ['five_hour', 'seven_day']
  if (!Array.isArray(rateLimits) || !rateLimits.some(limit => kinds.includes(limit?.kind))) return []
  const now = Date.now()
  return kinds.map(kind => {
    const limit = rateLimits.find(item => item?.kind === kind)
    if (limit) {
      const deadline = typeof limit.resetsAt === 'string' ? Date.parse(limit.resetsAt) : NaN
      const previous = observedResets.get(kind)
      if (Number.isFinite(limit.percentUsed) && limit.percentUsed >= 0 && Number.isFinite(deadline)) {
        if (!previous || deadline > previous.deadline) {
          observedResets.set(kind, { deadline, refreshed: false })
        } else if (deadline < previous.deadline) {
          return undefined
        }
      } else if (previous) {
        previous.refreshed = true
      }
      return { ...limit, reset: false }
    }
    const previous = observedResets.get(kind)
    // Claude drops expired windows; allow one request to obtain the new reading.
    if (previous && previous.deadline <= now && !previous.refreshed) {
      return { kind, percentUsed: 0, reset: true }
    }
    return undefined
  })
}

function consumeResets(usage, observedResets) {
  for (const kind of usage.resetKinds ?? []) {
    const previous = observedResets.get(kind)
    if (previous) previous.refreshed = true
  }
}

async function checkUsage($, observedResets) {
  const usage = await $.session.usage()
  const limits = usage?.rateLimits
  if (!Array.isArray(limits)) return { blocked: true, reason: 'Usage data is unavailable' }

  const [fiveHour, sevenDay] = usageWindows(limits, observedResets)
  const resetKinds = [fiveHour, sevenDay].filter(limit => limit?.reset).map(limit => limit.kind)
  const known = [fiveHour?.percentUsed, sevenDay?.percentUsed]
  if (known.some(value => !Number.isFinite(value) || value < 0)) {
    return { blocked: true, reason: resetReason('Five-hour or seven-day usage data is missing or invalid', [fiveHour, sevenDay]), resetKinds }
  }

  const exhausted = []
  if (fiveHour.percentUsed >= 100) exhausted.push('five-hour')
  if (sevenDay.percentUsed >= 100) exhausted.push('seven-day')
  if (exhausted.length) {
    return { blocked: true, reason: resetReason(`${exhausted.join(' and ')} usage is at or above 100%`, [fiveHour, sevenDay].filter(limit => limit.percentUsed >= 100)), resetKinds }
  }
  // Reserve before returning across an await so concurrent requests cannot reuse it.
  consumeResets({ resetKinds }, observedResets)
  return { blocked: false }
}

function resetReason(reason, relevant) {
  const resetTimes = relevant
    .map(limit => {
      if (typeof limit?.resetsAt !== 'string') return undefined
      const time = Date.parse(limit.resetsAt)
      if (!Number.isFinite(time)) return undefined
      const name = limit.kind === 'five_hour' ? 'five-hour' : 'seven-day'
      return `${name} resets ${new Date(time).toISOString()}`
    })
    .filter(Boolean)
  return resetTimes.length ? `${reason}; ${resetTimes.join('; ')}` : reason
}

function usageStatus(rateLimits, observedResets, context) {
  const [fiveHour, sevenDay] = usageWindows(rateLimits, observedResets)
  const five = fiveHour?.percentUsed
  const seven = sevenDay?.percentUsed
  const display = limit => limit?.reset ? 'reset' : Number.isFinite(limit?.percentUsed) && limit.percentUsed >= 0 ? `${limit.percentUsed}%` : '?'
  const approvalRequired = !Number.isFinite(five) || five < 0 || !Number.isFinite(seven) || seven < 0 || five >= 100 || seven >= 100
  const tokens = Number.isSafeInteger(context?.tokens) && context.tokens >= 0 ? context.tokens.toLocaleString('en-US') : '?'
  return `Guard active · 5h: ${display(fiveHour)} · weekly: ${display(sevenDay)} · context: ${tokens} tokens${approvalRequired ? ' · approval required' : ''}`
}

function showUsageStatus($, rateLimits, observedResets, context) {
  try {
    const result = $.ui.status(usageStatus(rateLimits, observedResets, context))
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {
    // Display failures must not affect session lifecycle or request gates.
  }
}

async function showInitialUsageStatus($, observedResets) {
  try {
    const usage = await $.session.usage()
    showUsageStatus($, usage?.rateLimits, observedResets, usage?.context)
  } catch {
    showUsageStatus($, undefined, observedResets)
  }
}

async function allowBlocked($, reason, description) {
  try {
    const answer = await $.ui.ask(
      `Usage credit guard: ${reason}. This request may use paid usage credits. Allow this one ${description}?`,
      ['Stop', 'Allow this request'],
    )
    return answer === 'Allow this request'
  } catch {
    return false
  }
}

export function register(on) {
  const observedResets = new Map()

  on('session.end', ($, e, next) => {
    observedResets.clear()
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await showInitialUsageStatus($, observedResets)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    showUsageStatus($, e.rateLimits, observedResets, e.context)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let usage
    try {
      usage = await checkUsage($, observedResets)
    } catch {
      usage = { blocked: true, reason: 'Usage data could not be read' }
    }

    if (usage.blocked && !(await allowBlocked($, usage.reason, `request for ${e.model}`))) {
      return stopped(e, usage.reason)
    }
    consumeResets(usage, observedResets)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return stopped(e, 'The guard failed and did not approve the request')
  })

  // These are separate paid-request APIs exposed to mods, outside turn.step.
  on('model.complete', ($, e, next) => guardModelApi($, e, next, observedResets)).catch(refuseModelApiFailure)
  on('model.fork', ($, e, next) => guardModelApi($, e, next, observedResets)).catch(refuseModelApiFailure)
  on('model.classify', ($, e, next) => guardModelApi($, e, next, observedResets)).catch(refuseModelApiFailure)
}

async function guardModelApi($, e, next, observedResets) {
  let usage
  try {
    usage = await checkUsage($, observedResets)
  } catch {
    usage = { blocked: true, reason: 'Usage data could not be read' }
  }
  const description = e.model ? `request for ${e.model}` : 'model API request'
  if (usage.blocked && !(await allowBlocked($, usage.reason, description))) {
    return { deny: `Request stopped by usage-credit-guard: ${usage.reason}.` }
  }
  consumeResets(usage, observedResets)
  return next(e)
}

async function refuseModelApiFailure($, e, next) {
  return { deny: 'Request stopped by usage-credit-guard because its guard failed.' }
}
