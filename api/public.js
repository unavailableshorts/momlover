const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY,
  ALLOWED_PUBLIC_DOMAIN 
} = process.env;

export default async function handler(req, res) {
  // 1. ORIGIN SECURITY & CORS
  const origin = req.headers.origin || req.headers['x-forwarded-host'] || "";

  const setCorsHeaders = (allowedOrigin) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // Pre-flight request handler
  if (req.method === "OPTIONS") {
    setCorsHeaders(origin);
    return res.status(200).end();
  }

  // Domain Verification
  if (origin && ALLOWED_PUBLIC_DOMAIN) {
    try {
      const originUrl = origin.startsWith('http') ? origin : `https://${origin}`;
      const originHost = new URL(originUrl).hostname;
      // Allow momswapped.blogspot.com and www.momswapped.blogspot.com
      if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
        return res.status(403).json({ error: "Forbidden: Invalid Public Origin" });
      }
    } catch (err) {
      // Ignore parse errors, let it fall through to fetch
    }
  }

  setCorsHeaders(origin);
  
  // Extract URL parameters
  const { action, page = 1, limit = 12, query = "", slug = "" } = req.query;

  // ==========================================
  // ACTION: VIEW INCREMENT (POST REQUEST)
  // ==========================================
  if (req.method === "POST" && action === "view") {
    const postSlug = req.body?.slug;
    if (postSlug) {
      // Send a ping to Google Apps Script to update the sheet (Fire and forget)
      fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=increment_view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: postSlug })
      }).catch(e => console.log("Analytics ping failed"));
    }
    return res.status(200).json({ success: true, message: "View counted" });
  }

  // ==========================================
  // FETCH DATA FROM GOOGLE APPS SCRIPT
  // ==========================================
  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
    const data = await response.json();
    
    // We expect { success: true, posts: [...] } from Function 2
    // NEW LOGIC: .reverse() is added here so the last row in your sheet shows up first!
    let posts = (data.posts || []).reverse();

    // Pagination math
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
        success: true,
        page: pageNum,
        totalPages: Math.ceil(filtered.length / limitNum),
        totalPosts: filtered.length,
        posts: filtered.slice(startIndex, startIndex + limitNum)
      });
    }

    // ==========================================
    // ACTION: GET SINGLE POST (With Related)
    // ==========================================
    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });
      
      // Find 3 related posts based on labels
      const postLabels = singlePost.labels ? singlePost.labels.split(",").map(l => l.trim().toLowerCase()) : [];
      let related = posts.filter(p => p.postUrl !== slug && p.labels && p.labels.split(",").some(l => postLabels.includes(l.trim().toLowerCase())));
      
      // If we don't have enough related posts, pad with random/latest posts
      if (related.length < 3) {
        const others = posts.filter(p => p.postUrl !== slug && !related.includes(p));
        related = [...related, ...others];
      }
      
      return res.status(200).json({ 
        success: true, 
        post: singlePost, 
        relatedPosts: related.slice(0, 3) 
      });
    }

    // ==========================================
    // ACTION: GET POPULAR
    // ==========================================
    if (action === "get_popular") {
      // Sort by views, descending
      const popular = [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 6);
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
