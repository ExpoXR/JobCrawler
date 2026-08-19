'use client';

import { useId, useState } from 'react';

/**
 * Sign-in form.
 *
 * The destination comes from the server as a prop, already validated as a
 * same-site path — an open redirect would otherwise be one query parameter away.
 */
export function LoginForm({ next }: { next: string }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? 'Could not sign in.');
        setBusy(false);
        return;
      }

      // A full navigation rather than a router push: every server component
      // needs to re-render with the new session.
      window.location.assign(next);
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <form className="panel auth-form" onSubmit={(event) => void submit(event)}>
      <h1>Sign in</h1>

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor={`${id}-email`}>Email</label>
        <input
          id={`${id}-email`}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-password`}>Password</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <button className="button full" type="submit" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
