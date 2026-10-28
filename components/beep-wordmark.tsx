import type { HTMLAttributes } from 'react'

// Geometry and theme behavior from @beep/brand/src/react.tsx (MIT).
// Kept local so this standalone app does not depend on the Beep monorepo.
export function BeepWordmark(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span data-beep-wordmark="" {...props}>
      <svg viewBox="0 0 24 24" fill="none" width="1.25em" height="1.25em" className="shrink-0 text-brand-400" aria-hidden="true">
        <path d="M6 20l6.5 -9" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M19 20c-6 0 -6 -16 -12 -16" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        <g transform="translate(5.4, 9.5) scale(0.52) rotate(8 12.5 2.5)">
          <path fill="var(--color-fg)" d="m0,0v2h1v1h1v1h1v1h7v-1h1v-1h1v-2h2v2h1v1h1v1h6v-1h1v-1h1v-1h1v-2z" />
          <path fill="var(--color-surface-0)" d="m2,1v1h4v2h1v-1h-2v-2h-1v3h1v-1h-2v-2z" />
          <path fill="var(--color-surface-0)" d="m15,1v1h4v2h1v-1h-2v-2h-1v3h1v-1h-2v-2z" />
        </g>
      </svg>
      <span>beep</span>
    </span>
  )
}
