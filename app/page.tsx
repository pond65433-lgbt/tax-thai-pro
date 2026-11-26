"use client";

// app/page.tsx — LINE LIFF dashboard
//
// • `@line/liff` is imported dynamically inside useEffect (it touches `window`).
// • Sends the LIFF ID token to /api/bills so users only see their own bills.
// • If NEXT_PUBLIC_LIFF_ID is not set, runs in preview mode (dev only) with demo data.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IBM_Plex_Sans_Thai } from "next/font/google";
import { AlertTriangle, Download, Loader2, Receipt, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import type { Bill, BillsResponse, ComplianceStatus, MonthlySummary } from "@/lib/bills";

const plex = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const baht = (n: number) =>
  new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB" }).format(n);

const thaiDate = (iso: string) =>
  new Date(`${iso}T12:00:00+07:00`).toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });

const monthLabel = (ym: string) =>
  ym === "all"
    ? "ทุกเดือน"
    : new Date(`${ym}-01T12:00:00+07:00`).toLocaleDateString("th-TH", {
        month: "long",
        year: "numeric",
        timeZone: "Asia/Bangkok",
      });

const STATUS = {
  valid: { label: "ขอคืน VAT ได้", Icon: ShieldCheck, text: "text-[#0A7A43]", bg: "bg-[#DDF3E6]" },
  review: { label: "ต้องตรวจสอบ", Icon: AlertTriangle, text: "text-[#8A5300]", bg: "bg-[#FFEFCF]" },
  invalid: { label: "ขอคืนไม่ได้", Icon: XCircle, text: "text-[#A12D2D]", bg: "bg-[#FDE2E0]" },
} as const;

const DOC_TYPE: Record<Bill["documentType"], string> = {
  full_tax_invoice: "ใบกำกับภาษี",
  abbreviated_tax_invoice: "ใบกำกับภาษีอย่างย่อ",
  receipt_only: "ใบเสร็จรับเงิน",
  other: "เอกสารอื่น",
};

/* ------------------------------------------------------------------ */
/* CSV export (UTF-8 BOM so Excel opens Thai text correctly)           */
/* ------------------------------------------------------------------ */

const csvCell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
// ="123…" stops Excel turning 13-digit tax IDs into 1.23E+12
const csvText = (v: string | null) => (v ? `="${v}"` : '""');

function buildCsv(bills: Bill[]): string {
  const header = [
    "วันที่",
    "ผู้ขาย",
    "เลขประจำตัวผู้เสียภาษี",
    "สาขา",
    "เลขที่เอกสาร",
    "ประเภทเอกสาร",
    "หมวดหมู่",
    "มูลค่าก่อน VAT",
    "VAT 7%",
    "รวมทั้งสิ้น",
    "สถานะ",
    "VAT ขอคืนได้",
    "หมายเหตุ",
  ];
  const lines = bills.map((b) =>
    [
      csvCell(b.date),
      csvCell(b.vendor),
      csvText(b.taxId),
      csvCell(b.branch),
      csvCell(b.invoiceNumber),
      csvCell(DOC_TYPE[b.documentType]),
      csvCell(b.category),
      b.subtotal.toFixed(2),
      b.vat.toFixed(2),
      b.total.toFixed(2),
      csvCell(STATUS[b.compliance.status].label),
      b.claimableVat.toFixed(2),
      csvCell(b.compliance.issues.join(" | ")),
    ].join(","),
  );
  return "\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n");
}

async function downloadCsv(bills: Bill[], monthKey: string) {
  const filename = `tax-bills-${monthKey}.csv`;
  const blob = new Blob([buildCsv(bills)], { type: "text/csv;charset=utf-8" });
  const file = new File([blob], filename, { type: "text/csv" });

  // LINE's in-app browser (esp. iOS) often blocks blob downloads → use the share sheet when possible.
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type Phase = "loading" | "ready" | "error";

export default function DashboardPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [data, setData] = useState<BillsResponse | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [month, setMonth] = useState<string | null>(null); // null = newest month
  const [filter, setFilter] = useState<ComplianceStatus | "all">("all");
  const tokenRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/bills", {
      cache: "no-store",
      headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
    });
    if (res.status === 401) throw new Error("เซสชันหมดอายุ กรุณาปิดแล้วเปิดแดชบอร์ดจากแชท LINE อีกครั้ง");
    if (!res.ok) throw new Error(`โหลดข้อมูลไม่สำเร็จ (รหัส ${res.status})`);
    setData((await res.json()) as BillsResponse);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (liffId) {
          const { default: liff } = await import("@line/liff"); // browser-only
          await liff.init({ liffId });
          if (!liff.isLoggedIn()) {
            liff.login();
            return;
          }
          tokenRef.current = liff.getIDToken();
          if (!tokenRef.current) {
            throw new Error("ไม่พบ ID token — เปิด scope “openid” ในการตั้งค่า LIFF แล้วลองใหม่");
          }
          liff.getProfile().then((p) => !cancelled && setUserName(p.displayName)).catch(() => {});
        } else {
          setPreviewMode(true);
        }
        await load();
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "รีเฟรชไม่สำเร็จ");
      setPhase("error");
    } finally {
      setRefreshing(false);
    }
  };

  /* ---------- derived data ---------- */
  const months = data?.summary.months ?? [];
  const activeMonth = month ?? months[0]?.month ?? "all";

  const summary: MonthlySummary | null = useMemo(() => {
    if (!data) return null;
    return activeMonth === "all"
      ? data.summary.overall
      : (data.summary.months.find((m) => m.month === activeMonth) ?? data.summary.overall);
  }, [data, activeMonth]);

  const monthBills = useMemo(
    () => (data?.bills ?? []).filter((b) => activeMonth === "all" || b.date.startsWith(activeMonth)),
    [data, activeMonth],
  );
  const visibleBills = useMemo(
    () => monthBills.filter((b) => filter === "all" || b.compliance.status === filter),
    [monthBills, filter],
  );

  const categories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of monthBills) totals.set(b.category, (totals.get(b.category) ?? 0) + b.total);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [monthBills]);
  const maxCategory = categories[0]?.[1] ?? 1;

  /* ---------- render ---------- */
  return (
    <main className={`${plex.className} min-h-dvh bg-[#F1F3EF] pb-28 text-[#17201B]`}>
      <div className="mx-auto max-w-md">
        {/* Top bar */}
        <header className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h1 className="text-xl font-semibold leading-tight">บิลภาษีของฉัน</h1>
            <p className="text-sm text-[#66706A]">{userName ? `สวัสดี ${userName}` : "สรุปค่าใช้จ่ายและ VAT ซื้อ"}</p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || phase === "loading"}
            aria-label="รีเฟรชข้อมูล"
            className="grid h-10 w-10 place-items-center rounded-full border border-[#D5DAD3] bg-white text-[#17201B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A8F4D] disabled:opacity-50"
          >
            <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
          </button>
        </header>

        {previewMode && (
          <p className="mx-5 mb-3 rounded-md bg-[#FFEFCF] px-3 py-2 text-xs text-[#8A5300]">
            โหมดทดลอง: ยังไม่ได้ตั้งค่า NEXT_PUBLIC_LIFF_ID จึงแสดงข้อมูลตัวอย่าง
          </p>
        )}

        {phase === "loading" && (
          <div className="flex flex-col items-center gap-3 py-24 text-[#66706A]">
            <Loader2 className="animate-spin" />
            <span className="text-sm">กำลังโหลดบิล…</span>
          </div>
        )}

        {phase === "error" && (
          <div className="mx-5 mt-6 rounded-lg border border-[#E9B9B5] bg-[#FDE2E0] p-4 text-sm text-[#A12D2D]">
            <p className="font-medium">โหลดข้อมูลไม่สำเร็จ</p>
            <p className="mt-1">{error}</p>
            <button
              type="button"
              onClick={() => location.reload()}
              className="mt-3 rounded-md bg-[#A12D2D] px-3 py-2 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A12D2D]"
            >
              โหลดหน้าใหม่
            </button>
          </div>
        )}

        {phase === "ready" && data && summary && (
          <>
            {/* Month picker */}
            <div className="px-5 pb-4">
              <label htmlFor="month" className="sr-only">
                เลือกเดือน
              </label>
              <select
                id="month"
                value={activeMonth}
                onChange={(e) => {
                  setMonth(e.target.value);
                  setFilter("all");
                }}
                className="w-full rounded-lg border border-[#D5DAD3] bg-white px-3 py-2.5 text-base font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0A8F4D]"
              >
                {months.map((m) => (
                  <option key={m.month} value={m.month}>
                    {monthLabel(m.month)}
                  </option>
                ))}
                {months.length > 0 && <option value="all">ทุกเดือน</option>}
                {months.length === 0 && <option value="all">ยังไม่มีข้อมูล</option>}
              </select>
            </div>

            {/* Claimable VAT — the one big moment: a receipt stub with a tear line */}
            <section className="relative mx-5 rounded-t-xl border border-b-0 border-[#D5DAD3] bg-white px-5 pt-5 pb-6">
              <p className="text-sm text-[#66706A]">ภาษีซื้อ 7% ที่ขอคืนได้</p>
              <p className="mt-1 text-[2.5rem] font-semibold leading-none tracking-tight text-[#0A7A43] [font-variant-numeric:tabular-nums]">
                {baht(summary.claimableVat)}
              </p>
              <p className="mt-3 text-sm text-[#66706A]">
                จากใบกำกับภาษีที่ผ่านเกณฑ์ {summary.validCount} จาก {summary.billCount} ใบ
              </p>
              <span aria-hidden className="absolute -bottom-2.5 -left-2.5 h-5 w-5 rounded-full bg-[#F1F3EF] ring-1 ring-[#D5DAD3]" />
              <span aria-hidden className="absolute -bottom-2.5 -right-2.5 h-5 w-5 rounded-full bg-[#F1F3EF] ring-1 ring-[#D5DAD3]" />
            </section>
            <div aria-hidden className="mx-5 h-0 border-t-2 border-dashed border-[#C3CAC1]" />

            {/* Ledger figures */}
            <section className="mx-5 grid grid-cols-3 divide-x divide-[#D5DAD3] border-x border-b border-[#D5DAD3] bg-white py-4 [font-variant-numeric:tabular-nums]">
              <Figure label="ค่าใช้จ่ายรวม" value={baht(summary.total)} />
              <Figure label="VAT ทั้งหมด" value={baht(summary.vat)} />
              <Figure label="VAT รอตรวจ" value={baht(summary.pendingVat)} tone="review" />
            </section>
            {summary.nonClaimableVat > 0 && (
              <p className="mx-5 mt-2 text-xs text-[#A12D2D]">
                VAT {baht(summary.nonClaimableVat)} อยู่ในบิลที่ขอคืนไม่ได้ ขอให้ผู้ขายออกใบกำกับภาษีที่ถูกต้อง
              </p>
            )}

            {/* Categories */}
            {categories.length > 0 && (
              <section className="mt-7 px-5">
                <h2 className="mb-3 text-base font-semibold">ค่าใช้จ่ายตามหมวดหมู่</h2>
                <ul className="space-y-3">
                  {categories.map(([name, total]) => (
                    <li key={name}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span>{name}</span>
                        <span className="[font-variant-numeric:tabular-nums]">{baht(total)}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-[#DEE3DB]">
                        <div
                          className="h-full rounded-full bg-[#17201B]"
                          style={{ width: `${Math.max(4, (total / maxCategory) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Bills */}
            <section className="mt-8">
              <h2 className="px-5 text-base font-semibold">รายการบิล</h2>

              <div className="flex gap-2 overflow-x-auto px-5 py-3" role="tablist" aria-label="กรองตามสถานะ">
                {(
                  [
                    ["all", "ทั้งหมด", monthBills.length],
                    ["valid", STATUS.valid.label, summary.validCount],
                    ["review", STATUS.review.label, summary.reviewCount],
                    ["invalid", STATUS.invalid.label, summary.invalidCount],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={filter === key}
                    onClick={() => setFilter(key)}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A8F4D] ${
                      filter === key
                        ? "border-[#17201B] bg-[#17201B] text-white"
                        : "border-[#D5DAD3] bg-white text-[#17201B]"
                    }`}
                  >
                    {label} {count}
                  </button>
                ))}
              </div>

              {visibleBills.length === 0 ? (
                <div className="mx-5 mt-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-[#C3CAC1] px-6 py-10 text-center text-sm text-[#66706A]">
                  <Receipt />
                  <p>
                    {monthBills.length === 0
                      ? "ยังไม่มีบิล ส่งรูปใบเสร็จหรือใบกำกับภาษีไปที่แชท LINE ของบอท บิลจะขึ้นที่นี่อัตโนมัติ"
                      : "ไม่มีบิลในสถานะนี้"}
                  </p>
                </div>
              ) : (
                <ul className="border-y border-[#D5DAD3] bg-white">
                  {visibleBills.map((b) => (
                    <BillRow key={b.id} bill={b} />
                  ))}
                </ul>
              )}
            </section>

            <p className="mx-5 mt-6 text-xs leading-relaxed text-[#66706A]">
              สถานะเป็นการตรวจเบื้องต้นจากข้อมูลบนเอกสาร ไม่ใช่คำปรึกษาด้านภาษี ควรให้นักบัญชีตรวจสอบก่อนยื่น ภ.พ.30
            </p>
          </>
        )}
      </div>

      {/* Export */}
      {phase === "ready" && data && (
        <div className="fixed inset-x-0 bottom-0 border-t border-[#D5DAD3] bg-[#F1F3EF]/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto max-w-md">
            <button
              type="button"
              disabled={monthBills.length === 0}
              onClick={() => downloadCsv(monthBills, activeMonth)}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#0A8F4D] py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A8F4D] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download size={18} />
              ส่งออก CSV/Excel ({monthBills.length} ใบ)
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Figure({ label, value, tone }: { label: string; value: string; tone?: "review" }) {
  return (
    <div className="px-3">
      <p className="text-xs text-[#66706A]">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${tone === "review" ? "text-[#8A5300]" : ""}`}>{value}</p>
    </div>
  );
}

function BillRow({ bill }: { bill: Bill }) {
  const s = STATUS[bill.compliance.status];
  return (
    <li className="border-b border-[#E3E7E0] px-5 py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{bill.vendor}</p>
          <p className="mt-0.5 text-sm text-[#66706A]">{thaiDate(bill.date)}</p>
          <p className="text-sm text-[#66706A]">{bill.category}</p>
        </div>
        <div className="shrink-0 text-right [font-variant-numeric:tabular-nums]">
          <p className="font-semibold">{baht(bill.total)}</p>
          <p className="mt-0.5 text-sm text-[#66706A]">VAT {baht(bill.vat)}</p>
        </div>
      </div>

      <span className={`mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.bg} ${s.text}`}>
        <s.Icon size={14} aria-hidden />
        {s.label}
      </span>

      {bill.compliance.issues.length > 0 && (
        <ul className={`mt-2 space-y-0.5 text-xs leading-relaxed ${s.text}`}>
          {bill.compliance.issues.map((issue) => (
            <li key={issue}>• {issue}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
