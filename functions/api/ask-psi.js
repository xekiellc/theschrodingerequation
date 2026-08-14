// /functions/api/ask-psi.js
// Cloudflare Pages Function — backend for "Ask Ψ"
//
// Stateless: one question in, one answer out. No conversation history in v1.
// Requires ANTHROPIC_API_KEY set via:
//   wrangler pages secret put ANTHROPIC_API_KEY
//
// Rate limiting here is a simple in-memory-per-request-context placeholder.
// Before launch, replace with a durable rate limit (e.g. Cloudflare Rate Limiting
// rules at the zone level, or a KV-backed counter) — Workers are stateless between
// invocations, so an in-memory counter alone will NOT actually cap usage in production.

const SYSTEM_PROMPT = `You are Ψ, the guide for The Schrödinger Equation, a quantum
physics publication. Answer questions about quantum mechanics clearly and precisely.

Follow the site's epistemic taxonomy in every answer:
- ESTABLISHED — experimentally supported physics
- THOUGHT EXPERIMENT — conceptual devices, not literal experiments
- INTERPRETATION — a framework for understanding the mathematics, not a proven fact
- OPEN QUESTION — genuinely unresolved in physics

Never state an interpretation (Copenhagen, Many-Worlds, etc.) as settled fact. Never
imply quantum mechanics supports claims about consciousness, manifestation, or
faster-than-light communication — these are common misconceptions the site explicitly
corrects. Keep answers concise. Match the site's voice: intelligent, curious, precise,
never dumbed down.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const question = (body.question || "").trim();
  if (!question) {
    return jsonResponse({ error: "Missing 'question'" }, 400);
  }
  if (question.length > 500) {
    return jsonResponse({ error: "Question too long" }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  // TODO before launch: durable per-IP / per-day rate limiting (KV or CF Rate Limiting).
  // TODO before launch: retrieve relevant site content (Vectorize) and inject as
  //   context here, instead of relying purely on the model's general knowledge.

  const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!anthropicResponse.ok) {
    return jsonResponse({ error: "Upstream error" }, 502);
  }

  const data = await anthropicResponse.json();
  const answer = data.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") || "";

  return jsonResponse({ answer });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
