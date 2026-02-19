import crypto from "crypto";

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  ALLOWED_DOMAIN,
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  GITHUB_TOKEN,
  GITHUB_USERNAME,
  GITHUB_REPO
} = process.env;

const SESSION_DURATION = 1000 * 60 * 60 * 4;

// =============================
// SESSION HELPERS
// =============================

function signSession(username) {
  const payload = JSON.stringify({
    user: username,
    exp: Date.now() + SESSION_DURATION
  });

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");

  return Buffer.from(payload).toString("base64") + "." + signature;
}

function verifySession(token) {
  try {
    const [payloadB64, signature] = token.split(".");
    const payload = Buffer.from(payloadB64, "base64").toString();

    const expectedSig = crypto
      .createHmac("sha256", SESSION_SECRET)
      .update(payload)
      .digest("hex");

    if (signature !== expectedSig) return null;

    const data = JSON.parse(payload);
    if (data.exp < Date.now()) return null;

    return data;
  } catch {
    return null;
  }
}

// =============================
// GITHUB FUNCTIONS
// =============================

async function uploadToGitHub(path, base64Content) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `Upload ${path}`,
        content: base64Content
      })
    }
  );

  if (!response.ok) {
    throw new Error("GitHub upload failed");
  }

  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${GITHUB_REPO}/main/${path}`;
}

async function deleteFromGitHub(path) {
  try {
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    if (!getRes.ok) return;

    const file = await getRes.json();

    await fetch(
      `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `Delete ${path}`,
          sha: file.sha
        })
      }
    );
  } catch (e) { console.error("Skip delete error", e); }
}

// =============================
// MAIN HANDLER
// =============================

export default async function handler(req, res) {
  const action = req.query.action;
  const origin = req.headers.origin;

  if (origin && new URL(origin).hostname !== ALLOWED_DOMAIN) {
    return res.status(403).json({ error: "Access denied" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // LOGIN / LOGOUT
  if (action === "login") {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signSession(username);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_DURATION/1000}`);
    return res.status(200).json({ success: true });
  }

  if (action === "logout") {
    res.setHeader("Set-Cookie", "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
    return res.status(200).json({ success: true });
  }

  // SESSION CHECK
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: "Not logged in" });
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ error: "Invalid session" });
  const session = verifySession(match[1]);
  if (!session) return res.status(401).json({ error: "Session expired" });

  try {
    if (req.method === "GET") {
      const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
      return res.status(200).json(await response.json());
    }

    if (req.method === "POST") {
      const { title, postUrl, labels, author, videoBase64, thumbnailBase64, originalVideoName, originalThumbName } = req.body;

      // Preserving original names inside folders
      const videoPath = `videos/${originalVideoName}`;
      const thumbPath = `thumbnails/${originalThumbName}`;

      const videoUrl = await uploadToGitHub(videoPath, videoBase64);
      const thumbUrl = await uploadToGitHub(thumbPath, thumbnailBase64);

      // Sending to Google Apps Script matching your sheet columns
      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title,
          postUrl: postUrl,
          videoLink: videoUrl,
          featureImage: thumbUrl,
          labels: labels,
          published: new Date().toISOString(),
          author: author
        })
      });

      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { rowIndex, vPath, tPath } = req.body;
      if (vPath) await deleteFromGitHub(vPath);
      if (tPath) await deleteFromGitHub(tPath);

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIndex })
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
