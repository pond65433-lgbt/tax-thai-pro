// app/api/bills/route.ts
//
// GET /api/bills
//   Header: Authorization: Bearer <LIFF ID token>
//   → { bills, summary: { months[], overall }, generatedAt }
//
// The ID token is verified with LINE, so each user only ever sees their own bills.
// (The `sub` claim equals the userId the Messaging API webhook sees, as long as the
//  LINE Login channel and the Messaging API channel belong to the same Provider.)
//
// In development (NODE_ENV !== "production") a request WITHOUT a token is allowed and
// returns every bill plus demo data, so you can preview the UI in a normal browser.

import { NextRequest, NextResponse } from "next/server";
import { billStore, seedDemoBills, summarize, type BillsResponse } from "@/lib/bills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Auth =
  | { ok: true; userId: string | null } // null = dev mode, all bills
  | { ok: false; status: number; error: string };

async function authenticate(req: NextRequest): Promise<Auth> {
  const header = req.headers.get("authorization");
  const idToken = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!idToken) {
    if (process.env.NODE_ENV !== "production") return { ok: true, userId: null };
    return { ok: false, status: 401, error: "Missing LINE ID token" };
  }

  const clientId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!clientId) {
    return { ok: false, status: 500, error: "Server is missing LINE_LOGIN_CHANNEL_ID" };
  }

  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
  });
  if (!res.ok) return { ok: false, status: 401, error: "Invalid or expired LINE ID token" };

  const claims = (await res.json()) as { sub?: string };
  if (!claims.sub) return { ok: false, status: 401, error: "ID token has no subject" };
  return { ok: true, userId: claims.sub };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    if (auth.userId === null) seedDemoBills(); // dev preview only

    const bills = billStore.list(auth.userId);
    const body: BillsResponse = {
      bills,
      summary: summarize(bills),
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[bills] failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
