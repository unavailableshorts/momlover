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
    // FIXED: Better domain check that handles 'www' and subdomains
    if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
      return res.status(403).json({ error: "Forbidden: Invalid Public Origin" });
    }
  } catch (err) { return res.status(403).json({ error: "Forbidden: Malformed Origin" }); }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}`);
    const data = await response.json();
    
    // FIXED: Mapping to handle spaces in Sheet Headers (e.g., 'post url' -> 'postUrl')
    let posts = (data.posts || []).map(p => ({
      title: p.Title || p.title,
      postUrl: p['post url'] || p.postUrl || p.slug, 
      videoLink: p['Video Link'] || p.videoLink,
      featureImage: p['Feature Image'] || p.featureImage,
      labels: p.Labels || p.labels || "",
      published: p.Published || p.published || p.Timestamp,
      author: p.Author || p.author || "Hulk King",
      views: parseInt(p.Views || p.views || 0)
    }));

    const { action, page = 1, limit = 8, query = "", slug = "" } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const startIndex = (pageNum - 1) * limitNum;

    // ACTION: VIEW INCREMENT
    if (req.method === "POST" && action === "view") {
      const { slug: postSlug } = req.body;
      fetch(`${GOOGLE_SCRIPT_URL}?key=${GOOGLE_SECRET_KEY}&action=increment_view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: postSlug })
      });
      return res.status(200).json({ success: true });
    }

    // ACTION: GET POSTS
    if (action === "get_posts" || !action) {
      return res.status(200).json({
        success: true,
        page: pageNum,
        totalPages: Math.ceil(posts.length / limitNum),
        results: posts.slice(startIndex, startIndex + limitNum)
      });
    }

    // ACTION: GET SINGLE POST
    if (action === "get_post") {
      const singlePost = posts.find(p => p.postUrl === slug);
      if (!singlePost) return res.status(404).json({ error: "Post not found" });
      
      const related = posts.filter(p => p.postUrl !== slug).slice(0, 3);
      return res.status(200).json({ success: true, post: singlePost, relatedPosts: related });
    }

    // ACTION: POPULAR
    if (action === "get_popular") {
      const popular = [...posts].sort((a, b) => b.views - a.views).slice(0, 5);
      return res.status(200).json({ success: true, results: popular });
    }

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
