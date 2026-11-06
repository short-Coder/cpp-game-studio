FROM emscripten/emsdk:3.1.64
RUN apt-get update && apt-get install -y curl git make && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 5.0 https://github.com/raysan5/raylib /opt/raylib \
 && cd /opt/raylib/src && emmake make PLATFORM=PLATFORM_WEB -j4
ENV EM_CACHE=/opt/emcache
RUN echo 'int main(){return 0;}' > /tmp/t.c && emcc /tmp/t.c -sUSE_GLFW=3 -o /tmp/t.js
WORKDIR /app
COPY backend/package.json ./
RUN npm install
COPY backend/ ./
RUN npm run build
RUN useradd -m app && mkdir -p /data /tmp/work && chown -R app /data /tmp/work /app && chmod -R a+rwX /opt/emcache
USER app
ENV DATA_DIR=/data
CMD ["node","dist/server.js"]
