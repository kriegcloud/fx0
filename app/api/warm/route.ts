import { log, warmChat } from '../../../lib/agent'
import { withSessionRoute } from '../../../lib/route-auth'

// The same maxDuration as /api/prompt, so Vercel bundles both routes into one function
// and this warm-up runs on the instances that serve the prompt. With a different value
// they become separate functions, and warming one leaves the other cold.
export const maxDuration = 800

// Called while the user types. The owner check, runtime binding, state hydration and
// the process's libfx agent happen now, so the send that follows skips them. Best
// effort: failures stay quiet.
export const POST = withSessionRoute(async (_request, { host }) => {
  try {
    await warmChat(host)
  } catch {
    log(host.id, 'warm:skipped', {})
  }
  return new Response(null, { status: 204 })
})
