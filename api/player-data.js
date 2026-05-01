// api/player-data.js

const {
  GOOGLE_SCRIPT_URL,
  GOOGLE_SECRET_KEY
} = process.env;

// 🔥 HARDCODED DOMAIN LOCK 🔥
const ALLOWED_PUBLIC_DOMAIN = "topgkindia.blogspot.com"; 

export default async function handler(req, res) {
  // 1. Grab the origin of the request
  const origin = req.headers.origin || req.headers['x-forwarded-host'];

  // Helper function to set CORS headers
  const setCorsHeaders = (allowedOrigin) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // 2. Preflight Request Handling
  if (req.method === "OPTIONS") {
    setCorsHeaders(origin);
    return res.status(200).end();
  }

  // 3. 🔥 ORIGIN LOCK SECURITY CHECK 🔥
  if (origin) {
    try {
      const originHost = new URL(origin.startsWith('http') ? origin : `https://${origin}`).hostname;
      
      // If the request isn't coming from your exact allowed domain, BLOCK IT.
      if (!originHost.endsWith(ALLOWED_PUBLIC_DOMAIN)) {
        return res.status(403).json({ success: false, error: "Forbidden Origin: You cannot embed this player." });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: "Invalid Origin format." });
    }
  } else {
    // Optional: If you want to block direct browser access (where origin is null), uncomment the next line:
    // return res.status(403).json({ success: false, error: "Direct access blocked." });
  }

  // If they pass the security check, attach the headers allowing them access
  setCorsHeaders(origin);

  // 4. Proceed with grabbing the video data
  const vid = req.query.vid;

  if (!vid) {
    return res.status(400).json({ success: false, error: "Missing vid parameter" });
  }

  try {
    const googleParams = new URLSearchParams({
      key: GOOGLE_SECRET_KEY,
      slug: vid
    });
    
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${googleParams.toString()}`);
    const data = await response.json();

    if (!data.success || !data.post) {
      return res.status(404).json({ success: false, error: "Video not found." });
    }

    const post = data.post;
    
    // Ensure a Full Video exists
    if (!post.fullVideo || post.fullVideo.trim() === "") {
        return res.status(404).json({ success: false, error: "Full HD video not available." });
    }

    // Return ONLY what the player needs
    return res.status(200).json({
        success: true,
        title: post.title,
        fullVideoLinks: post.fullVideo, 
        posterImage: post.featureImage || ""
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
