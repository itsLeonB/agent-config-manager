// A mutating request is trusted only when the browser names one of this site's own origins,
// or when it carries no origin at all and the browser itself marked the request same-origin
// (Sec-Fetch-Site is set by the browser; a page cannot forge it for a cross-site POST).
export function isSameOriginRequest(
  origin: string | null,
  secFetchSite: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (origin !== null) return allowedOrigins.includes(origin)
  return secFetchSite === 'same-origin'
}

// The allowlist may only hold values a foreign page cannot supply. Forwarded headers cannot
// be used: a foreign page sends its own Origin alongside matching x-forwarded-* headers and
// would otherwise whitelist itself. So the URL this server received is trusted only when it
// addresses a loopback host, and PUBLIC_ORIGIN covers every other deployment (a proxy, a LAN
// address): a non-loopback request has to match the configured value, since the Host it
// carries is not proof of anything on its own.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function allowedOrigins(request: Request): string[] {
  const received = new URL(request.url)
  const origins: string[] = []
  if (LOOPBACK_HOSTS.has(received.hostname)) origins.push(received.origin)
  const configured = process.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, '')
  if (configured !== undefined && configured !== '') origins.push(configured)
  return origins
}

// Shared by every mutating server function (rescan, save settings): the scanner runs
// configured commands as shell commands, so no foreign page may reach those writes.
export function isSameOriginMutationRequest(request: Request): boolean {
  return isSameOriginRequest(
    request.headers.get('origin'),
    request.headers.get('sec-fetch-site'),
    allowedOrigins(request),
  )
}
