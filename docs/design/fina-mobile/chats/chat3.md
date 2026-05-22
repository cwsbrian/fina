# 작업 진행 상황 확인

_Started 2026-05-19 16:10 UTC_

---

## User

지금 어디까지 작업됬는지 파악해보고 다음은 어떤거 작업해야하는지 알려줘

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: grep]_

_[tool: grep]_

작업 진행 상황을 정리해서 알려드릴게요.

## 📊 현재까지 작업된 것

`Fina Mobile Designs.html` 한 파일에 **11개 섹션, 약 70+ 아트보드**가 design canvas 위에 깔려 있어요. spec 기준으로 다 매핑해보면:

### ✅ 완료된 화면들

| 영역 | 화면 |
|---|---|
| **Home/Analysis** | Home (morning brief 카드), Analysis 탭 |
| **Chat — ritual** | Fresh / Mid-ritual / Done / Upgrade prompt |
| **Chat — Phase 2 blocks** | schedule_form, budget_edit, plan_card |
| **Activity (Transactions)** | List, Date range (preset/custom), Detail, Category picker, Add tx (empty/expense/income/note) |
| **Settings 계열** | Root, Profile edit, Delete account, Banks, Reconnect sheet, Plaid error toast ×2, Workspace settings/invite/switcher |
| **Subscription** | Trial active/expiring/expired, Pro active, Trial lock modal |
| **Phase 2 알림** | Thread list, Lock-screen push, Trial-expiring banner (Home/Activity/Chat/Banks), Sign out, Goals locked (Free/Lite), Banks Lite-limit, Notification settings, Brief settings, Push permission, Data export, Chat with context, Tx with bank error |
| **Phase 3 — Goals** | Home with Goals, List, Create, Detail, Chat plan→Save |
| **Phase 3 — Receipt OCR** | Capture, Processing, Parsed, Saved |
| **Phase 3 — Anomaly** | Chat anomaly, Detail, Flagged filter |
| **Empty states** | Home, Activity, Banks, Chats, Analysis |
| **Auth** | Splash, Onboarding ×3, Sign up, Sign in, Email verify, Forgot/Reset password ×4 |

전체적으로 spec의 §2~§9가 거의 다 커버됐어요.

---

## 🔍 spec 대비 빠진 것 / 약한 것

spec을 다시 훑어보니 아래가 안 보여요:

1. **`§3.3.6 quick_replies` block** — Phase 2 블록 섹션에 schedule/budget/plan은 있는데 quick_replies 칩 모음은 단독 데모가 없음
2. **`§4.3` Add Transaction의 income 토글 / 카테고리 선택 흐름** — 단일 폼은 있지만 카테고리 선택 단계 변형이 없음
3. **`§5.3` Account Detail** — `screens.jsx`에 `AccountDetail` 컴포넌트는 정의돼 있는데 캔버스에 아트보드로 노출이 안 되어 있어요 ⚠️
4. **`§7.3` Bank item error 인라인 배너** — 단독 배너만 있고 "여러 화면에 같이 떠 있는" Chat/Banks 상단 인라인 배너 시연이 부족
5. **온보딩 4번째 슬라이드** ("시작" CTA) — 1~3만 있음
6. **사이드 파일 정리** — `Fina Mobile Designs - Activity Analysis entry.html`, `analysis-date-options.html`, `chat-block-library.html`, `components/activity-analysis-entry.jsx` 가 메인 캔버스에 합쳐지지 않은 채로 떠 있음. 합치거나 지울지 결정 필요

---

## 🎯 다음으로 추천하는 작업

우선순위 순으로:

1. **사이드 HTML 파일 정리** — 메인 캔버스에 흡수할지 / 폐기할지 결정 (제일 빨리 정리 가능)
2. **빠진 4~5개 아트보드 추가**: `AccountDetail` 노출, `quick_replies` 데모, 온보딩 4번째 슬라이드, 인라인 bank-error 배너가 같이 떠 있는 다른 화면들
3. **interaction pass** — 지금은 정적 모킹뿐이니, 핵심 funnel(Home → morning brief → categorize_card 탭 → done)을 실제로 클릭해서 넘어가는 hi-fi 프로토타입 흐름으로 묶기

어느 쪽부터 갈까요? 아니면 다른 우선순위가 있으면 알려주세요.

