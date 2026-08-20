const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#0f0f0f"/><path fill="#f36e24" d="M14 14h36v9H25v7h20v8H25v12H14z"/></svg>`;

export function GET(): Response {
  return new Response(faviconSvg, {
    headers: {
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': 'image/svg+xml',
    },
  });
}
