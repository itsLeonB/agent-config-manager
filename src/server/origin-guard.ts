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
