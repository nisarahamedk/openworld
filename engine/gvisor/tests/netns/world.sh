#!/bin/sh
# Runs INSIDE one sandbox: 15 services that all listen on port 8080, each in its
# own network namespace, joined by a bridge, reachable by name (svc1..svc15).
set -e
N=${N:-15}
ip link add br0 type bridge
ip addr add 10.0.0.1/24 dev br0
ip link set br0 up
ip link set lo up
for i in $(seq 1 $N); do
  # A process that waits in a fresh network namespace; the service runs there.
  unshare -n sh -c "sleep 1; while [ ! -f /tmp/net$i ]; do sleep 0.05; done; ip link set lo up; \
    exec python3 -c 'import http.server as h,socket
class H(h.BaseHTTPRequestHandler):
    def do_GET(s):
        b=f\"svc$i on {socket.gethostname()} port 8080\".encode(); s.send_response(200); s.end_headers(); s.wfile.write(b)
    def log_message(s,*a): pass
h.HTTPServer((\"0.0.0.0\",8080),H).serve_forever()'" &
  pid=$!
  sleep 0.1
  ip link add h$i type veth peer name c$i
  ip link set c$i netns /proc/$pid/ns/net   # moving by pid is not supported in gVisor; by namespace file works
  ip link set h$i master br0 up
  nsenter -t $pid -n ip addr add 10.0.0.$((10+i))/24 dev c$i
  nsenter -t $pid -n ip link set c$i up
  nsenter -t $pid -n ip route add default via 10.0.0.1
  echo "10.0.0.$((10+i)) svc$i" >> /etc/hosts
  touch /tmp/net$i
done
sleep 2
ok=0
for i in $(seq 1 $N); do
  r=$(python3 -c "import urllib.request;print(urllib.request.urlopen('http://svc$i:8080',timeout=5).read().decode())" 2>&1) && ok=$((ok+1))
  echo "$r"
done
echo "reachable: $ok/$N"
echo "time skip still works: sleeping one day..."
t0=$(date +%s); sleep 86400; echo "slept $(( $(date +%s) - t0 ))s of world time"
