import crypto from "crypto";

const {
  ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET, ALLOWED_DOMAIN,
  GOOGLE_SCRIPT_URL, GOOGLE_SECRET_KEY, GITHUB_TOKEN,
  GITHUB_USERNAME, GITHUB_REPO
} = process.env;

const SESSION_DURATION = 1000 * 60 * 60 * 4;

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

async function uploadToGitHub(path, base64Content) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Upload ${path}`, content: base64Content })
  });
  if (!res.ok) throw new Error("GitHub upload failed");
  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${GITHUB_REPO}/main/${path}`;
}

async function safeDeleteGitHub(path) {
  try {
    const getRes = await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });
    if (!getRes.ok) return;
    const file = await getRes.json();
    await fetch(`https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/contents/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Delete ${path}`, sha: file.sha })
    });
  } catch (e) { console.log(`Skipped GitHub delete for ${path}`); }
}

export default async function handler(req, res) {
  const action = req.query.action;
  const origin = req.headers.origin;

  if (!origin || new URL(origin).hostname !== ALLOWED_DOMAIN) {
    return res.status(403).json({ error: "Forbidden: Invalid Origin" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (action === "login") {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid credentials" });
    const token = signSession(username);
    res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_DURATION/1000}`);
    return res.status(200).json({ success: true });
  }
  if (action === "logout") {
    res.setHeader("Set-Cookie", "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
    return res.status(200).json({ success: true });
  }

  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: "No cookie" });
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ error: "Invalid session" });
  const session = verifySession(match[1]);
  if (!session) return res.status(401).json({ error: "Session expired" });

  try {
    // --- 🔥 UPDATED GET BLOCK FOR PAGINATION ---
    if (req.method === "GET") {
      const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
      const data = await response.json();
      let posts = data.posts || [];

      // Extract query parameters sent from Blogger
      const { page = 1, limit = 20, query = "", sort = "newest" } = req.query;

      // 1. Calculate Dashboard Stats BEFORE pagination/filtering
      let totalViews = 0, highestViews = 0, topVideo = "-";
      const labelsSet = new Set();
      
      posts.forEach(p => {
        let v = parseInt(p.views) || 0;
        totalViews += v;
        if (v > highestViews) { highestViews = v; topVideo = p.title; }
        if (p.labels) p.labels.split(',').forEach(l => labelsSet.add(l.trim().toLowerCase()));
      });
      const stats = { totalVideos: posts.length, totalViews, topVideo };
      const tags = Array.from(labelsSet).filter(t => t !== "" && t !== "_draft");

      // 2. Apply Search Filter
      if (query) {
        const q = query.toLowerCase();
        posts = posts.filter(p => 
          (p.title && p.title.toLowerCase().includes(q)) || 
          (p.labels && p.labels.toLowerCase().includes(q))
        );
      }

      // 3. Apply Sorting
      if (sort === "popular") {
        posts.sort((a, b) => (parseInt(b.views) || 0) - (parseInt(a.views) || 0));
      } else if (sort === "oldest") {
        posts.sort((a, b) => new Date(a.published || a.timestamp || 0) - new Date(b.published || b.timestamp || 0));
      } else {
        // newest (default)
        posts.sort((a, b) => new Date(b.published || b.timestamp || 0) - new Date(a.published || a.timestamp || 0));
      }

      // 4. Server-Side Slicing (Pagination)
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const startIndex = (pageNum - 1) * limitNum;
      const paginatedPosts = posts.slice(startIndex, startIndex + limitNum);

      // 5. Send back the tiny, fast payload
      return res.status(200).json({
        posts: paginatedPosts,
        totalPages: Math.ceil(posts.length / limitNum),
        totalFound: posts.length,
        stats: stats,
        tags: tags
      });
    }

    // --- CREATE POST ---
    if (req.method === "POST") {
      const { title, postUrl, url, labels, author, published, videoLink, thumbnailBase64, originalThumbName, status } = req.body;
      
      const vUrl = videoLink; 
      const tUrl = await uploadToGitHub(`thumbnails/${postUrl}-${originalThumbName}`, thumbnailBase64);

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=create`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, postUrl, url, videoLink: vUrl, featureImage: tUrl, labels, published, author, status })
      });
      return res.status(200).json({ success: true });
    }

    // --- UPDATE POST ---
    if (req.method === "PUT") {
      const { 
        rowIndex, title, postUrl, url, labels, author, published, 
        videoLink, featureImage, 
        newVideoLink, oldVideoPath, 
        thumbnailBase64, originalThumbName, oldThumbPath,
        status 
      } = req.body;

      let finalVideoUrl = videoLink;
      let finalThumbUrl = featureImage;

      if (newVideoLink) {
        finalVideoUrl = newVideoLink;
        if (oldVideoPath) await safeDeleteGitHub(oldVideoPath); 
      }

      if (thumbnailBase64) {
        const newTPath = `thumbnails/${postUrl}-new-${originalThumbName}`;
        finalThumbUrl = await uploadToGitHub(newTPath, thumbnailBase64);
        if (oldThumbPath) await safeDeleteGitHub(oldThumbPath); 
      }

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=update`, {
        method: "POST", 
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          rowIndex, title, postUrl, url, labels, published, author,
          videoLink: finalVideoUrl, 
          featureImage: finalThumbUrl,
          status
        })
      });

      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { rowIndex, vPath, tPath } = req.body;
      if (vPath) await safeDeleteGitHub(vPath);
      if (tPath) await safeDeleteGitHub(tPath);

      await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIndex })
      });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
