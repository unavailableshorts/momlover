import crypto from "crypto";

function verifyToken(token) {
  try {
    const [dataB64, signature] = token.split(".");
    const data = Buffer.from(dataB64, "base64").toString();

    const expectedSig = crypto
      .createHmac("sha256", process.env.SESSION_SECRET)
      .update(data)
      .digest("hex");

    if (signature !== expectedSig) return null;

    const payload = JSON.parse(data);
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {

  // 🔒 CORS (IMPORTANT — Replace your blog URL)
  res.setHeader("Access-Control-Allow-Origin", "https://momswapped.blogspot.com");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 🔐 SESSION VALIDATION
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: "Unauthorized" });

  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ error: "Unauthorized" });

  const session = verifyToken(match[1]);
  if (!session) return res.status(401).json({ error: "Session expired" });

  const TOKEN = process.env.GITHUB_TOKEN;
  const USER = process.env.GITHUB_USERNAME;
  const REPO = process.env.GITHUB_REPO;

  try {

    // =========================
    // 📂 LIST FILES / FOLDERS
    // =========================
    if (req.method === "GET") {

      const folder = req.query.path || "";

      const listRes = await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${folder}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      );

      const data = await listRes.json();

      if (!listRes.ok) {
        return res.status(500).json({ error: data.message });
      }

      return res.status(200).json(data);
    }

    // =========================
    // ⬆ UPLOAD FILE
    // =========================
    if (req.method === "POST") {

      const { content, path } = req.body;

      if (!content || !path) {
        return res.status(400).json({ error: "Missing fields" });
      }

      // Check existing file (overwrite detection)
      const checkRes = await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${path}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      );

      let sha = null;
      if (checkRes.status === 200) {
        const existing = await checkRes.json();
        sha = existing.sha;
      }

      const uploadRes = await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${path}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: sha ? `Update ${path}` : `Upload ${path}`,
            content,
            ...(sha && { sha })
          })
        }
      );

      const result = await uploadRes.json();

      if (!uploadRes.ok) {
        return res.status(500).json({ error: result.message });
      }

      return res.status(200).json({ success: true });
    }

    // =========================
    // ✏ RENAME FILE
    // =========================
    if (req.method === "PUT") {

      const { oldPath, newPath } = req.body;

      if (!oldPath || !newPath) {
        return res.status(400).json({ error: "Missing fields" });
      }

      const getRes = await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${oldPath}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      );

      if (!getRes.ok) {
        return res.status(404).json({ error: "File not found" });
      }

      const file = await getRes.json();

      // Create new file
      await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${newPath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: `Rename ${oldPath} to ${newPath}`,
            content: file.content
          })
        }
      );

      // Delete old file
      await fetch(
        `https://api.github.com/repos/${USER}/${REPO}/contents/${oldPath}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: `Delete ${oldPath}`,
            sha: file.sha
          })
        }
      );

      return res.status(200).json({ success: true });
    }

    // =========================
    // 🗑 DELETE (Single or Bulk)
    // =========================
    if (req.method === "DELETE") {

      const { paths } = req.body;

      if (!paths || !Array.isArray(paths)) {
        return res.status(400).json({ error: "Paths array required" });
      }

      for (let path of paths) {

        const getRes = await fetch(
          `https://api.github.com/repos/${USER}/${REPO}/contents/${path}`,
          {
            headers: { Authorization: `Bearer ${TOKEN}` }
          }
        );

        if (!getRes.ok) continue;

        const file = await getRes.json();

        await fetch(
          `https://api.github.com/repos/${USER}/${REPO}/contents/${path}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              message: `Delete ${path}`,
              sha: file.sha
            })
          }
        );
      }

      return res.status(200).json({ success: true });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
