import { NextRequest, NextResponse } from "next/server";
import { resolveFlags } from "@/lib/mock-provider/chaos";
import { generateDataset } from "@/lib/mock-provider/data";
import { nextRequestCount, nextTokenRequestCount } from "@/lib/mock-provider/state";

const PAGE_SIZE = 20;
const RATE_LIMIT_EVERY = 10;
const SERVER_ERROR_EVERY = 25;
const EXPIRED_TOKEN_AFTER = 15;

// Cursor-paginated invoices from a deliberately adversarial upstream —
// see .claude/PRD.md "Mock Provider" for the full acceptance criteria
// this route implements.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const flags = resolveFlags(searchParams);
  const requestNumber = nextRequestCount();

  if (flags.rateLimit && requestNumber % RATE_LIMIT_EVERY === 0) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }

  if (flags.serverError && requestNumber % SERVER_ERROR_EVERY === 0) {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (flags.expiredToken) {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "demo-token";
    if (nextTokenRequestCount(token) > EXPIRED_TOKEN_AFTER) {
      return NextResponse.json({ error: "token_expired" }, { status: 401 });
    }
  }

  const dataset = generateDataset(flags);
  const cursorParam = searchParams.get("cursor");
  const offset = cursorParam ? Math.max(0, parseInt(cursorParam, 10) || 0) : 0;
  const page = dataset.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + PAGE_SIZE;
  const nextCursor = nextOffset < dataset.length ? String(nextOffset) : null;

  return NextResponse.json({
    data: page,
    next_cursor: nextCursor,
  });
}
