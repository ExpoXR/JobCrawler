/**
 * Match score badge.
 *
 * The score is written as a number and the band is spelled out in the
 * accessible label, so the colour is reinforcement rather than the only
 * carrier of meaning (plan section 27).
 */
export function ScoreBadge({ score }: { score: number }) {
  const rounded = Math.round(score);
  const band = rounded >= 75 ? 'high' : rounded >= 50 ? 'medium' : 'low';
  const bandLabel = band === 'high' ? 'Strong' : band === 'medium' ? 'Moderate' : 'Weak';

  return (
    <span className={`score-badge ${band}`}>
      <span aria-hidden="true">{rounded}%</span>
      <span className="label" aria-hidden="true">
        {bandLabel}
      </span>
      <span className="visually-hidden">{`${bandLabel} match, ${rounded} percent`}</span>
    </span>
  );
}
