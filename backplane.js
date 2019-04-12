const fs = require('fs')
const path = require('path')
const util = require('util')
const { spawn } = require('child_process')
const execFile = util.promisify(require('child_process').execFile)
const mkdirp = require('mkdirp')
const tempy = require('tempy')
const ipfsClient = require('ipfs-http-client')
const configTemplate = require('./go-ipfs-config.json')

require('dotenv').config()

const IPFS_BIN = './node_modules/@jimpick/go-ipfs-dep/go-ipfs/ipfs'
const repoDir = path.resolve(process.cwd(), 'ipfs-repo')

function log (...args) {
  console.log('pinner backplane:', ...args)
}

function checkEnv (key, message) {
  if (!process.env[key]) {
    console.error(`Need ${key} in environment`)
    process.exit(1)
  }
}

async function create () {
  mkdirp.sync(repoDir)
  const generatedConfig = tempy.file()
  checkEnv('PEER_ID', 'Need PEER_ID')
  checkEnv('PRIV_KEY', 'Need PRIV_KEY')
  configTemplate.Identity.PeerId = process.env.PEER_ID
  configTemplate.Identity.PrivKey = process.env.PRIV_KEY
  for (let i = 1; i <= 9; i++) {
    const bootstrap = process.env[`BOOTSTRAP${i}`]
    if (bootstrap) {
      configTemplate.Bootstrap.push(bootstrap)
    }
  }
  if (process.env.WEBSOCKET_ANNOUNCE_HOST) {
    const port = process.env.PORT || 3001
    configTemplate.Addresses.Announce.push(
      `/dns4/${process.env.WEBSOCKET_ANNOUNCE_HOST}/tcp/${port}/ws`
    )
    configTemplate.Addresses.Swarm.push('/ip4/0.0.0.0/tcp/24002/ws')
  }
  fs.writeFileSync(generatedConfig, JSON.stringify(configTemplate, null, 2))
  const { stdout } = await execFile(
    IPFS_BIN, [ 'init', generatedConfig ],
    { env: { 'IPFS_PATH': repoDir } }
  )
}

const ready = async function () {
  if (!fs.existsSync(repoDir)) {
    log('Create IPFS repo')
    await create()
  }

  log('Run IPFS')
  await new Promise((resolve, reject) => {
    const ipfsProcess = spawn(IPFS_BIN, [ 'daemon' ], {
      env: { 'IPFS_PATH': repoDir }
    })
    ipfsProcess.stdout.on('data', data => {
      process.stdout.write(data)
      const lines = `${data}`.split('\n')
      if (lines.find(line => line.startsWith('Daemon is ready'))) {
        resolve()
      }
    })
    ipfsProcess.stderr.on('data', data => {
      process.stdout.write(data)
    })
    process.on('exit', () => {
      ipfsProcess.kill()
    })
  })

  //console.log('Lookup IPNS')
  const ipfs = ipfsClient('/ip4/127.0.0.1/tcp/25001')
  return ipfs
}()

async function tunnel (clusterPeerId) {
  const { stdout } = await execFile(
    IPFS_BIN, [
      'p2p',
      'forward',
      '--allow-custom-protocol',
      '/libp2p-http',
      `/ip4/127.0.0.1/tcp/29097`,
      `/ipfs/${clusterPeerId}`
    ],
    { env: { 'IPFS_PATH': repoDir } }
  )
  log(stdout)
}

module.exports = {
  ready,
  tunnel
}


