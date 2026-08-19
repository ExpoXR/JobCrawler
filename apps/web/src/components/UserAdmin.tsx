'use client';

import type { UserRecord, UserRole } from '@ejc/database';
import { useCallback, useId, useState } from 'react';

/**
 * Account management.
 *
 * Every mutation is a request to `/api/admin/users`, which re-checks the
 * administrator role server-side — nothing here is trusted because it rendered.
 */

interface SerialisedUser extends Omit<UserRecord, 'createdAt' | 'updatedAt' | 'lastLoginAt'> {
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function UserAdmin({
  initialUsers,
  currentUserId,
  minPasswordLength,
}: {
  initialUsers: SerialisedUser[];
  currentUserId: string;
  minPasswordLength: number;
}) {
  const id = useId();
  const [users, setUsers] = useState(initialUsers);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = (await response.json()) as { users: SerialisedUser[] };
    setUsers(payload.users);
  }, []);

  const send = useCallback(
    async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown, success: string) => {
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const response = await fetch('/api/admin/users', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(payload.error ?? 'The change could not be applied.');
          return false;
        }
        setNotice(success);
        await refresh();
        return true;
      } catch {
        setError('Could not reach the server.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const ok = await send('POST', { email, password, role }, `Created ${email}.`);
    if (ok) {
      setEmail('');
      setPassword('');
      setRole('user');
    }
  }

  return (
    <section className="admin-section">
      <h2>Accounts</h2>

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <form className="panel user-invite" onSubmit={(event) => void invite(event)}>
        <h3>Add an account</h3>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-password`}>Initial password</label>
          <input
            id={`${id}-password`}
            type="password"
            required
            minLength={minPasswordLength}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="hint">
            At least {minPasswordLength} characters. Share it out of band and have them change it.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-role`}>Role</label>
          <select
            id={`${id}-role`}
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
          >
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </div>
        <button className="button" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Working…' : 'Create account'}
        </button>
      </form>

      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Last sign-in</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <tr key={user.id}>
                <td>
                  {user.email}
                  {isSelf ? <span className="hint"> (you)</span> : null}
                </td>
                <td>
                  <select
                    aria-label={`Role for ${user.email}`}
                    value={user.role}
                    disabled={busy || isSelf}
                    onChange={(event) =>
                      void send(
                        'PATCH',
                        { id: user.id, role: event.target.value },
                        `Updated ${user.email}.`,
                      )
                    }
                  >
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                </td>
                <td>{user.isActive ? 'Active' : 'Disabled'}</td>
                <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td className="user-actions">
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || isSelf}
                    onClick={() =>
                      void send(
                        'PATCH',
                        { id: user.id, isActive: !user.isActive },
                        `${user.isActive ? 'Disabled' : 'Enabled'} ${user.email}.`,
                      )
                    }
                  >
                    {user.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || isSelf}
                    onClick={() => {
                      if (!window.confirm(`Delete ${user.email}? This cannot be undone.`)) return;
                      void send('DELETE', { id: user.id }, `Deleted ${user.email}.`);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
