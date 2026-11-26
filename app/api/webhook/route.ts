// app/api/webhook/route.ts
//
// LINE Messaging API webhook:
//   1. Verifies x-line-signature against the RAW body (Node.js runtime).
//   2. Returns 200 immediately; the slow work (download image → Gemini vision →
//      save → reply) runs in `after()` so LINE never times out.
//   3. Replies with a Flex Message (reply token first, push as fallback).
//
// Requires Next.js 15.1+ (stable `after`).

import { NextRequest, NextResponse, after } from "next/server";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { messagingApi, validateSignature, webhook } from "@line/bot-sdk";
import {
  CATEGORIES,
  DOCUMENT_TYPE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  billStore,
  buildBill,
  formatBaht,
  formatThaiDate,
  type Bill,
  type ExtractedInvoice,
} from "@/lib/bills";

export const runtime = "nodejs"; // @line/bot-sdk needs Node APIs
export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds (Vercel) – also covers the `after()` work

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/* ------------------------------------------------------------------ */
/* Clients (created lazily so `next build` works without env vars)     */
/* ------------------------------------------------------------------ */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const lineClient = () =>
  new messagingApi.MessagingApiClient({
    channelAccessToken: requireEnv("LINE_CHANNEL_ACCESS_TOKEN"),
  });

const geminiClient = () =>
  new GoogleGenAI({
    apiKey: requireEnv("GEMINI_API_KEY"),
    httpOptions: { timeout: 40_000 },
  });

/* ------------------------------------------------------------------ */
/* Route handlers                                                      */
/* ------------------------------------------------------------------ */

export async function GET() {
  return NextResponse.json({ ok: true, service: "tax-thai-pro webhook" });
}

export async function POST(req: NextRequest) {
  // Signature must be checked on the raw text body – never on re-serialised JSON.
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelSecret || !validateSignature(rawBody, channelSecret, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: webhook.CallbackRequest;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Acknowledge now, work later.
  after(async () => {
    const results = await Promise.allSettled((payload.events ?? []).map(handleEvent));
    for (const r of results) {
      if (r.status === "rejected") console.error("[webhook] event failed:", r.reason);
    }
  });

  return NextResponse.json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Event handling                                                      */
/* ------------------------------------------------------------------ */

async function handleEvent(event: webhook.Event): Promise<void> {
  if (event.deliveryContext?.isRedelivery) return; // LINE retry – already handled

  const client = lineClient();
  const userId = (event.source as { userId?: string } | undefined)?.userId;

  if (event.type === "follow") {
    await send(client, event.replyToken, userId, [textMessage(WELCOME_TEXT)]);
    return;
  }

  if (event.type !== "message") return;

  if (event.message.type === "image") {
    await handleImage(client, event, event.message.id, userId);
    return;
  }

  // Anything else (text, sticker, …) → short help
  await send(client, event.replyToken, userId, [textMessage(HELP_TEXT())]);
}

async function handleImage(
  client: messagingApi.MessagingApiClient,
  event: webhook.MessageEvent,
  messageId: string,
  userId: string | undefined,
) {
  if (!userId) return;
  const replyToken = event.replyToken;

  if (billStore.hasMessage(messageId)) return; // duplicate delivery

  // Nice UX: show the "typing…" animation in 1:1 chats (best effort).
  client.showLoadingAnimation({ chatId: userId, loadingSeconds: 30 }).catch(() => {});

  try {
    const { bytes, mediaType } = await downloadLineImage(messageId);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      await send(client, replyToken, userId, [
        textMessage("รูปมีขนาดใหญ่เกิน 10 MB กรุณาถ่ายใหม่หรือย่อรูปแล้วส่งอีกครั้ง"),
      ]);
      return;
    }

    const extracted = await extractInvoice(bytes, mediaType);

    if (!extracted.is_receipt_document) {
      await send(client, replyToken, userId, [
        textMessage("ไม่พบใบเสร็จหรือใบกำกับภาษีในรูปนี้ ลองถ่ายให้เห็นเอกสารทั้งใบ แสงสว่าง ไม่เบลอ แล้วส่งใหม่อีกครั้งนะครับ"),
      ]);
      return;
    }

    const bill = billStore.add(buildBill(userId, messageId, extracted));
    await send(client, replyToken, userId, [billFlexMessage(bill)]);
  } catch (err) {
    console.error("[webhook] image analysis failed:", err);
    await send(client, replyToken, userId, [
      textMessage("ขออภัย วิเคราะห์รูปนี้ไม่สำเร็จ กรุณาลองส่งใหม่อีกครั้งในอีกสักครู่"),
    ]).catch(() => {});
  }
}

/** Reply token first (free); fall back to push if it expired or was already used. */
async function send(
  client: messagingApi.MessagingApiClient,
  replyToken: string | undefined,
  to: string | undefined,
  messages: messagingApi.Message[],
) {
  if (replyToken) {
    try {
      await client.replyMessage({ replyToken, messages });
      return;
    } catch (err) {
      console.warn("[webhook] reply failed, falling back to push:", err);
    }
  }
  if (to) await client.pushMessage({ to, messages });
}

/* ------------------------------------------------------------------ */
/* LINE image download                                                 */
/* ------------------------------------------------------------------ */

async function downloadLineImage(messageId: string) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${requireEnv("LINE_CHANNEL_ACCESS_TOKEN")}` },
  });
  if (!res.ok) throw new Error(`LINE content download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mediaType: sniffMediaType(bytes, res.headers.get("content-type")) };
}

function sniffMediaType(b: Buffer, header: string | null): ImageMediaType {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (b.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (header === "image/png" || header === "image/webp" || header === "image/gif") return header;
  return "image/jpeg";
}

/* ------------------------------------------------------------------ */
/* Gemini vision extraction (responseSchema → guaranteed JSON shape)   */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are a meticulous Thai accounting assistant. You read photos of Thai receipts and tax invoices and record exactly what is printed – never guess.

Rules:
- Thai digits (๐-๙) must be converted to Arabic digits. Remove commas from amounts.
- Dates: output Gregorian ISO (YYYY-MM-DD). Thai documents usually use Buddhist Era (พ.ศ.); subtract 543 (e.g. 2569 → 2026). Two-digit years: 69 = พ.ศ. 2569.
- vendor_tax_id: the SELLER's 13-digit taxpayer number (เลขประจำตัวผู้เสียภาษี), digits only. Null if not visible or not 13 digits. Never use the buyer's ID, a phone number or a branch code.
- has_tax_invoice_wording: true only if the document is titled/labelled "ใบกำกับภาษี" (including "ใบกำกับภาษี/ใบเสร็จรับเงิน", "ใบกำกับภาษีอย่างย่อ", "TAX INVOICE"). A plain "ใบเสร็จรับเงิน" / "RECEIPT" / "บิลเงินสด" is NOT a tax invoice.
- document_type: full_tax_invoice (has buyer name/address block), abbreviated_tax_invoice (ใบกำกับภาษีอย่างย่อ, typical for POS/retail), receipt_only, or other.
- subtotal = amount before VAT; vat = VAT amount printed on the document; total = grand total paid. If only two of the three are printed you may derive the third by simple arithmetic. If VAT is not printed, set vat to null and vat_shown_separately to false.
- vat_shown_separately: true only if a VAT amount (ภาษีมูลค่าเพิ่ม / VAT 7%) is printed as its own line.
- category: choose the best fit from the allowed list.
- confidence: 0-1, how legible and certain the extraction is.
- notes: one short Thai sentence about anything unclear (or null).
- If the image is not a receipt/invoice at all, set is_receipt_document=false and fill the rest with nulls/false.
- Respond with JSON only.`;

const nullableString = (description?: string): Schema => ({
  type: Type.STRING,
  nullable: true,
  ...(description ? { description } : {}),
});
const nullableNumber = (): Schema => ({ type: Type.NUMBER, nullable: true });

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    is_receipt_document: { type: Type.BOOLEAN },
    document_type: {
      type: Type.STRING,
      format: "enum",
      enum: ["full_tax_invoice", "abbreviated_tax_invoice", "receipt_only", "other"],
    },
    has_tax_invoice_wording: { type: Type.BOOLEAN },
    vendor_name: nullableString(),
    vendor_tax_id: nullableString("13 digits, no dashes"),
    vendor_branch: nullableString("e.g. สำนักงานใหญ่ or 00001"),
    vendor_address_present: { type: Type.BOOLEAN },
    buyer_name_present: { type: Type.BOOLEAN },
    buyer_address_present: { type: Type.BOOLEAN },
    invoice_number: nullableString(),
    date_iso: nullableString("Gregorian YYYY-MM-DD"),
    subtotal: nullableNumber(),
    vat: nullableNumber(),
    total: nullableNumber(),
    vat_shown_separately: { type: Type.BOOLEAN },
    category: { type: Type.STRING, format: "enum", enum: [...CATEGORIES] },
    confidence: { type: Type.NUMBER },
    notes: nullableString(),
  },
  required: [
    "is_receipt_document",
    "document_type",
    "has_tax_invoice_wording",
    "vendor_name",
    "vendor_tax_id",
    "vendor_branch",
    "vendor_address_present",
    "buyer_name_present",
    "buyer_address_present",
    "invoice_number",
    "date_iso",
    "subtotal",
    "vat",
    "total",
    "vat_shown_separately",
    "category",
    "confidence",
    "notes",
  ],
  propertyOrdering: [
    "is_receipt_document",
    "document_type",
    "has_tax_invoice_wording",
    "vendor_name",
    "vendor_tax_id",
    "vendor_branch",
    "vendor_address_present",
    "buyer_name_present",
    "buyer_address_present",
    "invoice_number",
    "date_iso",
    "subtotal",
    "vat",
    "total",
    "vat_shown_separately",
    "category",
    "confidence",
    "notes",
  ],
};

async function extractInvoice(bytes: Buffer, mediaType: ImageMediaType): Promise<ExtractedInvoice> {
  const ai = geminiClient();

  const call = () =>
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data: bytes.toString("base64") } },
            { text: "Extract this receipt / tax invoice as JSON following the schema." },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
        maxOutputTokens: 2048,
      },
    });

  // One retry for transient Gemini errors (429 / 5xx).
  let response;
  try {
    response = await call();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 429 || (status !== undefined && status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      response = await call();
    } else {
      throw err;
    }
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  // Defensive: strip code fences if the model ever adds them.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned) as ExtractedInvoice;
}

/* ------------------------------------------------------------------ */
/* LINE messages                                                       */
/* ------------------------------------------------------------------ */

const textMessage = (text: string): messagingApi.TextMessage => ({ type: "text", text });

const dashboardUrl = () =>
  process.env.NEXT_PUBLIC_LIFF_ID ? `https://liff.line.me/${process.env.NEXT_PUBLIC_LIFF_ID}` : null;

const WELCOME_TEXT =
  "สวัสดีครับ 👋 ส่งรูปใบเสร็จหรือใบกำกับภาษีมาได้เลย ผมจะอ่านข้อมูล ตรวจว่าขอคืน VAT ได้หรือไม่ และบันทึกให้อัตโนมัติ\n\n*ผลที่ได้เป็นการตรวจเบื้องต้น ไม่ใช่คำปรึกษาด้านภาษี";

const HELP_TEXT = () => {
  const url = dashboardUrl();
  return `ส่งรูปใบเสร็จหรือใบกำกับภาษีมาที่แชทนี้ได้เลยครับ 📸${url ? `\n\nดูสรุปรายเดือนและส่งออก CSV: ${url}` : ""}`;
};

const row = (label: string, value: string, bold = false): messagingApi.FlexBox => ({
  type: "box",
  layout: "horizontal",
  spacing: "sm",
  contents: [
    { type: "text", text: label, size: "sm", color: "#6B746E", flex: 3 },
    {
      type: "text",
      text: value,
      size: "sm",
      color: "#17201B",
      align: "end",
      wrap: true,
      flex: 5,
      weight: bold ? "bold" : "regular",
    },
  ],
});

function billFlexMessage(bill: Bill): messagingApi.FlexMessage {
  const { status, issues } = bill.compliance;
  const color = STATUS_COLOR[status];
  const url = dashboardUrl();

  const body: messagingApi.FlexComponent[] = [
    row("ผู้ขาย", bill.vendor, true),
    row("เลขผู้เสียภาษี", bill.taxId ?? "ไม่พบ"),
    row("ประเภทเอกสาร", DOCUMENT_TYPE_LABEL[bill.documentType]),
    row("เลขที่เอกสาร", bill.invoiceNumber ?? "-"),
    row("วันที่", formatThaiDate(bill.date)),
    row("หมวดหมู่", bill.category),
    { type: "separator", margin: "md" },
    row("ก่อน VAT", formatBaht(bill.subtotal)),
    row("VAT 7%", formatBaht(bill.vat)),
    row("รวมทั้งสิ้น", formatBaht(bill.total), true),
    row("VAT ขอคืนได้", formatBaht(bill.claimableVat), true),
  ];

  if (issues.length) {
    body.push({ type: "separator", margin: "md" });
    body.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: issues.map(
        (issue): messagingApi.FlexText => ({
          type: "text",
          text: `• ${issue}`,
          size: "xs",
          color,
          wrap: true,
        }),
      ),
    });
  }

  const bubble: messagingApi.FlexBubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: color,
      paddingAll: "16px",
      contents: [
        { type: "text", text: STATUS_LABEL[status], color: "#FFFFFF", weight: "bold", size: "lg" },
        { type: "text", text: "บันทึกบิลแล้ว", color: "#FFFFFFCC", size: "xs", margin: "xs" },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "16px",
      contents: body,
    },
    ...(url
      ? {
          footer: {
            type: "box" as const,
            layout: "vertical" as const,
            contents: [
              {
                type: "button" as const,
                style: "link" as const,
                action: { type: "uri" as const, label: "เปิดแดชบอร์ด", uri: url },
              },
            ],
          },
        }
      : {}),
  };

  return {
    type: "flex",
    altText: `${STATUS_LABEL[status]} • ${bill.vendor} • ${formatBaht(bill.total)}`.slice(0, 400),
    contents: bubble,
  };
}
