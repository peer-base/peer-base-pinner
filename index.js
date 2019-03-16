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
const backplane = require('./backplane')

const defaultOptions = {
  collaborationInactivityTimeoutMS: 2 * 60 * 1000
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
              console.error('Error', err)
              return cb && cb(err)
            }
            this.backplaneId = identity.id
            this.backplaneAddresses = identity.addresses
            console.log('Backplane Peer Id:', this.backplaneId)
            console.log('Backplane Peer Addresses:')
            for (const address of this.backplaneAddresses) {
              console.log(`  ${address}`)
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
      if (
        process.env.LOAD_FROM_IPNS &&
        process.env.LOAD_FROM_IPNS != '0' &&
        process.env.LOAD_FROM_IPNS.toLowerCase() != 'false'
      ) {
        try {
          const ipnsPath = `/ipns/${this.backplaneId}`
          console.log('Resolving', ipnsPath)
          const name = await this.backplaneIpfs.resolve(ipnsPath)
          console.log('Resolved IPNS:', name)
          const hash = name.replace('/ipfs/', '')
          console.log('Loading docIndex from IPFS', hash)
          const result = await this.backplaneIpfs.dag.get(hash)
          this.docIndex = result.value
          console.log('docIndex loaded')
        } catch (e) {
          console.error('Exception during IPNS resolve', e)
          process.exit(1)
        }
      } else if (
        process.env.INIT_IPNS &&
        process.env.INIT_IPNS != '0' &&
        process.env.INIT_IPNS.toLowerCase() != 'false'
      ) {
        this.docIndex = {}
        this.indexCid = await this.backplaneIpfs.dag.put(this.docIndex)
        const cidBase58 = this.indexCid.toBaseEncodedString()
        console.log('DocIndex CID (blank):', cidBase58)
        try {
          const ipfsPath = `/ipfs/${cidBase58}`
          const name = await this.backplaneIpfs.name.publish(ipfsPath)
          const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
          const ipnsPath = `/ipns/${this.backplaneId}`
          console.log('IPNS updated:', ipnsPath, elapsed)
        } catch (e) {
          console.error('IPNS Exception:', e)
        }
        console.log('\nRemove INIT_IPNS, and set LOAD_FROM_IPNS=true')
        console.log('and restart to continue')
        while (true) {
          await delay(60 * 1000) // Infinite loop
        }
      } else {
        console.log('\nFirst, set INIT_IPNS=true to create empty index on IPNS,')
        console.log('and then set LOAD_FROM_IPNS=true to load it.')
        while (true) {
          await delay(60 * 1000) // Infinite loop
        }
      }
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        const ipfsOptions = (this._options && this._options.ipfs) || {}
        this.ipfs = IPFS(this, ipfsOptions)
        if (this.ipfs.isOnline()) {
          this.ipfs.on('error', (err) => this._handleIPFSError(err))
          resolve()
        } else {
          this.ipfs.once('ready', () => {
            this.ipfs.on('error', (err) => this._handleIPFSError(err))
            resolve()
          })
        }
      })
    })
    .then(() => {
      this._peerCountGuess.start()
      console.log('pinner for %j started', this.name)
      setTimeout(() => {
        this.ipfs.swarm.connect(
          `/ip4/127.0.0.1/tcp/24001/ipfs/${this.backplaneId}`
        )
      }, 10000) // FIXME: Need something more reliable

      // Try to connect to custom bootstrap servers in a loop
      const interval = 60 * 1000
      const connect = this.backplaneIpfs.swarm.connect
      if (process.env.BOOTSTRAP1) {
        setInterval(() => connect(process.env.BOOTSTRAP1), interval)
      }
      if (process.env.BOOTSTRAP2) {
        setInterval(() => connect(process.env.BOOTSTRAP2), interval)
      }
      if (process.env.BOOTSTRAP3) {
        setInterval(() => connect(process.env.BOOTSTRAP3), interval)
      }
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
      console.log('error parsing gossip message:', err)
      return
    }

    let collaboration
    if (this._collaborations.has(collaborationName)) {
      collaboration = this._collaborations.get(collaborationName)
    } else {
      debug('new collaboration %s of type %s', collaborationName, type)
      console.log('New:', collaborationName)
      if (type) {
        collaboration = this._addCollaboration(collaborationName, type)
        await collaboration.start()
        this.emit('collaboration started', collaboration)
        try {
          const backup = fs.readFileSync('./backup.txt', 'utf8')
          for (let line of backup.split('\n')) {
            if (line.startsWith(collaborationName + ' ')) {
              const encodedDelta = line.slice(collaborationName.length + 1)
              const delta = decode(Buffer.from(encodedDelta, 'base64'))
              // console.log(delta)
              collaboration.shared.apply(delta)
            }
          }
        } catch (e) {
          console.error('Exception:', e)
        }
        // console.log('Jim new collab pinner state as delta', collaboration.shared.stateAsDelta())
      }
    }
    collaboration.deliverRemoteMembership(membership).catch((err) => {
      console.error('error delivering remote membership:', err)
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
      console.log('Timed out:', name)
      collaboration.removeListener('state changed', onStateChanged)
      this._collaborations.delete(name)

      collaboration.stop()
        .then(() => {
          this.emit('collaboration stopped', collaboration)
        })
        .catch((err) => {
          console.error('error stopping collaboration ' + name + ':', err)
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

      const fqn = collaboration.fqn()
      let backup = ''
      const delta = collaboration.shared.stateAsDelta()
      const clock = delta[1]

      // console.log('Jim changed pinner state as delta', delta)
      backup += `${fqn} ${encode(delta).toString('base64')}\n`
      console.log('Saving state:', fqn, clock)

      const opts = { 'cid-version': 1 }
      const res = await this.backplaneIpfs.add(encode(delta), opts)
      if (res.length !== 1) throw new Error('Expected length 1')
      const mainCid = new CID(res[0].hash)
      this.docIndex[fqn] = {
        main: mainCid,
        clock,
        date: Date.now(),
        subs: {}
      }

      for (let name of collaboration._subs.keys()) {
        const sub = collaboration._subs.get(name)
        const subDelta = sub.shared.stateAsDelta()
        const res = await this.backplaneIpfs.add(encode(subDelta), opts)
        if (res.length !== 1) throw new Error('Expected length 1')
        const cid = new CID(res[0].hash)
        this.docIndex[fqn].subs[name] = cid

        // console.log(` Sub ${name}:`, subDelta)
        backup += `${fqn}:${name} ${encode(subDelta).toString('base64')}\n`
      }
      fs.writeFileSync('./backup.txt', backup)
      /*
      console.log(
        'Saved main delta to IPFS:',
        mainCid.toBaseEncodedString('base32')
      )
      */
      // console.log('Jim docIndex', this.docIndex)
      this.indexCid = await this.backplaneIpfs.dag.put(this.docIndex)
      const cidBase58 = this.indexCid.toBaseEncodedString()
      console.log('DocIndex CID (updated):', cidBase58)
      const ipfsPath = `/ipfs/${cidBase58}`
      console.log('Updating IPNS...', ipfsPath)
      const start = Date.now()
      try {
        const name = await this.backplaneIpfs.name.publish(ipfsPath)
        const elapsed = `(${((Date.now() - start) / 1000).toFixed(1)}s)`
        const ipnsPath = `/ipns/${this.backplaneId}`
        console.log('IPNS updated:', ipnsPath, elapsed)
      } catch (e) {
        console.error('IPNS Exception:', e)
      }

      resetActivityTimeout()
    }

    const debouncedOnStateChanged = debounce(onStateChanged, 500)

    collaboration.on('state changed', debouncedOnStateChanged)

    resetActivityTimeout()

    return collaboration
  }

  _handleIPFSError (err) {
    console.error(err)
  }

  async stop () {
    try {
      await Promise.all(
        Array.from(this._collaborations.values())
          .map(collaboration => collaboration.stop())
      )
    } catch (err) {
      console.error('error stopping collaborations:', err)
    }

    if (this._gossip) {
      this._gossip.removeListener('message', this._onGossipMessage)
    }
    this._collaborations.clear()
    this._peerCountGuess.stop()
    await this.ipfs.stop()
  }
}

module.exports = (appName, options) => {
  return new AppPinner(appName, options)
}
