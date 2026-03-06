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
  
  const { action, page = 1, limit = 12, query = "", slug = "", sort = "newest" } = req.query;

  // ==========================================
  // VIEW COUNTER (DO NOT CACHE THIS!)
  // ==========================================
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

  // ==========================================
  // 🚀 VERCEL EDGE CACHE ENGINE (60s)
  // ==========================================
  /* ==========================================
   🚀 OPTIMIZED PUBLIC FETCH
========================================== */
res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

try {
    // 1. Build the query for Google Script
    // We pass the key, action, query, and sort so Google does the filtering
    const googleParams = new URLSearchParams({
        key: GOOGLE_SECRET_KEY,
        action: action === "search" ? "search" : "read", // Match your GAS logic
        query: query || "",
        sort: sort || "newest",
        page: page,
        limit: limit
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();
    
    // 2. Ensure we are working with a clean array
    let posts = data.posts || [];

    // 🛡️ PUBLIC VISIBILITY FILTER (Double Check)
    // Even if Google filters it, we keep this as a backup safety layer
    const now = new Date();
    posts = posts.filter(p => {
        const isDraft = (p.labels || "").toLowerCase().includes("_draft") || p.status === "draft";
        const pubDate = new Date(p.published || p.timestamp || 0);
        return !isDraft && pubDate <= now;
    });

    // ==========================================
    // ACTION: GET SINGLE POST (Slug logic)
    // ==========================================
    if (action === "get_post") {
        const singlePost = posts.find(p => p.postUrl === slug);
        if (!singlePost) return res.status(404).json({ error: "Post not found" });
        
        // Related posts logic remains the same...
        const postLabels = (singlePost.labels || "").split(",").map(l => l.trim().toLowerCase());
        const related = posts
            .filter(p => p.postUrl !== slug && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
            .slice(0, 3);
        
        return res.status(200).json({ success: true, post: singlePost, relatedPosts: related });
    }

    // ==========================================
    // DEFAULT RESPONSE (Grid)
    // ==========================================
    return res.status(200).json({
        success: true,
        page: parseInt(page),
        totalPages: data.totalPages || Math.ceil(posts.length / limit),
        totalPosts: data.totalFound || posts.length,
        posts: posts // Google already sliced this for us
    });

} catch (error) {
    return res.status(500).json({ success: false, error: "Public API Error: " + error.message });
}
  }
}
