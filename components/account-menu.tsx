'use client'

import { useEffect, useState } from 'react'
import { loadCached, readCached } from './cached-fetch'
import { buyCreditsUrl, useCredits } from './credits'
import { fastClick } from '../lib/fast-click'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Skeleton } from './ui/skeleton'

export interface AccountUser {
  id: string
  name: string
  email: string | null
  picture: string | null
  guest?: true
}

// Balances come with the team listing (cached for minutes); the checked team's is
// replaced by its live balance.
interface TeamOption { teamId: string; teamSlug: string; balance?: number | null }

function formatBalance(balance: number | null | undefined): string {
  // Flex-commitment teams bill against a commitment, so their balance is negative.
  return balance == null ? '' : balance < 0 ? 'flex' : `$${balance.toFixed(2)}`
}

const rowClassName = 'flex w-full items-center gap-2 px-2 py-1.5 text-left'
const interactiveRow = 'outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:opacity-60'

export default function AccountMenu({ user, team = null, onSignOut, signOutStatus = null, onSignIn, onSwitchTeam, onGrantTeams, sidebar = false, side = sidebar ? 'top' : 'bottom' }: {
  // undefined while the page is still learning who is signed in.
  user: AccountUser | null | undefined
  team?: string | null
  onSignOut: () => void
  signOutStatus?: 'pending' | 'failed' | null
  onSignIn: () => void
  onSwitchTeam: (teamId: string) => Promise<void>
  onGrantTeams?: () => void
  sidebar?: boolean
  // Where the menu opens: above the trigger when it sits at the bottom of the screen.
  side?: 'top' | 'bottom'
}) {
  const [open, setOpen] = useState(false)
  const [teams, setTeams] = useState<TeamOption[] | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [error, setError] = useState('')
  const credits = useCredits(user?.id ?? null, team)
  const balance = credits?.flexible ? 'flex' : formatBalance(credits?.balance)

  // Each listing probes every team against Gateway, so it is prefetched once per
  // page and cached per user; the menu then opens complete instead of growing.
  const teamsKey = user ? `fx0:cache:teams:v4:${user.id}` : null
  useEffect(() => {
    if (!teamsKey) return
    type Listing = { teams?: TeamOption[] }
    const cached = readCached<Listing>(teamsKey)
    if (Array.isArray(cached?.value.teams)) setTeams(cached.value.teams)
    let live = true
    void loadCached<Listing>(teamsKey, '/api/teams', 10 * 60_000).then((listing) => {
      if (live && Array.isArray(listing?.teams)) setTeams(listing.teams)
    })
    return () => { live = false }
  }, [teamsKey])

  async function chooseTeam(teamId: string) {
    if (switching) return
    setSwitching(teamId)
    setError('')
    try {
      await onSwitchTeam(teamId)
    } catch (error) {
      setError((error as Error).message || 'Unable to switch team. Try again.')
      setSwitching(null)
    }
  }

  const rowClass = sidebar ? 'h-8 w-full max-w-none justify-start px-3 text-[13px] text-foreground-secondary hover:text-foreground focus-visible:ring-offset-sidebar' : 'max-w-32'

  const signIn = (className = '') => (
    <Button variant="ghost" size="sm" disabled={signOutStatus === 'pending'} className={`${sidebar ? rowClass : 'shrink-0'} ${className}`} {...fastClick(onSignIn)}>
      Sign in
    </Button>
  )

  // Still streaming: the layout script marks html.guest when there is no session, so a
  // visitor sees Sign in at once rather than a placeholder for an account they lack.
  if (user === undefined) return (
    <>
      <div role="status" className={`flex h-8 items-center gap-2 [html.guest_&]:hidden ${sidebar ? 'w-full px-3' : 'w-32 shrink-0 px-3'}`}>
        <span className="sr-only">Loading account…</span>
        <Skeleton className="size-5 shrink-0" />
        <Skeleton className="h-3 w-24" />
      </div>
      {signIn('hidden [html.guest_&]:inline-flex')}
    </>
  )

  if (!user) return signIn()
  if (user.id === 'local:workstation') return <div className={`${rowClass} flex items-center text-foreground-secondary`}>CLIProxyAPI subscriptions</div>

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            setOpen((current) => !current)
          }}
          onClick={(event) => {
            if (event.detail !== 0) event.preventDefault()
          }}
          aria-label={`Account: ${user.name}`} className={`${rowClass} gap-2`}>
          <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center bg-secondary text-xs">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{user.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align={side === 'top' ? 'start' : 'end'} side={side} className="w-60 p-1 text-[13px]">
        {/* Two sizes only: 13px rows, 12px section label. Every row shares one
            inset and a check column, so names and actions line up. */}
        <p className="truncate px-2 pb-1.5 pt-2 font-medium">{user.name}</p>
        <div className="my-1 h-px bg-border" />
        {/* Generations bill to the checked team. Chats keep the team they were created with. */}
        <p className="px-2 pb-1 pt-1.5 text-xs text-foreground-tertiary">billing team</p>
        <div role="radiogroup" aria-label="billing team" className="max-h-48 overflow-y-auto">
          {teams == null || teams.length === 0 ? (
            <p className={rowClassName}>
              <span className="w-3 shrink-0" aria-hidden="true" />
              <span className="truncate text-foreground-tertiary">
                {team ?? (teams == null ? 'loading teams…' : 'no team with AI Gateway access')}
              </span>
              {team && balance && <span className="ml-auto shrink-0 tabular-nums text-foreground-tertiary">{balance}</span>}
            </p>
          ) : teams.map((option) => {
            const current = option.teamSlug === team || option.teamId === team
            const amount = current ? balance || formatBalance(option.balance) : formatBalance(option.balance)
            return (
              <button
                key={option.teamId}
                type="button"
                role="radio"
                aria-checked={current}
                disabled={switching != null}
                {...fastClick(() => { if (!current) void chooseTeam(option.teamId) })}
                className={`${rowClassName} ${interactiveRow} ${current ? 'text-foreground' : 'text-foreground-secondary'}`}
              >
                <span className="w-3 shrink-0" aria-hidden="true">{current ? '✓' : ''}</span>
                <span className="min-w-0 flex-1 truncate">{option.teamSlug}</span>
                {switching === option.teamId
                  ? <span className="text-xs text-foreground-tertiary">switching…</span>
                  : amount && <span className="shrink-0 tabular-nums text-foreground-tertiary">{amount}</span>}
              </button>
            )
          })}
          {onGrantTeams && (
            <button type="button" {...fastClick(onGrantTeams)} className={`${rowClassName} ${interactiveRow} text-foreground-secondary`}>
              <span className="w-3 shrink-0 text-center" aria-hidden="true">+</span>
              <span className="truncate">add a team</span>
            </button>
          )}
        </div>
        <div className="my-1 h-px bg-border" />
        {!credits?.flexible && (
          <a
            href={buyCreditsUrl(team)}
            target="_blank"
            rel="noreferrer"
            className={`${rowClassName} ${interactiveRow} text-foreground-secondary`}
          >
            <span className="w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">buy credits</span>
          </a>
        )}
        <button
          type="button"
          disabled={signOutStatus === 'pending'}
          {...fastClick(() => { setOpen(false); onSignOut() })}
          className={`${rowClassName} ${interactiveRow} text-foreground-secondary`}
        >
          <span className="w-3 shrink-0" aria-hidden="true" />
          <span>sign out</span>
        </button>
        {error && <p role="alert" className="px-2 py-1.5 text-xs text-error">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}
