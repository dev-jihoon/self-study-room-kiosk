#!/bin/sh
# 좌석 배정 서버를 HTTPS까지 한 번에 띄운다.
#
#   ./deploy.sh oci                  공인 IP로 접속하는 서버 (OCI). sslip.io 주소로 정식 인증서를 자동 발급
#   ./deploy.sh oci --open-firewall  위와 같고, 서버 안 방화벽(iptables)의 80, 443 포트도 연다
#   ./deploy.sh lan [IP]             학교 와이파이 안의 서버 (UNO Q). 자체 인증서, 처음 접속 때 경고를 넘겨야 함
#   ./deploy.sh stop                 내리기
#   ./deploy.sh logs                 로그 보기
set -e
cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "Docker Compose가 없습니다. Docker를 먼저 설치하세요."; exit 1; fi

MODE="${1:-}"
case "$MODE" in
  stop) $DC down; exit 0 ;;
  logs) $DC logs -f --tail 100; exit 0 ;;
  oci|lan) ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

# .env 준비 (있으면 SITE_ADDRESS, CADDY_TLS만 바꿈)
[ -f .env ] || cp .env.example .env
setenv() {
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); grep -v "^$1=" .env > "$tmp"; mv "$tmp" .env
  fi
  printf '%s=%s\n' "$1" "$2" >> .env
}

if [ "$MODE" = "oci" ]; then
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)
  [ -n "$IP" ] || { echo "공인 IP를 알아내지 못했습니다."; exit 1; }
  HOST="$(echo "$IP" | tr . -).sslip.io"
  setenv SITE_ADDRESS "$HOST"
  setenv CADDY_TLS ""
  URL="https://$HOST"
  if [ "${2:-}" = "--open-firewall" ] && command -v iptables >/dev/null 2>&1; then
    for p in 80 443; do
      sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
    done
    command -v netfilter-persistent >/dev/null 2>&1 && sudo netfilter-persistent save || true
    echo "서버 방화벽에서 80, 443 포트를 열었습니다."
  fi
else
  IP="${2:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
  [ -n "$IP" ] || { echo "IP를 알아내지 못했습니다. ./deploy.sh lan 192.168.0.23 처럼 넣어 주세요."; exit 1; }
  setenv SITE_ADDRESS "https://$IP"
  setenv CADDY_TLS "\"tls internal\""
  URL="https://$IP"
fi

mkdir -p data
$DC up -d --build

printf '서버가 뜨기를 기다리는 중'
i=0
until curl -fsSk --max-time 3 "$URL/api/health" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 40 ] && { echo; echo "응답이 없습니다. ./deploy.sh logs 로 확인하세요."; exit 1; }
  printf '.'; sleep 3
done
echo
echo "키오스크:   $URL/"
echo "감독 화면:  $URL/admin.html  (PIN은 .env의 ADMIN_PIN)"
if [ "$MODE" = "oci" ]; then
  echo "접속이 안 되면 OCI 콘솔의 보안 목록(Security List)에서 80, 443 포트 수신을 허용했는지 확인하세요."
else
  echo "태블릿에서 처음 열 때 인증서 경고가 나오면 '고급 > 계속'을 누르면 됩니다."
fi
