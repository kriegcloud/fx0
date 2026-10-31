// Shared by the stream projector and renderer so historical raw errors also
// explain how to recover, without rewriting the append-only conversation.
export const OUTPUT_TRUNCATED_MESSAGE = 'The model reached its response limit before finishing. Your last published preview is preserved. Continue in smaller steps to finish the design.'

export const OUTPUT_RECOVERY_PROMPT = 'Continue the interrupted task from the last successfully published design. The previous response was truncated. Do not repeat the same large tool call. If no design has been published, publish a complete, usable initial design under 12 KiB first. Then finish the remaining requirements through separate edit_design calls, keeping each call under about 12 KiB. Check each tool result before continuing, preserve completed work, and do not claim completion until all requested parts are implemented.'

export function isOutputTruncated(text: string | undefined): boolean {
  return text === OUTPUT_TRUNCATED_MESSAGE || /^(?:Error:\s*)?(?:OutputTruncated|max_output_tokens)\s*$/.test(text ?? '')
}

export function generationErrorMessage(text: string | undefined): string {
  return isOutputTruncated(text) ? OUTPUT_TRUNCATED_MESSAGE : text || 'This message did not finish. Resend to retry.'
}

export function canRecoverOutput(entries: { type: string; text?: string }[], activeTurnId: number | null): boolean {
  if (activeTurnId != null) return false
  // A newer user message supersedes a failure even before its turn starts.
  const latest = entries.findLast(entry => entry.type === 'error' || entry.type === 'user' || entry.type === 'divider')
  return latest?.type === 'error' && isOutputTruncated(latest.text)
}
