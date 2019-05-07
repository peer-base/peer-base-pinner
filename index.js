/* eslint no-console: "off" */
'use strict'

const fs = require('fs')
const debug = require('debug')('peer-pad:pinner')
const EventEmitter = require('events')
const Collaboration = require('peer-base/src/collaboration')
const IPFS = require('peer-base/src/transport/ipfs')
const PeerCountGuess = require('peer-base/src/peer-count-guess')
const { decode, encode } = require('delta-crdts-msgpack-codec')
const CID = require('cids')
const debounce = require('lodash.debounce')
const delay = require('delay')
const PQueue = require('p-queue')
const backplane = require('./backplane')
const cluster = require('./ipfs-cluster-api')

const defaultOptions = {
  collaborationInactivityTimeoutMS: 5 * 60 * 1000
  // collaborationInactivityTimeoutMS: 30 * 1000
}

function log (...args) {
  console.log('pinner:', ...args)
}

function logConnection (...args) {
  console.log('pinner cnxn:', ...args)
}

function logCollab (...args) {
  console.log('pinner collab:', ...args)
}

class AppPinner extends EventEmitter {
  constructor (name, options) {
    super()
    this.name = name
    if (!name) {
      throw new Error('pinner should have app name')
    }
    this._options = Object.assign({}, defaultOptions, options)
    this._peerCountGuess = new PeerCountGuess(
      this,
      options && options.peerCountGuess
    )
    this._collaborations = new Map()
    this._starting = null

    this._onGossipMessage = this._onGossipMessage.bind(this)
    this.lastCid = null
  }

  start () {
    if (this._starting) {
      return this._starting
    }

    this._starting = backplane.ready.then(backplaneIpfs => {
      this.backplaneIpfs = backplaneIpfs
      return new Promise((resolve, reject) => {
        const getIdAndAddresses = cb => {
          this.backplaneIpfs.id((err, identity) => {
            if (err) {
              logConnection('Error', err)
              return cb && cb(err)
            }
            this.backplaneId = identity.id
            this.backplaneAddresses = identity.addresses
            logConnection('Backplane Peer Id:', this.backplaneId)
            logConnection('Backplane Peer Addresses:')
            for (const address of this.backplaneAddresses) {
              logConnection(`  ${address}`)
            }
            cb && cb()
          })
        }
        getIdAndAddresses(err => {
          if (err) return reject(err)
          // Periodically poll to get updated addresses (might
          // change thanks to autorelay)
          setInterval(getIdAndAddresses, 2 * 60 * 1000)
          resolve()
        })
      })
    })
    .then(async () => {
      // If connecting to ipfs-cluster via libp2p, setup a p2p tunnel
      // See: https://github.com/ipfs-shipyard/peer-base-pinner/issues/5
      const apiAddr = process.env.IPFS_CLUSTER_API
      const match = apiAddr.match(/^\/ip[46]\/[^/]+\/tcp\/\d+\/ipfs\/([^/]+)$/)
      if (match) {
        // swarm connect
        const clusterPeerId = match[1]
        const connect = this.backplaneIpfs.swarm.connect
        log(`connecting to ipfs-cluster via ${apiAddr} ...`)
        const res = await connect(apiAddr)
        log('connected')
        log('configuring libp2p tunnel to ipfs-cluster')
        await backplane.tunnel(clusterPeerId)
        cluster.useTunnel()
      }
    })
    .then(() => {
      // Try to connect to custom bootstrap servers in a loop
      const interval = 60 * 1000
      const connect = this.backplaneIpfs.swarm.connect
      function connector (addr) {
        return async () => {
          try {
            logConnection(`connecting to ${addr} ...`)
            const res = await connect(addr)
            logConnection(`connected to ${addr}`)
          } catch (e) {
            logConnection(`failed connect to ${addr}`, e)
          }
        }
      }
      for (let i = 1; i <= 9; i++) {
        const addr = process.env[`BOOTSTRAP${i}`]
        if (addr) {
          connector(addr)()
          setInterval(connector(addr), interval)
        }
      }
    })
    .then(async () => {
      if (
        process.env.LOAD_FROM
      ) {
        try {
          const hash = process.env.LOAD_FROM
          log('Loading docIndex from IPFS', hash)
          const start = Date.now()
          const result = await this.backplaneIpfs.dag.get(hash)
          const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
          this.docIndex = result.value
          log(`docIndex loaded ${elapsed}, version ${this.docIndex._version}`)
          this.lastCid = hash
          this.lastPinnedCid = hash
        } catch (e) {
          log('Exception during initial load', e)
          process.exit(1)
        }
      } else {
        this.docIndex = {
          _created: Date.now(),
          _version: 1
        }
        this.indexCid = await this.backplaneIpfs.dag.put(this.docIndex)
        const cidBase58 = this.indexCid.toBaseEncodedString()
        log('DocIndex CID (blank):', cidBase58)
        this.pin(cidBase58)
        log('\nSet LOAD_FROM=<hash>')
        log('and restart to continue')
        while (true) {
          await delay(60 * 1000) // Infinite loop
        }
      }
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        log('starting js-ipfs')
        const ipfsOptions = (this._options && this._options.ipfs) || {}
        this.ipfs = IPFS(this, ipfsOptions)
        this.ipfs.on('error', (err) => this._handleIPFSError(err))
        if (this.ipfs.isOnline()) {
          log('started js-ipfs')
          resolve()
        } else {
          this.ipfs.once('ready', () => {
            log('started js-ipfs')
            resolve()
          })
        }
      })
    })
    .then(() => {
      this._peerCountGuess.start()
      log(`pinner for ${this.name} started`)
      setTimeout(() => {
        this.ipfs.swarm.connect(
          `/ip4/127.0.0.1/tcp/24001/ipfs/${this.backplaneId}`
        )
      }, 10000) // FIXME: Need something more reliable
    })

    return this._starting
  }

  async peerId () {
    return (await this.ipfs.id()).id
  }

  gossip (message) {
    if (this._gossip) {
      this._gossip.broadcast(message)
    }
  }

  setGossip (gossip) {
    this._gossip = gossip
    gossip.on('message', this._onGossipMessage)
  }

  setGlobalConnectionManager (globalConnectionManager) {
    this._globalConnectionManager = globalConnectionManager
    this.emit('global connection manager', globalConnectionManager)
  }

  getGlobalConnectionManager () {
    return this._globalConnectionManager
  }

  setTransportConnectionManager (connMgr) {
    this.transportConnectionManager = connMgr
  }

  peerCountGuess () {
    return this._peerCountGuess.guess()
  }

  peerCountEstimate () {
    return this.peerCountGuess()
  }

  async _onGossipMessage (message) {
    // debug('gossip message from %s', message.from)
    this.emit('gossip', message)
    const peerInfo = await this.ipfs.id()
    if (message.from === peerInfo.id) {
      return
    }
    let collaborationName, membership, type
    try {
      [collaborationName, membership, type] = decode(message.data)
    } catch (err) {
      log('error parsing gossip message:', err)
      return
    }
    if (collaborationName.startsWith('_')) {
      log('forbidden collaboration name: ' + collaborationName)
      return
    }

    let collaboration
    if (this._collaborations.has(collaborationName)) {
      collaboration = this._collaborations.get(collaborationName)
    } else {
      debug('new collaboration %s of type %s', collaborationName, type)
      logCollab('New:', collaborationName)
      if (type) {
        collaboration = this._addCollaboration(collaborationName, type)
        await collaboration.start()
        this.emit('collaboration started', collaboration)
        this.loadBackupsFromIpfs(collaborationName)
      }
    }
    collaboration.deliverRemoteMembership(membership).catch((err) => {
      log('error delivering remote membership:', err)
    })
  }

  _addCollaboration (name, type) {
    debug('adding collaboration %j of type %j', name, type)
    const options = {
      replicateOnly: true,
      receiveTimeoutMS: 6000
    }
    const collaboration = Collaboration(
      true,
      this.ipfs,
      this._globalConnectionManager,
      this,
      name,
      type,
      options
    )
    this._collaborations.set(name, collaboration)

    const onInactivityTimeout = () => {
      debug('collaboration %j timed out. Removing it...', name, type)
      logCollab('Timed out:', name)
      collaboration.removeListener('state changed', onStateChanged)
      this._collaborations.delete(name)

      collaboration.stop()
        .then(() => {
          this.emit('collaboration stopped', collaboration)
        })
        .catch((err) => {
          log('error stopping collaboration ' + name + ':', err)
        })
    }

    let activityTimeout

    const resetActivityTimeout = () => {
      if (activityTimeout) {
        clearTimeout(activityTimeout)
      }
      activityTimeout = setTimeout(
        onInactivityTimeout,
        this._options.collaborationInactivityTimeoutMS
      )
    }

    const onStateChanged = async () => {
      debug('state changed in collaboration %s', name)

      try {
        const fqn = collaboration.fqn()
        const delta = collaboration.shared.stateAsDelta()
        const clock = delta[1]
        const version = this.docIndex._version + 1

        log('Saving state:', fqn)
        Object.keys(clock).sort().forEach(key => {
          log(`  ${key}: ${clock[key]}`)
        })

        const opts = { 'cid-version': 1 }
        const encoded = encode(delta)
        // log('Write main:', encoded)
        const res = await this.backplaneIpfs.add(encoded, opts)
        if (res.length !== 1) throw new Error('Expected length 1')
        /*
        try {
          log('Test decode:', res[0].hash, decode(encoded))
          log('Encoded length:', encoded.length)
        } catch (e) {
          log('Test decode failed:', e)
        }
        */
        const mainCid = new CID(res[0].hash)
        this.docIndex[fqn] = {
          main: mainCid,
          clock,
          date: Date.now(),
          subs: {},
          version
        }

        for (let name of collaboration._subs.keys()) {
          const sub = collaboration._subs.get(name)
          const subDelta = sub.shared.stateAsDelta()
          const encoded = encode(subDelta)
          const res = await this.backplaneIpfs.add(encoded, opts)
          if (res.length !== 1) throw new Error('Expected length 1')
          const cid = new CID(res[0].hash)
          this.docIndex[fqn].subs[name] = {
            type: sub.typeName,
            cid
          }
        }
        this.docIndex._version = version
        this.indexCid = await this.backplaneIpfs.dag.put(this.docIndex)
        const cidBase58 = this.indexCid.toBaseEncodedString()
        log('DocIndex CID (updated):', cidBase58)
        this.pin(cidBase58)
        resetActivityTimeout()
      } catch (e) {
        log('Exception during update:', e)
      }
    }

    const debouncedOnStateChanged = debounce(onStateChanged, 10 * 1000)

    collaboration.on('state changed', debouncedOnStateChanged)

    resetActivityTimeout()

    return collaboration
  }

  _handleIPFSError (err) {
    log(err)
  }

  async stop () {
    try {
      await Promise.all(
        Array.from(this._collaborations.values())
          .map(collaboration => collaboration.stop())
      )
    } catch (err) {
      log('error stopping collaborations:', err)
    }

    if (this._gossip) {
      this._gossip.removeListener('message', this._onGossipMessage)
    }
    this._collaborations.clear()
    this._peerCountGuess.stop()
    await this.ipfs.stop()
  }

  async pin (cidBase58) {
    this.pendingCid = cidBase58
    log('Queued', this.pendingCid)
    if (!this.queue) {
      this.queue = new PQueue({concurrency: 1})
    }
    this.queue.add(() => this.pinWorker())
  }

  async pinWorker () {
    const cidBase58 = this.pendingCid
    if (!cidBase58) return
    log('Pinning', cidBase58)
    this.pendingCid = null
    const prevCid = this.lastPinnedCid
    if (cidBase58 !== this.lastPinnedCid) {
      await cluster.pin(cidBase58, this.docIndex._version, this.backplaneId)
      this.lastPinnedCid = cidBase58
    }
    if (prevCid && prevCid !== cidBase58) {
      await cluster.unpin(prevCid)
    }
    log('Pinned', cidBase58)
    await delay(30000)
  }

  async loadBackupsFromIpfs (name) {
    const doc = this.docIndex[name]
    // FIXME: Check vector clock and skip if already applied
    if (doc) {
      const collaboration = this._collaborations.get(name)
      const get = this.backplaneIpfs.get
      try {
        logCollab(`Retrieving backups for`, name)
        // log('Main cid:', doc.main.toBaseEncodedString())
        const res = await get(doc.main)
        if (res.length !== 1) throw new Error('Expected length 1')
        // log('Read main:', res[0])
        // log('Main encoded length:', res[0].content.length)
        const delta = decode(res[0].content)
        collaboration.shared.apply(delta)
        for (const subName in doc.subs) {
          const subType = doc.subs[subName].type
          const subCid = doc.subs[subName].cid
          const sub = await collaboration.sub(subName, subType)
          // log('Sub cid:', subName, subType, subCid.toBaseEncodedString())
          const res = await get(subCid)
          if (res.length !== 1) throw new Error('Expected length 1')
          const delta = decode(res[0].content)
          sub.shared.apply(delta)
        }
        logCollab(`Backups loaded for`, name)
        // console.log(delta)
        /*
        const encodedDelta = line.slice(collaborationName.length + 1)
        const delta = decode(Buffer.from(encodedDelta, 'base64'))
        // console.log(delta)
        collaboration.shared.apply(delta)
        */
      } catch (e) {
        logCollab('Load Backup Exception:', e)
      }
    }
  }
}

module.exports = (appName, options) => {
  return new AppPinner(appName, options)
}
