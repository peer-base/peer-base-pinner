/* eslint no-console: "off" */
'use strict'

const fs = require('fs')
const debug = require('debug')('peer-pad:pinner')
const EventEmitter = require('events')
const Collaboration = require('peer-base/src/collaboration')
const IPFS = require('peer-base/src/transport/ipfs')
const PeerCountGuess = require('peer-base/src/peer-count-guess')
const { decode, encode } = require('delta-crdts-msgpack-codec')

const defaultOptions = {
  collaborationInactivityTimeoutMS: 10000
}

class AppPinner extends EventEmitter {
  constructor (name, options) {
    super()
    this.name = name
    if (!name) {
      throw new Error('pinner should have app name')
    }
    this._options = Object.assign({}, defaultOptions, options)
    this._peerCountGuess = new PeerCountGuess(this, options && options.peerCountGuess)
    this._collaborations = new Map()
    this._starting = null

    this._onGossipMessage = this._onGossipMessage.bind(this)
  }

  start () {
    if (this._starting) {
      return this._starting
    }

    this._starting = new Promise((resolve, reject) => {
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
    }).then(() => {
      this._peerCountGuess.start()
      console.log('pinner for %j started', this.name)
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
              console.log(delta)
              collaboration.shared.apply(delta)
            }
          }
        } catch (e) {
          console.error('Exception:', e)
        }
        console.log('Jim new collab pinner state as delta', collaboration.shared.stateAsDelta())
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
    const collaboration = Collaboration(true, this.ipfs, this._globalConnectionManager, this, name, type, options)
    this._collaborations.set(name, collaboration)

    const onInactivityTimeout = () => {
      debug('collaboration %j timed out. Removing it...', name, type)
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
      activityTimeout = setTimeout(onInactivityTimeout, this._options.collaborationInactivityTimeoutMS)
    }

    const onStateChanged = () => {
      debug('state changed in collaboration %s', name)

      const fqn = collaboration.fqn()
      let backup = ''
      const delta = collaboration.shared.stateAsDelta()
      console.log('Jim changed pinner state as delta', delta)
      backup += `${fqn} ${encode(delta).toString('base64')}\n`
      for (let name of collaboration._subs.keys()) {
        const sub = collaboration._subs.get(name)
        const subDelta = sub.shared.stateAsDelta()
        console.log(` Sub ${name}:`, subDelta)
        backup += `${fqn}:${name} ${encode(subDelta).toString('base64')}\n`
      }
      fs.writeFileSync('./backup.txt', backup)

      resetActivityTimeout()
    }

    collaboration.on('state changed', onStateChanged)

    resetActivityTimeout()

    return collaboration
  }

  _handleIPFSError (err) {
    console.error(err)
  }

  async stop () {
    try {
      await Promise.all(Array.from(this._collaborations.values()).map((collaboration) => collaboration.stop()))
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
