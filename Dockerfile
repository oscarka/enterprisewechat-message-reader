# 使用 Node.js 18 完整版（native addon 可能需要额外系统库）
FROM node:18

WORKDIR /app

# 先拷贝依赖定义，利用 Docker 层缓存
COPY package*.json ./

# 安装依赖（wework-chat-node 包含 native addon，需要完整构建环境）
RUN npm install

# 拷贝源代码（不包括 .env，env 由 Cloud Run 注入）
COPY archiver.js .
COPY name_resolver.js .
COPY seq_store.js .
COPY supabase_store.js .
COPY cua_forwarder.js .
COPY message_debouncer.js .
COPY media_handler.js .
COPY diagnose_archiving.js .

# 拷贝 RSA 私钥（打包进镜像）
COPY data/ ./data/

# 启动
CMD ["node", "archiver.js"]
