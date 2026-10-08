#!/bin/sh
# Kazumi Web —— Cloudflare Worker 一键部署
#
# 用法:
#   CF_TOKEN=xxx ./deploy_cf.sh <ACCOUNT_ID> [SCRIPT_NAME]
#
# ACCOUNT_ID 获取:登录 dash.cloudflare.com，地址栏里
#   https://dash.cloudflare.com/<这串32位字符>/...
# 或 Workers & Pages 页面右侧的 Account ID。
#
# 需要 Token 权限:Account → Workers Scripts → Edit

set -e

ACC="$1"
NAME="${2:-kazumi-proxy}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$ACC" ]; then
  echo "用法: CF_TOKEN=xxx $0 <ACCOUNT_ID> [SCRIPT_NAME]"
  exit 1
fi
if [ -z "$CF_TOKEN" ]; then
  echo "错误: 未设置 CF_TOKEN 环境变量"
  exit 1
fi
if [ ! -f "$DIR/proxy/worker.js" ]; then
  echo "错误: 找不到 $DIR/proxy/worker.js"
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/$ACC/workers"

j() {
  python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception as e:
    print('   无法解析响应:', e); sys.exit(0)
print('   ', '成功' if d.get('success') else '失败')
for e in (d.get('errors') or []):
    print('    error', e.get('code'), e.get('message'))
r = d.get('result')
if isinstance(r, dict):
    for k in ('id','subdomain','enabled'):
        if k in r: print('    %s: %s' % (k, r[k]))
"
}

echo "[1/3] 上传 Worker 脚本 ($NAME)..."
curl -s -X PUT "$API/scripts/$NAME" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata={\"main_module\":\"worker.js\"};type=application/json" \
  -F "worker.js=@$DIR/proxy/worker.js;type=application/javascript+module" | j

echo "[2/3] 启用 workers.dev 路由..."
curl -s -X POST "$API/scripts/$NAME/subdomain" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"previews_enabled":true}' | j

echo "[3/3] 查询账号子域名..."
SUB=$(curl -s "$API/subdomain" -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print(''); raise SystemExit
print((d.get('result') or {}).get('subdomain') or '')
")

if [ -n "$SUB" ]; then
  URL="https://$NAME.$SUB.workers.dev"
  echo
  echo "=========================================="
  echo "  部署完成"
  echo "  代理地址: $URL"
  echo "=========================================="
  echo
  echo "验证 1（应返回 ok:true）:"
  echo "  $URL/"
  echo
  echo "验证 2（应返回一大段 HTML）:"
  echo "  $URL/?url=https%3A%2F%2Fwww.7sefun.top%2F"
  echo
  echo "把这个地址填进站点「设置 → 代理地址」:"
  echo "  $URL"
else
  echo
  echo "脚本已上传，但没能取到 workers.dev 子域名。"
  echo "请到 Cloudflare 控制台 → Workers & Pages 查看分配的地址，"
  echo "如果提示需要先设置账号子域名，在控制台里设置一次即可。"
fi
