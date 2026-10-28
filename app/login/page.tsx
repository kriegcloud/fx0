import { Suspense } from 'react'
import { BeepWordmark } from '../../components/beep-wordmark'
import { redirect } from 'next/navigation'
import { connection } from 'next/server.js'
import { requireUserSession } from '@/lib/auth'

export const metadata = { title: 'Sign in · beep' }

const ERRORS: Record<string, string> = {
  team_access: 'Choose a Vercel team with AI Gateway access to continue.',
  session_unavailable: 'Your session could not be renewed. Sign in again to continue.',
  signin_unavailable: 'Sign in is unavailable right now. Try again in a moment.',
}

type SearchParams = Promise<{ error?: string | string[] }>

function SignInLink({ href }: { href: string }) {
  return (
    <a href={href}
      className="mt-8 flex h-10 items-center justify-center bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
      Continue with Vercel
    </a>
  )
}

async function SignIn({ searchParams }: { searchParams: SearchParams }) {
  // Unsealing the session reads the clock, which must happen at request time.
  await connection()
  // A signed-out login's grant, or any failure to check it, shows sign-in.
  const [session, params] = await Promise.all([requireUserSession().catch(() => null), searchParams])
  // An expired grant is not a usable session: sending it to / would loop back here.
  if (session && session.expiresAt > Date.now() && !params.error) redirect('/')
  const message = typeof params.error === 'string'
    ? ERRORS[params.error] ?? 'Sign in could not be completed. Please try again.'
    : params.error ? 'Sign in could not be completed. Please try again.' : null
  return (
    <>
      {message ? <p role="alert" className="mt-5 text-sm text-destructive">{message}</p> : null}
      <SignInLink href={params.error === 'team_access' ? '/api/auth/signin?reauth=true' : '/api/auth/signin'} />
    </>
  )
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-sm border border-border p-8" aria-labelledby="login-heading">
        <BeepWordmark className="mb-8 text-2xl" />
        <h1 id="login-heading" className="text-xl font-medium tracking-tight">Sign in to beep</h1>
        <p className="mt-3 text-sm leading-6 text-foreground-secondary">
          Build with your Vercel account and your team’s AI Gateway access.
        </p>
        <Suspense fallback={<SignInLink href="/api/auth/signin" />}>
          <SignIn searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  )
}
