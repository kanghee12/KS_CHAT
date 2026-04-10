# KS_CHAT

실시간 채팅, 사진/영상 업로드, GIPHY, 읽음 표시를 지원하는 Flask + Flask-SocketIO 채팅 앱입니다.

## 주요 기능

- 닉네임 입장
- 실시간 메시지 전송
- 사진/영상 업로드
- GIPHY 검색 및 전송
- 접속자 목록
- 입력 중 표시
- 읽음 표시
- 대화 기록 유지
- 새 대화 시작

## 로컬 실행

```powershell
cd "C:\Users\huig5\OneDrive\바탕 화면\chating"
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

브라우저에서 `http://127.0.0.1:5000` 접속

## Railway 운영 배포

### 1. 앱 서비스 만들기

- 이 프로젝트를 GitHub 저장소에 올립니다.
- Railway에서 `Deploy from GitHub repo` 또는 `railway up`으로 앱 서비스를 만듭니다.

### 2. PostgreSQL 추가

- 프로젝트에서 `+ New` -> `PostgreSQL`
- 앱 서비스 Variables 탭에서 Postgres의 `DATABASE_URL`을 연결합니다.

### 3. Storage Bucket 추가

- 프로젝트에서 `+ New` -> `Bucket`
- 앱 서비스 Variables 탭에서 아래 값을 자동 주입하거나 직접 연결합니다.
  - `BUCKET`
  - `ACCESS_KEY_ID`
  - `SECRET_ACCESS_KEY`
  - `ENDPOINT`
  - `REGION`

### 4. 선택 환경 변수

- `GIPHY_API_KEY`: GIPHY 검색/전송 활성화
- `PRESIGNED_URL_TTL`: 업로드 파일 다운로드 URL 유지 시간(초), 기본 `3600`

### 5. 시작 명령

프로젝트에는 `Procfile`이 포함되어 있어 Railway에서 자동으로 사용 가능합니다.

```text
web: gunicorn -w 1 --threads 100 -b 0.0.0.0:$PORT app:app
```

## 운영 모드 동작 방식

- `DATABASE_URL`이 있으면 Postgres 사용
- 없으면 로컬 SQLite(`chat.db`) 사용
- Bucket 환경 변수가 있으면 S3 호환 스토리지 사용
- 없으면 로컬 업로드 폴더 사용

## 주요 파일

- `app.py`
- `templates/index.html`
- `static/style.css`
- `static/script.js`
- `requirements.txt`
- `Procfile`
