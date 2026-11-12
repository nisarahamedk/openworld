#!/usr/bin/env bash
# bundle.sh DIR [--netns] -- CMD ARGS...
# Writes an OCI bundle at DIR that runs CMD as root on the host's own root
# filesystem (gVisor gives it a private in-memory overlay), with a private /tmp.
set -eu
dir=$1; shift
netns=""
if [ "$1" = "--netns" ]; then netns=',{"type":"network"}'; shift; fi
[ "$1" = "--" ] && shift
mkdir -p "$dir"
args=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")
caps='["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_SETUID","CAP_SETGID","CAP_KILL","CAP_NET_ADMIN","CAP_SYS_ADMIN"]'
cat > "$dir/config.json" <<JSON
{"ociVersion":"1.0.0",
 "process":{"user":{"uid":0,"gid":0},"args":$args,
  "env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","HOME=/root"],"cwd":"/",
  "capabilities":{"bounding":$caps,"effective":$caps,"permitted":$caps}},
 "root":{"path":"/","readonly":false},"hostname":"world",
 "mounts":[{"destination":"/proc","type":"proc","source":"proc"},
           {"destination":"/tmp","type":"tmpfs","source":"tmpfs"},
           {"destination":"/dev/shm","type":"tmpfs","source":"tmpfs"}],
 "linux":{"namespaces":[{"type":"pid"},{"type":"ipc"},{"type":"uts"},{"type":"mount"}$netns]}}
JSON
