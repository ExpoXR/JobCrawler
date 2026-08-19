import {
  checkDatabaseHealth,
  countCandidates,
  countCompanies,
  countJobs,
  getSearchStats,
  listBlockedDomains,
  listRecentCrawlJobs,
  listSourceProviders,
} from '@ejc/database';
import { checkRedisHealth, getQueueStats } from '@ejc/queue';
import { getConfig } from '@ejc/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { guardAdminPage } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Admin' };

/**
 * Admin dashboard (plan section 33).
 *
 * Read-only overview rendered on the server; the mutating operations
 * (toggle provider, block domain, trigger re-crawl) live behind
 * `/api/admin/*`, which enforce the same `requireAdmin()` check.
 *
 * The edge gate in `proxy.ts` only redirects a caller with no session cookie —
 * this is the check that actually holds.
 */
export default async function AdminPage() {
  await guardAdminPage('/admin');

  const config = getConfig();

  const [database, redis, companies, activeJobs, candidates, searches, crawls, providers, blocked] =
    await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      countCompanies().catch(() => 0),
      countJobs(true).catch(() => 0),
      countCandidates().catch(() => 0),
      getSearchStats().catch(() => ({ total: 0, last24h: 0, averageResults: 0 })),
      listRecentCrawlJobs(15).catch(() => []),
      listSourceProviders().catch(() => []),
      listBlockedDomains().catch(() => []),
    ]);

  const queues = redis.ok ? await getQueueStats().catch(() => []) : [];

  return (
    <div className="container">
      <p className="ex-kicker">Operations workspace</p>
      <h1>Admin dashboard</h1>

      <nav className="admin-nav" aria-label="Administration">
        <Link href="/admin/providers">Model providers</Link>
        <Link href="/admin/users">Accounts</Link>
      </nav>

      <div className="stat-grid">
        <div className="stat">
          <div className="value">{companies.toLocaleString()}</div>
          <div className="label">Companies</div>
        </div>
        <div className="stat">
          <div className="value">{activeJobs.toLocaleString()}</div>
          <div className="label">Active jobs</div>
        </div>
        <div className="stat">
          <div className="value">{candidates.toLocaleString()}</div>
          <div className="label">Candidate profiles</div>
        </div>
        <div className="stat">
          <div className="value">{searches.last24h.toLocaleString()}</div>
          <div className="label">Searches (24 h)</div>
        </div>
      </div>

      <section className="panel admin-panel">
        <h2>Health</h2>
        <table className="component-table">
          <tbody>
            <tr>
              <th scope="row">PostgreSQL</th>
              <td className={database.ok ? 'status-ok' : 'status-bad'}>
                {database.ok ? 'connected' : (database.error ?? 'unavailable')}
              </td>
              <td className="numeric">{database.latencyMs} ms</td>
            </tr>
            <tr>
              <th scope="row">PostGIS</th>
              <td className={database.postgis ? 'status-ok' : 'status-bad'}>
                {database.postgis ? 'installed' : 'missing'}
              </td>
              <td />
            </tr>
            <tr>
              <th scope="row">pgvector</th>
              <td className={database.pgvector ? 'status-ok' : 'status-bad'}>
                {database.pgvector ? 'installed' : 'missing'}
              </td>
              <td />
            </tr>
            <tr>
              <th scope="row">Redis</th>
              <td className={redis.ok ? 'status-ok' : 'status-bad'}>
                {redis.ok ? 'connected' : 'unavailable'}
              </td>
              <td className="numeric">{redis.latencyMs} ms</td>
            </tr>
            <tr>
              <th scope="row">AI provider</th>
              <td>{config.ai.provider === 'none' ? 'not configured' : config.ai.provider}</td>
              <td>{config.ai.model || '—'}</td>
            </tr>
            <tr>
              <th scope="row">Embeddings</th>
              <td>
                {config.embedding.provider === 'none'
                  ? 'not configured (lexical scoring only)'
                  : config.embedding.provider}
              </td>
              <td>{config.embedding.model || '—'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel admin-panel">
        <h2>Queues</h2>
        {queues.length === 0 ? (
          <p className="hint">Redis is unavailable, so queue statistics cannot be read.</p>
        ) : (
          <table className="component-table">
            <thead>
              <tr>
                <th>Queue</th>
                <th className="numeric">Waiting</th>
                <th className="numeric">Active</th>
                <th className="numeric">Completed</th>
                <th className="numeric">Failed</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((queue) => (
                <tr key={queue.name}>
                  <td>{queue.name}</td>
                  <td className="numeric">{queue.waiting}</td>
                  <td className="numeric">{queue.active}</td>
                  <td className="numeric">{queue.completed}</td>
                  <td className="numeric">{queue.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel admin-panel">
        <h2>Providers</h2>
        {providers.length === 0 ? (
          <p className="hint">
            No providers registered yet. Start the worker, or open{' '}
            <code>/api/admin/providers</code> to trigger a registry sync.
          </p>
        ) : (
          <table className="component-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Capabilities</th>
                <th>Enabled</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.key}>
                  <td>{provider.name}</td>
                  <td>{provider.kind}</td>
                  <td>{provider.capabilities.join(', ')}</td>
                  <td className={provider.enabled ? 'status-ok' : 'status-bad'}>
                    {provider.enabled ? 'yes' : 'no'}
                  </td>
                  <td>{provider.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel admin-panel">
        <h2>Recent crawls</h2>
        {crawls.length === 0 ? (
          <p className="hint">No crawls recorded yet.</p>
        ) : (
          <table className="component-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Status</th>
                <th className="numeric">Pages</th>
                <th className="numeric">Jobs</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {crawls.map((crawl) => (
                <tr key={crawl.id}>
                  <td>{crawl.domain}</td>
                  <td className={crawl.status === 'failed' ? 'status-bad' : ''}>{crawl.status}</td>
                  <td className="numeric">{crawl.pagesFetched}</td>
                  <td className="numeric">{crawl.jobsFound}</td>
                  <td>{crawl.errorType ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Blocked domains</h2>
        {blocked.length === 0 ? (
          <p className="hint">
            None. Block one with <code>POST /api/admin/domains</code>.
          </p>
        ) : (
          <ul className="source-list">
            {blocked.map((domain) => (
              <li key={domain}>{domain}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
