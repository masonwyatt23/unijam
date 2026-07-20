export function sameOriginBrowserHeaders(origin, additionalHeaders = {}) {
  const targetOrigin = new URL(origin).origin;
  return {
    ...additionalHeaders,
    Origin: targetOrigin,
    "Sec-Fetch-Site": "same-origin",
  };
}
