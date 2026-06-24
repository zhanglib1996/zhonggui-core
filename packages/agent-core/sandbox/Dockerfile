FROM cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code:latest

COPY node.tar.xz /tmp/node.tar.xz
RUN python3 -c "import tarfile; t=tarfile.open('/tmp/node.tar.xz'); t.extractall('/tmp/ne', filter='fully_trusted'); t.close()" && \
    cp -r /tmp/ne/node-v22.11.0-linux-x64/* /usr/local/ && \
    rm -rf /tmp/node.tar.xz /tmp/ne && node --version

COPY nanoid-stub.js /tmp/nanoid-stub.js

RUN mkdir -p /opt/zhonggui-agent/node_modules/nanoid && \
    cp /tmp/nanoid-stub.js /opt/zhonggui-agent/node_modules/nanoid/index.js && \
    echo '{"name":"nanoid","version":"5.0.0","type":"module","main":"./index.js","exports":{".":"./index.js"}}' > /opt/zhonggui-agent/node_modules/nanoid/package.json

COPY index.js /opt/zhonggui-agent/
COPY package.json /opt/zhonggui-agent/

RUN cd /opt/zhonggui-agent && echo 'import("./index.js").then(m=>process.stdout.write(JSON.stringify(Object.keys(m))))' | node --input-type=module
