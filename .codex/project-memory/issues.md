# Known Issues

- Reverse-proxy/Cloudflare route validation is external to this repository and remains a release gate.
- `.env` still uses a localhost `PUBLIC_BASE_URL`; set the final public HTTPS origin when the reverse-proxy hostname is assigned.
