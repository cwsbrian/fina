# Fina Mobile — Screen & Feature Spec

**Date:** 2026-05-12
**Status:** Design complete, ready for implementation planning
**Owner:** Brian (cwsbrian@gmail.com)
**Based on:** Master spec `docs/superpowers/specs/2026-05-07-fina-design.md`
**Platform:** Expo (React Native) — iOS primary, Android secondary
**Scope:** v1 완성 기준 (Phase 1A → Phase 3). 각 화면에 phase 레이블 표기.

---

## 0. 설계 원칙

- **Mobile = main daily surface.** Web은 entry-only (랜딩, 가입, 결제, 초대 수락, workspace settings). chat / transactions / ritual UI는 mobile 전용.
- **Push → Chat이 핵심 funnel.** 매일 아침 push 탭 → chat thread → 카드 1탭 정리. 이 흐름이 Fina의 핵심 가치.
- **AI가 말을 건다.** 사용자가 앱을 열어서 정보를 찾는 게 아니라, AI가 아침에 정리된 내용을 들고 옴. 사용자는 반응만 하면 됨.
- **Tier gating은 input bar로.** Lite/Free는 chat을 볼 수 있지만 input bar가 잠겨있음. 잠금 상태에서도 카드 탭으로 카테고리 확인/거부는 가능. Pro만 자유 입력.
- **금액 표기**: 지출 = 양수 (빨간/일반색), 수입/환급 = 음수 → UI는 절대값 + 아이콘/색으로 구분.

---

## 1. 내비게이션 구조

```
App
├── Auth Stack (미인증)
│   ├── Splash
│   ├── Onboarding (최초 1회)
│   ├── Sign Up
│   ├── Sign In
│   └── Email Verification (magic link / OTP)
│
└── Main Stack (인증 완료)
    ├── Bottom Tab Bar
    │   ├── Chat          (탭 1 — 홈)
    │   ├── Transactions  (탭 2)
    │   ├── Banks         (탭 3)
    │   └── Settings      (탭 4)
    │
    ├── Modal / Full-screen overlays
    │   ├── Plaid Link (native SDK sheet)
    │   ├── Add Transaction
    │   ├── Transaction Detail
    │   ├── Category Picker
    │   ├── Budget Editor
    │   └── Upgrade Prompt
    │
    └── Push notification deep links
        └── → Chat thread (특정 thread_id)
```

### Bottom Tab Bar 아이콘 / 뱃지

| 탭 | 아이콘 | 뱃지 |
|---|---|---|
| Chat | 말풍선 | 읽지 않은 AI 메시지 수 |
| Transactions | 리스트 | 미분류 트랜잭션 수 (Pro/Lite) |
| Banks | 건물/은행 | error 상태 item 있으면 빨간 점 |
| Settings | 기어 | trial 만료 임박 시 주황 점 |

---

## 2. Auth 화면

### 2.1 Splash Screen

**Phase:** 1A

**요소:**
- Fina 로고 (중앙)
- 배경색 (브랜드 primary)
- 로딩 인디케이터 (세션 체크 중)

**동작:**
- 앱 시작 시 자동 표시 (~1-2초)
- 유효 세션 있으면 → Main Stack으로 이동
- 세션 없으면 → Onboarding 또는 Sign In으로 이동

---

### 2.2 Onboarding (최초 1회)

**Phase:** 1A

**요소 (3-4장 슬라이드):**

슬라이드 1 — "내 돈 사정 아는 AI 친구"
- 일러스트: 채팅 화면에서 AI가 아침 요약 보내는 모습
- 헤드라인: "매일 아침, Fina가 먼저 말 걸어"
- 서브: "어제 뭐 썼는지, 오늘 뭐 예정인지 — 내가 알아서 정리해서 알려줄게"

슬라이드 2 — "카드 한 번 탭으로 정리"
- 일러스트: categorize_card 탭하는 손
- 헤드라인: "미분류 내역 1탭 정리"
- 서브: "Costco = 시장? 탭 한 번으로 확인. 다음엔 자동으로"

슬라이드 3 — "가족이랑 같이"
- 일러스트: 두 사람이 같은 workspace 보는 모습
- 헤드라인: "가족 workspace 공유"
- 서브: "초대 한 번으로 수입/지출 같이 보기. 공짜로"

슬라이드 4 — "시작"
- CTA 버튼: "계정 만들기"
- 링크: "이미 계정 있어요 → 로그인"

**동작:**
- 슬라이드 스킵 가능 (우상단 "건너뛰기")
- 마지막 슬라이드에서 CTA → Sign Up으로 이동
- AsyncStorage에 "onboarding_seen" 저장 → 재방문 시 스킵

---

### 2.3 Sign Up

**Phase:** 1A

**요소:**
- Fina 로고 (상단)
- 이름 입력 필드
- 이메일 입력 필드
- 비밀번호 입력 필드 (강도 표시 선택)
- "계정 만들기" 버튼 (primary)
- "Google로 계속하기" 버튼 (secondary) ← v1.5+
- "Apple로 계속하기" 버튼 (secondary) ← v1.5+
- 하단: "이미 계정 있나요? 로그인" 링크
- 이용약관 + 개인정보처리방침 링크 (소문자)

**동작:**
- 이메일/비밀번호 제출 → Better Auth `/sign-up/email`
- 성공 → 이메일 인증 화면 또는 즉시 Main Stack (이메일 인증 방식에 따라)
- 가입 직후 백엔드가 workspace 자동 생성 + 30일 Pro Trial 시작
- 에러: 이미 가입된 이메일 → "이미 사용 중인 이메일입니다. 로그인하시겠어요?" + 로그인 버튼

---

### 2.4 Sign In

**Phase:** 1A

**요소:**
- Fina 로고 (상단)
- 이메일 입력 필드
- 비밀번호 입력 필드
- "로그인" 버튼 (primary)
- "비밀번호 잊었어요" 링크
- "Google로 계속하기" ← v1.5+
- "Apple로 계속하기" ← v1.5+
- Magic Link 옵션: "이메일로 링크 받기" ← 선택적 (Better Auth magic link 지원)
- 하단: "계정 없나요? 가입하기" 링크

**동작:**
- 성공 → Main Stack (유효한 workspace로 자동 선택)
- 실패 → 인라인 에러 ("이메일 또는 비밀번호를 확인하세요")
- Deep link로 진입 시 (초대 링크 등) → 로그인 후 해당 워크스페이스로 이동

---

### 2.5 이메일 인증 / Magic Link

**Phase:** 1A

**요소:**
- "이메일을 확인하세요" 타이틀
- 발송 이메일 주소 표시 ("[email]로 링크를 보냈어요")
- OTP 입력 필드 6자리 (선택: 또는 딥링크 자동 인증)
- "다시 보내기" 버튼 (30초 쿨다운)
- "이메일 주소 변경" 링크

**동작:**
- 이메일의 링크 탭 → 딥링크로 앱 오픈 → 자동 인증 → Main Stack
- OTP 수동 입력 → 인증 → Main Stack
- 만료된 링크/OTP → "링크가 만료됐어요. 다시 보내드릴게요" + 재전송

---

## 3. Chat 화면 (핵심)

### 3.1 Chat — Thread 목록

**Phase:** 2 (v1에서는 thread가 1개 — daily ritual thread만)

**요소:**
- "대화" 헤드라인
- Thread 목록 (날짜별 그룹)
  - Daily ritual threads: "5월 12일 아침 브리핑"
  - Ad-hoc threads: 사용자가 시작한 자유 대화
- 각 row: 날짜, 미리보기 텍스트, 읽지 않음 뱃지
- 새 대화 시작 버튼 (우상단 또는 FAB) — Pro만 활성

**동작:**
- Row 탭 → Chat Thread 화면
- v1 dogfood에서는 thread 목록 없이 바로 최신 thread로 진입

---

### 3.2 Chat Thread — 메인 화면

**Phase:** 1C (blocks 렌더러), Phase 2 (full ritual)

**전체 레이아웃:**
```
┌─────────────────────────────┐
│  ← 뒤로   "5월 12일"  ⋯   │  ← 네비게이션 바
├─────────────────────────────┤
│                             │
│   [메시지 스크롤 영역]        │
│                             │
│   [AI 메시지]               │
│   [사용자 메시지]            │
│   [AI 메시지 + 카드들]       │
│                             │
│                             │
├─────────────────────────────┤
│  [💬 메시지 입력창]  [전송]  │  ← Pro: 활성 / Lite+Free: 잠김
└─────────────────────────────┘
```

**요소:**

메시지 버블:
- AI 메시지: 좌측 정렬, 회색 배경, Fina 아이콘
- 사용자 메시지: 우측 정렬, primary 색상 배경
- 타임스탬프 (롱프레스 또는 스크롤 시 표시)
- 메시지 로딩: 타이핑 인디케이터 (...)

Input bar (Pro):
- 텍스트 입력 필드 (multiline 지원, 최대 높이 제한)
- 전송 버튼 (입력 없으면 비활성)
- 첨부 버튼 (Phase 3: 영수증 OCR용)

Input bar (Lite/Free):
- 잠금 아이콘 + "Pro로 업그레이드하면 채팅할 수 있어요" 텍스트
- 탭 시 Upgrade Prompt 모달

Financial context 배너 (상단 스크롤 아웃):
- 이번 달 예산 진행률 (Phase 2+)
- "이번 달 $X 중 $Y 사용" 한 줄 요약

**동작:**
- Pull-to-refresh: 최신 메시지 로드
- 새 메시지 도착 시 자동 스크롤 다운 (사용자가 스크롤 올렸으면 "새 메시지 ↓" 뱃지)
- 전송 → 낙관적 UI (즉시 버블 표시) → 서버 응답 대기 → AI 응답 스트리밍

---

### 3.3 Chat Block 렌더러 — 상세

**Phase:** 1C (기본 3종), Phase 2 (전체)

#### 3.3.1 `text` block

```
┌─────────────────────────────────┐
│  어제 사용한 내역 중 확인         │
│  받고 싶은 거 있어:               │
└─────────────────────────────────┘
```
- Markdown 렌더링 (굵기, 기울임, 목록, 코드블록)
- 링크는 인앱 브라우저로 오픈 (외부 URL)

---

#### 3.3.2 `categorize_card` block

```
┌─────────────────────────────────┐
│  🛒  Costco Warehouse           │
│      $87.43  ·  어제 오후 9시   │
│                                 │
│  AI 제안: [시장 ▼]              │  ← 카테고리 선택 드롭다운
│                                 │
│  [✓ 확인]    [다른 카테고리]    │
└─────────────────────────────────┘
```

- 상단: merchant 이름 + 금액 + 시간
- AI 제안 카테고리 표시 (있으면)
- 카테고리 선택 드롭다운: workspace의 전체 categories 목록
- [✓ 확인]: AI 제안 카테고리(또는 선택한 카테고리)로 confirm → intent consume API 호출
- 확인 후: 카드가 "✓ 시장으로 분류됨" 상태로 전환 (collapse or checkmark)
- [다른 카테고리]: 드롭다운 강제 오픈
- 여러 카드가 있을 때 각각 독립 처리 (하나 확인해도 다른 카드 영향 없음)

---

#### 3.3.3 `confirm_card` block

```
┌─────────────────────────────────┐
│  ⚠️  "Walmart 트랜잭션 23개를   │
│       시장 카테고리로 옮길까요?" │
│                                 │
│  [✓ 네, 옮겨줘]  [아니오]      │
└─────────────────────────────────┘
```

- 질문 텍스트
- 확인/거부 버튼 (accept_label, reject_label)
- 확인 → accept_intent consume → 백엔드 실행 → 완료 메시지
- 거부 → reject_intent consume (또는 무시)
- 처리 중 로딩 인디케이터
- 만료된 intent → "이 요청이 만료됐어요" 상태로 전환

---

#### 3.3.4 `schedule_form` block

**Phase:** 2

```
┌─────────────────────────────────┐
│  📅  예정 지출 추가             │
│                                 │
│  날짜:    [2026-05-20]          │
│  금액:    [$    ]               │
│  카테고리: [선택]               │
│  메모:    [        ]            │
│                                 │
│  [저장]                         │
└─────────────────────────────────┘
```

- 기본값은 AI가 채워줌 (defaults 필드)
- 저장 → submit_intent consume → schedule row 생성

---

#### 3.3.5 `budget_edit` block

**Phase:** 2

```
┌─────────────────────────────────┐
│  📊  외식 예산 수정              │
│                                 │
│  현재: $300/월                  │
│  새 금액: [$   ]                │
│                                 │
│  [저장]                         │
└─────────────────────────────────┘
```

- 카테고리명 표시
- 현재 예산 표시
- 새 금액 입력
- 저장 → submit_intent consume → budget row 업데이트

---

#### 3.3.6 `quick_replies` block

```
┌──────────────────────────────────────┐
│  [어떤 카테고리가 제일 많아?]          │
│  [이번 달 예산 어때?]                 │
│  [별 거 없어]                         │
└──────────────────────────────────────┘
```

- 가로 스크롤 또는 줄바꿈 버튼 목록
- 탭 시 해당 payload를 사용자 메시지로 전송 (또는 intent consume)
- 탭 후 quick_replies 영역 collapse

---

### 3.4 Morning Ritual Push → Chat 흐름

**Phase:** 2

1. 아침 설정 시간에 push 도착
   - 짧은 경우: push body에 메시지 텍스트 그대로
   - 긴/카드 있는 경우: "Fina가 어제 내역 확인 받고 싶대" + 앱 열기
2. 탭 → 앱 오픈 → 해당 daily thread로 딥링크 이동
3. 새 AI 메시지 + categorize_card들 표시
4. 카드 탭으로 처리 → 모두 완료 시 간단한 요약 ("오늘 정리 완료 ✓")

---

## 4. Transactions 화면

### 4.1 Transactions 목록

**Phase:** 1B-mobile

**전체 레이아웃:**
```
┌───────────────────────────────┐
│  트랜잭션          [🔍] [⚙]  │
├───────────────────────────────┤
│  [이번 달 ▼]  [전체 계좌 ▼]  │  ← 필터 바
│  미분류 X건  [미분류만 보기]   │  ← 미분류 배너 (있을 때만)
├───────────────────────────────┤
│  5월 12일 (월)                │  ← 날짜 섹션 헤더
│  ┌─────────────────────────┐  │
│  │ 🛒 Costco  시장         │  │
│  │    -$87.43          오후9│  │
│  └─────────────────────────┘  │
│  ┌─────────────────────────┐  │
│  │ ☕ Tim Hortons  외식/카페│  │
│  │    -$6.50           오전10│ │
│  └─────────────────────────┘  │
│                               │
│  5월 11일 (일)                │
│  ...                          │
└───────────────────────────────┘
```

**요소:**

필터 바:
- 기간 선택: 이번 달 / 저번 달 / 최근 3개월 / 커스텀 범위 (달력 picker)
- 계좌 선택: 전체 / 개별 계좌 (연결된 은행 계좌 목록)
- 카테고리 필터 (Phase 3): 카테고리 멀티 선택

미분류 배너:
- 미분류 트랜잭션이 있을 때만 표시
- "미분류 N건 — 채팅에서 정리하기" 버튼
- 탭 시 Chat으로 이동 (AI가 categorize_card들 보내줌)

트랜잭션 row:
- 왼쪽: 카테고리 아이콘 (없으면 물음표 아이콘, 회색)
- 중앙: merchant_normalized (이름) + 카테고리명 (없으면 "미분류")
- 오른쪽: 금액 + 시간
- pending 상태: 이름 옆에 "pending" 뱃지
- 수입/환급: 금액 앞에 "+" + 초록색

섹션 헤더 (날짜):
- 날짜 표시 (오늘/어제 → 상대 날짜)
- 해당 날짜 합계 (선택)

하단 합계 바 (Phase 2):
- 선택 기간 총 지출 / 수입 요약

**동작:**
- Row 탭 → Transaction Detail 화면
- 당기기로 새로고침 (manual sync trigger)
- 무한 스크롤 (페이지네이션)
- 미분류 row 탭 → Transaction Detail에서 카테고리 즉시 선택 가능

---

### 4.2 Transaction Detail

**Phase:** 1B-mobile

**요소:**
- 상단: merchant 이름 (크게), 금액 (더 크게)
- 카드형 섹션들:

  **기본 정보:**
  - 날짜/시간 (authorized + posted 둘 다 있으면 둘 다)
  - 계좌명 (예: "BMO Chequing ••••1234")
  - 상태: 완료 / pending
  - Plaid merchant_name (있으면)
  - 주소/위치 (Plaid에서 제공하면)

  **카테고리:**
  - 현재 카테고리 (아이콘 + 이름)
  - [변경] 버튼 → Category Picker 모달
  - 변경 시 백엔드에 POST .../categorize (merchant_mapping 업데이트 + 백필)
  - "이 merchant의 N개 트랜잭션에도 적용됩니다" 안내 (백필 범위)

  **메모:**
  - 현재 메모 (없으면 "메모 추가")
  - 탭해서 편집 (인라인 텍스트 에디터)

  **연관 Schedule (있으면):**
  - "5월 20일 예정 지출과 연결됨" 표시
  - 연결 해제 버튼

- 하단: [삭제] 버튼 (빨간색, manual 트랜잭션만 — Plaid 트랜잭션은 soft delete 불가)

**동작:**
- 카테고리 변경 → 낙관적 UI 업데이트 → 백엔드 sync
- 삭제 → confirm_card 스타일 확인 ("정말 삭제할까요?") → 확인 시 soft delete

---

### 4.3 트랜잭션 수동 추가 (Add Transaction)

**Phase:** 1A (Free 포함)

**진입:** Transactions 목록 우상단 "+" 버튼 → 모달 시트

**요소:**
- 금액 입력 (큰 숫자 키패드 스타일)
- 지출/수입 토글
- Merchant/설명 텍스트 필드
- 날짜 picker (기본값: 오늘)
- 카테고리 선택 (Category Picker 사용)
- 계좌 선택 (기본값: Cash 계좌)
- 메모 (선택)
- [저장] 버튼

**동작:**
- 저장 → POST /transactions (manual source)
- 목록 즉시 업데이트

---

### 4.4 Category Picker (공용 모달)

**Phase:** 1B-categorize (현재 존재)

**요소:**
- 검색 필드 ("카테고리 검색")
- 카테고리 목록 (알파벳 또는 자주 쓰는 순)
  - 각 row: 아이콘 + 이름
  - 현재 선택된 카테고리에 체크마크
- 하단: "새 카테고리 만들기" 버튼 (이름 입력 inline)

**동작:**
- 선택 즉시 dismiss + 부모 화면에 값 전달

---

## 5. Banks 화면

### 5.1 Banks 목록

**Phase:** 1B-mobile

**전체 레이아웃:**
```
┌───────────────────────────────┐
│  은행 연결              [+]   │
├───────────────────────────────┤
│  ┌─────────────────────────┐  │
│  │ 🏦 BMO Bank             │  │
│  │    Chequing ••••1234    │  │
│  │    Savings  ••••5678    │  │
│  │    마지막 sync: 방금     │  │
│  │    [새로고침]  [해제]    │  │
│  └─────────────────────────┘  │
│                               │
│  ┌─────────────────────────┐  │
│  │ ⚠️ TD Bank  (재연결 필요) │  │
│  │    계정 접근이 만료됨    │  │
│  │    [재연결] [해제]       │  │
│  └─────────────────────────┘  │
│                               │
│  ─── 은행 연결이 뭔가요? ──── │
│  Plaid를 통해 안전하게...      │
└───────────────────────────────┘
```

**요소:**

연결된 은행 카드 (정상):
- 은행 로고 + 이름
- 연결된 계좌 목록 (account mask, type)
- 마지막 sync 시간 ("방금", "2시간 전", "3일 전")
- [새로고침] 버튼 → manual sync
- [관리] 또는 [해제] 버튼

연결된 은행 카드 (error — relink_required):
- ⚠️ 아이콘
- "계정 접근이 만료됐습니다" 메시지
- [재연결] 버튼 → Plaid Link re-auth flow

우상단 [+]:
- Free 탭 시 → Upgrade Prompt ("Plaid 연결은 Lite부터 가능해요")
- Lite 탭 시 이미 1개 연결 → Upgrade Prompt ("Pro면 무제한 연결 가능해요")
- Lite 첫 연결 / Pro → Plaid Link 시트

하단 설명 섹션:
- Plaid 보안 설명 (이미 연결한 사람에게는 collapse 가능)

**동작:**
- 새로고침 탭 → sync 진행 인디케이터 → 완료 토스트 ("23개 트랜잭션 업데이트됨")
- 해제 탭 → confirm ("연결을 해제하면 새 트랜잭션이 자동 추가되지 않아요. 기존 내역은 유지됩니다") → 확인 시 disconnect

---

### 5.2 Plaid Link 흐름 (Native Sheet)

**Phase:** 1B-mobile

`react-native-plaid-link-sdk` 가 처리하는 네이티브 화면 — 앱이 직접 만드는 UI 아님.

**진입 → 종료 흐름:**
1. [+] 탭 → PlaidLink 컴포넌트 마운트 → Plaid 네이티브 시트 오픈
2. 사용자: 기관 선택 → 자격증명 입력 → 계좌 선택
3. Plaid: public_token 발급
4. 앱: `/plaid/exchange` POST → 백엔드 access_token 교환 + 초기 sync
5. 성공 → 시트 dismiss → Banks 화면 업데이트 (새 은행 카드 표시)
6. 실패 → 에러 토스트 + Plaid 에러 코드 로그

**에러 케이스:**
- `ITEM_LOGIN_REQUIRED` → 재로그인 안내
- `INSTITUTION_DOWN` → "기관 서버가 점검 중. 잠시 후 다시 시도해주세요"
- `already_connected` (P2002) → "이미 연결된 계좌예요"

---

### 5.3 계좌 상세 (Account Detail)

**Phase:** 1B-mobile

**진입:** Banks 목록의 계좌 row 탭

**요소:**
- 계좌명 + 번호 (mask)
- 계좌 종류 (Chequing / Savings / Credit Card 등)
- 잔고 (current, available, limit — 해당 있는 것만)
- 마지막 잔고 업데이트 시간
- 이 계좌의 최근 트랜잭션 목록 (최근 10개)
- [전체 트랜잭션 보기] → Transactions 목록으로 이동 (해당 계좌 필터 적용)
- [계좌 숨기기] 버튼 (status = hidden)

---

## 6. Settings 화면

### 6.1 Settings 홈

**Phase:** 1A (기본), 점진적 섹션 추가

**전체 레이아웃:**
```
┌───────────────────────────────┐
│  설정                          │
├───────────────────────────────┤
│  ┌─────────────────────────┐  │
│  │  Brian Choi             │  │  ← 프로필 섹션
│  │  cwsbrian@gmail.com     │  │
│  │  Pro Trial · 27일 남음   │  │
│  └─────────────────────────┘  │
│                               │
│  ─ Workspace ──────────────── │
│    내 workspace      >        │
│    멤버 관리         >        │
│    워크스페이스 전환  >        │
│                               │
│  ─ AI 설정 ────────────────── │
│    아침 브리핑 시간   >        │
│    브리핑 일시중지    토글     │
│                               │
│  ─ 구독 ───────────────────── │
│    구독 관리         >        │
│                               │
│  ─ 개인정보 ───────────────── │
│    데이터 내보내기    >        │
│    계정 삭제         >        │
│                               │
│    로그아웃                   │
└───────────────────────────────┘
```

**요소:**

프로필 섹션:
- 이름 + 이메일
- 현재 tier 표시 ("Pro Trial · 27일 남음" / "Pro" / "Lite" / "Free")
- Trial 만료 임박 시 (5일 전부터) 주황색으로 강조

**동작:**
- 프로필 섹션 탭 → 프로필 편집 화면

---

### 6.2 프로필 편집

**Phase:** 1A

**요소:**
- 이름 편집 필드
- 이메일 (읽기 전용, 변경은 별도 인증 flow)
- 아바타 (Phase 2: 사진 업로드)
- [저장] 버튼

---

### 6.3 Workspace 설정

**Phase:** 1.5-mobile

**요소:**
- 워크스페이스 이름 편집 (owner만)
- 멤버 목록
  - 각 row: 이름 + 이메일 + 역할 (owner/editor/viewer) + 상태 (active/pending)
  - Owner: 역할 변경 버튼, 제거 버튼
  - Pending invite: 취소 버튼
- 초대 보내기
  - 이메일 입력 + 역할 선택 (editor/viewer) + [초대 보내기]
  - 초대 보내면 pending row에 추가

**동작:**
- 역할 변경 → confirm ("Brian을 viewer로 변경할까요?")
- 멤버 제거 → confirm ("Brian을 workspace에서 제거할까요?")
- Owner 본인 제거 → 불가 ("workspace owner는 제거할 수 없어요. 먼저 소유권 이전을 하세요")

---

### 6.4 Workspace 전환 (Switcher)

**Phase:** 1.5-mobile

**진입:** Settings의 "워크스페이스 전환" 또는 헤더 workspace 이름 탭

**요소:**
- 워크스페이스 목록
  - 각 row: 이름 + 역할 + 체크마크 (현재 선택)
- 하단: "새 워크스페이스 만들기" (선택, v2)

**동작:**
- 다른 ws 탭 → X-Workspace-Id 변경 → 모든 화면 데이터 새로고침
- AsyncStorage에 마지막 선택 ws 저장

---

### 6.5 아침 브리핑 설정

**Phase:** 2

**요소:**
- 브리핑 켜기/끄기 토글
- 시간 picker (기본 8:00 AM)
- 타임존 (자동 감지, 변경 가능)
- "일시 중지" 설정: 특정 날짜까지 중지 (date picker)
- 테스트 전송: [지금 브리핑 받아보기] 버튼 (sandbox 즉시 발송)

---

### 6.6 구독 관리

**Phase:** 2 (billing 구현 시)

**요소:**

현재 구독 섹션:
- 현재 플랜 (Free / Lite / Pro / Pro Trial)
- 만료일 / 다음 결제일
- 결제 수단 (IAP 출처 표시 — "App Store를 통해 결제 중")

플랜 비교표:
| 기능 | Free | Lite $7 | Pro $15 |
| Plaid 연결 | ❌ | 1개 | 무제한 |
| AI 채팅 | ❌ | 읽기전용 | ✅ |
| 아침 브리핑 | 기본 | AI 브리핑 | AI 브리핑 |

IAP 버튼:
- [Lite 구독하기] / [Pro 구독하기]
- Apple/Google IAP 결제 시트 오픈
- "웹에서 가입하면 더 저렴해요" 멘트 없음 (App Store 정책)

Web 결제 안내:
- "이미 웹에서 구독하셨나요? 로그인하면 자동으로 적용됩니다"

구독 관리 링크:
- "App Store에서 구독 관리" (Settings > [user] > Subscriptions 딥링크)

---

### 6.7 데이터 내보내기

**Phase:** 2

**요소:**
- 기간 선택 (기본: 전체)
- 형식 선택: CSV
- [내보내기] 버튼 → 공유 시트 (Files, 이메일 등)

---

### 6.8 계정 삭제

**Phase:** 1A (법적 요구사항)

**요소:**
- 경고 텍스트 ("모든 데이터가 영구적으로 삭제됩니다")
- 이메일 재입력 확인 필드
- [삭제 확인] 버튼 (빨간색)

**동작:**
- 삭제 → 로그아웃 → Auth Stack → 계정 삭제 완료 화면

---

## 7. 공용 모달 / 오버레이

### 7.1 Upgrade Prompt

**Phase:** 1B-mobile (tier gating 시작)

**진입:** Plaid connect(Free), chat input(Lite/Free), 특정 기능 접근 시

**요소:**
- 반모달 시트 (bottom sheet)
- 잠긴 기능 아이콘
- 헤드라인: "이 기능은 Lite부터 사용할 수 있어요"
- 기능 목적 설명 (1-2줄)
- [Lite로 업그레이드 $7/월] 버튼
- [Pro로 업그레이드 $15/월] 버튼 (Pro 기능인 경우)
- [나중에] 버튼

---

### 7.2 Trial 만료 배너 (인앱)

**Phase:** 2

**진입:** 만료 5일 전부터, 앱 오픈 시 1회 표시

**요소:**
- 상단 배너 또는 전체 모달 (만료 당일)
- "Pro Trial이 N일 후 만료됩니다"
- [구독하기] / [나중에]
- 만료 후: "Trial이 종료됐어요. Plaid 연결과 AI 기능이 잠깁니다" + [업그레이드]

---

### 7.3 Bank Item Error 배너

**Phase:** 1B-mobile

**진입:** plaid_items.status = relink_required 인 item 존재 시

**요소:**
- 상단 인라인 배너 (Chat/Transactions/Banks 화면 상단)
- "BMO 계정 접근이 만료됐어요 — 재연결 필요"
- [재연결] 탭 → Banks 화면 → Plaid Link re-auth

---

## 8. Push Notification

**Phase:** 2

### 8.1 권한 요청

**진입:** 가입 후 최초 Chat 화면 진입 시 (또는 Settings에서)

**요소:**
- 사전 설명 화면: "Fina가 아침에 알려드리려면 알림 권한이 필요해요"
- [허용] → iOS/Android 시스템 권한 요청 시트
- [나중에] → 나중에 Settings에서 재요청 가능

### 8.2 Notification 종류

| 종류 | 내용 | 탭 시 이동 |
|---|---|---|
| Daily ritual | "Fina가 어제 내역 정리했어요 ☀️" | 오늘 daily thread |
| Ritual (카드 없음) | "어제 $127 썼어. 이번 주 예산 68%" | 오늘 daily thread |
| Anomaly (Phase 3) | "비정상적으로 큰 지출 감지: Loblaws $342" | Transaction Detail |
| Trial 만료 임박 | "Pro Trial 3일 남았어" | Settings > 구독 |
| Plaid error | "BMO 계정 재연결이 필요해요" | Banks 화면 |

---

## 9. Tier Gating 레퍼런스

| 기능 | Free | Lite | Pro |
|---|---|---|---|
| Transactions 조회 | ✅ (manual only) | ✅ (Plaid 1개) | ✅ (무제한) |
| 트랜잭션 수동 추가 | ✅ | ✅ | ✅ |
| 카테고리/예산/스케줄 | ✅ | ✅ | ✅ |
| Workspace sharing | ✅ | ✅ | ✅ |
| Plaid 연결 | ❌ → Upgrade prompt | 1개 | 무제한 |
| AI 카테고리 제안 | ❌ | ✅ | ✅ |
| Daily ritual (AI) | ❌ (기본 stats push만) | ✅ (read-only) | ✅ |
| Chat — categorize_card 탭 | ❌ | ✅ | ✅ |
| Chat — 자유 입력 | ❌ (input bar 잠김) | ❌ (input bar 잠김) | ✅ |
| Plan generation, deep audit | ❌ | ❌ | ✅ (Phase 3) |
| Receipt OCR | ❌ | ❌ | ✅ (Phase 3) |

---

## 10. 구현 Phase별 화면 요약

| Phase | 포함 화면 |
|---|---|
| **1A** | Splash, Onboarding, Sign Up, Sign In, 이메일 인증, Settings 홈 (기본), 프로필 편집, 계정 삭제, 수동 트랜잭션 추가 (stub) |
| **1B-mobile** | Transactions 목록, Transaction Detail, Category Picker, Banks 목록, Account Detail, Plaid Link flow, Upgrade Prompt |
| **1.5-mobile** | Workspace 설정, 멤버 관리, Workspace Switcher |
| **1C** | Chat Thread (text + categorize_card + confirm_card 렌더러), input bar tier gating |
| **Phase 2** | Morning ritual push flow, schedule_form/budget_edit/quick_replies 블록, 아침 브리핑 설정, 구독 관리, 데이터 내보내기, Trial 만료 UX, push 권한 요청, Bank error 배너 |
| **Phase 3** | Anomaly alerts, Receipt OCR, Plan generation UI, Goal tracking, Historical comparison |
