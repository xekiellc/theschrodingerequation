// scripts/generate-news-post.js
//
// Run by .github/workflows/quantum-news.yml on a schedule. Checks arXiv's
// quant-ph category for new papers since the last run. If nothing new is
// found, exits without writing anything — no forced quota, no filler.
//
// When something new is found, synthesizes ONE post via the Anthropic API in
// the site's voice and epistemic taxonomy, writes it to /news/<slug>/, and
// regenerates /news/index.html to list all published posts.
//
// Data source: arXiv API (free, no key). Industry/product news via NewsAPI
// is a planned follow-up, not wired in here yet.

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "content", "news", ".state.json");
const NEWS_DIR = path.join(__dirname, "..", "news");
const CONTENT_DIR = path.join(__dirname, "..", "content", "news");
const SITE_CSS_LINK = '<link rel="stylesheet" href="../../assets/css/site.css">';
const GA_SNIPPET = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-YPTR1K4Y5G"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag("js", new Date());
  gtag("config", "G-YPTR1K4Y5G");
</script>`;

async function main() {
  const state = loadState();
  const { newPapers, newestId } = await fetchNewArxivPapers(state.lastSeenId);

  // Always ensure the state directory exists and record the newest seen ID,
  // even when there's nothing to publish — this is what makes the *next*
  // run able to detect what's actually new, and guarantees content/news/
  // exists in the repo so the workflow's git add step never fails on a
  // missing path.
  if (newestId) {
    state.lastSeenId = newestId;
  }
  saveState(state);

  if (newPapers.length === 0) {
    console.log("No new quant-ph papers since last check. Nothing to publish.");
    return;
  }

  // Only ever publish one post per run, even if several papers came in —
  // keeps quality high over quantity, and avoids a backlog dump.
  const paper = newPapers[0];
  console.log(`New paper found: ${paper.title}`);

  const post = await synthesizePost(paper);
  const slug = slugify(paper.title);
  writePostPage(slug, post, paper);
  appendToIndex(slug, post, paper);

  state.publishedSlugs = state.publishedSlugs || [];
  state.publishedSlugs.push(slug);
  saveState(state);

  console.log(`Published: /news/${slug}/`);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastSeenId: null, publishedSlugs: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchNewArxivPapers(lastSeenId) {
  // quant-ph category, newest first
  const url =
    "http://export.arxiv.org/api/query?search_query=cat:quant-ph" +
    "&sortBy=submittedDate&sortOrder=descending&max_results=5";

  const res = await fetch(url);
  const xml = await res.text();
  const entries = parseArxivEntries(xml);
  const newestId = entries.length > 0 ? entries[0].id : null;

  if (!lastSeenId) {
    // First-ever run: don't dump the last 5 papers at once. Just record the
    // most recent as the baseline (handled by the caller) and publish
    // nothing this run.
    return { newPapers: [], newestId };
  }

  const newPapers = [];
  for (const entry of entries) {
    if (entry.id === lastSeenId) break;
    newPapers.push(entry);
  }
  return { newPapers, newestId };
}

function parseArxivEntries(xml) {
  const entries = [];
  const entryBlocks = xml.split("<entry>").slice(1);
  for (const block of entryBlocks) {
    const id = (block.match(/<id>(.*?)<\/id>/) || [])[1] || "";
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
    const published = (block.match(/<published>(.*?)<\/published>/) || [])[1] || "";
    entries.push({
      id: id.trim(),
      title: title.replace(/\s+/g, " ").trim(),
      summary: summary.replace(/\s+/g, " ").trim(),
      published: published.trim(),
      url: id.trim(),
    });
  }
  return entries;
}

async function synthesizePost(paper) {
  const systemPrompt = `You write for the Quantum News section of The Schrödinger
Equation, a quantum physics publication. Voice: intelligent, curious, precise,
never dumbed down, never hyped. This is an arXiv PREPRINT — not yet
peer-reviewed. Say so explicitly and do not overstate the result's certainty.

Follow the site's epistemic taxonomy: distinguish what the paper claims from
what is established. Do not editorialize beyond what the abstract supports.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{
  "headline": "a precise, non-hype headline, under 90 characters",
  "dek": "one-sentence summary, under 160 characters",
  "body_html": "2-3 short paragraphs as <p> tags, summarizing the paper for an
    intelligent general reader, explicitly noting it's an unreviewed preprint"
}`;

  const userPrompt = `Title: ${paper.title}\n\nAbstract: ${paper.summary}\n\narXiv URL: ${paper.url}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const data = await res.json();
  const text = data.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function writePostPage(slug, post, paper) {
  const dir = path.join(NEWS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  const dateStr = new Date(paper.published).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(post.headline)} — The Schrödinger Equation</title>
<meta name="description" content="${escapeHtml(post.dek)}">
<link rel="canonical" href="https://theschrodingerequation.com/news/${slug}/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
${SITE_CSS_LINK}
${GA_SNIPPET}
<style>
  .post-body{ max-width:640px; margin:0 auto; color:var(--chalk-dim); font-size:15.5px; line-height:1.75; }
  .post-body p{margin:0 0 16px;}
  .post-meta{ text-align:center; font-family:'IBM Plex Mono', monospace; font-size:12px; color:var(--chalk-dim); margin-bottom:32px; }
  .post-source{ text-align:center; margin-top:40px; font-family:'IBM Plex Mono', monospace; font-size:12px; }
  .post-source a{ color:var(--teal); }
</style>
</head>
<body>

<header class="nav">
  <div class="nav-inner">
    <a href="../../" class="brand"><span class="psi">Ψ</span><span class="psi-sq">|Ψ|²</span> THE SCHRÖDINGER EQUATION</a>
    <nav class="links">
      <a href="../../equation/">Equation</a>
      <a href="../../quantum-101/">Concepts</a>
      <a href="../../weird-stuff/">Weird Stuff</a>
      <a href="../../experiments/">Experiments</a>
      <a href="../../people/">People</a>
      <a href="../../applications/">Applications</a>
      <a href="../../frontier/">Frontier</a>
      <a href="../../news/">News</a>
    </nav>
  </div>
</header>

<section class="page-hero">
  <div class="page-eyebrow"><span class="tag tag-thought">Preprint — Not Peer-Reviewed</span></div>
  <h1 class="page-title">${escapeHtml(post.headline)}</h1>
  <p class="page-sub">${escapeHtml(post.dek)}</p>
</section>

<div class="wrap"><div class="divider"></div></div>

<section>
  <div class="wrap">
    <div class="post-meta">${dateStr}</div>
    <div class="post-body">${post.body_html}</div>
    <div class="post-source">Source: <a href="${paper.url}" target="_blank" rel="noopener">${paper.url}</a></div>
  </div>
</section>

<footer>
  <div class="wrap footer-inner">
    <div class="footer-psi">Ψ</div>
    <div class="footer-note">THE SCHRÖDINGER EQUATION</div>
  </div>
</footer>

</body>
</html>
`;

  fs.writeFileSync(path.join(dir, "index.html"), html);
}

function appendToIndex(slug, post, paper) {
  const dateStr = new Date(paper.published).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const entryHtml = `      <a href="../news/${slug}/" class="weird-item">
        <span class="weird-tag tag-thought">Preprint</span>
        <span class="weird-title">${escapeHtml(post.headline)}</span>
        <span class="weird-arrow">${dateStr} →</span>
      </a>
`;

  const indexPath = path.join(NEWS_DIR, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");

  if (html.includes('<div class="not-yet">')) {
    // First post ever: replace the empty state with a real list.
    const listOpen = '<div class="weird-list">\n';
    const listClose = "\n    </div>";
    const notYetBlockRegex = /<div class="not-yet">[\s\S]*?<\/div>\s*<\/div>/;
    html = html.replace(notYetBlockRegex, listOpen + entryHtml + listClose);
  } else if (html.includes('<div class="weird-list">')) {
    html = html.replace('<div class="weird-list">\n', '<div class="weird-list">\n' + entryHtml);
  }

  fs.writeFileSync(indexPath, html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch((err) => {
  console.error("generate-news-post failed:", err);
  process.exit(1);
});
