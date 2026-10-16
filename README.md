# 모일까

친구 모임이 날짜 투표 없이 약속을 잡는 웹앱이에요. 한 사람이 여러 그룹에 들어갈 수 있고, 그룹끼리는 서로 보이지 않아요. 될 수도 있는 점심·저녁을 칠해두면, 8~14일 뒤 같은 시간대에 기준 인원 이상 겹칠 때 방이 생기고 초대장이 가요.

빌드 과정이 없는 정적 웹앱이에요. 파일을 그대로 올리면 돌아가요.

## 처음 한 번만 하는 설정

### 1. Supabase 데이터베이스 만들기

1. Supabase 대시보드에서 49th 프로젝트를 열어요.
2. 왼쪽 메뉴 **SQL Editor** → **New query**를 눌러요.
3. `supabase/migrations/0001_init.sql` 파일 내용을 전부 붙여넣고 **Run**을 눌러요. "Success"가 나오면 끝이에요.

### 2. 익명 로그인 켜기

친구들이 이메일 없이 바로 들어올 수 있게 해요.

1. 왼쪽 메뉴 **Authentication** → **Sign In / Providers**(화면에 따라 Providers 또는 Settings)로 가요.
2. **Allow anonymous sign-ins**를 켜고 저장해요.

### 3. (0004를 실행했다면 건너뛰기) 지난 방 자동 청소

마감이 지난 방은 이미 화면에 안 보이지만, 데이터까지 지우려면:

1. **Database** → **Extensions**에서 `pg_cron`을 켜요.
2. SQL Editor에서 아래를 한 번 실행해요.

```sql
select cron.schedule('49th-cleanup', '0 * * * *', 'select public.cleanup_rooms()');
```

### 4. 알림 설정

1. Supabase 왼쪽 메뉴 **Edge Functions** → **Deploy a new function** → **Via Editor**를 눌러요.
2. 함수 이름을 `push`로 하고, `supabase/functions/push/index.ts` 내용을 전부 붙여넣고 **Deploy**를 눌러요.
3. 만든 함수의 **Details**(또는 Settings)에서 **Verify JWT**(Enforce JWT)를 꺼요. 데이터베이스가 따로 비밀번호를 붙여 부르기 때문에 괜찮아요.
4. SQL Editor에서 `supabase/migrations/0004_push.sql`을 실행해요.
5. 1분쯤 기다리면 알림 키가 자동으로 만들어져요. 그다음 앱 **설정 → 이 기기 알림 → 켜기**를 눌러요. 아이폰은 홈 화면에 추가한 앱에서만 켤 수 있어요.

0004를 실행하면 1분마다 도는 예약 작업(`49th-tick`)이 생겨서, 지난 방 정리와 투표 마감도 앱을 아무도 안 열어도 제때 처리돼요. (3번 자동 청소는 안 해도 돼요)

### 5. 새 친구용 주소 추가 (선택)

1. Vercel → 49th-app 프로젝트 → **Settings → Domains** → **Add**
2. `moilkka-app.vercel.app` 입력 → 추가
3. 이미 쓰고 있는 사람은 원래 주소(49th-app.vercel.app)를 계속 써요. 주소마다 로그인이 따로라서, 새 주소로 다시 설치하면 새 사람이 돼요.
4. 앱 안의 초대 번호 공유는 `config.js`의 `PUBLIC_URL`(새 주소)로 나가요.

### 6. Vercel에 올리기

1. vercel.com에 GitHub으로 로그인해요.
2. **Add New → Project** → `49th-app` 저장소를 **Import**해요.
3. Framework Preset은 **Other**, Build Command와 Output Directory는 비워둔 채로 **Deploy**를 눌러요.
4. 나온 주소(예: `49th-app.vercel.app`)를 친구들에게 보내면 돼요.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | 앱 화면 전부 |
| `config.js` | Supabase 주소와 공개용 키 |
| `manifest.webmanifest`, `sw.js`, `icons/` | 홈 화면에 설치되는 앱으로 만드는 파일 |
| `supabase/migrations/0001_init.sql` | 테이블, 보안 규칙, 방 자동 생성 규칙 |
| `supabase/migrations/0005~0011` | 규칙 정리, 빠지기, 내보내기, 빠르게 칠하기, 맛집 종류, 직접 방 유지, 여러 그룹 |
| `supabase/functions/push/index.ts` | 알림을 실제로 보내는 서버 함수 |
| `.github/workflows/keepalive.yml` | 하루 한 번 Supabase를 깨워서 잠들지 않게 해요 |

## 첫 버전에 들어간 것

- 홈 화면 설치 안내, 프로필, 그룹 만들기, 초대 번호로 참여
- 점심·저녁 칠하기, 친구 수 표시(누가 칠했는지는 안 보여요), 빠르게 칠하기(주말 저녁·주말 점심·평일 저녁, 4주) · 전체 지우기
- 8~14일 뒤 같은 시간대에 기준 인원 이상 겹치면 자동 방 생성, 응답 마감 3일
- 참석·패스(패스는 본인만 보여요), 기준 인원이 참석하면 확정
- 확정 후 누가 빠져도 남은 참석자가 기준 인원(직접 방은 2명) 이상이면 모임 유지, 아니면 방 삭제. 확정된 자동 방은 X로 못 없애요
- 빠지거나 지우거나 패스한 사람은 그 칸 칠이 지워지고, 누가 새로 칠해야 다시 생겨요
- 자동 방 응답 마감: 3일 뒤와 모임 5일 전 밤 9시 중 빠른 쪽 · 시간·식당 투표 마감: 모임 3일 전 밤 9시
- 직접 방 만들기(번개 포함, 초대한 친구만 보이고 모두 참석해야 확정, 응답은 전날 밤 9시까지 · 촉박하면 당일 밤까지)
- 설정: 프로필 수정, 초대 번호 공유, 기준 인원(방장만), 멤버 내보내기(방장만), 그룹 나가기(방장이 나가면 가장 먼저 들어온 멤버가 방장)

## 다음에 붙일 것

또 갈래요, 동네 분포도, 네이버 지도 링크로 이름 자동 채우기.

## 알아둘 점

- 로그인은 기기 단위예요. 앱을 지우거나 브라우저 데이터를 지우면 초대 번호로 다시 들어와야 하고, 이전 기록은 이어지지 않아요.
- `config.js`의 키는 공개용이에요. **secret 키와 DB 비밀번호는 절대 이 저장소에 넣지 마세요.**
- 화면 파일을 고친 뒤 폰에 바로 안 바뀌면 `sw.js`의 `CACHE` 버전 숫자를 하나 올려주세요.
