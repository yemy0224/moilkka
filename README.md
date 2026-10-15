# 49th

친구 일곱 명이 날짜 투표 없이 약속을 잡는 웹앱이에요. 될 수도 있는 점심·저녁을 칠해두면, 8~14일 뒤 같은 시간대에 기준 인원 이상 겹칠 때 방이 생기고 초대장이 가요.

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

### 3. (선택) 지난 방 자동 청소

마감이 지난 방은 이미 화면에 안 보이지만, 데이터까지 지우려면:

1. **Database** → **Extensions**에서 `pg_cron`을 켜요.
2. SQL Editor에서 아래를 한 번 실행해요.

```sql
select cron.schedule('49th-cleanup', '0 * * * *', 'select public.cleanup_rooms()');
```

### 4. Vercel에 올리기

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
| `.github/workflows/keepalive.yml` | 하루 한 번 Supabase를 깨워서 잠들지 않게 해요 |

## 첫 버전에 들어간 것

- 홈 화면 설치 안내, 프로필, 그룹 만들기, 초대 번호로 참여
- 점심·저녁 칠하기, 친구 수 표시(누가 칠했는지는 안 보여요)
- 8~14일 뒤 같은 시간대에 기준 인원 이상 겹치면 자동 방 생성, 응답 마감 3일
- 참석·패스(패스는 본인만 보여요), 기준 인원이 참석하면 확정
- 확정 후 누가 빠지거나 X를 누르면 방 삭제, 그 시간대엔 다시 안 생겨요
- 직접 방 만들기(초대한 친구만 보이고, 모두 참석해야 확정)
- 설정: 프로필 수정, 초대 번호 공유, 기준 인원(방장만), 그룹 나가기

## 다음에 붙일 것

시간 투표와 마감 자동 확정, 맛집 풀과 하트, 푸시 알림, 또 갈래요, 동네 분포도.

## 알아둘 점

- 로그인은 기기 단위예요. 앱을 지우거나 브라우저 데이터를 지우면 초대 번호로 다시 들어와야 하고, 이전 기록은 이어지지 않아요.
- `config.js`의 키는 공개용이에요. **secret 키와 DB 비밀번호는 절대 이 저장소에 넣지 마세요.**
- 화면 파일을 고친 뒤 폰에 바로 안 바뀌면 `sw.js`의 `CACHE` 버전 숫자를 하나 올려주세요.
