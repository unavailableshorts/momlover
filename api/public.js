const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers['x-forwarded-host'];

  // 1. Set CORS Headers
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

  // 2. Security Check (Public Domain)
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
  
  const { action, page = 1, limit = 21, query = "", slug = "", sort = "newest" } = req.query;

  // 3. Analytics Counters (POST Actions)
  if (req.method === "POST") {
    const postSlug = req.body?.slug;
    
    // Check for both view and sync_state (click) actions
    const gasAction = action === "view" ? "increment_view" : (action === "sync_state" ? "increment_click" : null);

    if (gasAction && postSlug) {
      // Background ping to Google Apps Script doPost
      fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=${gasAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: postSlug })
      }).catch(e => console.log("Analytics ping failed"));

      return res.status(200).json({ success: true, message: "Activity logged" });
    }
  }

  // 4. Data Fetching (GET)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

  try {
    // We now send ALL parameters to Google. 
    // Google will handle the 2,700+ rows much faster than Vercel can.
    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      page: page,
      limit: limit,
      query: query,
      sort: sort,
      slug: slug // Used for get_post action
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Google Script failed to return data");
    }

    // 5. Single Post Logic (Including Related Posts)
    if (action === "get_post") {
      if (!data.post) return res.status(404).json({ error: "Post not found" });
      
      // Related posts logic: find posts with similar labels from the main results
      // If Google didn't return them, we can use the main posts list
      const postLabels = (data.post.labels || "").split(",").map(l => l.trim().toLowerCase());
      const allPosts = data.posts || [];
      
      const related = allPosts
        .filter(p => p.postUrl !== slug && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
        .slice(0, 6);
      
      return res.status(200).json({ 
        success: true, 
        post: data.post, 
        relatedPosts: related 
      });
    }

    // 6. Default Response (Grid/Search)
    // We just return what Google already paginated and filtered for us.
    return res.status(200).json({
      success: true,
      page: parseInt(data.page || page),
      totalPages: data.totalPages,
      totalFound: data.totalFound,
      posts: data.posts,
      stats: data.stats,
      tags: data.tags
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Public API Error: " + error.message });
  }
}
