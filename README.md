# peer-base-pinner
A pinner for peer-base ... backup collaborations using IPFS, IPLD, IPNS + ipfs-cluster

### Initial Setup
```bash
$ IPFS_HOME=/tmp/peer-base-pinner ipfs init
$ cat << EOF > .env
# Expose a websocket proxy (optional)
WEBSOCKET_ANNOUNCE_HOST=my-peer-base-pinner.herokuapp.com
WEBSOCKET_EXTERNAL_PORT=80
## Starts a proxy and listens on /dns4/<host>/tcp/80/ws/ipfs/<backplane-peer-id>

# The IPFS cluster
BOOTSTRAP1=/dns4/example.com/tcp/9097/ipfs/QmXXX

# Set IPNS_MODE to init on first run, then load
IPNS_MODE=init

# ipfs-cluster stuff
IPFS_CLUSTER_API=/dns4/example.com/tcp/9097/ipfs/QmXXX
IPFS_CLUSTER_LABEL=some-label
IPFS_CLUSTER_USER=jimpick
IPFS_CLUSTER_PASSWORD=iloveipfs

# Create a new Peer Id and private key (from /tmp/peer-base-pinner/config)
PEER_ID=QmYYY
PRIV_KEY=ZZZZZZZZZ....=
EOF
$ heroku maintenance:on
$ heroku plugins:install heroku-config
$ heroku config:push
$ heroku maintenance:off
# wait for it to start up
$ heroku config:set IPNS_MODE=load
```
