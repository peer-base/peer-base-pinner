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

const IPFS_BIN = './node_modules/go-ipfs-dep/go-ipfs/ipfs'
const repoDir = path.resolve(process.cwd(), 'ipfs-repo')

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
  fs.writeFileSync(generatedConfig, JSON.stringify(configTemplate, null, 2))
  const { stdout } = await execFile(
    IPFS_BIN, [ 'init', generatedConfig ],
    { env: { 'IPFS_PATH': repoDir } }
  )
}

const ready = async function () {
  if (!fs.existsSync(repoDir)) {
    console.log('Create IPFS repo')
    await create()
  }

  console.log('Run IPFS')
  await new Promise((resolve, reject) => {
    const ipfsProcess = spawn(IPFS_BIN, [ 'daemon' ], {
      env: { 'IPFS_PATH': repoDir }
    })
    ipfsProcess.stdout.on('data', data => {
      console.log(`stdout: ${data}`)
      if (`${data}`.startsWith('Daemon is ready')) {
        resolve()
      }
    })
    ipfsProcess.stderr.on('data', data => {
      console.log(`stderr: ${data}`)
    })
  })

  //console.log('Lookup IPNS')
  const ipfs = ipfsClient('/ip4/127.0.0.1/tcp/25001')
  return ipfs
}()

module.exports = {
  ready
}


