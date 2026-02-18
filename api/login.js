import crypto from "crypto";

const SESSION_DURATION = 1000 * 60 * 60 * 4; // 4 hours

function signToken(payload) {
  const data = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(data)
    .digest("hex");

  return Buffer.from(data).toString("base64") + "." + signature;
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "https://momswapped.blogspot.com");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password } = req.body;

  if (
    username !== process.env.ADMIN_USERNAME ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const payload = {
    user: username,
    exp: Date.now() + SESSION_DURATION
  };

  const token = signToken(payload);

  res.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_DURATION/1000}`
  );

  return res.status(200).json({ success: true });
}

