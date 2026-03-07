const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers['x-forwarded-host'] || "";

  // 1. Set CORS Headers
  const setCorsHeaders = (allowedOrigin) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  if (req.method === "OPTIONS") {
    setCorsHeaders(origin);
    return res.status(200).end();
  }

  // 2. Security Check
  if (origin && ALLOWED_PUBLIC_DOMAIN) {
    try {
      const originUrl = origin.startsWith('http') ? origin : `https://${origin}`;
      const originHost = new URL(originUrl).hostname;
      if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
        return res.status(403).json({ error: "Forbidden: Invalid Public Origin" });
      }
    } catch (err) {
      // Quietly continue if URL parsing fails
    }
  }

  setCorsHeaders(origin);
  
  const { action, page = 1, limit = 12, query = "", slug = "", sort = "newest" } = req.query;

  // 3. View Counter (POST)
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

  // 4. Data Fetching (GET)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    // 🔥 FIX: If we are getting a single post, we need ALL posts to search through 
    // and to generate related posts. We override the limit to 5000 here.
    const isSinglePostRequest = action === "get_post";
    const fetchLimit = isSinglePostRequest ? 5000 : limit;

    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      action: action === "search" ? "search" : "read",
      query: query || "",
      sort: sort || "newest",
      page: isSinglePostRequest ? 1 : page,
      limit: fetchLimit
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();
    
    let posts = data.posts || [];

    // 5. Visibility Filter (Safety Layer)
    const now = new Date();
    posts = posts.filter(p => {
      const isDraft = (p.labels || "").toLowerCase().includes("_draft") || p.status === "draft";
      const pubDate = new Date(p.published || p.timestamp || 0);
      return !isDraft && pubDate <= now;
    });

    // 6. Handle Specific Actions
    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });
      
      const postLabels = (singlePost.labels || "").split(",").map(l => l.trim().toLowerCase());
      const related = posts
        .filter(p => p.postUrl !== slug && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
        .slice(0, 6); // Up to 6 related posts looks better on grid!
      
      return res.status(200).json({ success: true, post: singlePost, relatedPosts: related });
    }

    // Default Response (Grid)
    return res.status(200).json({
      success: true,
      page: parseInt(page),
      totalPages: data.totalPages || Math.ceil(posts.length / limit),
      totalPosts: data.totalFound || posts.length,
      posts: posts.slice(0, limit) // Ensure we only return the requested limit to the grid
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Public API Error: " + error.message });
  }
}
