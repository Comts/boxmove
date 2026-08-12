# 거래처 관리 · 지도 웹앱

운반 회사용 거래처(고객사) 관리 웹앱입니다. 거래처를 등록하면 주소가 자동으로 지도 좌표로 변환되어 네이버 지도 위에 표시됩니다. 기사님들이 스마트폰으로 접속해서 거래처 위치를 바로 확인할 수 있도록 모바일 화면에 맞춰 제작했습니다.

## 주요 기능

- 신규 거래처 추가 / 수정 / 삭제 (회사명, 주소, 담당자, 연락처, 메모)
- 주소 입력 시 자동으로 지도 좌표 변환 (네이버 지오코딩)
- 지도에서 거래처 위치 마커로 확인, 클릭 시 상세 정보 표시
- 거래처 목록 검색 (회사명/주소/담당자)
- 모바일 화면 최적화 (기사님 스마트폰 사용 가정)
- **로그인 후에만 이용 가능** — 아이디/비밀번호 없이는 거래처 정보 조회·수정·삭제 불가
- **역할별 권한 분리** — 관리자 계정(등록·수정·삭제 가능)과 기사님 계정(조회만 가능)이 따로 있음

## 보안 설계 요약

거래처 주소·연락처 등은 민감한 영업정보라 아래와 같이 보호하고 있습니다.

- **로그인 필수**: 로그인 페이지(`/login`) 외의 모든 화면과 API는 로그인 세션이 없으면 접근이 차단됩니다.
- **비밀번호 무차별 대입 방지**: 로그인 시도를 15분에 10회로 제한합니다 (초과 시 자동 차단).
- **세션 쿠키 보호**: 쿠키에 `httpOnly`(자바스크립트로 탈취 불가), `sameSite=lax`(다른 사이트에서의 위조 요청 방지) 설정이 적용되어 있고, 배포 환경(HTTPS)에서는 `secure` 옵션으로 암호화된 연결에서만 전송됩니다.
- **HTTPS 자동 적용**: Render 등에 배포하면 자동으로 SSL 인증서가 발급되어 모든 통신이 암호화됩니다.
- **보안 헤더(Helmet)**: 클릭재킹, XSS 등 일반적인 웹 공격을 막는 HTTP 보안 헤더가 기본 적용됩니다.
- **입력값 검증/길이 제한**: 서버에서 모든 입력값 길이를 제한하고, 화면 출력 시 이스케이프 처리하여 악성 스크립트 삽입을 방지합니다.
- **필수 보안 환경변수 점검**: 비밀번호·세션 키가 설정되지 않으면 서버가 아예 실행되지 않도록 되어 있어, 기본값으로 방치되는 것을 막습니다.
- **역할별 접근 제어**: 등록·수정·삭제 API는 관리자 계정으로 로그인했을 때만 서버에서 허용합니다. 기사님 계정으로는 화면에 버튼 자체가 안 보이는 것은 물론, 혹시라도 요청을 직접 보내더라도 서버가 차단합니다 (403 오류).

### 계정 종류

| 계정 | 할 수 있는 것 | 용도 |
|---|---|---|
| 관리자 (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) | 조회 + 등록 + 수정 + 삭제 | 배차 담당자, 사무실 관리자 |
| 기사님 (`VIEWER_USERNAME` / `VIEWER_PASSWORD`) | 조회만 가능 | 운전 중인 기사님들과 공유 |

두 계정 모두 여러 명이 같은 아이디/비밀번호를 함께 써도 되는 "공유 계정" 방식입니다 (기사님들끼리 같은 조회용 계정 공유, 관리자끼리 같은 관리자 계정 공유). 사람마다 개별 계정을 만들어서 "누가 언제 무엇을 수정했는지" 기록까지 남기고 싶으시면 말씀해주세요 — 이어서 작업해드릴 수 있습니다.

## 1. 네이버 지도 API 키 발급 (필수)

1. https://console.ncloud.com 접속 후 회원가입/로그인
2. 콘솔 상단에서 **AI·NAVER API > Application** 이동
3. **Application 등록** 클릭
4. 사용할 API에서 **Maps** 선택 (Web Dynamic Map, Geocoding 둘 다 체크)
5. Web 서비스 URL에 배포할 도메인을 등록 (로컬 테스트 시 `http://localhost:3000` 추가, 배포 후에는 실제 도메인 추가/수정 필요)
6. 등록 완료 후 발급된 **Client ID**, **Client Secret** 확인

> 네이버클라우드는 신용카드 등록이 필요할 수 있으나, Maps API는 일정 사용량까지 무료입니다.

## 2. 로컬 실행 방법

```bash
cd transport-app
npm install
cp .env.example .env
```

`.env` 파일을 열어 아래 값을 모두 채워주세요. **보안 관련 항목(ADMIN_USERNAME, ADMIN_PASSWORD, VIEWER_USERNAME, VIEWER_PASSWORD, SESSION_SECRET)이 비어 있으면 서버가 실행되지 않습니다.**

```
NAVER_MAPS_CLIENT_ID=발급받은_Client_ID
NAVER_MAPS_CLIENT_SECRET=발급받은_Client_Secret
PORT=3000

ADMIN_USERNAME=관리자_아이디
ADMIN_PASSWORD=반드시_강력한_비밀번호로_변경
VIEWER_USERNAME=기사님_아이디
VIEWER_PASSWORD=이것도_반드시_강력한_비밀번호로_변경
SESSION_SECRET=아래_명령으로_생성한_랜덤값
NODE_ENV=development
```

`SESSION_SECRET`은 터미널에서 아래 명령을 실행해 나온 값을 붙여넣으면 됩니다.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

실행:

```bash
npm start
```

브라우저에서 http://localhost:3000 접속 → `/login`으로 자동 이동 → 설정한 아이디/비밀번호로 로그인 → 정상 동작 확인.

같은 와이파이에 연결된 폰에서 테스트하려면, PC의 내부 IP(예: 192.168.0.5)로 접속하면 됩니다 (`http://192.168.0.5:3000`). 단, 네이버 콘솔의 Web 서비스 URL에도 해당 주소를 등록해야 지도가 뜹니다.

## 3. 기사님들이 폰으로 볼 수 있게 배포하기 (무료 호스팅 예시: Render)

1. https://render.com 가입 (GitHub 계정으로 가능)
2. 이 `transport-app` 폴더를 GitHub 저장소로 업로드
3. Render 대시보드에서 **New > Web Service** 선택 후 해당 저장소 연결
4. 설정값
   - Build Command: `npm install`
   - Start Command: `npm start`
5. **Environment** 탭에서 환경변수 추가 (전부 필수)
   - `NAVER_MAPS_CLIENT_ID`
   - `NAVER_MAPS_CLIENT_SECRET`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — 등록·수정·삭제 가능한 관리자 계정 (강력한 비밀번호 권장)
   - `VIEWER_USERNAME` / `VIEWER_PASSWORD` — 조회만 가능한 기사님 계정
   - `SESSION_SECRET` — 로컬에서 생성한 랜덤 문자열 (위 명령 참고)
   - `NODE_ENV` = `production`
6. 배포 완료 후 발급되는 주소 (예: `https://transport-app.onrender.com`) 를 네이버 콘솔의 Web 서비스 URL에도 등록
7. **기사님들에게는** 주소 + 기사님 계정(VIEWER) 아이디/비밀번호만 전달 → 조회만 가능
   **관리자/배차 담당자에게는** 주소 + 관리자 계정(ADMIN) 아이디/비밀번호 전달 → 등록·수정·삭제 가능
   폰 브라우저 접속 후 "홈 화면에 추가" 하면 앱처럼 사용 가능

> ⚠️ 아이디/비밀번호는 거래처 정보를 지키는 유일한 장치입니다. 특히 관리자 계정 정보는 등록·수정·삭제 권한이 있으니 배차 담당자 등 꼭 필요한 사람에게만 전달하세요. 유출이 의심되면 Render Environment 탭에서 해당 비밀번호 값을 바로 변경할 수 있습니다 (변경 후 재배포되면 즉시 반영).

> Render 무료 플랜은 일정 시간 미사용 시 서버가 잠들었다가 첫 접속 때 다시 깨어나는 데 몇 초 걸릴 수 있습니다. 상시 빠른 응답이 필요하면 유료 플랜(월 소액) 또는 Railway, Fly.io 같은 다른 호스팅도 고려할 수 있습니다.

## 4. 데이터 저장 방식

거래처 데이터는 `data/clients.json` 파일에 저장됩니다. 별도 데이터베이스 설치가 필요 없어 간단하지만, 배포 환경(Render 등)에 따라 재배포 시 파일이 초기화될 수 있습니다. 데이터를 안전하게 오래 보관하려면 추후 데이터베이스(Postgres 등) 연동을 권장드립니다 — 필요하시면 말씀해주세요, 이어서 작업해드릴 수 있습니다.

## 5. 폴더 구조

```
transport-app/
├── server.js          # Express 서버, API, 로그인/세션, 지오코딩 프록시
├── package.json
├── .env.example
├── .gitignore
├── data/
│   └── clients.json   # 거래처 데이터 (샘플 2건 포함)
└── public/
    ├── login.html      # 로그인 화면
    ├── index.html      # 메인 화면 (로그인 필요)
    ├── style.css
    └── app.js
```

## 6. 보안 체크리스트 (배포 전 꼭 확인)

- [ ] `ADMIN_PASSWORD`, `VIEWER_PASSWORD`를 기본값이 아닌 강력한 비밀번호로 바꿨는지
- [ ] `SESSION_SECRET`을 랜덤 값으로 생성해 넣었는지
- [ ] 배포 환경에 `NODE_ENV=production`을 설정했는지
- [ ] `.env` 파일을 GitHub에 올리지 않았는지 (`.gitignore`에 이미 포함되어 있어 기본적으로는 안전합니다)
- [ ] 로그인 정보(아이디/비밀번호)를 회사 관계자 외에는 공유하지 않았는지
