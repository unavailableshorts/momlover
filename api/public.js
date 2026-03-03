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
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
    const data = await response.json();
    
    let allPosts = data.posts || [];

    // ==========================================
    // 🛡️ PUBLIC VISIBILITY FILTER (CRITICAL)
    // ==========================================
    const now = new Date();
    let posts = allPosts.filter(p => {
      // 1. Check for hidden Draft label or status
      const isDraft = (p.labels || "").toLowerCase().includes("_draft") || p.status === "draft";
      
      // 2. Check if the publish date is in the future
      const pubDate = new Date(p.published || p.timestamp || 0);
      const isFuture = pubDate > now;

      // Only return true if it's NOT a draft and NOT scheduled for the future
      return !isDraft && !isFuture;
    });

    // ==========================================
    // ACTION: GET LABELS 
    // ==========================================
    if (action === "get_labels") {
      const labelsSet = new Set();
      posts.forEach(p => {
        if (p.labels) {
          p.labels.split(",")
            .map(l => l.trim())
            .filter(l => l !== "" && l !== "_draft") // Don't show draft tag in category list
            .forEach(l => labelsSet.add(l));
        }
      });
      return res.status(200).json({ success: true, labels: Array.from(labelsSet) });
    }

    // ==========================================
    // GLOBAL SORTING ENGINE
    // ==========================================
    if (sort === "popular") {
        posts.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
    } else if (sort === "oldest") {
        posts.sort((a, b) => new Date(a.published || a.timestamp || 0) - new Date(b.published || b.timestamp || 0));
    } else {
        posts.sort((a, b) => new Date(b.published || b.timestamp || 0) - new Date(a.published || a.timestamp || 0));
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const startIndex = (pageNum - 1) * limitNum;

    // ==========================================
    // ACTION: SEARCH
    // ==========================================
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

    // ==========================================
    // ACTION: GET SINGLE POST
    // ==========================================
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

    // ==========================================
    // ACTION: GET POPULAR (Featured Widget)
    // ==========================================
    if (action === "get_popular") {
      const popular = [...posts].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0)).slice(0, 6);
      return res.status(200).json({ success: true, posts: popular });
    }

    // ==========================================
    // ACTION: GET POSTS (DEFAULT GRID)
    // ==========================================
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
