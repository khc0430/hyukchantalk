# 혁찬톡 (HyukchanTalk) - Node.js Version 🚀

파이썬의 설정 복잡함을 해결하기 위해 Node.js로 재구축된 실시간 웹 메신저입니다.

## 🌟 주요 기능
1.  **실시간 채팅:** Socket.io를 사용하여 딜레이 없는 실시간 대화를 지원합니다.
2.  **프로필 및 사진 관리:** 사용자가 직접 닉네임과 사진을 변경할 수 있습니다.
3.  **유저 상태 추적:** 10초 단위 하트비트로 유저의 온라인/오프라인 상태를 표시합니다.
4.  **카카오톡 스타일 UI:** 익숙하고 깔끔한 현대적인 디자인을 제공합니다.
5.  **간편한 배포:** Node.js 환경에서 작동하여 설정 오류를 최소화했습니다.

---

## 🛠️ 실행 방법 (로컬)

1.  **필수 도구 설치:**
    ```bash
    npm install
    ```
2.  **서버 실행:**
    ```bash
    npm start
    ```
3.  브라우저에서 `http://localhost:10000` 접속

---

## 📱 Render에 배포하여 링크 만들기

1.  **GitHub에 업로드:** 현재 폴더의 모든 파일을 GitHub 저장소에 올립니다.
2.  **Render 설정:**
    *   **Runtime:** `Node`
    *   **Build Command:** `npm install`
    *   **Start Command:** `node server.js`
3.  배포 완료 후 제공되는 `https://...onrender.com` 링크를 공유하세요!

---

## 📂 프로젝트 구조
- `server.js`: Node.js 백엔드 서버 (Express + Socket.io)
- `package.json`: 프로젝트 설정 및 라이브러리 목록
- `public/index.html`: 메인 웹 UI 및 클라이언트 로직
- `public/uploads/`: 업로드된 프로필 사진 저장 폴더
