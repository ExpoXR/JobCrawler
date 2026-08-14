import { getCompanyById, getJobById, findJobsByCompany } from '@ejc/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Job detail page (plan section 29).
 *
 * Provenance is the point of this page: what came from a source, what was
 * inferred, where each claim can be checked, and when it was last verified.
 */

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const job = await getJobById(id).catch(() => undefined);
  return { title: job ? job.title : 'Job' };
}

function formatDate(value: string | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

/** Confidence label (plan section 29): extracted vs derived vs missing. */
function Confidence({ level }: { level: 'confirmed' | 'inferred' | 'uncertain' }) {
  return <span className={`confidence ${level}`}>{level}</span>;
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;

  const job = await getJobById(id);
  if (!job) notFound();

  const company = job.companyId ? await getCompanyById(job.companyId) : undefined;
  const relatedJobs = job.companyId
    ? (await findJobsByCompany(job.companyId)).filter((entry) => entry.id !== job.id).slice(0, 6)
    : [];

  return (
    <div className="container">
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/search?mode=jobs">← Back to search</Link>
      </p>

      <h1>{job.title}</h1>
      <p className="result-company">
        {company ? <Link href={`/companies/${company.id}`}>{company.name}</Link> : job.companyName}
        {job.city ? ` · ${job.city}` : ''}
        {job.country ? `, ${job.country}` : ''}
      </p>

      <div className="result-meta" style={{ marginBottom: '1.25rem' }}>
        {job.isActive ? (
          <span className="badge vacancy">Active vacancy</span>
        ) : (
          <span className="badge">No longer listed</span>
        )}
        {job.workModel !== 'unknown' ? <span>{job.workModel}</span> : null}
        {job.employmentType !== 'unknown' ? (
          <span>{job.employmentType.replace('_', '-')}</span>
        ) : null}
        {job.seniority !== 'unknown' ? <span>{job.seniority}</span> : null}
        {job.salaryMin || job.salaryMax ? (
          <span>
            {job.salaryMin?.toLocaleString() ?? '?'}–{job.salaryMax?.toLocaleString() ?? '?'}{' '}
            {job.salaryCurrency ?? ''}
          </span>
        ) : null}
      </div>

      <div className="detail-grid">
        <div>
          {job.aiSummary ? (
            <section className="panel" style={{ marginBottom: '1rem' }}>
              <h2>Summary</h2>
              <p>{job.aiSummary}</p>
              <p className="hint">
                Generated from the posting text <Confidence level="inferred" />
              </p>
            </section>
          ) : null}

          <section className="panel" style={{ marginBottom: '1rem' }}>
            <h2>
              Job description <Confidence level="confirmed" />
            </h2>
            {job.description ? (
              // Rendered as plain text: scraped HTML is never trusted as markup.
              <p style={{ whiteSpace: 'pre-wrap' }}>{job.description}</p>
            ) : (
              <p className="hint">No description was extracted from the source page.</p>
            )}
          </section>

          {relatedJobs.length > 0 ? (
            <section className="panel">
              <h2>Other vacancies at this company</h2>
              <ul>
                {relatedJobs.map((entry) => (
                  <li key={entry.id}>
                    <Link href={`/jobs/${entry.id}`}>{entry.title}</Link>
                    {entry.city ? ` — ${entry.city}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div>
          <section className="panel" style={{ marginBottom: '1rem' }}>
            <h2>Apply</h2>
            {job.applicationUrl ? (
              <a
                className="button full"
                href={job.applicationUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                Open original posting ↗
              </a>
            ) : (
              <p className="hint">No application URL was found.</p>
            )}
          </section>

          <section className="panel" style={{ marginBottom: '1rem' }}>
            <h2>Skills</h2>
            {job.skills.length > 0 ? (
              <div className="chip-group">
                {job.skills.map((skill) => (
                  <span className="chip" key={skill}>
                    {skill}
                  </span>
                ))}
              </div>
            ) : (
              <p className="hint">None detected.</p>
            )}
          </section>

          <section className="panel" style={{ marginBottom: '1rem' }}>
            <h2>Sources</h2>
            <ul className="source-list">
              {job.sources.length > 0 ? (
                job.sources.map((source) => (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
                      {source.url}
                    </a>
                    <div className="hint">via {source.provider}</div>
                  </li>
                ))
              ) : (
                <li className="hint">No source URLs recorded.</li>
              )}
            </ul>
          </section>

          <section className="panel">
            <h2>Provenance</h2>
            <table className="component-table">
              <tbody>
                <tr>
                  <th scope="row">Discovered</th>
                  <td>{formatDate(job.discoveredAt)}</td>
                </tr>
                <tr>
                  <th scope="row">Published</th>
                  <td>{formatDate(job.publishedAt)}</td>
                </tr>
                <tr>
                  <th scope="row">Last verified</th>
                  <td>{formatDate(job.lastVerifiedAt)}</td>
                </tr>
                <tr>
                  <th scope="row">Expires</th>
                  <td>{formatDate(job.expiresAt)}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
