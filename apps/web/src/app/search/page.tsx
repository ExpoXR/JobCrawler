import type { Metadata } from 'next';

import { SearchWorkspace } from '@/components/SearchWorkspace';

export const metadata: Metadata = { title: 'Search' };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const mode = params['mode'] === 'candidates' ? 'candidates' : 'jobs';

  return <SearchWorkspace mode={mode} />;
}
