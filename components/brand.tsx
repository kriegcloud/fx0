'use client'

import type { MouseEvent } from 'react'
import { BeepWordmark } from './beep-wordmark'

// A real link home, so a new tab or a copied link work; a plain click opens the
// empty draft in place (onHome) instead of reloading the app.
export default function Brand({ onHome }: { onHome: () => void }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onHome()
  }

  return (
    <a
      href="/"
      aria-label="beep home"
      onClick={onClick}
      className="-mx-1 block px-1 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BeepWordmark className="text-xl" />
    </a>
  )
}
