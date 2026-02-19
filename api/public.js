const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  const origin = req.headers.origin;

  if (!origin) return res.status(403).json({ error: "Forbidden: Missing Origin" });

  try {
    const originHost = new URL(origin).hostname;
    if (originHost !== ALLOWED_PUBLIC_DOMAIN) {
      return res.status(403).json({ error: "Forbidden: Invalid Public Origin" });
    }
  } catch (err) { return res.status(403).json({ error: "Forbidden: Malformed Origin" }); }

  res.setHeader("Access-Control-Allow-Origin", origin);
  // NEW: Allow POST requests so the frontend can send view counts
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // ==========================================
  // INCREMENT VIEW COUNTER (POST REQUEST)
  // ==========================================
  if (req.method === "POST" && req.query.action === "view") {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    // Tell Google Sheets to add +1 to the view count
    // We don't await this because we want to return a fast response to the user
    fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=increment_view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug })
    });

    return res.status(200).json({ success: true, message: "View counted" });
  }

  // From here down, it's just GET requests
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  // Cache data for fast loading
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=86400");

  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
    const data = await response.json();
    let posts = data.posts || [];

    posts.sort((a, b) => a.rowIndex - b.rowIndex);

    const { action, page = 1, limit = 12, query = "", slug = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const startIndex = (pageNum - 1) * limitNum;

    if (action === "get_posts") {
      return res.status(200).json({
        success: true, page: pageNum, totalPages: Math.ceil(posts.length / limitNum),
        totalPosts: posts.length, posts: posts.slice(startIndex, startIndex + limitNum)
      });
    }

    if (action === "search") {
      const lowerQuery = query.toLowerCase();
      const filteredPosts = posts.filter(p => p.title.toLowerCase().includes(lowerQuery) || p.labels.toLowerCase().includes(lowerQuery));
      return res.status(200).json({
        success: true, page: pageNum, totalPages: Math.ceil(filteredPosts.length / limitNum),
        totalPosts: filteredPosts.length, posts: filteredPosts.slice(startIndex, startIndex + limitNum)
      });
    }

    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });

      const postLabels = singlePost.labels.split(",").map(l => l.trim().toLowerCase());
      let related = posts.filter(p => p.postUrl !== slug && p.labels.split(",").some(l => postLabels.includes(l.trim().toLowerCase())));

      if (related.length < 3) {
        const others = posts.filter(p => p.postUrl !== slug && !related.includes(p));
        related = [...related, ...others];
      }
      return res.status(200).json({ success: true, post: singlePost, relatedPosts: related.slice(0, 3) });
    }

    // ==========================================
    // REAL MOST POPULAR
    // ==========================================
    if (action === "get_popular") {
      // NEW: Sort by the actual 'views' number from highest to lowest
      const popularPosts = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0));
      
      return res.status(200).json({
        success: true,
        posts: popularPosts.slice(0, 6) // Give back the top 6 most viewed
      });
    }

    return res.status(400).json({ error: "Invalid API action specified." });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to fetch data." });
  }
}
