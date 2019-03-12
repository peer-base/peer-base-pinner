const assert = require('assert')
const fs = require('fs')
const path = require('path')
const util = require('util')
const { spawn } = require('child_process')
const execFile = util.promisify(require('child_process').execFile)
const mkdirp = require('mkdirp')
const tempy = require('tempy')
const configTemplate = require('./go-ipfs-config.json')

require('dotenv').config()

const IPFS_BIN = './node_modules/go-ipfs-dep/go-ipfs/ipfs'
const repoDir = path.resolve(process.cwd(), 'ipfs-repo')

async function create () {
  mkdirp.sync(repoDir)
  const generatedConfig = tempy.file()
  assert(process.env.PEER_ID, 'Need PEER_ID')
  assert(process.env.PRIV_KEY, 'Need PRIV_KEY')
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
  const ipfsProcess = spawn(IPFS_BIN, [ 'daemon' ], {
    env: { 'IPFS_PATH': repoDir },
    stdio: 'inherit'
  })
  console.log('Lookup IPNS')
}()

module.exports = {
  ready
}


