#!/bin/sh
# 좌석 배정 서버를 HTTPS까지 한 번에 띄운다.
#
#   ./deploy.sh oci                  공인 IP로 접속하는 서버 (OCI). sslip.io 주소로 정식 인증서를 자동 발급
#   ./deploy.sh oci --open-firewall  위와 같고, 서버 안 방화벽(iptables)의 80, 443 포트도 연다
#   ./deploy.sh lan [IP]             학교 와이파이 안의 서버 (UNO Q). 자체 인증서, 처음 접속 때 경고를 넘겨야 함
#   ./deploy.sh npm [네트워크]       Nginx Proxy Manager가 있는 서버. 좌석 서버만 띄우고 HTTPS는 NPM이 맡음
#   ./deploy.sh stop                 내리기
#   ./deploy.sh logs                 로그 보기
#   ./deploy.sh reset-pin 1234       감독 PIN을 잊었을 때 새 PIN으로 정하기
set -e
cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "Docker Compose가 없습니다. Docker를 먼저 설치하세요."; exit 1; fi

MODE="${1:-}"
if [ "$MODE" = "reset-pin" ]; then
  echo "${2:-}" | grep -Eq '^[0-9]{4,8}$' || { echo "새 PIN을 숫자 4~8자리로 넣어 주세요. 예: ./deploy.sh reset-pin 1234"; exit 1; }
  mkdir -p data
  printf '%s\n' "$2" > data/reset-pin
  echo "감독 화면에서 새 PIN($2)으로 로그인하면 바뀝니다."
  exit 0
fi
case "$MODE" in
  stop) $DC down; exit 0 ;;
  logs) $DC logs -f --tail 100; exit 0 ;;
  oci|lan|npm) ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

# .env 준비 (있으면 SITE_ADDRESS, CADDY_TLS만 바꿈)
[ -f .env ] || cp .env.example .env
setenv() {
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); grep -v "^$1=" .env > "$tmp"; mv "$tmp" .env
  fi
  printf '%s=%s\n' "$1" "$2" >> .env
}

if [ "$MODE" = "npm" ]; then
  NET="${2:-}"
  if [ -z "$NET" ]; then
    NPM_ID=$(docker ps --format '{{.ID}} {{.Image}}' | grep -i 'nginx-proxy-manager' | head -n1 | cut -d' ' -f1)
    [ -n "$NPM_ID" ] || { echo "실행 중인 Nginx Proxy Manager 컨테이너를 찾지 못했습니다. ./deploy.sh npm <도커 네트워크 이름> 처럼 넣어 주세요."; exit 1; }
    # NPM 컨테이너의 기본 네트워크 (compose로 띄웠으면 *_default, 아니면 bridge가 아닌 첫 번째)
    # 도커 기본 bridge에서는 컨테이너 이름으로 찾아갈 수 없어서 쓰지 않는다
    NETS=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$NPM_ID" | tr ' ' '\n' | grep -v '^$')
    NET=$(echo "$NETS" | grep '_default$' | head -n1)
    [ -n "$NET" ] || NET=$(echo "$NETS" | grep -vx 'bridge\|host\|none' | head -n1)
    [ -n "$NET" ] || { echo "NPM 컨테이너가 기본 bridge 네트워크에만 있습니다. docker network create npm-net && docker network connect npm-net <NPM 컨테이너> 후 ./deploy.sh npm npm-net 으로 실행하세요."; exit 1; }
  fi
  docker network inspect "$NET" >/dev/null 2>&1 || { echo "도커 네트워크 '$NET'이 없습니다."; exit 1; }
  setenv NPM_NETWORK "$NET"
  setenv COMPOSE_FILE "docker-compose.yml:docker-compose.npm.yml"
  mkdir -p data
  $DC up -d --build app
  printf '서버가 뜨기를 기다리는 중'
  i=0
  until docker exec study-room-kiosk wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1; do
    i=$((i+1)); [ $i -gt 20 ] && { echo; echo "응답이 없습니다. ./deploy.sh logs 로 확인하세요."; exit 1; }
    printf '.'; sleep 2
  done
  echo
  echo "좌석 서버가 NPM 네트워크($NET)에 붙었습니다."
  set -a; . ./.env; set +a
  if [ -n "$NPM_EMAIL" ] && [ -n "$NPM_PASSWORD" ]; then
    ./scripts/npm-proxy-host.sh
  else
    echo "Proxy Host를 자동으로 만들려면 .env에 NPM_EMAIL, NPM_PASSWORD(NPM 관리자 계정)를 넣고 다시 실행하세요."
    echo "도메인은 KIOSK_DOMAIN으로 정할 수 있고, 비워 두면 <공인IP>.sslip.io를 씁니다."
  fi
  exit 0
fi
setenv COMPOSE_FILE "docker-compose.yml"

if [ "$MODE" = "oci" ]; then
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)
  [ -n "$IP" ] || { echo "공인 IP를 알아내지 못했습니다."; exit 1; }
  HOST="$(echo "$IP" | tr . -).sslip.io"
  setenv SITE_ADDRESS "$HOST"
  setenv CADDY_TLS ""
  setenv DEFAULT_SNI "$HOST"
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
  setenv DEFAULT_SNI "$IP"
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
echo "감독 화면:  $URL/admin  (PIN은 .env의 ADMIN_PIN)"
if [ "$MODE" = "oci" ]; then
  echo "접속이 안 되면 OCI 콘솔의 보안 목록(Security List)에서 80, 443 포트 수신을 허용했는지 확인하세요."
else
  echo "태블릿에서 처음 열 때 인증서 경고가 나오면 '고급 > 계속'을 누르면 됩니다."
fi
