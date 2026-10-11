import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";
import { NextRequest, NextResponse } from "next/server";

// All Brave requests run on the server. The subscription token is never
// returned to the browser or included in the model's prompt.
export const runtime = "edge";

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const result = auth(request, ModelProvider.GPT);
  if (result.error) {
    return jsonError("Please sign in with your access code first.", 401);
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return jsonError(
      "Brave Search is not configured. Set BRAVE_SEARCH_API_KEY in Vercel.",
      503,
    );
  }

  let body: { query?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid search request.", 400);
  }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 400 || query.split(/\s+/).length > 75) {
    return jsonError("Search query must be 1-400 characters and at most 75 words.", 400);
  }

  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", "5");
  endpoint.searchParams.set("safesearch", "moderate");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 429) {
        return jsonError("Brave Search rate limit or quota exceeded.", 429);
      }
      if (response.status === 401 || response.status === 403) {
        return jsonError("Brave Search API key is not authorized.", 502);
      }
      return jsonError("Brave Search request failed.", 502);
    }

    const data = (await response.json()) as {
      web?: { results?: BraveWebResult[] };
    };
    const sources = (data.web?.results || [])
      .filter((item) => {
        try {
          const parsed = new URL(item.url || "");
          return parsed.protocol === "https:" || parsed.protocol === "http:";
        } catch {
          return false;
        }
      })
      .slice(0, 5)
      .map((item) => ({
        title: (item.title || "").slice(0, 220),
        url: item.url!,
        description: (item.description || "").slice(0, 650),
      }));

    return NextResponse.json(
      { sources },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError("Brave Search timed out or is temporarily unavailable.", 502);
  } finally {
    clearTimeout(timer);
  }
}
