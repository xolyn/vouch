const CLASSLESS_CSS = "https://static.zly.vg/sample/style.css";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlPage(message, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${CLASSLESS_CSS}">
  <title>Vouch</title>
</head>
<body>
  <header>
    <p style="font-family: Inter, sans-serif; font-weight: bold;">Vouch</p>
  </header>
  <main>
    <p>${message}</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildEmailHtml(confirmUrl) {
  return `<!DOCTYPE html>
<html lang="zh">
<body style="font-family:sans-serif;max-width:480px;margin:40px auto;color:#111">
  <h2 style="margin-bottom:8px">验证你的邮箱</h2>
  <p style="color:#555">点击下方按钮确认你的邮箱地址，链接 <strong>10 分钟</strong>内有效。</p>
  <a href="${confirmUrl}"
     style="display:inline-block;margin:24px 0;padding:12px 28px;background:#000;color:#fff;
            text-decoration:none;border-radius:6px;font-size:15px">
    ✅ 验证邮箱
  </a>
  <p style="font-size:13px;color:#999">或复制以下链接：<br>${confirmUrl}</p>
  <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
  <p style="font-size:12px;color:#bbb">如果你没有发起此请求，请忽略这封邮件。</p>
</body>
</html>`;
}

async function handleVerify(request, env) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) {
    return json({ error: "missing_email" }, 400);
  }

  const rateLimitKey = "rl:" + email;
  const rateLimited = await env.EMAIL_VERIFY_KV.get(rateLimitKey);
  if (rateLimited) {
    return json({ error: "too_soon" }, 429);
  }

  const token = crypto.randomUUID();
  const cs = crypto.randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const record = { email, status: "pending", expiresAt };

  await env.EMAIL_VERIFY_KV.put(token, JSON.stringify(record), {
    expirationTtl: 660,
  });
  await env.EMAIL_VERIFY_KV.put("cs:" + cs, token, { expirationTtl: 660 });
  await env.EMAIL_VERIFY_KV.put(rateLimitKey, "1", { expirationTtl: 60 });

  const origin = new URL(request.url).origin;
  const confirmUrl = `${origin}/confirm?cs=${cs}`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: email,
      subject: "验证你的邮箱",
      html: buildEmailHtml(confirmUrl),
    }),
  });

  if (!emailRes.ok) {
    return json({ error: "email_send_failed" }, 500);
  }

  return json({ token });
}

async function handleConfirm(request, env) {
  const cs = new URL(request.url).searchParams.get("cs");
  if (!cs) {
    return htmlPage("链接无效或已过期", 410);
  }

  const token = await env.EMAIL_VERIFY_KV.get("cs:" + cs);
  if (!token) {
    return htmlPage("链接无效或已过期", 410);
  }

  const raw = await env.EMAIL_VERIFY_KV.get(token);
  if (!raw) {
    return htmlPage("链接无效或已过期", 410);
  }

  const data = JSON.parse(raw);

  if (Date.now() > data.expiresAt) {
    await env.EMAIL_VERIFY_KV.put(
      token,
      JSON.stringify({ ...data, status: "expired" }),
      { expirationTtl: 60 }
    );
    return htmlPage("链接已过期，请重新发起验证", 410);
  }

  if (data.status === "approved") {
    return htmlPage("邮箱已验证过了");
  }

  await env.EMAIL_VERIFY_KV.put(
    token,
    JSON.stringify({ ...data, status: "approved" }),
    { expirationTtl: 600 }
  );

  return htmlPage("✅ 邮箱验证成功！可以关闭此页面了");
}

async function handleCheck(request, env) {
  const params = new URL(request.url).searchParams;
  const token = params.get("token");
  const email = params.get("email");

  if (!token) {
    return json({ error: "missing_token" }, 400);
  }

  if (!email) {
    return json({ error: "missing_email" }, 400);
  }

  const raw = await env.EMAIL_VERIFY_KV.get(token);
  if (!raw) {
    return json({ status: "expired" });
  }

  const data = JSON.parse(raw);

  if (data.email !== email) {
    return json({ error: "not_found" }, 404);
  }

  if (data.status === "pending" && Date.now() > data.expiresAt) {
    return json({ status: "expired" });
  }

  return json({ status: data.status, email: data.email });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && pathname === "/verify") {
      return handleVerify(request, env);
    }

    if (method === "GET" && pathname === "/confirm") {
      return handleConfirm(request, env);
    }

    if (method === "GET" && pathname === "/check") {
      return handleCheck(request, env);
    }

    return json({ error: "not_found" }, 404);
  },
};
