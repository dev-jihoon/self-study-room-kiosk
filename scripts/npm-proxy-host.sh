#!/bin/sh
# Nginx Proxy Manager API로 좌석 서버용 Proxy Host를 만든다 (관리 화면을 열 필요 없음).
# deploy.sh npm 이 .env 값을 읽어 부른다. 직접 부를 때:
#   NPM_EMAIL=... NPM_PASSWORD=... KIOSK_DOMAIN=... ./scripts/npm-proxy-host.sh
#
# 필요한 값 (.env에 넣어 두면 됨, .env는 git에 올라가지 않음)
#   NPM_EMAIL, NPM_PASSWORD   NPM 관리자 계정
#   KIOSK_DOMAIN              비워 두면 <공인IP>.sslip.io
#   NPM_URL                   NPM 관리 API 주소, 기본 http://127.0.0.1:81
#   LE_EMAIL                  인증서 발급 알림 메일, 기본 NPM_EMAIL
set -e

NPM_URL="${NPM_URL:-http://127.0.0.1:81}"
[ -n "$NPM_EMAIL" ] && [ -n "$NPM_PASSWORD" ] || { echo "NPM_EMAIL, NPM_PASSWORD가 필요합니다."; exit 1; }
if [ -z "$KIOSK_DOMAIN" ]; then
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || true)
  [ -n "$IP" ] || { echo "공인 IP를 알아내지 못했습니다. KIOSK_DOMAIN을 넣어 주세요."; exit 1; }
  KIOSK_DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
LE_EMAIL="${LE_EMAIL:-$NPM_EMAIL}"

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# 1. 로그인
TOKEN=$(curl -fsS -X POST "$NPM_URL/api/tokens" -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$(json_str "$NPM_EMAIL")\",\"secret\":\"$(json_str "$NPM_PASSWORD")\"}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "NPM 로그인에 실패했습니다. NPM_URL과 계정을 확인하세요."; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

# 2. 이미 있으면 그대로 둔다
if curl -fsS "$NPM_URL/api/nginx/proxy-hosts" -H "$AUTH" | grep -q "\"$KIOSK_DOMAIN\""; then
  echo "이미 $KIOSK_DOMAIN Proxy Host가 있습니다."
  echo "https://$KIOSK_DOMAIN/"
  exit 0
fi

# 3. 만들기 (Let's Encrypt 인증서 발급, HTTPS 강제)
BODY=$(cat <<EOF
{
  "domain_names": ["$KIOSK_DOMAIN"],
  "forward_scheme": "http",
  "forward_host": "study-room-kiosk",
  "forward_port": 8080,
  "access_list_id": 0,
  "certificate_id": "new",
  "ssl_forced": true,
  "http2_support": true,
  "hsts_enabled": false,
  "hsts_subdomains": false,
  "block_exploits": true,
  "caching_enabled": false,
  "allow_websocket_upgrade": true,
  "advanced_config": "",
  "locations": [],
  "meta": { "letsencrypt_email": "$(json_str "$LE_EMAIL")", "letsencrypt_agree": true, "dns_challenge": false }
}
EOF
)
RES=$(curl -sS -X POST "$NPM_URL/api/nginx/proxy-hosts" -H "$AUTH" -H 'Content-Type: application/json' -d "$BODY")
if echo "$RES" | grep -q '"id"'; then
  echo "Proxy Host를 만들었습니다: https://$KIOSK_DOMAIN/"
else
  echo "Proxy Host를 만들지 못했습니다. NPM 응답:"
  echo "$RES"
  exit 1
fi
