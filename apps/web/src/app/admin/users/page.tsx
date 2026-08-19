import { listUsers } from '@ejc/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { UserAdmin } from '@/components/UserAdmin';
import { guardAdminPage, MIN_PASSWORD_LENGTH } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Accounts' };

export default async function AdminUsersPage() {
  const actor = await guardAdminPage('/admin/users');
  const users = await listUsers();

  // Dates cannot cross into a client component as `Date` objects.
  const serialised = users.map((user) => ({
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  }));

  return (
    <div className="container">
      <p className="ex-kicker">
        <Link href="/admin">Admin</Link> · Accounts
      </p>
      <h1>Accounts</h1>

      <UserAdmin
        initialUsers={serialised}
        currentUserId={actor.id}
        minPasswordLength={MIN_PASSWORD_LENGTH}
      />
    </div>
  );
}
