# 자기주도학습실 좌석 배정 키오스크

야간자율학습 시간에 학생이 태블릿 키오스크에서 학생증 바코드(또는 학번)로 자리를 배정받고, 감독 선생님은 누가 어디에 앉았는지와 누가 아직 안 왔는지를 한 화면에서 확인하는 시스템입니다. 다이나믹스 1조 탐구 결과물입니다.

## 화면

| 주소 | 용도 |
| --- | --- |
| `index.html` | 키오스크. 바코드를 카메라에 비추거나 학번을 입력하면 자리 고르기, 자리 바꾸기, 반납을 할 수 있습니다. 상단 제목을 2초 누르면 감독 화면으로 갑니다. |
| `admin.html` | 감독 화면. 좌석 현황(이름 표시), 미입실 명단, 기록, 설정. 처음 PIN은 `0000`입니다. |
| `me.html` | 배정이 끝나면 키오스크에 뜨는 QR을 휴대폰으로 찍었을 때 열리는 "내 자리" 화면입니다. |
| `cards.html` | 명단의 학번을 Code 128 바코드로 찍은 시연용 카드 인쇄 페이지(A4 8장). |

## 운영 규칙

- 아침과 점심은 자유석이라 키오스크를 쓰지 않고, 야간자율학습 시간(기본 18:00~22:30)에만 배정합니다.
- 시연 모드를 켜면 시간과 상관없이 배정할 수 있습니다. 기본값은 켜짐입니다.
- 날짜가 바뀌면 좌석과 기록이 자동으로 비워집니다.
- 한 학생은 한 자리만 쓸 수 있고, 다른 자리를 고르면 이동으로 처리됩니다.

## 두 가지 실행 방식

### 1. 시연 모드 (GitHub Pages, 서버 없음)

`public/` 폴더를 그대로 정적 호스팅합니다. 데이터는 그 태블릿 브라우저에 저장되고, 키오스크와 감독 화면은 같은 태블릿에서 탭을 바꿔 봅니다. 한 번 열어 두면 와이파이가 끊겨도 동작합니다. 카메라는 HTTPS에서만 켜지는데 GitHub Pages는 HTTPS라 그대로 됩니다.

### 2. 서버 모드 (UNO Q에서 Docker)

여러 태블릿과 감독 PC가 같은 좌석 현황을 봅니다. 외부 패키지 없이 Node 내장 모듈만 씁니다.

```sh
./scripts/make-cert.sh 192.168.0.23     # UNO Q의 IP로 자체 서명 인증서 생성
docker compose up -d --build            # https://192.168.0.23:8443
```

- 태블릿에서 처음 접속할 때 인증서 경고가 나오면 "계속 진행"을 눌러야 카메라를 쓸 수 있습니다.
- 데이터는 `data/state.json`에 저장됩니다. `data/roster.csv`(학번,이름,야자신청)를 두면 처음 실행 때 그 명단을 씁니다.
- Docker 없이 실행: `node server/server.js` (환경 변수 `PORT`, `DATA_DIR`, `ADMIN_PIN`, `DEMO_MODE`, `TLS_CERT`, `TLS_KEY`, `EVENTS_TOKEN`).
- 동작 확인: `npm test`

## 배정 알림

배정되면 학생에게 자리를 알려 주는 방법은 세 가지입니다. 자세한 내용은 [docs/notifications.md](docs/notifications.md)에 있습니다.

1. **QR 내 자리 확인** (지금 동작): 배정 완료 화면의 QR을 휴대폰으로 찍으면 자리 번호와 배치도가 뜹니다.
2. **카카오톡 봇 연동** (서버 모드): 봇이 `GET /api/events?since=…`로 새 배정을 가져가 메시지를 보냅니다.
3. **웹훅** (서버 모드): 감독 화면 설정에 주소를 넣으면 배정마다 JSON을 POST합니다.

## 구조

```
public/
  index.html admin.html me.html cards.html
  js/core.js       배정 규칙. 브라우저와 서버가 같이 씀
  js/store.js      서버가 있으면 api/, 없으면 브라우저 저장소
  js/seatmap.js    좌석 배치도 그리기
  js/scanner.js    카메라 바코드 인식 (BarcodeDetector, 없으면 ZXing)
  data/layout.json 좌석 배치 (107석, 기둥 2개)
  data/roster.json 시연용 가짜 명단 48명
  vendor/          ZXing, qrcode-generator, JsBarcode (모두 MIT)
server/server.js   서버 모드
```

좌석 배치를 바꾸려면 `public/data/layout.json`만 고치면 됩니다. 숫자는 좌석 번호, `"P"`는 기둥, `null`은 빈칸입니다.
