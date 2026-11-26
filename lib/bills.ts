// lib/bills.ts
// Shared types, Thai tax-invoice compliance rules, in-memory "DB" and summary logic.
//
// ⚠️ The store lives in process memory: it is wiped on restart and is NOT shared
// between serverless instances. Swap `billStore` for Supabase / Postgres / Firestore
// / Vercel KV before going to production — the rest of the app only uses its 3 methods.

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type DocumentType =
  | "full_tax_invoice" // ใบกำกับภาษี (เต็มรูป)
  | "abbreviated_tax_invoice" // ใบกำกับภาษีอย่างย่อ
  | "receipt_only" // ใบเสร็จรับเงิน / บิลเงินสด ที่ไม่ใช่ใบกำกับภาษี
  | "other";

export type ComplianceStatus = "valid" | "review" | "invalid";

export const CATEGORIES = [
  "อาหารและเครื่องดื่ม",
  "เดินทางและขนส่ง",
  "วัสดุสำนักงาน",
  "ซอฟต์แวร์และบริการออนไลน์",
  "สาธารณูปโภค",
  "ค่าเช่า",
  "การตลาดและโฆษณา",
  "อุปกรณ์และสินทรัพย์",
  "บริการวิชาชีพ",
  "อื่น ๆ",
] as const;

/** Shape returned by Claude (via the `record_invoice` tool). */
export interface ExtractedInvoice {
  is_receipt_document: boolean;
  document_type: DocumentType;
  has_tax_invoice_wording: boolean;
  vendor_name: string | null;
  vendor_tax_id: string | null;
  vendor_branch: string | null;
  vendor_address_present: boolean;
  buyer_name_present: boolean;
  buyer_address_present: boolean;
  invoice_number: string | null;
  date_iso: string | null;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  vat_shown_separately: boolean;
  category: string;
  confidence: number;
  notes: string | null;
}

export interface Bill {
  id: string;
  userId: string;
  sourceMessageId: string | null;
  createdAt: string; // ISO timestamp
  vendor: string;
  taxId: string | null;
  branch: string | null;
  invoiceNumber: string | null;
  date: string; // YYYY-MM-DD (Gregorian)
  subtotal: number;
  vat: number;
  total: number;
  category: string;
  documentType: DocumentType;
  compliance: { status: ComplianceStatus; issues: string[] };
  /** VAT that can be claimed as input tax right now (0 unless status === "valid"). */
  claimableVat: number;
  confidence: number;
  notes: string | null;
}

export interface MonthlySummary {
  month: string; // "YYYY-MM" or "all"
  billCount: number;
  subtotal: number;
  vat: number;
  total: number;
  claimableVat: number; // VAT on bills with status "valid"
  pendingVat: number; // VAT on bills with status "review"
  nonClaimableVat: number; // VAT on bills with status "invalid"
  validCount: number;
  reviewCount: number;
  invalidCount: number;
}

export interface BillsResponse {
  bills: Bill[];
  summary: { months: MonthlySummary[]; overall: MonthlySummary };
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Display helpers (used by the LINE Flex Message)                     */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<ComplianceStatus, string> = {
  valid: "ขอคืน VAT ได้",
  review: "ต้องตรวจสอบ",
  invalid: "ขอคืน VAT ไม่ได้",
};

export const STATUS_COLOR: Record<ComplianceStatus, string> = {
  valid: "#0A8F4D",
  review: "#C27A00",
  invalid: "#C23B3B",
};

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  full_tax_invoice: "ใบกำกับภาษี",
  abbreviated_tax_invoice: "ใบกำกับภาษีอย่างย่อ",
  receipt_only: "ใบเสร็จรับเงิน",
  other: "เอกสารอื่น",
};

export const formatBaht = (n: number) =>
  new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB" }).format(n);

export const formatThaiDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00+07:00`).toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });

/* ------------------------------------------------------------------ */
/* Compliance rules (Thai Revenue Code §86/4 – heuristic, not advice)  */
/* ------------------------------------------------------------------ */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const todayBangkok = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD

/** Official checksum for the 13-digit Thai taxpayer / juristic-person ID. */
export function isValidThaiTaxId(id: string | null | undefined): boolean {
  if (!id || !/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  let year = Number(m[1]);
  if (year > 2400) year -= 543; // Buddhist Era safety net
  const iso = `${String(year).padStart(4, "0")}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T12:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (year < 2000 || d.getTime() > now.getTime() + 36 * 3600 * 1000) return null;
  return iso;
}

interface Evaluation {
  status: ComplianceStatus;
  issues: string[];
  claimableVat: number;
}

function evaluateCompliance(
  x: ExtractedInvoice,
  n: { taxId: string | null; subtotal: number; vat: number; total: number },
  extraWarnings: string[],
): Evaluation {
  const blocking: string[] = [];
  const warnings: string[] = [...extraWarnings];

  // 1) Must actually be a tax invoice
  if (
    !x.has_tax_invoice_wording ||
    x.document_type === "receipt_only" ||
    x.document_type === "other"
  ) {
    blocking.push("ไม่ใช่ใบกำกับภาษี (ไม่พบคำว่า “ใบกำกับภาษี”) ใช้ขอคืน VAT ไม่ได้");
  }

  // 2) Seller's 13-digit tax ID
  if (!n.taxId) {
    blocking.push("ไม่พบเลขประจำตัวผู้เสียภาษี 13 หลักของผู้ขาย");
  } else if (!isValidThaiTaxId(n.taxId)) {
    blocking.push("เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ไม่ครบ 13 หลักหรือ checksum ไม่ผ่าน) ตรวจสอบกับผู้ขาย");
  }

  // 3) VAT must be separately shown
  if (!x.vat_shown_separately || n.vat <= 0) {
    blocking.push("ไม่แสดง VAT แยกจากราคาสินค้า/บริการ");
  }

  // 4) Warnings (claimable only after human review)
  if (x.document_type === "abbreviated_tax_invoice") {
    warnings.push("เป็นใบกำกับภาษีอย่างย่อ ควรยืนยันกับนักบัญชีก่อนใช้เครดิตภาษีซื้อ");
  } else if (x.document_type === "full_tax_invoice") {
    if (!x.buyer_name_present || !x.buyer_address_present) {
      warnings.push("ใบกำกับภาษีเต็มรูปต้องมีชื่อและที่อยู่ผู้ซื้อ — ขอให้ผู้ขายออกใหม่");
    }
  }
  if (!x.vendor_name) warnings.push("อ่านชื่อผู้ขายไม่ได้");
  if (!x.vendor_address_present) warnings.push("ไม่พบที่อยู่ผู้ขาย");
  if (!x.invoice_number) warnings.push("ไม่พบเลขที่ใบกำกับภาษี");

  if (n.subtotal > 0 && n.vat > 0) {
    const expected = round2(n.subtotal * 0.07);
    if (Math.abs(n.vat - expected) > 0.06) {
      warnings.push(`VAT ไม่เท่ากับ 7% ของมูลค่าก่อน VAT (คาดว่า ${formatBaht(expected)})`);
    }
    if (Math.abs(round2(n.subtotal + n.vat) - n.total) > 0.06) {
      warnings.push("ยอดรวมไม่ตรงกับ มูลค่าก่อน VAT + VAT");
    }
  }
  if (x.confidence < 0.6) warnings.push("ภาพไม่ชัด อ่านข้อมูลได้ไม่มั่นใจ ตรวจสอบตัวเลขอีกครั้ง");

  const status: ComplianceStatus = blocking.length ? "invalid" : warnings.length ? "review" : "valid";
  return {
    status,
    issues: [...blocking, ...warnings],
    claimableVat: status === "valid" ? n.vat : 0,
  };
}

/** Turn Claude's raw extraction into a normalised, scored Bill. */
export function buildBill(
  userId: string,
  sourceMessageId: string | null,
  x: ExtractedInvoice,
): Bill {
  const taxId = x.vendor_tax_id ? x.vendor_tax_id.replace(/\D/g, "") || null : null;

  let { subtotal, vat, total } = x;
  if (total != null && vat != null && subtotal == null) subtotal = round2(total - vat);
  if (subtotal != null && vat != null && total == null) total = round2(subtotal + vat);
  if (total != null && subtotal != null && vat == null && x.vat_shown_separately) {
    vat = round2(total - subtotal);
  }
  if (total != null && subtotal == null) subtotal = total;
  if (subtotal != null && total == null) total = subtotal;
  const n = {
    taxId,
    subtotal: round2(subtotal ?? 0),
    vat: round2(vat ?? 0),
    total: round2(total ?? 0),
  };

  const extraWarnings: string[] = [];
  let date = normalizeDate(x.date_iso);
  if (!date) {
    date = todayBangkok();
    extraWarnings.push("อ่านวันที่บนเอกสารไม่ได้ ระบบใช้วันที่ส่งรูปแทน");
  }

  const evaluation = evaluateCompliance(x, n, extraWarnings);

  return {
    id: randomUUID(),
    userId,
    sourceMessageId,
    createdAt: new Date().toISOString(),
    vendor: x.vendor_name?.trim() || "ไม่ทราบชื่อผู้ขาย",
    taxId,
    branch: x.vendor_branch,
    invoiceNumber: x.invoice_number,
    date,
    ...n,
    category: x.category || "อื่น ๆ",
    documentType: x.document_type,
    compliance: { status: evaluation.status, issues: evaluation.issues },
    claimableVat: evaluation.claimableVat,
    confidence: x.confidence,
    notes: x.notes,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory store (survives Next.js dev hot-reload via globalThis)    */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as { __taxThaiBills?: Map<string, Bill> };
const db = (g.__taxThaiBills ??= new Map<string, Bill>());

export const billStore = {
  add(bill: Bill): Bill {
    db.set(bill.id, bill);
    return bill;
  },
  /** `userId === null` returns every bill (dev only). Newest first. */
  list(userId: string | null): Bill[] {
    return [...db.values()]
      .filter((b) => userId === null || b.userId === userId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  },
  /** Used to ignore LINE webhook re-deliveries. */
  hasMessage(sourceMessageId: string): boolean {
    for (const b of db.values()) if (b.sourceMessageId === sourceMessageId) return true;
    return false;
  },
};

/* ------------------------------------------------------------------ */
/* Summaries                                                           */
/* ------------------------------------------------------------------ */

function summarizeGroup(month: string, bills: Bill[]): MonthlySummary {
  const s: MonthlySummary = {
    month,
    billCount: bills.length,
    subtotal: 0,
    vat: 0,
    total: 0,
    claimableVat: 0,
    pendingVat: 0,
    nonClaimableVat: 0,
    validCount: 0,
    reviewCount: 0,
    invalidCount: 0,
  };
  for (const b of bills) {
    s.subtotal += b.subtotal;
    s.vat += b.vat;
    s.total += b.total;
    if (b.compliance.status === "valid") {
      s.claimableVat += b.claimableVat;
      s.validCount++;
    } else if (b.compliance.status === "review") {
      s.pendingVat += b.vat;
      s.reviewCount++;
    } else {
      s.nonClaimableVat += b.vat;
      s.invalidCount++;
    }
  }
  s.subtotal = round2(s.subtotal);
  s.vat = round2(s.vat);
  s.total = round2(s.total);
  s.claimableVat = round2(s.claimableVat);
  s.pendingVat = round2(s.pendingVat);
  s.nonClaimableVat = round2(s.nonClaimableVat);
  return s;
}

export function summarize(bills: Bill[]): BillsResponse["summary"] {
  const groups = new Map<string, Bill[]>();
  for (const b of bills) {
    const key = b.date.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const months = [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a)) // newest month first
    .map(([month, list]) => summarizeGroup(month, list));
  return { months, overall: summarizeGroup("all", bills) };
}

/* ------------------------------------------------------------------ */
/* Demo data (development only, so the dashboard isn't empty)         */
/* ------------------------------------------------------------------ */

export function seedDemoBills() {
  if (db.size > 0) return;
  const now = new Date();
  const ym = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const mk = (
    day: string,
    vendor: string,
    taxId: string | null,
    subtotal: number,
    category: string,
    documentType: DocumentType,
    status: ComplianceStatus,
    issues: string[] = [],
  ) => {
    const vat = status === "invalid" && documentType === "receipt_only" ? 0 : round2(subtotal * 0.07);
    const bill: Bill = {
      id: randomUUID(),
      userId: "demo",
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
      vendor,
      taxId,
      branch: "00000",
      invoiceNumber: `INV-${Math.floor(Math.random() * 90000 + 10000)}`,
      date: day,
      subtotal,
      vat,
      total: round2(subtotal + vat),
      category,
      documentType,
      compliance: { status, issues },
      claimableVat: status === "valid" ? vat : 0,
      confidence: 0.9,
      notes: null,
    };
    db.set(bill.id, bill);
  };
  // Fictional vendors / tax IDs – demo data only
  mk(`${ym(0)}-18`, "บริษัท ออฟฟิศดี จำกัด", "0105500000014", 4280, "วัสดุสำนักงาน", "full_tax_invoice", "valid");
  mk(`${ym(0)}-14`, "บริษัท คลาวด์ตัวอย่าง จำกัด", "0105500000022", 1990, "ซอฟต์แวร์และบริการออนไลน์", "full_tax_invoice", "valid");
  mk(`${ym(0)}-09`, "ร้านกาแฟบ้านสวน", null, 385, "อาหารและเครื่องดื่ม", "receipt_only", "invalid", [
    "ไม่ใช่ใบกำกับภาษี (ไม่พบคำว่า “ใบกำกับภาษี”) ใช้ขอคืน VAT ไม่ได้",
    "ไม่พบเลขประจำตัวผู้เสียภาษี 13 หลักของผู้ขาย",
  ]);
  mk(`${ym(0)}-03`, "มินิมาร์ทตัวอย่าง สาขา 001", "0105500000031", 214.95, "อาหารและเครื่องดื่ม", "abbreviated_tax_invoice", "review", [
    "เป็นใบกำกับภาษีอย่างย่อ ควรยืนยันกับนักบัญชีก่อนใช้เครดิตภาษีซื้อ",
  ]);
  mk(`${ym(1)}-27`, "บริษัท สาธารณูปโภคตัวอย่าง จำกัด", "0105500000049", 3120.5, "สาธารณูปโภค", "full_tax_invoice", "review", [
    "ใบกำกับภาษีเต็มรูปต้องมีชื่อและที่อยู่ผู้ซื้อ — ขอให้ผู้ขายออกใหม่",
  ]);
  mk(`${ym(1)}-11`, "บริษัท แท็กซี่ตัวอย่าง จำกัด", "0105500000057", 560, "เดินทางและขนส่ง", "full_tax_invoice", "valid");
}
