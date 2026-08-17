import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const noIndex = process.env.PUBLIC_ROBOTS_NOINDEX !== 'false';

  return {
    rules: noIndex
      ? { userAgent: '*', disallow: '/' }
      : {
          userAgent: '*',
          allow: '/',
          disallow: ['/admin/', '/api/', '/research/'],
        },
  };
}
