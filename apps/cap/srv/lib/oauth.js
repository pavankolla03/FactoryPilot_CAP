const cds = require('@sap/cds')

/**
 * OAuth2 client-credentials token exchange for Integration Suite endpoints.
 *
 * Tokens are cached per endpoint until shortly before expiry. Without that,
 * every question would pay a second round trip to the auth server before it
 * even reaches the iFlow.
 *
 * The client id and secret are read from environment variables named by the
 * endpoint's `credentialRef` — never stored in the database. credentialRef
 * names a *pair*: `<REF>_CLIENT_ID` and `<REF>_CLIENT_SECRET`.
 */

const tokens = new Map() // endpointID -> { token, expiresAt }

class OAuthError extends Error {}

function credentialsFor(endpoint) {
  const ref = endpoint?.credentialRef
  if (!ref) return { error: 'No credentialRef set on this endpoint.' }
  const clientId = process.env[`${ref}_CLIENT_ID`]
  const clientSecret = process.env[`${ref}_CLIENT_SECRET`]
  const missing = [
    !clientId && `${ref}_CLIENT_ID`,
    !clientSecret && `${ref}_CLIENT_SECRET`,
  ].filter(Boolean)
  if (missing.length) {
    return { error: `Not set on the server: ${missing.join(' and ')}. Set them with cf set-env and restage.` }
  }
  return { clientId, clientSecret }
}

async function getToken(endpoint, { force = false } = {}) {
  const key = endpoint.ID || endpoint.url
  const cached = tokens.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.token

  const creds = credentialsFor(endpoint)
  if (creds.error) throw new OAuthError(creds.error)
  if (!endpoint.tokenUrl) throw new OAuthError('No tokenUrl set on this endpoint.')

  // Credentials go in the body, not the URL: a query string ends up in access
  // logs and proxy logs on every hop.
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs || 15000)
  let res
  try {
    res = await fetch(endpoint.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    throw new OAuthError(
      err.name === 'AbortError'
        ? `Token request timed out after ${endpoint.timeoutMs || 15000}ms`
        : `Token request failed: ${err.message}`
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // Deliberately does not echo the response body — a failed token exchange
    // can reflect the submitted credentials back.
    throw new OAuthError(
      `Auth server rejected the client credentials (HTTP ${res.status}). ` +
        'Check the client id/secret and that the service key has not been rotated.'
    )
  }

  const payload = await res.json()
  const token = payload.access_token
  if (!token) throw new OAuthError('Auth server returned no access_token')

  // Refresh a minute early rather than racing the expiry mid-request.
  const ttlSeconds = Math.max(60, Number(payload.expires_in) || 3600) - 60
  tokens.set(key, { token, expiresAt: Date.now() + ttlSeconds * 1000 })
  cds.log('oauth').info(`token acquired for endpoint ${endpoint.name || key}, valid ~${ttlSeconds}s`)
  return token
}

/** Drop a cached token — used when a call comes back 401 so the next attempt
 *  re-authenticates instead of replaying a revoked token. */
function invalidate(endpoint) {
  tokens.delete(endpoint.ID || endpoint.url)
}

function clear() {
  tokens.clear()
}

module.exports = { getToken, invalidate, clear, credentialsFor, OAuthError, _tokens: tokens }
