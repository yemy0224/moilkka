// 49th 푸시 발송 서버 함수
// 데이터베이스의 예약 작업(tick)이 1분마다 불러요. 대기열의 알림을 꺼내 각 기기로 보내요.
// Supabase 대시보드 → Edge Functions → 이름 push 로 만들고, JWT 확인(Verify JWT)은 꺼주세요.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return keys.default ?? Object.values(keys)[0] ?? "";
  } catch {
    return "";
  }
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
    auth: { persistSession: false },
  });

  // 데이터베이스가 부른 게 맞는지 확인
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: ok, error: secretErr } = await db.rpc("push_check_secret", { p_secret: secret });
  if (secretErr) return json({ error: secretErr.message }, 500);
  if (!ok) return json({ error: "forbidden" }, 403);

  // 알림 서명 키: 없으면 처음 한 번 만들어서 저장
  let { data: stored } = await db.rpc("push_get_vapid");
  if (!stored) {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    const appKey = await webpush.exportApplicationServerKey(keys);
    const { error } = await db.rpc("push_set_vapid", {
      p_public: exported.publicKey,
      p_private: exported.privateKey,
      p_app_key: appKey,
    });
    if (error) return json({ error: error.message }, 500);
    ({ data: stored } = await db.rpc("push_get_vapid")); // 동시에 만들었으면 먼저 저장된 걸 써요
  }
  const vapidKeys = await webpush.importVapidKeys(
    { publicKey: stored.public_jwk, privateKey: stored.private_jwk },
    { extractable: false },
  );
  const server = await webpush.ApplicationServer.new({
    contactInformation: "https://github.com/yemy0224/49th-app",
    vapidKeys,
  });

  const { data: rows, error: takeErr } = await db.rpc("push_take", { p_limit: 100 });
  if (takeErr) return json({ error: takeErr.message }, 500);

  // 알림 하나가 기기 하나라도에 닿으면 보낸 걸로 쳐요
  const delivered = new Set<number>();
  const failed = new Set<number>();
  let gone = 0;

  await Promise.all(
    (rows ?? []).map(async (r: any) => {
      try {
        const sub = server.subscribe({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });
        await sub.pushTextMessage(
          JSON.stringify({ title: r.title, body: r.body, url: r.url ?? "/" }),
          { ttl: 86400 } as any,
        );
        delivered.add(r.id);
      } catch (e) {
        if (e instanceof webpush.PushMessageError && e.isGone()) {
          // 앱을 지웠거나 알림을 끈 기기
          await db.rpc("push_drop_subscription", { p_endpoint: r.endpoint });
          gone++;
          delivered.add(r.id);
        } else {
          console.error("push failed", r.id, String(e));
          failed.add(r.id);
        }
      }
    }),
  );

  const done = [...delivered];
  const retry = [...failed].filter((id) => !delivered.has(id));
  if (done.length) await db.rpc("push_done", { p_ids: done });
  if (retry.length) await db.rpc("push_fail", { p_ids: retry });

  return json({ sent: done.length, retry: retry.length, gone });
});
