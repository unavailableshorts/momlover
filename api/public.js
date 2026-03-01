const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers['x-forwarded-host'] || "";

  const setCorsHeaders = (allowedOrigin) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  if (req.method === "OPTIONS") {
    setCorsHeaders(origin);
    return res.status(200).end();
  }

  if (origin && ALLOWED_PUBLIC_DOMAIN) {
    try {
      const originUrl = origin.startsWith('http') ? origin : `https://${origin}`;
      const originHost = new URL(originUrl).hostname;
      if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
        return res.status(403).json({ error: "Forbidden: Invalid Public Origin" });
      }
    } catch (err) {}
  }

  setCorsHeaders(origin);
  
  // NEW: Added 'sort' to the extracted query parameters (defaults to newest)
  const { action, page = 1, limit = 12, query = "", slug = "", sort = "newest" } = req.query;

  if (req.method === "POST" && action === "view") {
    const postSlug = req.body?.slug;
    if (postSlug) {
      fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=increment_view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: postSlug })
      }).catch(e => console.log("Analytics ping failed"));
    }
    return res.status(200).json({ success: true, message: "View counted" });
  }

  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
    const data = await response.json();
    
    let posts = data.posts || [];

    // ==========================================
    // ACTION: GET LABELS 
    // ==========================================
    if (action === "get_labels") {
      const labelsSet = new Set();
      posts.forEach(p => {
        if (p.labels) p.labels.split(",").forEach(l => labelsSet.add(l.trim()));
      });
      const uniqueLabels = Array.from(labelsSet).filter(l => l !== "");
      return res.status(200).json({ success: true, labels: uniqueLabels });
    }

    // ==========================================
    // 💎 NEW GLOBAL SORTING ENGINE 💎
    // Vercel sorts the entire array BEFORE paginating!
    // ==========================================
    if (sort === "popular") {
        posts.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
    } else if (sort === "oldest") {
        posts.sort((a, b) => new Date(a.published || a.timestamp || 0) - new Date(b.published || b.timestamp || 0));
    } else {
        // Default: Newest first
        posts.sort((a, b) => new Date(b.published || b.timestamp || 0) - new Date(a.published || a.timestamp || 0));
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const startIndex = (pageNum - 1) * limitNum;

    // ACTION: SEARCH
    if (action === "search") {
      const lowerQuery = query.toLowerCase();
      const filtered = posts.filter(p => 
        (p.title && p.title.toLowerCase().includes(lowerQuery)) || 
        (p.labels && p.labels.toLowerCase().includes(lowerQuery))
      );
      
      return res.status(200).json({
        success: true, page: pageNum, totalPages: Math.ceil(filtered.length / limitNum), totalPosts: filtered.length,
        posts: filtered.slice(startIndex, startIndex + limitNum)
      });
    }

    // ACTION: GET SINGLE POST
    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });
      
      const postLabels = singlePost.labels ? singlePost.labels.split(",").map(l => l.trim().toLowerCase()) : [];
      let related = posts.filter(p => p.postUrl !== slug && p.labels && p.labels.split(",").some(l => postLabels.includes(l.trim().toLowerCase())));
      
      if (related.length < 3) {
        const others = posts.filter(p => p.postUrl !== slug && !related.includes(p));
        related = [...related, ...others];
      }
      
      return res.status(200).json({ success: true, post: singlePost, relatedPosts: related.slice(0, 3) });
    }

    // ACTION: GET POPULAR (For the top featured widget - overrides standard limit)
    if (action === "get_popular") {
      // By default, sorting engine already handled popular if requested, but we force slice(0,6) here for the widget
      const popular = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 6);
      return res.status(200).json({ success: true, posts: popular });
    }

    // ACTION: GET POSTS (DEFAULT GRID)
    // Server securely slices only the 12 items needed for this specific page!
    return res.status(200).json({
      success: true,
      page: pageNum,
      totalPages: Math.ceil(posts.length / limitNum),
      totalPosts: posts.length,
      posts: posts.slice(startIndex, startIndex + limitNum)
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to fetch data: " + error.message });
  }
}
