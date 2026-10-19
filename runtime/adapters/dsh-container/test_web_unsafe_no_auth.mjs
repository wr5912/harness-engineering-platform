import assert from 'node:assert/strict'
import { apply } from './web-unsafe-no-auth/index.js'
import { readFileSync } from 'node:fs'

const original = {
  admit: () => ({ rejection: 403 }),
  browserPeer: { id: 'native-owner-peer' },
  requestRejection: () => 403,
  authorizeIndex: () => false,
  authenticatedUrl: (url) => `${url}?token=existing`,
}
const connection = Object.create(original)
let dispose
let injectIndex
apply({ connection, on: (event, listener) => {
  assert.equal(event, 'webserver/index-inject')
  injectIndex = listener
}, effect: (setup) => { dispose = setup() } })
const rows = []
injectIndex(rows)
assert.deepEqual(rows, [{ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } }])
assert.equal(connection.requestRejection({ headers: { host: 'evil.invalid' } }), undefined)
assert.deepEqual(connection.admit({ headers: { host: 'evil.invalid' } }), { peer: original.browserPeer })
assert.equal(connection.authorizeIndex({}, {}), true)
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080/')
dispose()
assert.equal(connection.requestRejection({}), 403)
assert.deepEqual(connection.admit({}), { rejection: 403 })
assert.equal(connection.authorizeIndex({}, {}), false)
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080/?token=existing')

apply({ connection, webServer: { publicPath: path => path.startsWith('/assistant/') ? path : '/assistant' + path },
  on: () => {}, effect: setup => { dispose = setup() } })
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080/assistant/')
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080/assistant/'), 'http://127.0.0.1:3080/assistant/')
dispose()

const manifest = JSON.parse(readFileSync(new URL('./web-unsafe-no-auth/package.json', import.meta.url)))
assert.ok(manifest.name && manifest.version)
assert.equal(manifest.dsh, undefined)
assert.equal(manifest.exports['./client'], undefined)
