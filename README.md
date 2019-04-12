# peer-base-pinner
A pinner for peer-base ... backup collaborations using IPFS, IPLD, IPNS + ipfs-cluster

### Initial Setup
```bash
$ IPFS_HOME=/tmp/peer-base-pinner ipfs init
$ cat << EOF > .env
# Expose a websocket proxy (optional)
WEBSOCKET_ANNOUNCE_HOST=peer-base-pinner.example.com
WEBSOCKET_EXTERNAL_PORT=8080
## Starts a proxy and announces it as /dns4/<host>/tcp/<port>/ws/ipfs/<backplane-peer-id>
##
## If running on a platform such as Heroku that requires a 'Host' header in
## order to route to the correct app, and because it is not currently possible
## to embed 'Host' headers in multiaddrs, it maybe be necessary to manually
## proxy through an additional layer (such as nginx) in order to add the
## 'Host header. See: https://github.com/multiformats/multiaddr/issues/63
## An example nginx config is shown below.

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

### Example nginx websocket proxy to add Host header

```
server {
    listen 8080;
    server_name peer-pad-pinner.example.com;
    location / {
        proxy_pass http://peer-pad-pinner.herokuapp.com:80;
        proxy_cache_bypass $http_upgrade;
        proxy_http_version 1.1;
        proxy_set_header Host "peer-pad-pinner.herokuapp.com:80";
        proxy_set_header Origin "http://peer-pad-pinner.herokuapp.com:80";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
     }
}
```
