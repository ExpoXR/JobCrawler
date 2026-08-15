import { findJobsByCompany, getCompanyById } from '@ejc/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ResearchPanel } from '@/components/ResearchPanel';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const company = await getCompanyById(id).catch(() => undefined);
  return { title: company ? company.name : 'Company' };
}

function formatDate(value: string | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
}

/** Company detail page, including the potential-employer case (plan section 18). */
export default async function CompanyDetailPage({ params }: PageProps) {
  const { id } = await params;

  const company = await getCompanyById(id);
  if (!company) notFound();

  const jobs = await findJobsByCompany(company.id);

  return (
    <div className="container">
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/search?mode=jobs">← Back to search</Link>
      </p>

      <h1>{company.name}</h1>
      <p className="result-company">
        {[company.industry, company.city, company.country].filter(Boolean).join(' · ')}
      </p>

      <div className="result-meta" style={{ marginBottom: '1.25rem' }}>
        {jobs.length > 0 ? (
          <span className="badge vacancy">{jobs.length} active vacancies</span>
        ) : (
          <span className="badge potential">Potential employer — no active vacancy found</span>
        )}
        {company.website ? (
          <a href={company.website} target="_blank" rel="noopener noreferrer nofollow">
            {new URL(company.website).hostname}
          </a>
        ) : null}
      </div>

      <div className="detail-grid">
        <div>
          {company.description ? (
            <section className="panel" style={{ marginBottom: '1rem' }}>
              <h2>About</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{company.description}</p>
            </section>
          ) : null}

          {jobs.length > 0 ? (
            <section className="panel" style={{ marginBottom: '1rem' }}>
              <h2>Open positions</h2>
              <ul>
                {jobs.map((job) => (
                  <li key={job.id}>
                    <Link href={`/jobs/${job.id}`}>{job.title}</Link>
                    {job.city ? ` — ${job.city}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="panel" style={{ marginBottom: '1rem' }}>
              <h2>No active vacancy found</h2>
              <p>
                No open position was found on this company&apos;s website at the last crawl. If the
                technologies below match your profile, an unsolicited application may still be
                worthwhile.
              </p>
              {company.careerPageUrl ? (
                <a
                  className="button"
                  href={company.careerPageUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  Open career page ↗
                </a>
              ) : null}
            </section>
          )}

          {company.technologies.length > 0 ? (
            <section className="panel">
              <h2>Detected technologies</h2>
              <div className="chip-group">
                {company.technologies.map((technology) => (
                  <span className="chip" key={technology}>
                    {technology}
                  </span>
                ))}
              </div>
              <p className="hint" style={{ marginTop: '0.5rem' }}>
                Detected from the company&apos;s public pages — indicative, not authoritative.
              </p>
            </section>
          ) : null}
        </div>

        <div>
          <ResearchPanel companyId={company.id} />

          <section className="panel" style={{ marginBottom: '1rem' }}>
            <h2>Contact</h2>
            <ul className="source-list">
              {company.website ? (
                <li>
                  <a href={company.website} target="_blank" rel="noopener noreferrer nofollow">
                    Website
                  </a>
                </li>
              ) : null}
              {company.careerPageUrl ? (
                <li>
                  <a
                    href={company.careerPageUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    Career page
                  </a>
                </li>
              ) : null}
              {company.contactPageUrl ? (
                <li>
                  <a
                    href={company.contactPageUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    Contact page
                  </a>
                </li>
              ) : null}
              {company.publicEmail ? <li>{company.publicEmail}</li> : null}
              {company.publicPhone ? <li>{company.publicPhone}</li> : null}
              {Object.entries(company.socialLinks).map(([key, url]) => (
                <li key={key}>
                  <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                    {key}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2>Provenance</h2>
            <table className="component-table">
              <tbody>
                <tr>
                  <th scope="row">Last crawled</th>
                  <td>{formatDate(company.lastCrawledAt)}</td>
                </tr>
                <tr>
                  <th scope="row">Last verified</th>
                  <td>{formatDate(company.lastVerifiedAt)}</td>
                </tr>
                <tr>
                  <th scope="row">Sitemaps</th>
                  <td>{company.sitemapUrls.length}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
