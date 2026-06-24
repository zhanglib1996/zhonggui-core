# Sandbox Docker Image

Builds a CubeSandbox-compatible image with Node.js v22 + @zhonggui/agent-core.

## Build

```bash
# 1. Download Node.js binary
curl -o /tmp/node.tar.xz https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz

# 2. Build agent-core
cd ../../ && npm run build --workspace packages/agent-core

# 3. Copy dist + build image
cp dist/index.js /tmp/sandbox-build/
cp package.json /tmp/sandbox-build/
cp /tmp/node.tar.xz /tmp/sandbox-build/
docker build -t localhost:5000/sandbox-agent:v0.1.0 /tmp/sandbox-build
docker push localhost:5000/sandbox-agent:v0.1.0

# 4. Create CubeSandbox template
cubemastercli tpl create-from-image \
  --image localhost:5000/sandbox-agent:v0.1.0 \
  --writable-layer-size 1G \
  --expose-port 49999 --expose-port 49983

# 5. Test
python3 test_sandbox_agent.py
```

## Contents

- Node.js v22.11.0
- nanoid v5.0.0 (stub)
- @zhonggui/agent-core v0.3.0 (42 exports)
