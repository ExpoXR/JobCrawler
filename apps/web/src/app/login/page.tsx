import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/LoginForm';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/**
 * Constrains the post-login destination to a path on this site.
 *
 * `next` arrives from a query parameter, so without this the login page would
 * be a ready-made open redirect. A leading `//` or `/\` is rejected too: both
 * are protocol-relative URLs that browsers resolve to another host.
 */
function safeNext(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  return candidate;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params['next']);

  // Already signed in: nothing to do here.
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="auth-layout">
      <LoginForm next={next} />
    </div>
  );
}
