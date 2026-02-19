import crypto from "crypto";

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  ALLOWED_DOMAIN, // Note: This should be exactly "momswapped.blogspot.com" (No https://)
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  GITHUB_TOKEN,
  GITHUB_USERNAME,
  GITHUB_REPO
} = process.env;

const SESSION_DURATION = 1000 * 60 * 60 * 4; // 4 hours

// =============================
// SESSION HELPERS
// =============================
function signSession(username) {
  const payload = JSON.stringify({ user: username, exp: Date.now() + SESSION_DURATION });
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64") + "." + signature;
}

function verifySession(token) {
  try {
    const [payloadB64, signature] = token.split(".");
    const payload = Buffer.from(payloadB64, "base64").toString();
    const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
    if (signature !== expectedSig) return null;
    const data = JSON.parse(payload);
    return data.exp < Date.now() ? null : data;
  } catch { return null; }
}

// =============================
// GITHUB HELPERS
// =============================
async function uploadToGitHub(path, base64Content) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Upload ${path}`, content: base64Content })
  });
  if (!response.ok) throw new Error("GitHub upload failed. File might exceed 20MB.");
  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${GITHUB_REPO}/main/${path}`;
}

async function safeDeleteGitHub(path) {
  try {
    const getRes = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });
    if (!getRes.ok) return; // File already deleted or missing

    const file = await getRes.json();
    await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Delete ${path}`, sha: file.sha })
    });
  } catch (e) { console.log(`Safely skipped GitHub deletion for ${path}`); }
}

// =============================
// MAIN HANDLER
// =============================
export default async function handler(req, res) {
  const action = req.query.action;
  const origin = req.headers.origin;

  // ---------------------------
  // STRONG ORIGIN LOCK
  // ---------------------------
  // 1. Block requests with no Origin (e.g., direct API calls from bots/Postman)
  if (!origin) {
    return res.status(403).json({ error: "Forbidden: Missing Origin Header" });
  }

  // 2. Block requests from any domain other than your specific Blogger site
  try {
    const originHost = new URL(origin).hostname;
    if (originHost !== ALLOWED_DOMAIN) {
      return res.status(403).json({ error: "Forbidden: Invalid Origin Domain" });
    }
  } catch (err) {
    return res.status(403).json({ error: "Forbidden: Malformed Origin" });
  }

  // If it passes the lock, grant CORS access specifically to that origin
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Pre-flight request for browsers
  if (req.method === "OPTIONS") return res.status(200).end();

  // ---------------------------
  // LOGIN / LOGOUT
  // ---------------------------
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

  // ---------------------------
  // SESSION VALIDATION
  // ---------------------------
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: "Unauthorized: No cookie" });
  
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ error: "Unauthorized: Invalid session format" });
  
  const session = verifySession(match[1]);
  if (!session) return res.status(401).json({ error: "Unauthorized: Session expired" });

  // ---------------------------
  // DATABASE OPERATIONS
  // ---------------------------
  try {
    // 1. READ (GET)
    if (req.method === "GET") {
      const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
      return res.status(200).json(await response.json());
    }

    // 2. CREATE (POST)
    if (req.method === "POST") {
      const { 
        title, postUrl, url, labels, author, // Now fully synced with 8 GAS columns
        videoBase64, originalVideoName, 
        thumbnailBase64, originalThumbName 
      } = req.body;

      // Ensure GitHub files get unique names
      const videoPath = `videos/${postUrl}-${originalVideoName}`;
      const thumbPath = `thumbnails/${postUrl}-${originalThumbName}`;

      const vUrl = await uploadToGitHub(videoPath, videoBase64);
      const tUrl = await uploadToGitHub(thumbPath, thumbnailBase64);

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title || "",
          postUrl: postUrl || "",
          url: url || "", 
          videoLink: vUrl,
          featureImage: tUrl,
          labels: labels || "",
          published: new Date().toISOString(),
          author: author || "Hulk King"
        })
      });
      return res.status(200).json({ success: true });
    }

    // 3. EDIT/UPDATE (PUT)
    if (req.method === "PUT") {
      // Passes the body straight to GAS, which is expecting the 8 columns + rowIndex
      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body)
      });
      return res.status(200).json({ success: true });
    }

    // 4. DELETE (DELETE)
    if (req.method === "DELETE") {
      const { rowIndex, vPath, tPath } = req.body;

      // Delete from GitHub if paths are provided
      if (vPath) await safeDeleteGitHub(vPath);
      if (tPath) await safeDeleteGitHub(tPath);

      // Delete from Google Sheets
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
