#!/bin/bash
# wechat-archiver 一键部署脚本
# 部署到 Cloud Run，复用现有 VPC Connector（固定出口 IP 35.233.194.33）
set -e

PROJECT_ID="gen-lang-client-0884226164"
SERVICE_NAME="wechat-archiver"
REGION="us-west1"
IMAGE="gcr.io/$PROJECT_ID/$SERVICE_NAME"
BUCKET="wechat-archiver-state"

echo "======================================"
echo "  wechat-archiver 部署脚本"
echo "======================================"

# 1. 创建 GCS 状态存储桶（用于保存拉取进度）
echo ""
echo "📦 [1/4] 创建 GCS 状态桶 gs://$BUCKET ..."
gsutil mb -p $PROJECT_ID -l $REGION "gs://$BUCKET" 2>/dev/null \
  && echo "✅ 桶已创建" \
  || echo "ℹ️  桶已存在，跳过"

# 把当前进度文件上传到 GCS（首次部署用，避免从头重跑）
if [ -f "data/archiving_seq.json" ]; then
  echo "📤 上传初始 seq 文件到 GCS ..."
  gsutil cp data/archiving_seq.json "gs://$BUCKET/archiver_seq.json"
  echo "✅ 初始 seq 已上传"
fi

# 2. 构建镜像
echo ""
echo "🐳 [2/4] 构建并推送 Docker 镜像 ..."
gcloud builds submit \
  --tag "$IMAGE" \
  --project "$PROJECT_ID" \
  .

# 3. 读取 .env 并注入（排除注释和空行）
echo ""
echo "⚙️  [3/4] 读取 .env 配置 ..."
if [ ! -f ".env" ]; then
  echo "❌ .env 文件不存在，请先复制 .env.example 并填写"
  exit 1
fi

ENV_VARS=$(grep -v '^#' .env | grep -v '^[[:space:]]*$' | tr '\n' ',' | sed 's/,$//')
ENV_VARS="${ENV_VARS},STATE_BUCKET=${BUCKET}"

# 4. 部署到 Cloud Run
echo ""
echo "🚀 [4/4] 部署到 Cloud Run ($REGION) ..."
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --memory 512Mi \
  --cpu 1 \
  --vpc-connector wechat-connector \
  --vpc-egress all-traffic \
  --set-env-vars "$ENV_VARS"

echo ""
echo "======================================"
echo "✅ 部署完成！"
echo ""
echo "查看实时日志："
echo "  gcloud logging read 'resource.labels.service_name=\"$SERVICE_NAME\"' \\"
echo "    --project $PROJECT_ID --limit 50 --freshness=1h"
echo ""
echo "查询所有客户消息："
echo "  gcloud logging read 'resource.labels.service_name=\"$SERVICE_NAME\" AND jsonPayload.type=\"wechat_message\"' \\"
echo "    --project $PROJECT_ID --limit 100 --format json"
echo "======================================"
