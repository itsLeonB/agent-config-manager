// A mutating request is trusted only when the browser names this site's origin, or when
// it carries no origin at all and the browser itself marked the request same-origin
// (Sec-Fetch-Site is set by the browser; a page cannot forge it for a cross-site POST).
export function isSameOriginRequest(
  origin: string | null,
  secFetchSite: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (origin !== null) return allowedOrigins.includes(origin)
  return secFetchSite === 'same-origin'
}

// Behind Dokploy the request reaches us as an internal host, so the proxy's forwarded
// host and protocol are accepted as this site's own origin too.
export function allowedOrigins(request: Request): string[] {
  const url = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
  const host = forwardedHost !== undefined && forwardedHost !== '' ? forwardedHost : request.headers.get('host')
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
  const proto = forwardedProto !== undefined && forwardedProto !== '' ? forwardedProto : url.protocol.slice(0, -1)
  const origins = [url.origin]
  if (host !== null) origins.push(`${proto}://${host}`)
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
