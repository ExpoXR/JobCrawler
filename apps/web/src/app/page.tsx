import Link from 'next/link';

/**
 * Homepage (plan section 26): the two-way entry point. No account, no
 * registration — the choice of direction is the only thing asked for.
 */
export default function HomePage() {
  return (
    <div className="container">
      <section className="hero">
        <h1>ExpoJobCrawler</h1>
        <p className="lede">
          A geographic employment research engine. It searches the open web around a place —
          company websites, career pages and public profiles — not just job boards.
        </p>

        <div className="mode-choice">
          <Link className="mode-card" href="/search?mode=jobs">
            <strong>I am looking for a job</strong>
            <span>
              Enter a city, a radius and a role. You will get active vacancies plus companies
              nearby that plausibly employ people like you, each with an explained match score.
            </span>
          </Link>

          <Link className="mode-card" href="/search?mode=candidates">
            <strong>I am looking for people</strong>
            <span>
              Describe the role or paste a job description. You will get publicly available
              professional profiles in the area, with links back to the original source.
            </span>
          </Link>
        </div>
      </section>

      <section className="container" style={{ maxWidth: 720, paddingTop: 0 }}>
        <h2>How it works</h2>
        <ol>
          <li>Your location is geocoded against OpenStreetMap.</li>
          <li>Indexed companies and jobs inside the radius are returned immediately.</li>
          <li>
            Live discovery runs in the background: nearby companies are found, their
            <code> robots.txt</code> and sitemaps are read, and career pages are analysed.
          </li>
          <li>
            Results are deduplicated across sources, scored against your requirements, and every
            score is explained with the evidence behind it.
          </li>
        </ol>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          The crawler respects <code>robots.txt</code>, crawl delays and rate limits, and never
          attempts to bypass access controls. Only publicly available professional information is
          indexed.
        </p>
      </section>
    </div>
  );
}
