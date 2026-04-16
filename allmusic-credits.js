// netlify/functions/allmusic-credits.js
// Server-side AllMusic credits scraper
// Called by isrc-lookup.html to avoid browser CORS and JS-rendering issues

const TECH_ROLES = [
  'mastering','engineer','assistant engineer','mixing','mixed by','producer',
  'produced','art direction','design','photography','management','manager',
  'liner notes','coordinator','compilation','remaster','restoration',
  'art','supervisor','supervised','a&r','legal','business affairs','publicity'
];

const isTech = role => TECH_ROLES.some(t => role.toLowerCase().includes(t));

// Extract performers from AllMusic HTML (server-rendered portions)
function parseCreditsHtml(html) {
  const performers = [];

  // AllMusic credits HTML pattern:
  // <div class="credit">
  //   <div class="name"><a>Artist Name</a></div>
  //   <div class="role">Role</div>
  // </div>
  // Also handles: <li class="credit"><span class="artist">...</span><span class="role">...</span></li>

  // Pattern 1: div.credit blocks
  const creditBlocks = [...html.matchAll(/<div[^>]+class="[^"]*credit[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];
  for (const block of creditBlocks) {
    const inner = block[1];
    const nameMatch = inner.match(/class="[^"]*(?:name|artist)[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)/i);
    const roleMatch = inner.match(/class="[^"]*role[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)/i);
    if (nameMatch && roleMatch) {
      const name = nameMatch[1].trim();
      const role = roleMatch[1].trim();
      if (name && role && !isTech(role)) performers.push({ name, role });
    }
  }

  // Pattern 2: JSON-LD structured data
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of jsonLdMatches) {
    try {
      const data = JSON.parse(m[1]);
      if (data.creditedTo || data.credit || data.performer) {
        const credits = [].concat(data.creditedTo || data.credit || data.performer || []);
        for (const c of credits) {
          const name = c.name || c['@value'] || '';
          const role = c.roleName || c.role || c.jobTitle || '';
          if (name && role && !isTech(role)) performers.push({ name, role });
        }
      }
    } catch (e) { /* not valid JSON */ }
  }

  // Pattern 3: Nuxt/Vue embedded state (__NUXT__ or window.__data__)
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (nuxtMatch) {
    try {
      const data = JSON.parse(nuxtMatch[1]);
      // Try to find credits in nested structure
      const str = JSON.stringify(data);
      const creditSection = str.match(/"credits"\s*:\s*(\[[\s\S]*?\])/);
      if (creditSection) {
        const credits = JSON.parse(creditSection[1]);
        for (const c of credits) {
          if (c.name && c.role && !isTech(c.role)) performers.push({ name: c.name, role: c.role });
        }
      }
    } catch (e) { /* skip */ }
  }

  // Pattern 4: Simple text pattern — "Name\nRole" repeated blocks
  // AllMusic often renders: <td class="artist">Name</td><td class="role">Role</td>
  const tdPattern = [...html.matchAll(/<td[^>]+class="[^"]*(?:artist|name|credit-name)[^"]*"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]+class="[^"]*role[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)];
  for (const m of tdPattern) {
    const name = m[1].replace(/<[^>]+>/g, '').trim();
    const role = m[2].replace(/<[^>]+>/g, '').trim();
    if (name && role && !isTech(role)) performers.push({ name, role });
  }

  // Deduplicate by name+role
  const seen = new Set();
  return performers.filter(p => {
    const key = `${p.name}|${p.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const amUrl = params.url;

  if (!amUrl || !amUrl.includes('allmusic.com')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'valid allmusic url required' }) };
  }

  // Strip fragment, try both /credits path and #credits anchor
  const baseUrl = amUrl.replace(/#.*$/, '').replace(/\/credits$/, '');
  const urlsToTry = [
    baseUrl + '/credits',
    baseUrl,
  ];

  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  let performers = [];
  let usedUrl = '';

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, { headers: fetchHeaders, redirect: 'follow' });
      if (!res.ok) continue;
      const html = await res.text();
      performers = parseCreditsHtml(html);
      usedUrl = url;
      if (performers.length > 0) break;
    } catch (e) {
      continue;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ performers, url: usedUrl || baseUrl })
  };
};
