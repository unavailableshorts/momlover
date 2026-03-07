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
  
  const { action, page = 1, limit = 20, query = "", slug = "", sort = "newest" } = req.query;

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
    // 🛠️ FIX 1: Ask Google Sheets for a massive batch so we have plenty of data to filter
    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      action: action === "search" ? "search" : "read",
      query: query || "",
      sort: sort || "newest",
      page: 1,      // Always pull from the beginning
      limit: 2000   // Pull up to 2000 rows to ensure we don't run out after filtering
    });

    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();
    
    let posts = data.posts || [];

    // 🛠️ FIX 2: Run the Visibility Filter on the MASSIVE batch first
    const now = new Date();
    posts = posts.filter(p => {
      const isDraft = (p.labels || "").toLowerCase().includes("_draft") || p.status === "draft";
      const pubDate = new Date(p.published || p.timestamp || 0);
      return !isDraft && pubDate <= now;
    });

    // 6. Handle Single Post Requests
    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });
      
      const postLabels = (singlePost.labels || "").split(",").map(l => l.trim().toLowerCase());
      const related = posts
        .filter(p => p.postUrl !== slug && (p.labels || "").split(",").some(l => postLabels.includes(l.trim().toLowerCase())))
        .slice(0, 6); 
      
      return res.status(200).json({ success: true, post: singlePost, relatedPosts: related });
    }

    // 🛠️ FIX 3: Manually paginate inside Vercel AFTER filtering
    const reqPage = parseInt(page) || 1;
    const reqLimit = parseInt(limit) || 21;
    const startIndex = (reqPage - 1) * reqLimit;
    const endIndex = startIndex + reqLimit;
    
    const paginatedPosts = posts.slice(startIndex, endIndex);

    // Default Response (Grid)
    return res.status(200).json({
      success: true,
      page: reqPage,
      totalPages: Math.ceil(posts.length / reqLimit), // Accurate total pages!
      totalPosts: posts.length,                       // Accurate total posts!
      posts: paginatedPosts                           // Will always equal your limit (20) unless you hit the end!
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: "Public API Error: " + error.message });
  }
}
