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
  
  const { action, page = 1, limit = 21, query = "", slug = "", sort = "newest" } = req.query;

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

  // 2. DATA FETCHING (GET)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    // Send standard parameters to Google
    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      page: page,
      limit: limit,
      query: query || "",
      sort: sort,
      slug: slug // Google Script uses this for 'get_post'
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();

    if (!data.success) return res.status(500).json({ error: data.error });

    // Handle Single Post View (with related posts logic)
    if (slug || action === "get_post") {
      const post = data.post;
      if (!post) return res.status(404).json({ error: "Post not found" });

      // Build related posts from the 'posts' array Google sent back
      const postLabels = (post.labels || "").split(",").map(l => l.trim().toLowerCase());
      const related = (data.posts || [])
        .filter(p => p.postUrl !== post.postUrl && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
        .slice(0, 6);

      return res.status(200).json({ success: true, post, relatedPosts: related });
    }

    // Default: Grid View
    return res.status(200).json({
      success: true,
      page: parseInt(data.page || page),
      totalPages: data.totalPages,
      totalFound: data.totalFound,
      posts: data.posts,
      stats: data.stats
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
