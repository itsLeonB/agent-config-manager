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
// would otherwise whitelist itself. So the origin of the URL this server actually received,
// plus the operator-configured PUBLIC_ORIGIN, which is what makes a proxied deployment work.
export function allowedOrigins(request: Request): string[] {
  const origins = [new URL(request.url).origin]
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
