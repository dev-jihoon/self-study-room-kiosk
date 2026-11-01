#!/bin/sh
# 학교 와이파이 안에서 쓸 자체 서명 인증서를 만든다.
# 사용법: ./scripts/make-cert.sh 192.168.0.23   (UNO Q의 IP)
set -e
IP="${1:?UNO Q의 IP 주소를 넣어 주세요}"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=study-room-kiosk" \
  -addext "subjectAltName=IP:${IP},DNS:localhost"
echo "certs/cert.pem, certs/key.pem 을 만들었습니다. 태블릿에서 https://${IP}:8443 으로 접속한 뒤 경고 화면에서 계속 진행을 누르세요."
