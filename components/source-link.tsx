import { REPO_URL } from './how-it-works'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export default function SourceLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="upstream fx0 source on GitHub (opens in a new tab)"
          className="grid size-8 shrink-0 place-items-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* The octocat in the same square frame as the help button beside it. */}
          <svg viewBox="-2 -2 20 20" className="size-5" aria-hidden="true">
            <rect x="-1.625" y="-1.625" width="19.25" height="19.25" fill="none" stroke="currentColor" strokeWidth="0.75" />
            <path fill="currentColor" transform="translate(3 3) scale(0.625)" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
          </svg>
        </a>
      </TooltipTrigger>
      <TooltipContent>view upstream fx0 source on GitHub</TooltipContent>
    </Tooltip>
  )
}
