export function loadConfig(env) {
  const token = (env.WEBSNAP_TOKEN ?? '').trim()
  if (token === '') {
    throw new Error('WEBSNAP_TOKEN is required: set it to the bearer token clients must present. Refusing to start.')
  }
  const port = env.PORT !== undefined ? Number(env.PORT) : 8080
  return {
    port,
    token,
    allowPrivateAddresses: env.ALLOW_PRIVATE_ADDRESSES === 'true',
  }
}
