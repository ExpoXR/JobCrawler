'use client';

import Link from 'next/link';
import { useState } from 'react';

import { forgetMapsKeyInSession } from '@/lib/mapsKey';

/**
 * Account controls in the header.
 *
 * Signing out is a POST, not a link: a GET that changes state can be triggered
 * by any image tag on any page.
 */
export function AccountNav({ email, role }: { email?: string; role?: 'admin' | 'user' }) {
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // A Google Maps key belongs to the person, not the tab. Signing out is
      // the point at which they stop being that person on this machine.
      forgetMapsKeyInSession();
      window.location.assign('/');
    }
  }

  if (!email) {
    return <Link href="/login">Sign in</Link>;
  }

  return (
    <>
      {role === 'admin' ? <Link href="/admin">Admin</Link> : null}
      <span className="account-email" title={email}>
        {email}
      </span>
      <button type="button" className="link-button" onClick={() => void signOut()} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </>
  );
}
