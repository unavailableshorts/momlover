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

/* ===============================
   SESSION FUNCTIONS
================================ */
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

/* ===============================
   GITHUB THUMBNAIL UPLOAD
================================ */
async function uploadThumbnail(path, base64Content) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Upload ${path}`, content: base64Content })
    }
  );
  if (!res.ok) throw new Error("Thumbnail upload failed");
  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${GITHUB_REPO}/main/${path}`;
}

async function deleteThumbnail(path) {
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
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Delete ${path}`, sha: file.sha })
      }
    );
  } catch {}
}

/* ===============================
   MAIN HANDLER
================================ */
export default async function handler(req, res) {
  const action = req.query.action;
  const origin = req.headers.origin;

  if (!origin || new URL(origin).hostname !== ALLOWED_DOMAIN) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  /* LOGIN/LOGOUT */
  if (action === "login") {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signSession(username);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_DURATION / 1000}`);
    return res.json({ success: true });
  }
  
  if (action === "logout") {
    res.setHeader("Set-Cookie", "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
    return res.json({ success: true });
  }

  /* SESSION CHECK */
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: "No session" });
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ error: "Invalid session" });
  const session = verifySession(match[1]);
  if (!session) return res.status(401).json({ error: "Session expired" });

  try {
    /* FETCH POSTS */
    if (req.method === "GET") {
      const googleParams = new URLSearchParams({
        key: GOOGLE_SECRET_KEY,
        page: req.query.page || 1,
        limit: req.query.limit || 20,
        query: req.query.query || "",
        sort: req.query.sort || "newest"
      });
      const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
      const data = await response.json();
      return res.json({
        posts: data.posts || [], totalPages: data.totalPages || 1,
        totalFound: data.totalFound || 0, stats: data.stats || {}, tags: data.tags || []
      });
    }

    /* CREATE POST & MANAGE MODELS (POST) */
    if (req.method === "POST") {
      const bodyAction = req.body.action;

      // 🛠️ ADD MODEL (WITH GITHUB UPLOAD)
      if (bodyAction === "add_model") {
        const { name, img, imageBase64 } = req.body;
        let finalImgUrl = img;

        if (imageBase64) {
          const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
          const imgPath = `models/${cleanName}-${Date.now()}.jpg`;
          finalImgUrl = await uploadThumbnail(imgPath, imageBase64);
        }

        const gsRes = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=add_model`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add_model", name, img: finalImgUrl })
        });
        const gsData = await gsRes.json();
        return res.json(gsData);
      }

      // 🛠️ DELETE MODEL (WITH GITHUB DELETE)
      if (bodyAction === "delete_model") {
        const { name, imgPath } = req.body;
        
        if (imgPath && imgPath.includes('githubusercontent.com')) {
           const pathPart = imgPath.split('main/')[1];
           if (pathPart) await deleteThumbnail(pathPart);
        }

        const gsRes = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=delete_model`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete_model", name })
        });
        const gsData = await gsRes.json();
        return res.json(gsData);
      }

      // --- STANDARD CREATE POST ---
      const { title, postUrl, url, labels, author, published, videoLink, videoTrailer, featureImage, thumbnailBase64, originalThumbName, isManualThumb, status } = req.body;
      
      let finalThumbUrl = featureImage;
      if (!isManualThumb && thumbnailBase64) {
        const thumbPath = `thumbnails/${postUrl}-${originalThumbName}`;
        finalThumbUrl = await uploadThumbnail(thumbPath, thumbnailBase64);
      }

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=create`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", title, postUrl, url, videoLink, videoTrailer, featureImage: finalThumbUrl, labels, published, author, status })
      });
      return res.json({ success: true });
    }

    /* UPDATE POST */
    if (req.method === "PUT") {
      const { rowIndex, title, postUrl, url, labels, author, published, videoLink, videoTrailer, featureImage, thumbnailBase64, originalThumbName, oldThumbPath, status } = req.body;
      let finalThumb = featureImage;
      if (thumbnailBase64) {
        const newPath = `thumbnails/${postUrl}-${originalThumbName}`;
        finalThumb = await uploadThumbnail(newPath, thumbnailBase64);
        if (oldThumbPath) await deleteThumbnail(oldThumbPath);
      }
      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=update`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", rowIndex, title, postUrl, url, labels, videoLink, videoTrailer, featureImage: finalThumb, published, author, status })
      });
      return res.json({ success: true });
    }

    /* DELETE POST */
    if (req.method === "DELETE") {
      const { rowIndex, tPath } = req.body;
      if (tPath) await deleteThumbnail(tPath);
      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", rowIndex })
      });
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
