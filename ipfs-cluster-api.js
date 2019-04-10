const delay = require('delay')
require('isomorphic-fetch')

let apiBase = process.env.IPFS_CLUSTER_API

const user = process.env.IPFS_CLUSTER_USER
const pw = process.env.IPFS_CLUSTER_PASSWORD
const auth = Buffer.from(`${user}:${pw}`).toString('base64')

function log (...args) {
  console.log('pinner cluster api:', ...args)
}

function useTunnel () {
  // Override when using libp2p tunnel
  apiBase = 'http://127.0.0.1:29097'
}

async function pin (cid) {
  const apiBaseUrl = new URL(apiBase)
  let name = 'peer-base-pinner'
  if (process.env.IPFS_CLUSTER_LABEL) {
    name += `: ${process.env.IPFS_CLUSTER_LABEL}`
  }
  const opts = `name=${encodeURIComponent(name)}`
  const apiPinAdd = new URL(`/pins/${cid}?${opts}`, apiBaseUrl)
  log(`pinning ${cid} to cluster`)
  const start = Date.now()
  const res = await fetch(
    apiPinAdd.href,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`
      }
    }
  )
  if (!res.ok) {
    log('Error:', res.status, res.statusText)
    throw new Error('Pin add failed')
  }
  const apiPinStatus = new URL(`/pins/${cid}`, apiBaseUrl)
  let count = 0
  while (true) {
    count++
    if ((count % 10) === 1) {
      const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
      log(`waiting for ${cid} status`, elapsed)
    }
    const res = await fetch(
      apiPinStatus.href,
      {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      }
    )
    if (!res.ok) {
      throw new Error('Pin status failed')
    }
    const json = await res.json()
    // log(JSON.stringify(json, null, 2))
    if (
      json.peer_map &&
      json.peer_map
    ) {
      const finished = Object.keys(json.peer_map).some(peerId => {
        const peer = json.peer_map[peerId]
        return peer.status === 'pinned'
      })
      if (finished) {
        const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
        log('pinned', cid, elapsed)
        break
      }
      const notPinning = Object.keys(json.peer_map).some(peerId => {
        const peer = json.peer_map[peerId]
        return (
          peer.status !== 'pinning' &&
          peer.status !== 'remote' &&
          peer.status !== 'unpinned' &&
          peer.status !== 'pin_error'
        )
      })
      if (notPinning) {
        const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
        log('Aborting ipfs-cluster pin', elapsed)
        log(JSON.stringify(json, null, 2))
        throw new Error('pinning failed')
      }
    }
    await delay(1000)
  }
}

async function unpin (cid) {
  const apiBaseUrl = new URL(apiBase)
  const apiPinRm = new URL(`/pins/${cid}`, apiBaseUrl)
  log(`unpinning ${cid} from cluster`)
  const res = await fetch(
    apiPinRm.href,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${auth}`
      }
    }
  )
  if (!res.ok) {
    throw new Error('Pin rm failed')
  }
}

module.exports = {
  useTunnel,
  pin,
  unpin
}
