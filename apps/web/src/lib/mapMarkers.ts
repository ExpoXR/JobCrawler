import type { GeoPoint, SearchResultItem } from '@ejc/shared';

/**
 * Marker geometry and semantics, shared by both map implementations.
 *
 * MapLibre draws markers as DOM elements and Google draws them as SVG symbols,
 * so nothing about the *rendering* can be shared — but the meaning must be, or
 * the two maps would disagree about what a square means. Kept here rather than
 * in a component so it stays testable and so switching provider cannot change
 * what the legend describes.
 *
 * Shape carries the category and colour carries the match band. Colour alone is
 * not an accessible signal, which is why the shape is not decorative.
 */

export interface MarkerModel {
  id: string;
  point: GeoPoint;
  kind: SearchResultItem['kind'];
  score: number;
  label: string;
}

/**
 * Marker budget. Both maps degrade badly well before this, and a search is
 * capped at 500 results server-side, so this only bites on the widest queries.
 */
export const MAX_MARKERS = 400;

/**
 * Match bands as CSS custom properties, with a literal fallback.
 *
 * The Google Maps API paints symbols itself and cannot resolve `var(--…)`, so
 * the token has to be read from the document at runtime — hence a pair rather
 * than a plain string. The fallbacks are the light-theme values from
 * `expoxr-system.css`.
 */
export interface ColorToken {
  token: string;
  fallback: string;
}

export const MATCH_COLORS: { high: ColorToken; medium: ColorToken; low: ColorToken } = {
  high: { token: '--ex-success', fallback: '#18704a' },
  medium: { token: '--ex-warning', fallback: '#8a5700' },
  low: { token: '--ex-muted', fallback: '#666870' },
};

export function matchColorToken(score: number): ColorToken {
  if (score >= 75) return MATCH_COLORS.high;
  if (score >= 50) return MATCH_COLORS.medium;
  return MATCH_COLORS.low;
}

export function pointOf(item: SearchResultItem): GeoPoint | undefined {
  return item.job?.coordinates ?? item.company?.location ?? item.candidate?.coordinates;
}

export function labelOf(item: SearchResultItem): string {
  if (item.kind === 'candidate') return item.candidate?.publicName ?? 'Public profile';
  if (item.kind === 'potential_employer') return item.company?.name ?? 'Company';
  return item.job?.title ?? 'Vacancy';
}

/** Results without coordinates are dropped here; they still appear in the list. */
export function toMarkers(items: readonly SearchResultItem[]): MarkerModel[] {
  const markers: MarkerModel[] = [];
  for (const item of items) {
    const point = pointOf(item);
    if (!point) continue;
    markers.push({
      id: item.id,
      point,
      kind: item.kind,
      score: item.match.score,
      label: labelOf(item),
    });
  }
  return markers;
}

/** Zoom that fits the searched radius, shared so both maps open the same way. */
export function zoomForRadius(radiusKm: number): number {
  if (radiusKm > 100) return 7;
  if (radiusKm > 40) return 8.5;
  return 10;
}

export function markerTitle(marker: MarkerModel): string {
  return `${marker.label} — ${Math.round(marker.score)}%`;
}

export function markerAriaLabel(marker: MarkerModel): string {
  return `${marker.label}, ${Math.round(marker.score)} percent match`;
}
