const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers['x-forwarded-host'];

  const setCorsHeaders = (allowedOrigin) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  };

  if (req.method === "OPTIONS") {
    setCorsHeaders(origin);
    return res.status(200).end();
  }

  // Security Check
  if (origin && ALLOWED_PUBLIC_DOMAIN) {
    try {
      const originHost = new URL(origin.startsWith('http') ? origin : `https://${origin}`).hostname;
      if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
        return res.status(403).json({ error: "Forbidden Origin" });
      }
    } catch (err) {}
  }

  setCorsHeaders(origin);
  
  const { action, page = 1, limit = 24, query = "", slug = "", sort = "newest" } = req.query;

  // 1. ANALYTICS (POST)
  if (req.method === "POST") {
    const postSlug = req.body?.slug;
    const gasAction = action === "view" ? "increment_view" : (action === "sync_state" ? "increment_click" : null);

    if (gasAction && postSlug) {
      fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=${gasAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: postSlug })
      }).catch(() => {});
      return res.status(200).json({ success: true });
    }
  }

  // 2. DATA FETCHING (GET) - NO CACHE
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      action: action,
      page: page,
      limit: limit,
      query: query || "",
      sort: sort,
      slug: slug,
      t: Date.now() // Bypass internal fetch cache
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`, {
      cache: 'no-store' 
    });
    const data = await response.json();

    if (!data.success) return res.status(500).json({ error: data.error });

    if (action === "get_models") {
      return res.status(200).json({ success: true, models: data.models });
    }

    // 🛠️ SECURITY FILTER (Exact India IST Timezone Fix)
    const now = new Date();
    // Shift Google's clock forward by exactly 5.5 hours to match India Standard Time
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    
    if (!isAdmin) {
      posts = posts.filter(p => {
        const isDraft = (p.labels || "").includes("_draft") || p.status === "draft";
        let pTime = new Date(p.published).getTime();
        
        // Compare the exact India time against the post time
        const isFuture = !isNaN(pTime) && pTime > istTime.getTime();
        return !isDraft && !isFuture;
      });
    }

    // Prepare filtered list for Grid and Related sections
    const allFilteredPosts = (data.posts || []).filter(filterVisibility);

    // 3. Handle Single Post View
    if (slug || action === "get_post") {
      const post = data.post;
      if (!post || !filterVisibility(post)) {
        return res.status(404).json({ error: "Post not found or not yet available" });
      }

      const postLabels = (post.labels || "").split(",").map(l => l.trim().toLowerCase());
      const related = allFilteredPosts
        .filter(p => p.postUrl !== post.postUrl && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
        .slice(0, 6);

      return res.status(200).json({ success: true, post, relatedPosts: related });
    }

    // 4. Default: Grid View
    return res.status(200).json({
      success: true,
      page: parseInt(data.page || page),
      totalPages: data.totalPages,
      totalFound: data.totalFound,
      posts: allFilteredPosts,
      stats: data.stats
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
